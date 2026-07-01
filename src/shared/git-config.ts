/**
 * KageOps Git Integration Toggle
 *
 * KageOps does git work for two reasons:
 *   1. Per-task branches + merge-into-main give every agent's output
 *      a clean, reviewable commit trail.
 *   2. The acceptance + build verification gates expect a workspace
 *      that's a git repo (the BuildVerificationGate runs `git status`
 *      to detect uncommitted work).
 *
 * Both are valuable in production. Both are pure overhead during
 * benchmark runs and quick tests, where the only output we care about
 * is the produced files on disk.
 *
 * Setting `KAGEOPS_DISABLE_GIT=1` short-circuits every git operation
 * to a no-op log line. The orchestration pipeline still runs
 * end-to-end; it just doesn't touch git.
 *
 * Reasonable defaults:
 *   - Production / `npm run dev` Electron path:  KAGEOPS_DISABLE_GIT unset (git ON)
 *   - Benchmark runs:                            KAGEOPS_DISABLE_GIT=1
 *   - Headless CI:                               KAGEOPS_DISABLE_GIT=1
 *   - Unit / integration tests:                  KAGEOPS_DISABLE_GIT=1
 */

/**
 * True when git operations should run normally. False when the user
 * has opted out via `KAGEOPS_DISABLE_GIT=1` (or the value is `true`,
 * `yes`, or `on`).
 */
export function isGitEnabled(): boolean {
    const raw = process.env['KAGEOPS_DISABLE_GIT'];
    if (raw === undefined || raw === '') return true;
    const normalised = raw.trim().toLowerCase();
    return !(normalised === '1' || normalised === 'true' || normalised === 'yes' || normalised === 'on');
}

/** Inverse of isGitEnabled(), for readability at call sites. */
export function isGitDisabled(): boolean {
    return !isGitEnabled();
}
