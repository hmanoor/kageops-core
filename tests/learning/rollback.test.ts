/**
 * Tests for src/learning/rollback.ts (B-478)
 *
 * Covers:
 *   1. listApoBackups returns entries sorted newest-first, each with
 *      correct {timestamp, createdAt, size, agentsWithOverrides}
 *   2. listApoBackups ignores files that don't match the prefix/suffix
 *   3. listApoBackups returns [] when the preset dir doesn't exist
 *   4. listApoBackups tolerates corrupt backup JSON (entry kept, agents = [])
 *   5. restoreApoBackup throws for missing backup
 *   6. restoreApoBackup refuses a backup from a different directory
 *   7. restoreApoBackup refuses a file whose name doesn't match the preset
 *   8. restoreApoBackup throws when backup is not valid JSON
 *   9. restoreApoBackup snapshots current preset to apo-rollback-backup-<ts>.json
 *  10. restoreApoBackup writes atomically (tmp + rename)
 *  11. restoreApoBackup with no existing preset file skips snapshot step
 */

import { describe, it, expect } from 'vitest';
import {
    listApoBackups,
    restoreApoBackup,
    type FsLike,
} from '../../src/learning/rollback';

// ── In-memory fs stub ────────────────────────────────

interface MemFs extends FsLike {
    readonly files: Map<string, string>;
    readonly writes: string[];
    readonly renames: Array<{ from: string; to: string }>;
}

/**
 * Normalize path separators so the in-memory fs behaves consistently
 * regardless of platform. Real `path.join` on Windows produces `\\`
 * separators; the test fixture uses forward slashes. Without this,
 * lookups by composed path (dir+name via path.join) miss the fixture
 * entries on Windows.
 */
function normalizePath(p: unknown): string {
    return String(p).replace(/\\/g, '/');
}

function makeFs(initial: Record<string, string> = {}): MemFs {
    const files = new Map<string, string>(
        Object.entries(initial).map(([k, v]) => [normalizePath(k), v]),
    );
    const writes: string[] = [];
    const renames: Array<{ from: string; to: string }> = [];

    const fsImpl = {
        existsSync(p: unknown): boolean {
            const key = normalizePath(p);
            if (files.has(key)) {
                return true;
            }
            // Treat any directory containing a known file as existing.
            const prefix = key.endsWith('/') ? key : `${key}/`;
            for (const f of files.keys()) {
                if (f.startsWith(prefix)) {
                    return true;
                }
            }
            return false;
        },
        readFileSync(p: unknown, _enc?: unknown): string {
            const key = normalizePath(p);
            const value = files.get(key);
            if (value === undefined) {
                throw new Error(`ENOENT: ${key}`);
            }
            return value;
        },
        writeFileSync(p: unknown, data: unknown, _enc?: unknown): void {
            const key = normalizePath(p);
            files.set(key, String(data));
            writes.push(key);
        },
        renameSync(from: unknown, to: unknown): void {
            const fromKey = normalizePath(from);
            const toKey = normalizePath(to);
            const value = files.get(fromKey);
            if (value === undefined) {
                throw new Error(`ENOENT: ${fromKey}`);
            }
            files.set(toKey, value);
            files.delete(fromKey);
            renames.push({ from: fromKey, to: toKey });
        },
        readdirSync(dir: unknown): string[] {
            const dirKey = normalizePath(dir);
            const prefix = dirKey.endsWith('/') ? dirKey : `${dirKey}/`;
            const names = new Set<string>();
            for (const f of files.keys()) {
                if (f.startsWith(prefix)) {
                    const rest = f.slice(prefix.length);
                    const head = rest.split('/')[0];
                    if (head !== undefined && head !== '') {
                        names.add(head);
                    }
                }
            }
            return [...names];
        },
        statSync(p: unknown): { size: number } {
            const key = normalizePath(p);
            const value = files.get(key);
            if (value === undefined) {
                throw new Error(`ENOENT: ${key}`);
            }
            return { size: Buffer.byteLength(value, 'utf-8') };
        },
    } as unknown as FsLike;

    return Object.assign(fsImpl as MemFs, { files, writes, renames });
}

const PRESET = '/tmp/kageops-rollback-test/agent-config.test.json';

