/**
 * KageOps Embedded Postgres Adapter (PGlite)
 *
 * Wraps `@electric-sql/pglite` behind `pg.Pool` / `pg.Client` -shaped facades
 * so the rest of the codebase can use embedded Postgres without any call-site
 * changes. One shared PGlite instance per process (PGlite uses a single
 * exclusive WASM connection — multiple facades multiplex over it).
 *
 * Mode selection happens in `client.ts`:
 *   - DATABASE_URL unset OR KAGEOPS_DB_MODE=embedded → use this adapter
 *   - DATABASE_URL set (postgres://...)              → use real pg.Pool
 */

import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '../shared/logger';

const log = createLogger('EmbeddedPG');

// ── Shared PGlite singleton ──────────────────────────

let _pglite: PGliteInterface | null = null;
let _bootPromise: Promise<PGliteInterface> | null = null;
let _dataDir: string | null = null;

/**
 * F-349: snapshot of everything we observed during the most-recent boot
 * attempt — used by initDatabase to produce an actionable error message
 * when PGlite throws Aborted() for a reason that isn't a lock conflict.
 * Populated even on success so test harnesses can verify cleanup ran.
 */
interface BootDiagnostics {
    pidFileExistedAtStart: boolean;
    pidFileFirstLine: string | null;
    cleanedStaleLock: boolean;
    cleanedStaleLockReason: string | null;
    pgVersion: string | null;
    capturedStderr: string[];
    capturedStdout: string[];
}

let _lastDiagnostics: BootDiagnostics | null = null;

export function getLastEmbeddedDiagnostics(): BootDiagnostics | null {
    return _lastDiagnostics;
}

/**
 * Resolve the PGlite data directory.
 * Defaults to `<KAGEOPS_DATA_DIR>/pgdata` (persistent across restarts).
 * Falls back to `:memory:` when KAGEOPS_DB_EMBEDDED_MEMORY=1 (tests).
 */
export function resolveEmbeddedDataDir(): string {
    if (process.env['KAGEOPS_DB_EMBEDDED_MEMORY'] === '1') {
        return 'memory://';
    }
    const base = process.env['KAGEOPS_DATA_DIR'] ?? path.join(os.homedir(), '.kageops');
    return path.join(base, 'pgdata');
}

/**
 * Get or lazily boot the shared PGlite instance.
 * Safe to call concurrently — deduped via `_bootPromise`.
 */
