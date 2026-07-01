/**
 * P1-08a — revision proposal staging.
 *
 * Out-of-workspace staging directory where Forge's revision-mode
 * output lands BEFORE the operator accepts it. Lives under
 * `KAGEOPS_DATA_DIR/staging/<project_id>/<task_id>/` so:
 *
 *   1. Uncommitted proposals don't leak into the workspace's git tree
 *      (no accidental commits of "rejected" content).
 *   2. A killed orchestrator process can resume + re-evaluate the
 *      staged contents without re-spending on a new LLM call.
 *   3. Reject is a single `rm -r` — no git-revert dance.
 *
 * Accept moves files into the workspace via the standard `writeFile`
 * path so the P1-01c sha256 cache + sanitisation + stream events
 * all run normally; the staging dir is then cleaned up.
 *
 * Pure + side-effecting boundary: this module owns FS I/O for the
 * staging dir + a `ProposedFile` shape. Forge's `executeRevisionTask`
 * is the only caller in P1-08a; P1-08b's Sensei chat surface will
 * call `listProposed` + `acceptProposal` / `rejectProposal` from the
 * IPC layer.
 *
 * Behavior is opt-in via `KAGEOPS_FEATURE_REVISIONS=true` per the
 * plan doc. When the flag is off, Forge writes straight to the
 * workspace as it does today (P1-06b behaviour).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createLogger } from '../shared/logger';

const log = createLogger('RevisionStaging');

// ── Types ──────────────────────────────────────────────

/**
 * One proposed file in a revision proposal. `proposedSha256` is the
 * sha256 of the staged content the operator hasn't accepted yet.
 * `currentSha256` is the sha256 of what's currently on disk at the
 * same relative path (null when the file doesn't exist on disk yet,
 * e.g. the revision creates a brand-new file).
 */
export interface ProposedFile {
    readonly path: string;
    readonly sizeBytes: number;
    readonly proposedSha256: string;
    readonly currentSha256: string | null;
    /** True when the proposed content equals what's on disk — no-op. */
    readonly unchanged: boolean;
}

export interface RevisionProposal {
    readonly projectId: string;
    readonly taskId: string;
    readonly stagingDir: string;
    readonly files: readonly ProposedFile[];
    readonly createdAt: string;
}

export interface RevisionStagingConfig {
    /**
     * Root dir for all staging proposals. Defaults to
     * `<KAGEOPS_DATA_DIR or ~/.kageops>/staging` so it never leaks
     * into the project workspace.
     */
    readonly stagingRoot?: string;
}

// ── Public API ────────────────────────────────────────

/**
 * Resolve the staging dir path for a given (projectId, taskId).
 * Returns the absolute path. Does NOT create the directory.
 */
export function stagingDirFor(projectId: string, taskId: string, config: RevisionStagingConfig = {}): string {
    const root = config.stagingRoot ?? defaultStagingRoot();
    return path.join(root, projectId, taskId);
}

/**
 * Write one proposed file to the staging dir. Idempotent — re-writing
 * the same content is a no-op (sha matches). Returns the
 * `ProposedFile` describing what landed.
 *
 * `repoPath` is the workspace root so we can compute the
 * `currentSha256` of the on-disk file (if any) for the diff payload.
 */
export function stageFile(
    projectId: string,
    taskId: string,
    repoPath: string,
    relativePath: string,
    content: string,
    config: RevisionStagingConfig = {},
): ProposedFile {
    const dir = stagingDirFor(projectId, taskId, config);
    fs.mkdirSync(dir, { recursive: true });

    // Path traversal guard — staged paths must resolve under the
    // staging dir (not escape via `../`).
    const absStaged = path.resolve(dir, relativePath);
    if (!absStaged.startsWith(path.resolve(dir))) {
        throw new Error(`Path traversal detected: ${relativePath} escapes staging dir`);
    }
    fs.mkdirSync(path.dirname(absStaged), { recursive: true });
    fs.writeFileSync(absStaged, content, 'utf-8');

    const proposedSha256 = sha256(content);
    const currentSha256 = readCurrentSha256(repoPath, relativePath);
    const sizeBytes = Buffer.byteLength(content, 'utf-8');

    return {
        path: relativePath,
        sizeBytes,
        proposedSha256,
        currentSha256,
        unchanged: currentSha256 === proposedSha256,
    };
}

/**
 * List every proposed file in a staging dir + return a fully-formed
 * `RevisionProposal`. Used by the Sensei chat surface (P1-08b) when
 * the operator opens the diff view.
 *
 * `repoPath` is the project workspace so currentSha256 reflects the
 * file as it sits on disk RIGHT NOW (not at staging time) — handles
 * the "operator hand-edited the file between propose + review" case.
 */
