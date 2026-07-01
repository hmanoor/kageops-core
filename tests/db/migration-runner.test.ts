/**
 * Database migration runner tests
 */

import { describe, it, expect } from 'vitest';
import {
    computeChecksum,
    parseMigrationFile,
    sortMigrations,
    validateMigrationChain,
    getPendingMigrations,
    buildMigrationState,
    formatMigrationStatus,
    createMigrationConfig,
    validateChecksum,
    formatMigrationPlan,
    formatMigrationResults,
    type Migration,
    type MigrationResult,
} from '../../src/db/migration-runner';

// ── Helpers ─────────────────────────────────────────

function makeMigration(version: number, name: string, appliedAt: string | null = null): Migration {
    const sql = `-- migration ${version}\nCREATE TABLE ${name}();`;
    return {
        id: `${version}-${name}`,
        version,
        name,
        sql,
        checksum: computeChecksum(sql),
        appliedAt,
    };
}

// ── computeChecksum ─────────────────────────────────

describe('computeChecksum', () => {
    it('returns consistent hash for same input', () => {
        const a = computeChecksum('SELECT 1;');
        const b = computeChecksum('SELECT 1;');
        expect(a).toBe(b);
    });

    it('returns different hash for different input', () => {
        const a = computeChecksum('SELECT 1;');
        const b = computeChecksum('SELECT 2;');
        expect(a).not.toBe(b);
    });

    it('returns 8-char hex string', () => {
        const hash = computeChecksum('test');
        expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });
});

// ── parseMigrationFile ──────────────────────────────

describe('parseMigrationFile', () => {
    it('parses valid NNN-name.sql filename', () => {
        const result = parseMigrationFile('001-init.sql', 'CREATE TABLE t();');
        expect(result).not.toBeNull();
        expect(result!.version).toBe(1);
        expect(result!.name).toBe('init');
        expect(result!.appliedAt).toBeNull();
    });

    it('returns null for invalid filenames', () => {
        expect(parseMigrationFile('readme.md', '')).toBeNull();
        expect(parseMigrationFile('1-short.sql', '')).toBeNull();
        expect(parseMigrationFile('abc-name.sql', '')).toBeNull();
    });

    it('computes checksum from content', () => {
        const content = 'ALTER TABLE t ADD COLUMN x INT;';
        const result = parseMigrationFile('002-add-column.sql', content);
        expect(result!.checksum).toBe(computeChecksum(content));
    });

    it.each([
        ['001-create-users.sql', 1, 'create-users'],
        ['010-add-indexes.sql', 10, 'add-indexes'],
        ['100-big-migration.sql', 100, 'big-migration'],
    ])('parseMigrationFile(%s) => version=%d name=%s', (file, ver, name) => {
        const result = parseMigrationFile(file, 'SQL');
        expect(result!.version).toBe(ver);
        expect(result!.name).toBe(name);
    });
});

// ── sortMigrations ──────────────────────────────────

describe('sortMigrations', () => {
    it('sorts by version ascending', () => {
        const unsorted = [makeMigration(3, 'c'), makeMigration(1, 'a'), makeMigration(2, 'b')];
        const sorted = sortMigrations(unsorted);
        expect(sorted.map((m) => m.version)).toEqual([1, 2, 3]);
    });

    it('does not mutate original array', () => {
        const original = [makeMigration(2, 'b'), makeMigration(1, 'a')];
        sortMigrations(original);
        expect(original[0].version).toBe(2);
    });
});

// ── validateMigrationChain ──────────────────────────

describe('validateMigrationChain', () => {
    it('returns empty for valid sequential chain', () => {
        const chain = [makeMigration(1, 'a'), makeMigration(2, 'b'), makeMigration(3, 'c')];
        expect(validateMigrationChain(chain)).toEqual([]);
    });

    it('detects gaps', () => {
        const chain = [makeMigration(1, 'a'), makeMigration(3, 'c')];
        const errors = validateMigrationChain(chain);
        expect(errors.some((e) => e.includes('Gap'))).toBe(true);
    });

    it('detects duplicates', () => {
        const chain = [makeMigration(1, 'a'), makeMigration(1, 'b')];
        const errors = validateMigrationChain(chain);
        expect(errors.some((e) => e.includes('Duplicate'))).toBe(true);
    });
});

