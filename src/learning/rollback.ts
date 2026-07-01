/**
 * KageOps Learning — APO Rollback (B-478)
 *
 * Consumes the `.apo-backup-<ts>.json` trail left by
 * `apply-winner.ts#applyWinner` and lets an operator restore a prior
 * preset snapshot from the Command Center UI.
 *
 * Why a dedicated module rather than reusing `applyWinner`?
 *   - Rollback overwrites the *entire* preset with the backup's contents,
 *     not just one agent's `systemPromptOverride`. That matches what the
 *     backup captured (the pre-write file verbatim) and is the only way
 *     to undo cross-agent changes applied in sequence.
 *   - Rollback is itself auditable — the pre-rollback file becomes a
 *     fresh backup named `<preset>.apo-rollback-backup-<ts>.json`, so
 *     operators can undo an errant restore.
 *
 * Guarantees:
 *   - **Atomic**: writes to a sibling temp file and renames, so a crash
 *     mid-write leaves the preset intact.
 *   - **Scope-gated**: list/restore only work on `<presetPath>` files —
 *     no directory traversal, no reading outside the preset's own dir.
 *   - **Reversible**: restoring X also snapshots the current preset to a
 *     new backup, so a mistaken rollback is one click away from undo.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '../shared/logger';

const log = createLogger('APO.Rollback');

// ── Injectable fs shape ──────────────────────────────

export interface FsLike {
    readonly existsSync: typeof fs.existsSync;
    readonly readFileSync: typeof fs.readFileSync;
    readonly writeFileSync: typeof fs.writeFileSync;
    readonly renameSync: typeof fs.renameSync;
    readonly readdirSync: typeof fs.readdirSync;
    readonly statSync: typeof fs.statSync;
}

// ── Public types ─────────────────────────────────────

export interface BackupEntry {
    /** Absolute path to the `.apo-backup-<ts>.json` file. */
    readonly backupPath: string;
    /** Absolute path of the preset the backup snapshots. */
    readonly presetPath: string;
    /** Millisecond epoch parsed from the filename (not the filesystem mtime). */
    readonly timestamp: number;
    /** ISO-8601 string for `timestamp`. UI convenience. */
    readonly createdAt: string;
    /** File size in bytes — used to surface obviously-corrupt zero-byte backups. */
    readonly size: number;
    /**
     * Agents whose `systemPromptOverride` is populated in this backup's
     * snapshot. Used by the UI to tell "scout-only" backups apart from
     * "herald + scout" multi-apply snapshots.
     */
    readonly agentsWithOverrides: readonly string[];
}

export interface ListBackupsOptions {
    readonly presetPath?: string;
    readonly fs?: FsLike;
}

export interface RestoreBackupOptions {
    /** Absolute path to the backup to restore. */
    readonly backupPath: string;
    /**
     * Absolute path to the preset being restored. Defaults to the same
     * preset-resolution precedence as `apply-winner.ts`.
     */
    readonly presetPath?: string;
    readonly fs?: FsLike;
    readonly now?: () => number;
}

export interface RestoreBackupResult {
    readonly presetPath: string;
    readonly backupPath: string;
    /**
     * Absolute path of the new backup holding the preset's state from
     * *before* this restore ran. Null if the preset file did not exist
     * (fresh restore into an empty slot).
     */
    readonly replacedBackupPath: string | null;
    /** Number of bytes written to the preset. */
    readonly bytesWritten: number;
}

// ── List ─────────────────────────────────────────────

export function listApoBackups(
    opts: ListBackupsOptions = {}
): readonly BackupEntry[] {
    const fsImpl = opts.fs ?? fs;
    const presetPath = opts.presetPath ?? resolvePresetPath();
    const dir = path.dirname(presetPath);
    const prefix = `${path.basename(presetPath)}.apo-backup-`;
    const suffix = '.json';

    if (!fsImpl.existsSync(dir)) {
        return Object.freeze([]);
    }

    const names = fsImpl.readdirSync(dir);
    const entries: BackupEntry[] = [];

    for (const name of names) {
        if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
            continue;
        }
        const tsPart = name.slice(prefix.length, name.length - suffix.length);
        const timestamp = Number(tsPart);
        if (!Number.isFinite(timestamp) || timestamp <= 0) {
            continue;
        }

        const backupPath = path.join(dir, name);
        let size = 0;
        try {
            size = fsImpl.statSync(backupPath).size;
        } catch {
            continue;
        }

        let agentsWithOverrides: string[] = [];
        try {
            const raw = fsImpl.readFileSync(backupPath, 'utf-8').toString();
            agentsWithOverrides = extractAgentsWithOverrides(raw);
        } catch {
            // Keep the entry so operators can still see the corrupt file
            // in the list and manually clean it up — but with empty agents.
            agentsWithOverrides = [];
        }

        entries.push(
            Object.freeze({
                backupPath,
                presetPath,
                timestamp,
                createdAt: new Date(timestamp).toISOString(),
                size,
                agentsWithOverrides: Object.freeze(agentsWithOverrides),
            })
        );
    }

    entries.sort((a, b) => b.timestamp - a.timestamp);
    return Object.freeze(entries);
}