export function listProposed(
    projectId: string,
    taskId: string,
    repoPath: string,
    config: RevisionStagingConfig = {},
): RevisionProposal | null {
    const dir = stagingDirFor(projectId, taskId, config);
    if (!fs.existsSync(dir)) return null;

    const relativePaths = walkRelative(dir);
    if (relativePaths.length === 0) {
        return {
            projectId,
            taskId,
            stagingDir: dir,
            files: [],
            createdAt: safeMtime(dir),
        };
    }

    const files = relativePaths.map((rel) => {
        const abs = path.join(dir, rel);
        const content = fs.readFileSync(abs);
        const proposedSha256 = crypto.createHash('sha256').update(content).digest('hex');
        const currentSha256 = readCurrentSha256(repoPath, rel);
        return {
            path: rel,
            sizeBytes: content.length,
            proposedSha256,
            currentSha256,
            unchanged: currentSha256 === proposedSha256,
        };
    });

    return {
        projectId,
        taskId,
        stagingDir: dir,
        files,
        createdAt: safeMtime(dir),
    };
}

/**
 * Accept a revision proposal — move each staged file into the live
 * workspace. Caller passes a `writer` (the standard `writeFile` from
 * AutonautAgent) so the P1-01c sha256 cache + sanitisation + stream
 * events all run normally.
 *
 * Cleans up the staging dir on success. Returns the list of files
 * actually written (omitting any that match what's already on disk).
 *
 * Crash safety: writer runs sequentially; if the orchestrator dies
 * mid-write, the staging dir still has the remaining content and a
 * retry continues from where it left off (idempotent on unchanged
 * files via the sha256 cache).
 */
export async function acceptProposal(
    projectId: string,
    taskId: string,
    repoPath: string,
    writer: (relativePath: string, content: string) => Promise<void>,
    config: RevisionStagingConfig = {},
): Promise<readonly string[]> {
    const proposal = listProposed(projectId, taskId, repoPath, config);
    if (proposal === null) {
        log.warn({ projectId, taskId }, 'P1-08a: acceptProposal called with no staged content — no-op');
        return [];
    }

    const written: string[] = [];
    for (const file of proposal.files) {
        if (file.unchanged) {
            log.debug({ projectId, taskId, file: file.path }, 'P1-08a: skipping unchanged file on accept');
            continue;
        }
        const stagedPath = path.join(proposal.stagingDir, file.path);
        const content = fs.readFileSync(stagedPath, 'utf-8');
        await writer(file.path, content);
        written.push(file.path);
    }

    discardStagingDir(proposal.stagingDir);
    log.info({ projectId, taskId, accepted: written.length, totalStaged: proposal.files.length }, 'P1-08a: revision proposal accepted');
    return written;
}

/**
 * Reject a revision proposal — delete the staging dir. Caller is
 * responsible for emitting any `revision.rejected` event.
 *
 * Idempotent — calling reject on a non-existent staging dir is a
 * no-op so the operator can hammer the Reject button without races.
 */
export function rejectProposal(
    projectId: string,
    taskId: string,
    config: RevisionStagingConfig = {},
): void {
    const dir = stagingDirFor(projectId, taskId, config);
    discardStagingDir(dir);
    log.info({ projectId, taskId }, 'P1-08a: revision proposal rejected');
}

// ── Internals ──────────────────────────────────────────

function defaultStagingRoot(): string {
    const dataDir = process.env['KAGEOPS_DATA_DIR'] ?? path.join(os.homedir(), '.kageops');
    return path.join(dataDir, 'staging');
}

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function readCurrentSha256(repoPath: string, relativePath: string): string | null {
    if (repoPath === '') return null;
    const abs = path.resolve(repoPath, relativePath);
    if (!fs.existsSync(abs)) return null;
    try {
        const buf = fs.readFileSync(abs);
        return crypto.createHash('sha256').update(buf).digest('hex');
    } catch {
        return null;
    }
}

function walkRelative(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                out.push(path.relative(root, full).replace(/\\/g, '/'));
            }
        }
    };
    walk(root);
    return out.sort();
}

function safeMtime(dir: string): string {
    try {
        return fs.statSync(dir).mtime.toISOString();
    } catch {
        return new Date().toISOString();
    }
}

function discardStagingDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ dir, err: msg }, 'P1-08a: failed to discard staging dir (non-fatal)');
    }
    // Clean up empty project-level parent dir if no other tasks remain.
    try {
        const parent = path.dirname(dir);
        if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
            fs.rmdirSync(parent);
        }
    } catch {
        // best-effort
    }
}
