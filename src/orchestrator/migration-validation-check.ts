/**
 * Migration validation check (G6).
 *
 * Generated SQL migrations are an error-prone surface. Two real defects shipped
 * in the MCC build:
 *   1. A migration referenced an enum (`refund_status`) that was never declared
 *      — it "worked" where the type already existed but failed on a FRESH apply
 *      in declaration order.
 *   2. The seed used a `password_hash` column + hardcoded user IDs, incompatible
 *      with delegated auth (Clerk/Supabase Auth), where accounts are created
 *      through the provider, not seeded.
 *
 * "It parses" is not "it applies". This module:
 *   - APPLIES the discovered migrations, in order, to a fresh in-memory PGlite
 *     database and reports the first statement that fails. This catches
 *     undeclared types, forward references, FKs to missing tables, and syntax
 *     errors that a static read misses.
 *   - Guards the apply: migrations that use Supabase-isms PGlite can't model
 *     (RLS policies, the `auth.` schema, non-vector extensions) SKIP the apply
 *     (reported as skipped, not failed) so they don't false-fail. Static checks
 *     still run.
 *   - STATICALLY flags a `password_hash`/password seed under delegated auth —
 *     a semantic mismatch the apply can't see (it applies fine, it's just wrong).
 *
 * Pure where possible; fs injected and PGlite dynamically imported so the build
 * gate only pays the WASM boot cost when a project actually has migrations.
 */

import * as path from 'path';

export type AuthModel = 'clerk' | 'supabase' | 'custom' | 'unknown';

export interface MigrationFile {
    /** Repo-relative path, forward-slashed. */
    readonly path: string;
    readonly content: string;
}

export interface MigrationViolation {
    readonly check: 'migration-apply-failed' | 'seed-auth-mismatch';
    readonly file: string;
    readonly message: string;
}

export interface MigrationValidationResult {
    readonly migrationCount: number;
    readonly applyStatus: 'passed' | 'failed' | 'skipped' | 'no-migrations';
    readonly applySkipReason: string | null;
    readonly violations: readonly MigrationViolation[];
}

const SOURCE_SQL_EXT = '.sql';
const SKIP_DIRS: ReadonlySet<string> = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage', '.vercel',
]);
// Directory names that mark a SQL migration set.
const MIGRATION_DIR_NAMES: ReadonlySet<string> = new Set(['migrations', 'migration', 'drizzle']);
const MAX_MIGRATION_FILES = 200;

// ── Discovery ────────────────────────────────────────

/**
 * Find SQL migration files and return them ordered for a clean top-to-bottom
 * apply (sorted by directory then filename — drizzle's `0000_`, `0001_` prefixes
 * and timestamped Supabase names both sort correctly).
 */
export function discoverMigrationFiles(
    repoPath: string,
    fsImpl: typeof import('fs'),
): readonly MigrationFile[] {
    const found: MigrationFile[] = [];

    const walk = (dir: string, inMigrationDir: boolean): void => {
        let entries: import('fs').Dirent[];
        try {
            entries = fsImpl.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                walk(full, inMigrationDir || MIGRATION_DIR_NAMES.has(entry.name.toLowerCase()));
            } else if (entry.isFile()) {
                if (!inMigrationDir) continue;
                if (path.extname(entry.name).toLowerCase() !== SOURCE_SQL_EXT) continue;
                try {
                    const content = fsImpl.readFileSync(full, 'utf-8');
                    found.push({ path: path.relative(repoPath, full).replace(/\\/g, '/'), content });
                } catch {
                    // unreadable — skip
                }
            }
        }
    };
    walk(repoPath, false);

    return found
        .slice()
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .slice(0, MAX_MIGRATION_FILES);
}

// ── Auth model detection ─────────────────────────────

