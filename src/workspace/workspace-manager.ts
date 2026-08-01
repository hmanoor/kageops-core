/**
 * KageOps Workspace Manager
 *
 * Creates and manages project workspaces from a golden template.
 * Each project gets its own git-initialized directory with the
 * standard KageOps structure (Decision #9: Template + Spawn).
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { createLogger } from '../shared/logger';
import { isGitEnabled, gitIdentityArgs } from '../shared/git-config';
import { detectSimpleApp } from '../shared/simple-app-detector';

const log = createLogger('WorkspaceManager');

// ── Types ────────────────────────────────────────────

export interface ProjectMetadata {
    readonly name: string;
    readonly description: string;
    readonly trustLevel: string;
    readonly createdAt: string;
}

// ── Constants ────────────────────────────────────────

/**
 * Relative path from package root to the golden template directory.
 * In production (dist/), the template is at `../../templates/default`.
 * In dev/tests, it's at `../../templates/default` from src/.
 */
const TEMPLATE_RELATIVE_PATH = '../../templates/default';

// ── Workspace Manager ────────────────────────────────

export class WorkspaceManager {
    private readonly templateDir: string;

    constructor(templateDir?: string) {
        this.templateDir = templateDir ?? path.resolve(__dirname, TEMPLATE_RELATIVE_PATH);
    }

    /**
     * Create a new project workspace from the golden template.
     * Returns the absolute path to the new project directory.
     *
     * @throws Error if workspace already exists or template is missing
     */
    async createProject(
        projectsDir: string,
        projectSlug: string,
        name: string,
        description: string,
        trustLevel = 'low'
    ): Promise<string> {
        const safeSlug = this.validateSlug(projectSlug);

        const targetDir = path.resolve(projectsDir, safeSlug);

        // Ensure target is under projectsDir
        this.validatePath(projectsDir, targetDir);

        // Check for duplicates
        if (fs.existsSync(targetDir)) {
            throw new Error(`Project workspace already exists: ${targetDir}`);
        }

        // Ensure template exists
        if (!fs.existsSync(this.templateDir)) {
            throw new Error(`Golden template not found: ${this.templateDir}`);
        }

        // Ensure parent directory exists
        if (!fs.existsSync(projectsDir)) {
            fs.mkdirSync(projectsDir, { recursive: true });
        }

        // Copy template
        this.copyTemplate(this.templateDir, targetDir);

        // Customize project metadata
        this.customizeTemplate(targetDir, name, description, trustLevel);

        // F-351 + F-366: when the brief describes a static-HTML project
        // (counter / todo / calculator / landing page / single-file / etc.)
        // the template's package.json + tsconfig.json + src/ scaffold are
        // dead weight. Forge writes index.html + styles.css + script.js to
        // the workspace root; the build-verify gate skips when package.json
        // is absent (build-verification-gate.resolveBuildPlan). Stripping
        // the build scaffold here prevents:
        //   - `npm install` running on a no-build project (61 MB workspaces!)
        //   - BuildVerificationGate trying to run `tsc` with no .ts sources
        //   - Aegis/CI getting confused about whether tests should run
        // Detection mirrors detectSimpleApp so the rule stays consistent
        // across task-decomposer / Forge / acceptance-gate / workspace.
        const detection = detectSimpleApp(description);
        if (detection.simple) {
            this.stripBuildScaffold(targetDir, detection.kind ?? 'static-html');
        }

        // Initialize git repo (skipped when KAGEOPS_DISABLE_GIT is set —
        // benchmark / test runs that don't want commit history).
        if (isGitEnabled()) {
            await this.initGitRepo(targetDir);
        } else {
            log.info({ targetDir }, 'Git disabled — skipping init');
        }

        log.info({ targetDir }, 'Created project workspace');
        return targetDir;
    }

    /**
     * Get the absolute path to an existing project workspace.
     * Returns null if the workspace does not exist.
     */
    getProjectPath(projectsDir: string, projectSlug: string): string | null {
        const safeSlug = this.validateSlug(projectSlug);
        const targetDir = path.resolve(projectsDir, safeSlug);
        this.validatePath(projectsDir, targetDir);

        if (!fs.existsSync(targetDir)) {
            return null;
        }

        return targetDir;
    }

    /**
     * Check if a project workspace exists.
     */
    projectExists(projectsDir: string, projectSlug: string): boolean {
        return this.getProjectPath(projectsDir, projectSlug) !== null;
    }

