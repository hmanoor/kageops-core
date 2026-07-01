/**
 * P2.3-02 — Drizzle migration step for the Vercel deploy path.
 *
 * Surfaced by the FleetPulse smoke (2026-05-31): Forge wrote
 * `drizzle/0001_create_assets_positions.sql` to the workspace, but
 * `Aegis.deployPreview` invoked `vercel deploy` without ever pushing
 * the schema to the live Neon DB. The deployed `/dashboard` then 500'd
 * on first SELECT because the `assets`/`positions` tables didn't exist.
 *
 * Fix shape: BEFORE invoking the deployer, detect whether the workspace
 * intends to run a migration step (drizzle sql files OR a `db:push`
 * script in `package.json`), and if so run `npx drizzle-kit push`
 * against the `DATABASE_URL` from the deployment_config. If the migrator
 * fails, the deploy is aborted — there's no point pushing a build to
 * Vercel that will crash on first request.
 *
 * Pure-ish module: `runDrizzlePush()` accepts the spawn function so
 * tests can drive deterministic outputs without invoking the real CLI;
 * `detectMigrationIntent()` accepts file-existence + read-file callbacks
 * so tests don't touch the disk.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';

import { createLogger } from '../shared/logger';

const log = createLogger('DrizzleMigrator');

// ── Detection ──────────────────────────────────────────

export type MigrationIntent =
    /** Workspace ships a drizzle `*.sql` migration file. */
    | { readonly kind: 'sql-files'; readonly directory: string; readonly count: number }
    /** package.json has a `db:push` script (e.g. nextjs-saas bundle). */
    | { readonly kind: 'db-push-script'; readonly script: string }
    /** No migration step detected — Aegis should skip. */
    | { readonly kind: 'none' };

export interface DetectMigrationDeps {
    readonly readdir: (dirPath: string) => Promise<readonly string[]>;
    readonly readFile: (filePath: string) => Promise<string>;
}

/**
 * Look for either:
 *   - a `drizzle/` directory containing one or more `*.sql` files, OR
 *   - a `db:push` script entry in `<cwd>/package.json`.
 *
 * `db:push` takes precedence — when both exist, we trust the script
 * because it's the explicit operator-facing contract.
 *
 * Returns `kind: 'none'` when neither is present. Errors (missing
 * package.json, malformed JSON, etc.) are swallowed and downgraded to
 * `none` so a missing-config workspace doesn't break the deploy path.
 */
export async function detectMigrationIntent(
    cwd: string,
    deps?: Partial<DetectMigrationDeps>
): Promise<MigrationIntent> {
    const readdir = deps?.readdir ?? (async (p) => (await fs.readdir(p)) as readonly string[]);
    const readFile = deps?.readFile ?? ((p) => fs.readFile(p, 'utf8'));

    const pkgScript = await readDbPushScript(path.join(cwd, 'package.json'), readFile);
    if (pkgScript !== null) {
        return { kind: 'db-push-script', script: pkgScript };
    }

    const drizzleDir = path.join(cwd, 'drizzle');
    try {
        const entries = await readdir(drizzleDir);
        const sqlFiles = entries.filter((name) => name.toLowerCase().endsWith('.sql'));
        if (sqlFiles.length > 0) {
            return { kind: 'sql-files', directory: drizzleDir, count: sqlFiles.length };
        }
    } catch {
        // ENOENT or unreadable — no drizzle dir, that's fine.
    }

    return { kind: 'none' };
}

async function readDbPushScript(
    pkgPath: string,
    readFile: (filePath: string) => Promise<string>
): Promise<string | null> {
    try {
        const raw = await readFile(pkgPath);
        const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
        const script = parsed.scripts?.['db:push'];
        if (typeof script === 'string' && script.length > 0) {
            return script;
        }
    } catch {
        // Missing or malformed — defer to drizzle-dir detection.
    }
    return null;
}

// ── Push ───────────────────────────────────────────────

export interface DrizzlePushInput {
    /** Workspace root that contains `drizzle.config.ts` (or `.js`). */
    readonly cwd: string;
    /** The live Postgres connection string the schema is pushed against. */
    readonly databaseUrl: string;
    /**
     * Extra env vars to forward (e.g. tokens for the drizzle config to
     * read). The base env always includes `process.env` plus the
     * required `DATABASE_URL`.
     */
    readonly extraEnv?: Readonly<Record<string, string>>;
}

export interface DrizzlePushResult {
    readonly status: 'pushed' | 'failure';
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
    readonly durationMs: number;
}

export type SpawnFn = (
    command: string,
    args: readonly string[],
    options: SpawnOptions
) => ChildProcessWithoutNullStreams;

/**
 * Spawn `npx --yes drizzle-kit push` with `DATABASE_URL` pre-set in the
 * environment. We always pass `--yes` so npx doesn't hang on an
 * interactive prompt in CI/headless; the `drizzle-kit` binary is
 * resolved from the workspace's local node_modules first.
 *
 * Args are a closed set chosen by this module — no operator input is
 * concatenated into a command string, so shell injection is not a risk.
 * The `DATABASE_URL` value is passed via the child's environment, NOT
 * as a CLI arg, so it never appears in process listings.
 */
export async function runDrizzlePush(
    input: DrizzlePushInput,
    spawnFn: SpawnFn
): Promise<DrizzlePushResult> {
    if (input.databaseUrl.length === 0) {
        throw new Error('drizzle push: DATABASE_URL is empty — refusing to spawn');
    }
    if (/[\r\n]/.test(input.databaseUrl)) {
        throw new Error('drizzle push: DATABASE_URL contains a newline — refusing to spawn');
    }

    const isWindows = process.platform === 'win32';
    const command = isWindows ? 'npx.cmd' : 'npx';
    const args: readonly string[] = ['--yes', 'drizzle-kit', 'push'];

    const childEnv: Record<string, string> = {
        ...inheritStringEnv(process.env),
        ...(input.extraEnv !== undefined ? toStringEnv(input.extraEnv) : {}),
        DATABASE_URL: input.databaseUrl,
    };

    return new Promise((resolve) => {
        const startTime = Date.now();
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];

        const child = spawnFn(command, args, {
            cwd: input.cwd,
            env: childEnv,
            shell: isWindows,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        child.stdout.on('data', (chunk: Buffer) => {
            stdoutChunks.push(chunk.toString());
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
        });

        child.on('close', (code: number | null) => {
            const stdout = stdoutChunks.join('');
            const stderr = stderrChunks.join('');
            const status: 'pushed' | 'failure' = code === 0 ? 'pushed' : 'failure';
            resolve({
                status,
                stdout,
                stderr,
                exitCode: code,
                durationMs: Date.now() - startTime,
            });
        });

        child.on('error', (err: Error) => {
            log.warn({ err: err.message }, 'spawn error for drizzle-kit push');
            resolve({
                status: 'failure',
                stdout: stdoutChunks.join(''),
                stderr: err.message,
                exitCode: null,
                durationMs: Date.now() - startTime,
            });
        });
    });
}

// ── Helpers ────────────────────────────────────────────

function inheritStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string') out[key] = value;
    }
    return out;
}

function toStringEnv(env: Readonly<Record<string, string>>): Record<string, string> {
    return { ...env };
}