export async function getEmbeddedDb(): Promise<PGliteInterface> {
    if (_pglite !== null) {
        return _pglite;
    }
    if (_bootPromise !== null) {
        return _bootPromise;
    }
    const dataDir = resolveEmbeddedDataDir();
    _dataDir = dataDir;
    log.info({ dataDir }, 'Booting embedded Postgres (PGlite)...');

    // F-349: fresh diagnostics for this boot attempt
    const diag: BootDiagnostics = {
        pidFileExistedAtStart: false,
        pidFileFirstLine: null,
        cleanedStaleLock: false,
        cleanedStaleLockReason: null,
        pgVersion: null,
        capturedStderr: [],
        capturedStdout: [],
    };
    _lastDiagnostics = diag;

    // PG_VERSION marker tells us whether this is a fresh dir or an existing
    // one (and which PG major created it — load-bearing for version-skew
    // diagnosis).
    try {
        const pgVersionPath = path.join(dataDir, 'PG_VERSION');
        if (fs.existsSync(pgVersionPath)) {
            diag.pgVersion = fs.readFileSync(pgVersionPath, 'utf8').trim();
        }
    } catch { /* ignore */ }

    // F-348: clean up stale postmaster.pid before opening. PGlite's
    // Emscripten layer reads the lock file but does NOT check whether the
    // recorded PID is alive — if a previous KageOps run was force-killed
    // (Task Manager, Windows reboot, Electron crash) the lock survives and
    // every subsequent launch fails with the same cryptic Aborted() error.
    try {
        cleanupStalePostmasterLock(dataDir, diag);
    } catch (cleanupErr) {
        log.warn(
            { err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) },
            'Stale-lock cleanup failed (continuing to PGlite open)',
        );
    }

    // F-349: capture console output during PGlite init. In a packaged
    // Electron build stdout/stderr are swallowed, so any Emscripten
    // abort message that would normally appear on the console disappears.
    // Wrapping console.log / console.error during the (brief) boot window
    // gives us the actual cause when PGlite fails with `Aborted()`.
    const origLog = console.log.bind(console);
    const origErr = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    const cap = (sink: 'out' | 'err') => (...args: unknown[]) => {
        try {
            const line = args.map((a) => typeof a === 'string' ? a : String(a)).join(' ');
            if (sink === 'err') diag.capturedStderr.push(line);
            else diag.capturedStdout.push(line);
        } catch { /* swallow */ }
        if (sink === 'err') origErr(...args); else origLog(...args);
    };
    console.log = cap('out');
    console.error = cap('err');
    console.warn = cap('err');

    // PGlite's internal mkdir is non-recursive and fails with ENOENT when
    // the parent directory does not exist. The ~/.kageops/ default has
    // always existed (it's the first thing the installer / settings-store
    // touches) but any custom KAGEOPS_DATA_DIR path that drills more than
    // one level deep (e.g. ~/.kageops-overnight/run-1-donedeck-cli/pgdata)
    // hits this — the runner died in 1.5s on every overnight launch
    // because the parent run-1-donedeck-cli/ wasn't pre-created.
    // Pre-create the data dir recursively so PGlite's own mkdir is a no-op
    // when it gets there.
    try {
        fs.mkdirSync(dataDir, { recursive: true });
    } catch (mkdirErr) {
        log.warn(
            { err: mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr), dataDir },
            'Pre-creating PGlite data dir failed (continuing — PGlite may handle it)',
        );
    }

    const t0 = Date.now();
    _bootPromise = (async () => {
        try {
            const db = new PGlite(dataDir, { extensions: { vector }, debug: 1 });
            await db.waitReady;
            _pglite = db;
            log.info({ bootMs: Date.now() - t0 }, 'Embedded Postgres ready.');
            return db;
        } catch (err) {
            const raw = err instanceof Error ? err.message : String(err);

            // F-345 + F-349: distinguish a *real* lock conflict (live PID
            // holding the file) from a generic Emscripten Aborted() that
            // happens to leave a stale lock behind. Until v0.1.17 we
            // mislabelled every Aborted() as a lock conflict, which sent
            // users on a wild-goose chase for "another KageOps process"
            // that didn't exist.
            const matchesAbortRegex =
                /Aborted|unreachable|SQLITE_BUSY|EBUSY|EACCES|locked|already in use/i.test(raw);
            const isGenuineLockConflict =
                matchesAbortRegex && diag.pidFileExistedAtStart && !diag.cleanedStaleLock;

            if (isGenuineLockConflict) {
                throw new Error(
                    `PGlite could not open data dir at "${dataDir}". ` +
                    `Another process is holding the lock (postmaster.pid points at a live PID). ` +
                    `Close the other KageOps instance, OR set KAGEOPS_DATA_DIR to a different ` +
                    `directory before launching. Original error: ${raw}`,
                );
            }

            if (matchesAbortRegex) {
                // PGlite aborted for a non-lock reason (likely pgdata
                // corruption from a previous crash, or vector extension
                // load failure). The captured emscripten output usually
                // pinpoints which.
                const tail = diag.capturedStderr.slice(-12).join(' | ');
                throw new Error(
                    `PGlite aborted while opening "${dataDir}" — this is NOT a lock conflict. ` +
                    `Most likely the data directory is corrupted from an earlier crash. ` +
                    `To recover: stop KageOps, rename "${dataDir}" to "${dataDir}.bak", ` +
                    `then restart — PGlite will rebuild a fresh data dir. ` +
                    `Your project files outside pgdata are unaffected. ` +
                    `Emscripten stderr tail: ${tail || '(empty)'} | Original error: ${raw}`,
                );
            }
            throw err;
        } finally {
            console.log = origLog;
            console.error = origErr;
            console.warn = origWarn;
        }
    })();
    return _bootPromise;
}

/**
 * F-348: detect and remove a stale `postmaster.pid` lock file.
 *
 * PGlite stores the lock at `<dataDir>/postmaster.pid`. The first line is
 * the owning PID. We check whether that PID is alive; if not, we delete
 * the file. If the PID *is* alive we leave the lock alone so the friendly
 * F-345 lock-conflict error fires.
 *
 * Conservative: any parse failure, fs error, or ambiguity → leave the
 * file in place. Worst case we keep the v0.1.16 behaviour (cryptic
 * Aborted() with friendly wrapper). Best case we self-heal after a
 * crash.
 */