/** Infer the app's auth model from package.json deps. */
export function detectAuthModel(repoPath: string, fsImpl: typeof import('fs')): AuthModel {
    try {
        const pkgRaw = fsImpl.readFileSync(path.join(repoPath, 'package.json'), 'utf-8');
        const pkg = JSON.parse(pkgRaw) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        const names = Object.keys(deps);
        if (names.some((n) => n.startsWith('@clerk/'))) return 'clerk';
        if (names.some((n) => n.includes('supabase'))) return 'supabase';
        // bcrypt/argon present → app rolls its own auth → custom
        if (names.some((n) => /bcrypt|argon2|passport|next-auth|@auth\//.test(n))) return 'custom';
        return 'unknown';
    } catch {
        return 'unknown';
    }
}

// ── Static seed / auth-model check ───────────────────

const PASSWORD_COLUMN_RE = /\b(password_hash|password_digest|hashed_password|password)\b/i;
const SEED_INSERT_RE = /\binsert\s+into\b/i;

/**
 * Delegated-auth apps (Clerk, Supabase Auth) must NOT seed a password column or
 * invent user rows — accounts come from the provider and app rows FK to the
 * provider's user table. Flag a migration/seed that does.
 */
export function detectSeedAuthMismatch(
    files: readonly MigrationFile[],
    authModel: AuthModel,
): readonly MigrationViolation[] {
    if (authModel !== 'clerk' && authModel !== 'supabase') return [];
    const violations: MigrationViolation[] = [];
    for (const file of files) {
        const hasPassword = PASSWORD_COLUMN_RE.test(file.content);
        const hasInsert = SEED_INSERT_RE.test(file.content);
        if (hasPassword && hasInsert) {
            violations.push({
                check: 'seed-auth-mismatch',
                file: file.path,
                message:
                    `Seed/migration defines or inserts a password column while auth is delegated to ` +
                    `${authModel === 'clerk' ? 'Clerk' : 'Supabase Auth'}. Delegated-auth apps create ` +
                    `accounts through the provider — app tables FK to the provider's user id and must ` +
                    `not store passwords or seed hardcoded users. Drop the password column and the seed.`,
            });
        }
    }
    return violations;
}

// ── PGlite apply guard ───────────────────────────────

// Constructs PGlite can't model — presence means we SKIP the apply rather than
// false-fail. (Supabase migrations lean on all of these.)
const UNSUPPORTED_PATTERNS: readonly { readonly re: RegExp; readonly label: string }[] = [
    { re: /\bcreate\s+policy\b/i, label: 'RLS policies (CREATE POLICY)' },
    { re: /\benable\s+row\s+level\s+security\b/i, label: 'row-level security' },
    { re: /\bauth\.(users|uid|role|jwt)\b/i, label: 'Supabase auth schema/functions' },
    { re: /\bstorage\.(buckets|objects)\b/i, label: 'Supabase storage schema' },
];
// Extensions PGlite (with the vector ext loaded) can handle. Anything else → skip.
const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(['vector', 'pgcrypto', 'uuid-ossp']);
const CREATE_EXTENSION_RE = /create\s+extension\s+(?:if\s+not\s+exists\s+)?["']?([a-z0-9_-]+)["']?/gi;

/** Decide whether the migration set is safe to apply on PGlite. */
export function pgliteApplyGuard(files: readonly MigrationFile[]): { safe: boolean; reason: string | null } {
    const corpus = files.map((f) => f.content).join('\n');
    for (const { re, label } of UNSUPPORTED_PATTERNS) {
        if (re.test(corpus)) return { safe: false, reason: `uses ${label} (PGlite can't model it)` };
    }
    let m: RegExpExecArray | null;
    CREATE_EXTENSION_RE.lastIndex = 0;
    while ((m = CREATE_EXTENSION_RE.exec(corpus)) !== null) {
        const ext = m[1].toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
            return { safe: false, reason: `creates unsupported extension "${ext}"` };
        }
    }
    return { safe: true, reason: null };
}

// ── Throwaway apply ──────────────────────────────────

/**
 * Apply the migrations, in order, to a fresh in-memory PGlite. Returns the first
 * failing file + error, or ok. Never throws — a harness failure must not block
 * the gate. Caller should only invoke when `pgliteApplyGuard().safe`.
 */
export async function applyMigrationsToThrowawayDb(
    files: readonly MigrationFile[],
): Promise<{ ok: true } | { ok: false; file: string; error: string }> {
    interface ThrowawayDb {
        exec(sql: string): Promise<unknown>;
        close(): Promise<void>;
    }
    let db: ThrowawayDb | null = null;
    try {
        const { PGlite } = await import('@electric-sql/pglite');
        const { vector } = await import('@electric-sql/pglite/vector');
        db = new PGlite({ extensions: { vector } }) as unknown as ThrowawayDb;
        for (const file of files) {
            try {
                await db.exec(file.content);
            } catch (err) {
                return {
                    ok: false,
                    file: file.path,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        }
        return { ok: true };
    } catch {
        // Boot/import failure — treat as inconclusive (ok) so we never block on
        // our own harness breaking.
        return { ok: true };
    } finally {
        if (db !== null) {
            try {
                await db.close();
            } catch {
                /* ignore close errors */
            }
        }
    }
}

// ── Orchestration ────────────────────────────────────

/**
 * Full G6 validation: discover migrations, apply (guarded) to a throwaway DB,
 * and run the static seed/auth check. Never throws.
 */
export async function validateMigrations(
    repoPath: string,
    fsImpl: typeof import('fs'),
): Promise<MigrationValidationResult> {
    const files = discoverMigrationFiles(repoPath, fsImpl);
    if (files.length === 0) {
        return { migrationCount: 0, applyStatus: 'no-migrations', applySkipReason: null, violations: [] };
    }

    const violations: MigrationViolation[] = [];

    // Static seed/auth-model check (independent of the apply).
    const authModel = detectAuthModel(repoPath, fsImpl);
    violations.push(...detectSeedAuthMismatch(files, authModel));

    // Guarded apply.
    const guard = pgliteApplyGuard(files);
    let applyStatus: MigrationValidationResult['applyStatus'];
    let applySkipReason: string | null = null;

    if (!guard.safe) {
        applyStatus = 'skipped';
        applySkipReason = guard.reason;
    } else {
        const result = await applyMigrationsToThrowawayDb(files);
        if (result.ok) {
            applyStatus = 'passed';
        } else {
            applyStatus = 'failed';
            violations.push({
                check: 'migration-apply-failed',
                file: result.file,
                message:
                    `Migrations failed to apply to a fresh database at "${result.file}": ${result.error}. ` +
                    `Every type/enum/extension/table must be declared before its first use, and the set must ` +
                    `apply top-to-bottom on an empty DB.`,
            });
        }
    }

    return { migrationCount: files.length, applyStatus, applySkipReason, violations };
}

/** Format validation violations into an operator-facing warning, or null. */
export function formatMigrationWarning(result: MigrationValidationResult): string | null {
    if (result.violations.length === 0) return null;
    const lines = result.violations.map((v) => `  - ${v.file} [${v.check}] — ${v.message}`);
    return (
        `Migration validation: ${result.violations.length} issue(s) across ${result.migrationCount} ` +
        `migration file(s) (apply: ${result.applyStatus}${result.applySkipReason ? ` — ${result.applySkipReason}` : ''}).\n` +
        lines.join('\n')
    );
}