// ── Restore ──────────────────────────────────────────

export function restoreApoBackup(
    opts: RestoreBackupOptions
): RestoreBackupResult {
    const fsImpl = opts.fs ?? fs;
    const now = opts.now ?? Date.now;
    const presetPath = opts.presetPath ?? resolvePresetPath();

    if (!fsImpl.existsSync(opts.backupPath)) {
        throw new Error(
            `[APO.Rollback] backup file does not exist: ${opts.backupPath}`
        );
    }

    // Scope-gate: the backup must live in the preset's directory, and its
    // name must match the expected `.apo-backup-<ts>.json` shape for the
    // target preset. Prevents a malicious caller from passing an arbitrary
    // path and tricking us into copying it over the preset.
    const expectedDir = path.dirname(presetPath);
    const backupDir = path.dirname(opts.backupPath);
    if (path.resolve(expectedDir) !== path.resolve(backupDir)) {
        throw new Error(
            `[APO.Rollback] backup "${opts.backupPath}" is not in the ` +
                `preset's directory (${expectedDir})`
        );
    }
    const expectedPrefix = `${path.basename(presetPath)}.apo-backup-`;
    if (!path.basename(opts.backupPath).startsWith(expectedPrefix)) {
        throw new Error(
            `[APO.Rollback] backup "${opts.backupPath}" is not a backup ` +
                `of preset "${presetPath}"`
        );
    }

    const backupRaw = fsImpl.readFileSync(opts.backupPath, 'utf-8').toString();
    try {
        JSON.parse(backupRaw);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
            `[APO.Rollback] backup is not valid JSON (${opts.backupPath}): ${message}`
        );
    }

    const ts = now();
    const replacedBackupPath = fsImpl.existsSync(presetPath)
        ? `${presetPath}.apo-rollback-backup-${ts}.json`
        : null;

    if (replacedBackupPath !== null) {
        const currentRaw = fsImpl.readFileSync(presetPath, 'utf-8').toString();
        fsImpl.writeFileSync(replacedBackupPath, currentRaw, 'utf-8');
    }

    const tmpPath = `${presetPath}.tmp-${process.pid}-${ts}`;
    fsImpl.writeFileSync(tmpPath, backupRaw, 'utf-8');
    fsImpl.renameSync(tmpPath, presetPath);

    log.info(
        {
            presetPath,
            backupPath: opts.backupPath,
            replacedBackupPath,
            bytesWritten: backupRaw.length,
        },
        'restoreApoBackup: preset restored from backup'
    );

    return Object.freeze({
        presetPath,
        backupPath: opts.backupPath,
        replacedBackupPath,
        bytesWritten: backupRaw.length,
    });
}

// ── Internals ────────────────────────────────────────

function extractAgentsWithOverrides(raw: string): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return [];
    }
    const agents = (parsed as Record<string, unknown>)['agents'];
    if (typeof agents !== 'object' || agents === null) {
        return [];
    }
    const out: string[] = [];
    for (const [name, value] of Object.entries(agents as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) {
            continue;
        }
        const override = (value as Record<string, unknown>)['systemPromptOverride'];
        if (typeof override === 'string' && override.trim() !== '') {
            out.push(name);
        }
    }
    out.sort();
    return out;
}

/**
 * Mirror of `apply-winner.ts#resolvePresetPath` — duplicated for the same
 * reason (avoiding Electron-facing imports from the learning module).
 */
function resolvePresetPath(): string {
    const dataDir =
        process.env['KAGEOPS_DATA_DIR'] ?? path.join(os.homedir(), '.kageops');

    let preset = process.env['KAGEOPS_PRESET'];
    if (preset === undefined || preset === '') {
        const activePresetFile = path.join(dataDir, 'active-preset.txt');
        if (fs.existsSync(activePresetFile)) {
            try {
                preset = fs.readFileSync(activePresetFile, 'utf-8').trim();
            } catch {
                // active-preset.txt exists but unreadable — fall through.
            }
        }
    }

    if (preset !== undefined && preset !== '') {
        return path.join(dataDir, `agent-config.${preset}.json`);
    }

    return path.join(dataDir, 'agent-config.json');
}