function sampleConfig(agents: Record<string, string | null>): string {
    const agentsObj: Record<string, Record<string, unknown>> = {};
    for (const [name, prompt] of Object.entries(agents)) {
        agentsObj[name] = {
            model: 'openrouter/google/gemini-2.5-flash',
            ...(prompt !== null ? { systemPromptOverride: prompt } : {}),
        };
    }
    return JSON.stringify({ defaults: { model: 'x' }, agents: agentsObj }, null, 2);
}

// ── listApoBackups ───────────────────────────────────

describe('listApoBackups', () => {
    it('returns entries sorted newest-first', () => {
        const fsImpl = makeFs({
            [PRESET]: sampleConfig({ scout: 'current' }),
            [`${PRESET}.apo-backup-1000.json`]: sampleConfig({ scout: 'v1' }),
            [`${PRESET}.apo-backup-3000.json`]: sampleConfig({ scout: 'v3' }),
            [`${PRESET}.apo-backup-2000.json`]: sampleConfig({ scout: 'v2' }),
        });

        const entries = listApoBackups({ presetPath: PRESET, fs: fsImpl });
        expect(entries.map((e) => e.timestamp)).toEqual([3000, 2000, 1000]);
        expect(entries[0]?.createdAt).toBe(new Date(3000).toISOString());
        expect(entries[0]?.agentsWithOverrides).toEqual(['scout']);
    });

    it('ignores files that do not match the backup prefix/suffix', () => {
        const fsImpl = makeFs({
            [PRESET]: sampleConfig({ scout: 'current' }),
            [`${PRESET}.apo-backup-1000.json`]: sampleConfig({ scout: 'v1' }),
            [`${PRESET}.apo-backup-999.txt`]: 'not json',
            [`${PRESET}.some-other-file.json`]: '{}',
            '/tmp/kageops-rollback-test/unrelated.json': '{}',
        });

        const entries = listApoBackups({ presetPath: PRESET, fs: fsImpl });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.timestamp).toBe(1000);
    });

    it('skips filenames with non-numeric or zero/negative timestamps', () => {
        const fsImpl = makeFs({
            [`${PRESET}.apo-backup-0.json`]: sampleConfig({ scout: 'x' }),
            [`${PRESET}.apo-backup--1.json`]: sampleConfig({ scout: 'x' }),
            [`${PRESET}.apo-backup-notanumber.json`]: sampleConfig({ scout: 'x' }),
            [`${PRESET}.apo-backup-1234.json`]: sampleConfig({ scout: 'x' }),
        });
        const entries = listApoBackups({ presetPath: PRESET, fs: fsImpl });
        expect(entries.map((e) => e.timestamp)).toEqual([1234]);
    });

    it('returns [] when the preset dir does not exist', () => {
        const fsImpl = makeFs();
        const entries = listApoBackups({
            presetPath: '/nowhere/agent-config.test.json',
            fs: fsImpl,
        });
        expect(entries).toEqual([]);
    });

    it('lists agentsWithOverrides for each backup', () => {
        const fsImpl = makeFs({
            [`${PRESET}.apo-backup-1000.json`]: sampleConfig({
                scout: 'scout prompt',
                herald: null,
                pixel: 'pixel prompt',
            }),
        });
        const entries = listApoBackups({ presetPath: PRESET, fs: fsImpl });
        expect(entries[0]?.agentsWithOverrides).toEqual(['pixel', 'scout']);
    });

    it('keeps corrupt backups in the list with empty agentsWithOverrides', () => {
        const fsImpl = makeFs({
            [`${PRESET}.apo-backup-1000.json`]: '{ not valid json',
        });
        const entries = listApoBackups({ presetPath: PRESET, fs: fsImpl });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.agentsWithOverrides).toEqual([]);
    });

    it('records file size for each backup', () => {
        const payload = sampleConfig({ scout: 'v1' });
        const fsImpl = makeFs({
            [`${PRESET}.apo-backup-1000.json`]: payload,
        });
        const entries = listApoBackups({ presetPath: PRESET, fs: fsImpl });
        expect(entries[0]?.size).toBe(Buffer.byteLength(payload, 'utf-8'));
    });

    it('returns a frozen array with frozen entries', () => {
        const fsImpl = makeFs({
            [`${PRESET}.apo-backup-1000.json`]: sampleConfig({ scout: 'v1' }),
        });
        const entries = listApoBackups({ presetPath: PRESET, fs: fsImpl });
        expect(Object.isFrozen(entries)).toBe(true);
        expect(Object.isFrozen(entries[0])).toBe(true);
    });
});

