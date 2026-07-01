/**
 * P1-13 — Bundle host compatibility check.
 *
 * Pure module that decides whether a bundle's declared
 * `kageops_version` constraint is satisfied by the running host
 * version. Wired into the loader so incompatible bundles are skipped
 * with a clear log line, never crash.
 *
 * Conventions:
 *   - Missing `kageops_version` → permissive (every host accepts it).
 *     Matches the `types.ts` comment that calls the field optional.
 *   - Malformed semver range → bundle skipped (we surface the error
 *     in `result.errors` so the operator sees the typo).
 *   - The host version's prerelease suffix is STRIPPED before
 *     comparison (via `semver.coerce`) so a bundle saying "I work on
 *     0.2.x" matches a 0.2.0-beta.6 host. Without this, semver's
 *     default behaviour rejects every prerelease against any
 *     non-prerelease range — which would mean every bundle gets
 *     skipped on every beta build. That defeats the whole point of
 *     gating betas through the same loader as stables.
 */

import semver from 'semver';

export interface CompatCheckOk {
    readonly ok: true;
}

export interface CompatCheckSkip {
    readonly ok: false;
    readonly reason: string;
}

export type CompatCheckResult = CompatCheckOk | CompatCheckSkip;

/**
 * Check whether `constraint` (a semver range) is satisfied by
 * `hostVersion` (a semver-or-prerelease string).
 *
 * - `constraint === undefined`  → ok (permissive default).
 * - Malformed range or version  → skip with a descriptive reason.
 */
export function checkBundleCompat(
    constraint: string | undefined,
    hostVersion: string
): CompatCheckResult {
    if (constraint === undefined) {
        return { ok: true };
    }

    const coercedHost = semver.coerce(hostVersion);
    if (coercedHost === null) {
        return {
            ok: false,
            reason: `host version "${hostVersion}" is not a valid semver`,
        };
    }

    // Validate that the range parses up-front so we can give a
    // bundle-specific error rather than a generic semver throw.
    const parsedRange = semver.validRange(constraint);
    if (parsedRange === null) {
        return {
            ok: false,
            reason: `kageops_version constraint "${constraint}" is not a valid semver range`,
        };
    }

    // Compare against the coerced (prerelease-stripped) host version
    // so 0.2.0-beta.6 satisfies a range of ">=0.2.0 <0.3.0". See the
    // module-level comment for why this is the intended behaviour.
    const satisfied = semver.satisfies(coercedHost, parsedRange);
    if (!satisfied) {
        return {
            ok: false,
            reason: `bundle requires host kageops_version ${constraint}, but host is ${hostVersion}`,
        };
    }

    return { ok: true };
}