// ── getPendingMigrations ────────────────────────────

describe('getPendingMigrations', () => {
    it('returns unapplied migrations sorted by version', () => {
        const all = [makeMigration(1, 'a'), makeMigration(2, 'b'), makeMigration(3, 'c')];
        const applied = [makeMigration(1, 'a', '2026-01-01')];
        const pending = getPendingMigrations(all, applied);
        expect(pending.map((m) => m.version)).toEqual([2, 3]);
    });

    it('returns empty when all applied', () => {
        const all = [makeMigration(1, 'a')];
        const applied = [makeMigration(1, 'a', '2026-01-01')];
        expect(getPendingMigrations(all, applied)).toEqual([]);
    });
});

// ── buildMigrationState ─────────────────────────────

describe('buildMigrationState', () => {
    it('builds correct state', () => {
        const all = [makeMigration(1, 'a'), makeMigration(2, 'b')];
        const applied = [makeMigration(1, 'a', '2026-01-01')];
        const state = buildMigrationState(all, applied);
        expect(state.current).toBe(1);
        expect(state.applied.length).toBe(1);
        expect(state.pending.length).toBe(1);
    });

    it('returns current=0 when nothing applied', () => {
        const state = buildMigrationState([makeMigration(1, 'a')], []);
        expect(state.current).toBe(0);
    });
});

// ── formatMigrationStatus ───────────────────────────

describe('formatMigrationStatus', () => {
    it('includes version and name in table', () => {
        const state = buildMigrationState(
            [makeMigration(1, 'init'), makeMigration(2, 'users')],
            [makeMigration(1, 'init', '2026-01-01')],
        );
        const output = formatMigrationStatus(state);
        expect(output).toContain('init');
        expect(output).toContain('users');
        expect(output).toContain('Pending');
        expect(output).toContain('Applied');
    });
});

// ── createMigrationConfig ───────────────────────────

describe('createMigrationConfig', () => {
    it('returns defaults without overrides', () => {
        const config = createMigrationConfig();
        expect(config.tableName).toBe('schema_migrations');
        expect(config.validateChecksums).toBe(true);
    });

    it('applies overrides', () => {
        const config = createMigrationConfig({ tableName: 'custom' });
        expect(config.tableName).toBe('custom');
        expect(config.validateChecksums).toBe(true);
    });
});

// ── validateChecksum ────────────────────────────────

describe('validateChecksum', () => {
    it('returns true for matching checksum', () => {
        const m = makeMigration(1, 'a');
        expect(validateChecksum(m, m.checksum)).toBe(true);
    });

    it('returns false for mismatched checksum', () => {
        const m = makeMigration(1, 'a');
        expect(validateChecksum(m, 'deadbeef')).toBe(false);
    });
});

// ── formatMigrationPlan ─────────────────────────────

describe('formatMigrationPlan', () => {
    it('shows "up to date" when no pending', () => {
        expect(formatMigrationPlan([])).toContain('up to date');
    });

    it('lists pending migrations', () => {
        const pending = [makeMigration(2, 'users'), makeMigration(3, 'posts')];
        const plan = formatMigrationPlan(pending);
        expect(plan).toContain('users');
        expect(plan).toContain('posts');
        expect(plan).toContain('2 migration(s)');
    });
});

// ── formatMigrationResults ──────────────────────────

describe('formatMigrationResults', () => {
    it('shows complete header on success', () => {
        const results: MigrationResult[] = [
            { migration: makeMigration(1, 'init'), success: true, error: null, durationMs: 10 },
        ];
        const output = formatMigrationResults(results);
        expect(output).toContain('Migration Complete');
    });

    it('shows failed header on failure', () => {
        const results: MigrationResult[] = [
            { migration: makeMigration(1, 'init'), success: false, error: 'syntax error', durationMs: 5 },
        ];
        const output = formatMigrationResults(results);
        expect(output).toContain('Migration Failed');
        expect(output).toContain('syntax error');
    });
});