// ── restoreApoBackup ─────────────────────────────────

describe('restoreApoBackup', () => {
    const BACKUP = `${PRESET}.apo-backup-1000.json`;

    it('throws when the backup file does not exist', () => {
        const fsImpl = makeFs({ [PRESET]: sampleConfig({ scout: 'current' }) });
        expect(() =>
            restoreApoBackup({ backupPath: BACKUP, presetPath: PRESET, fs: fsImpl })
        ).toThrow(/backup file does not exist/);
    });

    it('refuses a backup located in a different directory', () => {
        const fsImpl = makeFs({
            [PRESET]: sampleConfig({ scout: 'current' }),
            '/some/other/dir/agent-config.test.json.apo-backup-1000.json':
                sampleConfig({ scout: 'v1' }),
        });
        expect(() =>
            restoreApoBackup({
                backupPath:
                    '/some/other/dir/agent-config.test.json.apo-backup-1000.json',
                presetPath: PRESET,
                fs: fsImpl,
            })
        ).toThrow(/not in the preset's directory/);
    });

    it('refuses a file whose name does not match the preset prefix', () => {
        const fsImpl = makeFs({
            [PRESET]: sampleConfig({ scout: 'current' }),
            '/tmp/kageops-rollback-test/random-file.json': '{}',
        });
        expect(() =>
            restoreApoBackup({
                backupPath: '/tmp/kageops-rollback-test/random-file.json',
                presetPath: PRESET,
                fs: fsImpl,
            })
        ).toThrow(/not a backup of preset/);
    });

    it('throws when the backup is not valid JSON', () => {
        const fsImpl = makeFs({
            [PRESET]: sampleConfig({ scout: 'current' }),
            [BACKUP]: 'not valid json',
        });
        expect(() =>
            restoreApoBackup({ backupPath: BACKUP, presetPath: PRESET, fs: fsImpl })
        ).toThrow(/not valid JSON/);
    });

    it('snapshots the current preset to apo-rollback-backup-<ts>.json', () => {
        const current = sampleConfig({ scout: 'current' });
        const backup = sampleConfig({ scout: 'v1' });
        const fsImpl = makeFs({ [PRESET]: current, [BACKUP]: backup });

        const result = restoreApoBackup({
            backupPath: BACKUP,
            presetPath: PRESET,
            fs: fsImpl,
            now: () => 5000,
        });

        expect(result.replacedBackupPath).toBe(
            `${PRESET}.apo-rollback-backup-5000.json`
        );
        expect(fsImpl.files.get(result.replacedBackupPath ?? '')).toBe(current);
    });

    it('overwrites the preset with the backup contents atomically', () => {
        const current = sampleConfig({ scout: 'current' });
        const backup = sampleConfig({ scout: 'v1' });
        const fsImpl = makeFs({ [PRESET]: current, [BACKUP]: backup });

        restoreApoBackup({
            backupPath: BACKUP,
            presetPath: PRESET,
            fs: fsImpl,
            now: () => 5000,
        });

        expect(fsImpl.files.get(PRESET)).toBe(backup);
        // The final rename should have a tmp source path ending at the preset.
        const rename = fsImpl.renames[fsImpl.renames.length - 1];
        expect(rename?.to).toBe(PRESET);
        expect(rename?.from.startsWith(`${PRESET}.tmp-`)).toBe(true);
    });

    it('returns bytesWritten matching the backup payload', () => {
        const backup = sampleConfig({ scout: 'v1' });
        const fsImpl = makeFs({
            [PRESET]: sampleConfig({ scout: 'current' }),
            [BACKUP]: backup,
        });
        const result = restoreApoBackup({
            backupPath: BACKUP,
            presetPath: PRESET,
            fs: fsImpl,
            now: () => 5000,
        });
        expect(result.bytesWritten).toBe(backup.length);
    });

    it('skips the snapshot step when the preset file does not yet exist', () => {
        const backup = sampleConfig({ scout: 'v1' });
        const fsImpl = makeFs({ [BACKUP]: backup });
        const result = restoreApoBackup({
            backupPath: BACKUP,
            presetPath: PRESET,
            fs: fsImpl,
            now: () => 5000,
        });
        expect(result.replacedBackupPath).toBeNull();
        expect(fsImpl.files.get(PRESET)).toBe(backup);
    });
});
