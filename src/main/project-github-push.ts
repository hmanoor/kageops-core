/**
 * KageOps — Project push-to-GitHub IPC handler (B-427)
 *
 * Thin shim over GitHubClient.pushBranch for the Artifact Browser's
 * "Push to GitHub" button. Push-only: requires the project row to
 * already have `github_owner` / `github_repo` set (configured via the
 * existing v0.9 SET_PROJECT_GITHUB flow) and a GitHub PAT stored via
 * the secret store. Returns a structured error instead of throwing so
 * the renderer can surface a toast.
 */

import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { IPC } from '../shared/ipc-channels';
import { gitIdentityArgs } from '../shared/git-config';
import { createLogger } from '../shared/logger';
import type { GitHubClient } from '../github/github-client';
import {
    streamSubprocessOutput,
    type SubprocessEventPublisher,
} from '../orchestrator/subprocess-stream';

const log = createLogger('ProjectGitHubPush');

// ── Types ────────────────────────────────────────────

export interface PushProjectResponse {
    readonly success: boolean;
    readonly error?: string;
    readonly branch?: string;
    readonly repoUrl?: string;
}

export interface ProjectGitHubRow {
    readonly github_owner: string | null;
    readonly github_repo: string | null;
    readonly repo_path: string | null;
}

export interface ProjectGitHubPushDeps {
    readonly getProjectRow: (projectId: string) => Promise<ProjectGitHubRow | null>;
    readonly getGitHubToken: () => Promise<string | null>;
    readonly getGitHubClient: () => Pick<GitHubClient, 'pushBranch'>;
    readonly getCurrentBranch: (repoPath: string, ctx?: GitStreamContext) => Promise<string>;
    readonly ensureCommitted: (repoPath: string, ctx?: GitStreamContext) => Promise<void>;
    /** Optional bus for piping git stdout/stderr to the Agent Terminal panel. */
    readonly getEventBus?: () => SubprocessEventPublisher | null;
}

/**
 * Per-call streaming context: lets `runGit` pipe stdout/stderr into the
 * `subprocess.output` event bus so the Agent Terminal panel can tail the
 * push live. Both fields must be present to enable streaming.
 */
export interface GitStreamContext {
    readonly bus: SubprocessEventPublisher | null;
    readonly projectId: string | null;
}

// ── Pure handler (exported for tests) ────────────────

/**
 * Validate + coerce + dispatch. Returns a structured error on every
 * failure path — never throws. Caller can render `error` verbatim.
 */
