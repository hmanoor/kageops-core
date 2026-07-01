/**
 * Stale env-var scrubber (bug #6 — v0.1.32)
 *
 * Pre-F-382 builds shipped a Windows-only hardcoded default of
 *   KAGEOPS_DATA_DIR=C:\projects\playground\kageops\projects\data
 *   KAGEOPS_PROJECTS_DIR=C:\projects\playground\kageops\projects
 *
 * F-382 (v0.1.28) moved the default to ~/.kageops on every platform but did
 * NOT migrate users who already had the legacy literal persisted to their
 * `~/.kageops/.env`. As a result, those users' apps kept booting against
 * paths their machine no longer had (PGlite ENOENT, orchestrator failed to
 * start) even though the in-app Configuration screen still showed sensible
 * defaults.
 *
 * This module detects the bad lines on every app start and comments them
 * out in place. The original value is preserved as a comment prefix so the
 * user (or a future incident) can see what was removed. We also strip the
 * matching entries from `process.env` in case some earlier loader pulled
 * them in already.
 *
 * Detection is intentionally narrow — we only touch the two
 * directory-path keys, and only when the value is a legacy literal OR
 * points at a directory that doesn't exist on disk. Any other line in the
 * .env (Google OAuth client id / secret, provider keys, custom overrides)
 * is preserved byte-for-byte.
 */

import * as fs from 'fs';
// `fs` retained for the file read/write at boot. The directory-existence
// probe was removed in v0.1.41 (#163) — see decideScrubReason.

/** The keys this scrubber will ever touch. Anything else is left alone. */
const SCRUBBABLE_KEYS = ['KAGEOPS_DATA_DIR', 'KAGEOPS_PROJECTS_DIR'] as const;
type ScrubbableKey = (typeof SCRUBBABLE_KEYS)[number];

/**
 * Legacy literal paths shipped as Windows-only defaults pre-F-382.
 * Detection is case-insensitive and matches both slash conventions so a
 * value that was edited by hand still gets caught. Substring match —
 * not exact — so `…\playground\kageops\projects\data\…` also triggers.
 */
const LEGACY_PATH_NEEDLES: readonly string[] = [
    'playground\\kageops\\projects',
    'playground/kageops/projects',
];

export interface ScrubResult {
    /** How many lines were commented out. */
    readonly scrubbed: number;
    /** Human-readable lines suitable for the bootstrap log. */
    readonly details: readonly string[];
    /** Whether the .env file existed at all. */
    readonly fileExisted: boolean;
}

/**
 * Scrub a single `.env` file in place. Idempotent — calling twice is a
 * no-op on the second call because the offending lines are already
 * commented out.
 *
 * Returns a summary so the caller can log what changed.
 */
export function scrubStaleEnvFile(envPath: string): ScrubResult {
    if (!fs.existsSync(envPath)) {
        return { scrubbed: 0, details: [], fileExisted: false };
    }

    let original: string;
    try {
        original = fs.readFileSync(envPath, 'utf-8');
    } catch {
        return { scrubbed: 0, details: ['could not read .env'], fileExisted: true };
    }

    const lines = original.split(/\r?\n/);
    const details: string[] = [];
    let changed = false;

    const out = lines.map((line) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) return line;

        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) return line;

        const key = trimmed.slice(0, eqIdx).trim();
        if (!SCRUBBABLE_KEYS.includes(key as ScrubbableKey)) return line;

        const rawValue = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        const reason = decideScrubReason(rawValue);
        if (reason === null) return line;

        changed = true;
        details.push(`${key}=${rawValue}  →  scrubbed (${reason})`);
        // Prepend the comment to the original line verbatim so quoted values,
        // surrounding whitespace, and any inline annotations are preserved
        // exactly — makes manual recovery / forensics trivial.
        return `# [scrubbed by KageOps v0.1.32 — ${reason}] ${line}`;
    });

    if (!changed) {
        return { scrubbed: 0, details: [], fileExisted: true };
    }

    try {
        fs.writeFileSync(envPath, out.join('\n'), 'utf-8');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            scrubbed: 0,
            details: [`detected ${details.length} stale entries but write failed: ${msg}`],
            fileExisted: true,
        };
    }

    // Also unset matching keys in process.env so the running process
    // doesn't keep using a bad value an earlier loader pulled in.
    for (const detail of details) {
        const k = detail.split('=')[0]!.trim();
        if (process.env[k] !== undefined && decideScrubReason(process.env[k] ?? '') !== null) {
            delete process.env[k];
        }
    }

    return { scrubbed: details.length, details, fileExisted: true };
}

/**
 * Why a given value should be scrubbed, or `null` if it should be kept.
 * Exported for tests.
 *
 * NARROWED in v0.1.41 (#163): only the legacy literal pattern and an
 * empty value will trigger a scrub. The pre-v0.1.41 implementation also
 * scrubbed values whose target directory did not exist on disk — that
 * branch was over-eager and silently wiped legitimately-saved custom
 * paths on every boot. Combined with the v0.1.41 mkdir-on-save fix in
 * the config IPC handler, this means: a user who configures a custom
 * `KAGEOPS_PROJECTS_DIR` gets the directory created at save-time, and
 * the scrubber never touches it again.
 */
export function decideScrubReason(value: string): string | null {
    if (value === '') return 'empty value';

    const lc = value.toLowerCase();
    if (LEGACY_PATH_NEEDLES.some((n) => lc.includes(n.toLowerCase()))) {
        return 'legacy default path from pre-F-382 builds';
    }

    return null;
}