    /**
     * Delete a project workspace (for cleanup / testing).
     */
    async deleteProject(projectsDir: string, projectSlug: string): Promise<void> {
        const safeSlug = this.validateSlug(projectSlug);
        const targetDir = path.resolve(projectsDir, safeSlug);
        this.validatePath(projectsDir, targetDir);

        if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
            log.info({ targetDir }, 'Deleted workspace');
        }
    }

    /**
     * Get the path to the golden template directory.
     */
    getTemplatePath(): string {
        return this.templateDir;
    }

    // ── Private Helpers ──────────────────────────────

    /**
     * Recursively copy the golden template to the target directory.
     */
    private copyTemplate(source: string, target: string): void {
        fs.cpSync(source, target, { recursive: true });
    }

    /**
     * Customize the copied template with project-specific values.
     */
    private customizeTemplate(
        targetDir: string,
        name: string,
        description: string,
        trustLevel: string
    ): void {
        // Update .autonauts/project.json
        const projectJsonPath = path.join(targetDir, '.autonauts', 'project.json');
        const metadata: ProjectMetadata = {
            name,
            description,
            trustLevel,
            createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(projectJsonPath, JSON.stringify(metadata, null, 2), 'utf-8');

        // Update README.md
        const readmePath = path.join(targetDir, 'README.md');
        const readmeContent = [
            `# ${name}`,
            '',
            description,
            '',
            '---',
            '',
            'Created by [KageOps](https://kageops.ai)',
            '',
        ].join('\n');
        fs.writeFileSync(readmePath, readmeContent, 'utf-8');
    }

    /**
     * F-351 + F-366: remove the build scaffold from a workspace whose brief
     * is a static-HTML project. Idempotent — missing files are silently
     * ignored. The .autonauts/ metadata + README.md + designs/ + marketing/
     * + docs/ + data/ stay intact (those are still useful for static apps).
     *
     * Exposed for tests.
     */
    stripBuildScaffold(targetDir: string, kind: string): void {
        const toRemove = ['package.json', 'package-lock.json', 'tsconfig.json', 'node_modules', 'src', 'tests'];
        for (const entry of toRemove) {
            const full = path.join(targetDir, entry);
            if (fs.existsSync(full)) {
                fs.rmSync(full, { recursive: true, force: true });
            }
        }
        log.info({ targetDir, kind }, 'Stripped build scaffold for static-HTML brief');
    }

    /**
     * Initialize a git repo in the target directory with an initial commit.
     */
    private async initGitRepo(targetDir: string): Promise<void> {
        await this.runGit(targetDir, ['init']);
        await this.runGit(targetDir, ['add', '-A']);
        // Identity is pinned at the invocation: without it this fails outright
        // on a machine with no global git config, and otherwise attributes
        // machine-authored commits to the human. See shared/git-config.ts.
        await this.runGit(targetDir, [...gitIdentityArgs(), 'commit', '-m', 'Initial project scaffold']);
    }

    /**
     * F-334: Ensure a project workspace is a real git repo before agents
     * start running `git add/commit` inside it.
     *
     * Idempotent. No-op when:
     *   - git is disabled via KAGEOPS_DISABLE_GIT
     *   - `.git/` already exists in `targetDir`
     *
     * Otherwise runs `git init` + an empty initial commit so subsequent
     * `git add -A` from autonaut-agent.gitCommit() doesn't fail with
     * `fatal: not a git repository`.
     *
     * Called by Sensei's bare-directory fallback path (when the golden
     * template clone fails) and on workspace reopen for projects created
     * before this guard existed.
     */
    async ensureGitInitialized(targetDir: string): Promise<void> {
        if (!isGitEnabled()) {
            return;
        }
        if (!fs.existsSync(targetDir)) {
            return;
        }
        if (fs.existsSync(path.join(targetDir, '.git'))) {
            return;
        }
        try {
            await this.runGit(targetDir, ['init']);
            // Empty commit so HEAD is valid — branch checkout / first
            // `git add -A` from agents both rely on a non-empty ref log.
            await this.runGit(targetDir, [...gitIdentityArgs(), 'commit', '--allow-empty', '-m', 'Initial commit (auto-init)']);
            log.info({ targetDir }, 'F-334: auto-initialized git repo in existing workspace');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg, targetDir }, 'F-334: git auto-init failed — agents may hit "not a git repository"');
        }
    }

    /**
     * Sanitize and validate a slug. NFKD-normalises, maps Unicode dashes
     * (hyphen, en, em, horizontal bar, minus) to ASCII, lowercases, and
     * strips combining marks before checking the safe-char regex. Returns
     * the sanitized slug — callers should use the return value for path
     * resolution rather than the raw input.
     */
    private validateSlug(slug: string): string {
        if (slug.length === 0) {
            throw new Error('Project slug cannot be empty');
        }

        const sanitized = slug
            .normalize('NFKD')
            .replace(/[‐‑‒–—―−]/g, '-')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase();

        if (!/^[a-z0-9][a-z0-9_-]*$/.test(sanitized)) {
            throw new Error(
                `Invalid project slug: "${slug}"` +
                (sanitized !== slug ? ` (sanitized: "${sanitized}")` : '') +
                '. Use only letters, numbers, hyphens, and underscores.'
            );
        }

        if (sanitized.includes('..') || sanitized.includes('/') || sanitized.includes('\\')) {
            throw new Error(`Path traversal detected in slug: "${slug}"`);
        }

        return sanitized;
    }

    /**
     * Validate that resolvedPath is under parentDir (prevent path traversal).
     */
    private validatePath(parentDir: string, resolvedPath: string): void {
        const resolvedParent = path.resolve(parentDir);
        const resolvedTarget = path.resolve(resolvedPath);

        if (!resolvedTarget.startsWith(resolvedParent + path.sep) && resolvedTarget !== resolvedParent) {
            throw new Error(`Path traversal detected: ${resolvedPath} is outside ${parentDir}`);
        }
    }

    /**
     * Run a git command in the given directory.
     */
    private runGit(cwd: string, args: readonly string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawn('git', [...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
            proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error(`git ${args.join(' ')} failed (exit ${code ?? 'null'}): ${stderr.trim()}`));
                }
            });

            proc.on('error', (err) => {
                reject(new Error(`Failed to spawn git: ${err.message}`));
            });
        });
    }
}