export async function handlePushProjectToGitHub(
    deps: ProjectGitHubPushDeps,
    rawProjectId: unknown,
): Promise<PushProjectResponse> {
    if (typeof rawProjectId !== 'string' || rawProjectId.trim() === '') {
        return { success: false, error: 'Invalid projectId' };
    }
    const projectId = rawProjectId.trim();

    let row: ProjectGitHubRow | null;
    try {
        row = await deps.getProjectRow(projectId);
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (row === null) return { success: false, error: 'Project not found' };

    const owner = (row.github_owner ?? '').trim();
    const repo = (row.github_repo ?? '').trim();
    if (owner === '' || repo === '') {
        return {
            success: false,
            error: 'GitHub repo not configured for this project. Open Settings → Projects → GitHub to link a repo first.',
        };
    }

    const repoPath = (row.repo_path ?? '').trim();
    if (repoPath === '') return { success: false, error: 'Project has no workspace path' };

    const token = await deps.getGitHubToken();
    if (token === null || token === '') {
        return {
            success: false,
            error: 'GitHub token not configured. Add a Personal Access Token in Settings → GitHub.',
        };
    }

    const streamCtx: GitStreamContext = {
        bus: deps.getEventBus?.() ?? null,
        projectId,
    };

    try {
        await deps.ensureCommitted(repoPath, streamCtx);
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    let branch: string;
    try {
        branch = await deps.getCurrentBranch(repoPath, streamCtx);
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (branch === '') return { success: false, error: 'Could not determine current branch' };

    try {
        await deps.getGitHubClient().pushBranch(repoPath, { owner, repo, token }, branch);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ projectId, branch, err: msg }, 'pushBranch failed');
        return { success: false, error: msg };
    }

    return {
        success: true,
        branch,
        repoUrl: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(branch)}`,
    };
}

// ── Default dependency implementations ───────────────

/**
 * Resolve whether a path contains a `.git` directory or is itself a
 * worktree (file `.git` pointing at gitdir).
 */
async function isGitRepo(repoPath: string): Promise<boolean> {
    try {
        const stat = await fsp.stat(path.join(repoPath, '.git'));
        return stat.isDirectory() || stat.isFile();
    } catch {
        return false;
    }
}

/**
 * Ensure the repo is initialized and the working tree has at least one
 * commit. Agents may leave behind uncommitted changes — we auto-commit
 * those under the "kageops/auto" identity so `push` has a ref to send.
 */
export async function ensureCommitted(repoPath: string, ctx?: GitStreamContext): Promise<void> {
    if (!fs.existsSync(repoPath)) {
        throw new Error(`Workspace path does not exist: ${repoPath}`);
    }

    const isRepo = await isGitRepo(repoPath);
    if (!isRepo) {
        await runGit(repoPath, ['init'], ctx);
        await runGit(repoPath, ['checkout', '-B', 'main'], ctx);
    }

    // If the working tree is clean AND there is at least one commit, nothing to do.
    const status = await runGit(repoPath, ['status', '--porcelain'], ctx);
    let hasCommit = true;
    try {
        await runGit(repoPath, ['rev-parse', '--verify', 'HEAD'], ctx);
    } catch {
        hasCommit = false;
    }
    if (status.trim() === '' && hasCommit) return;

    // Identity — required for `git commit` to succeed in environments
    // with no global git config.
    await runGit(repoPath, [...gitIdentityArgs(), 'add', '.'], ctx);
    await runGit(repoPath, [
        ...gitIdentityArgs(),
        'commit',
        '--allow-empty',
        '-m',
        'KageOps: push snapshot',
    ], ctx);
}

/**
 * Return the current branch name. Falls back to creating `main` if the
 * repo is in a detached state.
 */
export async function getCurrentBranch(repoPath: string, ctx?: GitStreamContext): Promise<string> {
    try {
        const out = await runGit(repoPath, ['symbolic-ref', '--short', 'HEAD'], ctx);
        return out.trim();
    } catch {
        // Detached HEAD — create a main branch pointing at HEAD
        await runGit(repoPath, ['checkout', '-B', 'main'], ctx);
        return 'main';
    }
}

function runGit(cwd: string, args: string[], ctx?: GitStreamContext): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

        // Tail to Agent Terminal when both projectId + bus are available.
        const stop = (ctx?.bus !== null && ctx?.bus !== undefined && ctx.projectId !== null && ctx.projectId !== '')
            ? streamSubprocessOutput(proc, ctx.bus, {
                projectId: ctx.projectId,
                source: 'github-push',
                agent: 'system',
            })
            : (): void => undefined;

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            stop();
            if (code === 0) resolve(stdout);
            else reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`));
        });
        proc.on('error', (err) => {
            stop();
            reject(new Error(`Failed to spawn git: ${err.message}`));
        });
    });
}

// ── IPC registration ─────────────────────────────────

export function registerProjectGitHubPushHandler(deps: ProjectGitHubPushDeps): void {
    ipcMain.handle(IPC.PROJECT_PUSH_GITHUB, async (_event, args: unknown) => {
        const a = (typeof args === 'object' && args !== null) ? args as Record<string, unknown> : {};
        const projectId = a['projectId'];
        return handlePushProjectToGitHub(deps, projectId);
    });
}
