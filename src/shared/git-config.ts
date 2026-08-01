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

// ── Committer identity for machine-authored commits ──────────────────
//
// Reported by an outside reviewer (2026-07-30): identity handling was
// inconsistent. Two paths passed an explicit `-c user.*` pair; the
// workspace scaffold and template-cloner paths did not, and inherited
// whatever the developer had configured globally. That produced two
// distinct failures:
//
//   1. Provenance — agent-authored commits were attributed to the human
//      operator with nothing marking them as machine-generated.
//   2. A first-run blocker — on a machine with no global user.email /
//      user.name (fresh container, CI image, a developer who has never
//      configured git), those commits fail outright with "Please tell me
//      who you are". The reviewer hit exactly this: some of the tests
//      "didn't run correctly locally because of the git settings".
//
// Every commit path now goes through `gitIdentityArgs()`, so identity is
// explicit at the invocation and never depends on ambient global config.

/** Default identity for commits KageOps makes on the operator's behalf. */
export const DEFAULT_GIT_IDENTITY = {
    name: 'KageOps',
    email: 'kageops@local',
} as const;

/** Distinct identities per actor, so a commit trail says who made it. */
const ACTOR_IDENTITIES: Readonly<Record<string, { name: string; email: string }>> = {
    burst: { name: 'KageOps Burst', email: 'kageops-burst@local' },
};

/**
 * `-c` flags that pin the committer identity for a single git invocation.
 * Prepend to the args of any git command that creates a commit:
 *
 *     runGit(dir, [...gitIdentityArgs(), 'commit', '-m', 'msg'])
 *
 * Using `-c` rather than `git config` keeps it scoped to the one command
 * — we never write into the user's repo or global config.
 *
 * Override with KAGEOPS_GIT_AUTHOR_NAME / KAGEOPS_GIT_AUTHOR_EMAIL when
 * you want the trail attributed differently (e.g. a service account).
 */
export function gitIdentityArgs(actor?: string): readonly string[] {
    const preset = actor !== undefined ? ACTOR_IDENTITIES[actor] : undefined;
    const base = preset ?? DEFAULT_GIT_IDENTITY;

    const envName = (process.env['KAGEOPS_GIT_AUTHOR_NAME'] ?? '').trim();
    const envEmail = (process.env['KAGEOPS_GIT_AUTHOR_EMAIL'] ?? '').trim();

    const name = envName !== '' ? envName : base.name;
    const email = envEmail !== '' ? envEmail : base.email;

    return ['-c', `user.email=${email}`, '-c', `user.name=${name}`];
}
