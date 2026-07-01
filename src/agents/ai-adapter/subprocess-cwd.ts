/**
 * Safe working directory for file-writing CLI subprocesses (claude-cli, codex-cli).
 *
 * RG-1: a missing/empty `cwd` previously fell through to the parent process cwd —
 * the KageOps repo — letting the agentic CLI read KageOps's CLAUDE.md and write
 * files into the source tree. During a 2026-06-12 benchmark this overwrote
 * `landing/index.html` (likely because `KAGEOPS_DISABLE_GIT` left the task's
 * `repoPath` empty, so the caller passed no cwd).
 *
 * This makes that impossible: a CLI subprocess NEVER inherits the repo cwd. A
 * valid caller cwd (the project workspace) is used as-is; a missing one is
 * redirected to an isolated scratch dir OUTSIDE the source tree, so a caller
 * bug can't corrupt the repo. We redirect rather than throw so a legitimate
 * no-workspace run (e.g. git-disabled benchmarks) still proceeds — the warning
 * surfaces the missing-workspace bug without breaking the run.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

let scratchDir: string | null = null;

/** Isolated, writable scratch dir OUTSIDE the KageOps source tree. Created once. */
export function subprocessScratchDir(): string {
    if (scratchDir === null) {
        const dir = path.join(os.tmpdir(), 'kageops-cli-scratch');
        fs.mkdirSync(dir, { recursive: true });
        scratchDir = dir;
    }
    return scratchDir;
}

export interface SafeCwd {
    /** Always a real, writable directory — never the parent process cwd. */
    readonly cwd: string;
    /** True when the caller passed no cwd and we fell back to scratch. */
    readonly redirected: boolean;
}

/**
 * Resolve a safe cwd for a file-writing CLI subprocess. A non-empty caller cwd
 * is honoured verbatim; anything else redirects to the scratch dir. The return
 * `cwd` is always defined, so the spawn never inherits `process.cwd()`.
 */
export function safeSubprocessCwd(callerCwd: string | undefined): SafeCwd {
    if (callerCwd !== undefined && callerCwd.trim() !== '') {
        return { cwd: callerCwd, redirected: false };
    }
    return { cwd: subprocessScratchDir(), redirected: true };
}

/** Test seam — reset the memoized scratch dir. */
export function _resetSubprocessScratchForTests(): void {
    scratchDir = null;
}