function cleanupStalePostmasterLock(dataDir: string, diag: BootDiagnostics): void {
    const pidFile = path.join(dataDir, 'postmaster.pid');
    if (!fs.existsSync(pidFile)) return;

    diag.pidFileExistedAtStart = true;

    let raw: string;
    try {
        raw = fs.readFileSync(pidFile, 'utf8');
    } catch {
        return; // can't read → leave alone
    }

    const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? '';
    diag.pidFileFirstLine = firstLine;
    const pid = Number.parseInt(firstLine, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
        // Unparseable or sentinel like "-42" — PGlite writes negative
        // values when no real PID is available. These are never alive,
        // so the lock is by definition stale.
        log.info({ pidFile, firstLine }, 'Removing postmaster.pid with non-positive PID');
        try {
            fs.unlinkSync(pidFile);
            diag.cleanedStaleLock = true;
            diag.cleanedStaleLockReason = `non-positive PID (${firstLine})`;
        } catch { /* ignore */ }
        return;
    }

    if (isProcessAlive(pid)) {
        log.debug({ pid, pidFile }, 'postmaster.pid points at a live process — leaving lock in place');
        return;
    }

    log.info({ staleP: pid, pidFile }, 'Removing stale postmaster.pid (owning process is gone)');
    try {
        fs.unlinkSync(pidFile);
        diag.cleanedStaleLock = true;
        diag.cleanedStaleLockReason = `dead PID ${pid}`;
    } catch (err) {
        log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Failed to remove stale postmaster.pid — PGlite open will likely fail',
        );
    }
}

/**
 * Cross-platform liveness probe. `process.kill(pid, 0)` doesn't kill —
 * it just checks whether the OS would deliver a signal. Throws ESRCH if
 * the process doesn't exist, EPERM if it exists but we don't have
 * permission (in which case the process *is* alive). Anything else is
 * treated as "alive" out of caution.
 */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return false;
        if (code === 'EPERM') return true; // exists, just not ours to signal
        return true;
    }
}

/** Test helper: reset the singleton so a fresh instance boots on next call. */
export function resetEmbeddedDbForTests(): void {
    _pglite = null;
    _bootPromise = null;
    _dataDir = null;
}

export async function closeEmbedded(): Promise<void> {
    if (_pglite !== null) {
        try {
            await _pglite.close();
        } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Close failed (ignoring).');
        }
        _pglite = null;
        _bootPromise = null;
        _dataDir = null;
    }
}

// ── Mode detection ───────────────────────────────────

/**
 * Should the app use embedded PGlite instead of external Postgres?
 *
 * Precedence:
 *   1. `KAGEOPS_DB_MODE=embedded|external` — explicit override
 *   2. `DATABASE_URL` set and non-empty → external
 *   3. Otherwise → embedded (zero-Docker default)
 */
export function isEmbeddedMode(databaseUrlOverride?: string): boolean {
    const modeEnv = (process.env['KAGEOPS_DB_MODE'] ?? '').toLowerCase();
    if (modeEnv === 'embedded') return true;
    if (modeEnv === 'external') return false;

    const url = databaseUrlOverride ?? process.env['DATABASE_URL'] ?? '';
    return url.trim() === '';
}

// ── Shared query result shape (matches pg.QueryResult subset) ──

interface EmbeddedQueryResult<T = unknown> {
    readonly rows: T[];
    readonly rowCount: number;
    readonly command?: string;
}

async function runQuery<T = unknown>(sql: string, params: unknown[] = []): Promise<EmbeddedQueryResult<T>> {
    const db = await getEmbeddedDb();
    const result = await db.query<T>(sql, params as unknown[]);
    return {
        rows: result.rows as T[],
        rowCount: (result.rows as unknown[]).length,
        command: (result as { command?: string }).command,
    };
}

async function runExec(sql: string): Promise<void> {
    const db = await getEmbeddedDb();
    await db.exec(sql);
}

// ── EmbeddedPool (mimics pg.Pool subset) ─────────────

/**
 * Pool facade for embedded mode. PGlite has no real connection pool
 * (single WASM connection, internally serialized), so this just forwards.
 */
export class EmbeddedPool extends EventEmitter {
    private _ended = false;

    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<EmbeddedQueryResult<T>> {
        if (this._ended) {
            throw new Error('[EmbeddedPool] Pool has been ended.');
        }
        // Multi-statement SQL (schema loads, seed files) must use exec(),
        // since query() only supports a single statement.
        if (isMultiStatementSql(sql)) {
            await runExec(sql);
            return { rows: [], rowCount: 0 };
        }
        return runQuery<T>(sql, params);
    }

    async end(): Promise<void> {
        this._ended = true;
        // Do NOT close the shared PGlite instance here — other facades
        // (e.g. EmbeddedClient inside EventBus) may still hold it.
        // Process shutdown calls `closeEmbedded()` directly.
    }
}

/**
 * Heuristic: does this SQL contain multiple top-level statements?
 * PGlite's query() rejects multi-statement SQL; exec() accepts it.
 * We check for a semicolon followed by non-whitespace *inside* the string,
 * ignoring a trailing terminator.
 */
function isMultiStatementSql(sql: string): boolean {
    const stripped = stripSqlComments(sql).trim().replace(/;\s*$/, '');
    // Cheap check — if there's a semicolon outside string literals, assume multi.
    let inSingle = false;
    let inDouble = false;
    let inDollar = false;
    let dollarTag = '';
    for (let i = 0; i < stripped.length; i++) {
        const c = stripped[i];
        if (!inDouble && !inDollar && c === "'") inSingle = !inSingle;
        else if (!inSingle && !inDollar && c === '"') inDouble = !inDouble;
        else if (!inSingle && !inDouble && c === '$') {
            // Detect $tag$ or $$
            const endTag = stripped.indexOf('$', i + 1);
            if (endTag !== -1 && endTag - i < 32) {
                const tag = stripped.slice(i, endTag + 1);
                if (!inDollar) {
                    inDollar = true;
                    dollarTag = tag;
                    i = endTag;
                } else if (tag === dollarTag) {
                    inDollar = false;
                    dollarTag = '';
                    i = endTag;
                }
            }
        } else if (!inSingle && !inDouble && !inDollar && c === ';') {
            return true;
        }
    }
    return false;
}

function stripSqlComments(sql: string): string {
    // Remove -- line comments and /* block */ comments (not string-aware, but fine for schema.sql).
    return sql
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}

// ── EmbeddedClient (mimics pg.Client subset for LISTEN/NOTIFY) ──

/**
 * Client facade. In external mode, event-bus uses a dedicated pg.Client
 * so LISTEN blocks don't tie up pool connections. In embedded mode there
 * are no pool connections — PGlite's `.listen()` is just a callback
 * registration. We intercept LISTEN/UNLISTEN SQL and translate.
 */
export class EmbeddedClient extends EventEmitter {
    private _connected = false;
    private _ended = false;
    private readonly _unsubs = new Map<string, () => Promise<void>>();

    async connect(): Promise<void> {
        await getEmbeddedDb();
        this._connected = true;
    }

    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<EmbeddedQueryResult<T>> {
        if (this._ended) {
            throw new Error('[EmbeddedClient] Client has been ended.');
        }
        if (!this._connected) {
            await this.connect();
        }

        const listenMatch = sql.match(/^\s*LISTEN\s+"?([A-Za-z0-9_]+)"?\s*;?\s*$/i);
        if (listenMatch !== null) {
            const channel = listenMatch[1];
            if (!this._unsubs.has(channel)) {
                const db = await getEmbeddedDb();
                const unsub = await db.listen(channel, (payload: string) => {
                    // pg emits notifications as { channel, payload } — mirror that shape.
                    this.emit('notification', { channel, payload });
                });
                this._unsubs.set(channel, unsub as unknown as () => Promise<void>);
            }
            return { rows: [] as T[], rowCount: 0 };
        }

        const unlistenMatch = sql.match(/^\s*UNLISTEN\s+"?([A-Za-z0-9_*]+)"?\s*;?\s*$/i);
        if (unlistenMatch !== null) {
            const channel = unlistenMatch[1];
            if (channel === '*') {
                for (const [, unsub] of this._unsubs) {
                    await unsub();
                }
                this._unsubs.clear();
            } else {
                const unsub = this._unsubs.get(channel);
                if (unsub !== undefined) {
                    await unsub();
                    this._unsubs.delete(channel);
                }
            }
            return { rows: [] as T[], rowCount: 0 };
        }

        return runQuery<T>(sql, params);
    }

    async end(): Promise<void> {
        this._ended = true;
        for (const [, unsub] of this._unsubs) {
            try {
                await unsub();
            } catch {
                // ignore — instance may already be closed
            }
        }
        this._unsubs.clear();
        // Do NOT close the shared PGlite instance — see EmbeddedPool.end() note.
    }
}
