/**
 * Database client behavioral tests
 *
 * Covers query helpers, pool management, and initialization logic in both
 * modes: external pg.Pool and embedded PGlite. All tests mock the underlying
 * implementation — no real database connection is opened.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock pg module (external mode) ──────────────────

const mockPoolQuery = vi.fn();
const mockPoolEnd = vi.fn();
const mockPoolOn = vi.fn();

const MockPool = vi.fn(() => ({
    query: mockPoolQuery,
    end: mockPoolEnd,
    on: mockPoolOn,
}));

vi.mock('pg', () => ({
    Pool: MockPool,
}));

// ── Mock fs module for schema/seed files ────────────

vi.mock('fs', () => ({
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => 'SELECT 1;'),
}));

// ── Mock embedded-pg module so tests never boot PGlite ──

const mockEmbeddedQuery = vi.fn();
const mockEmbeddedEnd = vi.fn();
const mockEmbeddedOn = vi.fn();
const mockEmbeddedExec = vi.fn();

vi.mock('../../src/db/embedded-pg', () => ({
    EmbeddedPool: vi.fn(() => ({
        query: mockEmbeddedQuery,
        end: mockEmbeddedEnd,
        on: mockEmbeddedOn,
    })),
    EmbeddedClient: vi.fn(),
    isEmbeddedMode: vi.fn(),
    getEmbeddedDb: vi.fn(async () => ({ exec: mockEmbeddedExec })),
    closeEmbedded: vi.fn(),
    resolveEmbeddedDataDir: vi.fn(() => '/tmp/pgdata'),
    resetEmbeddedDbForTests: vi.fn(),
}));

async function setExternalMode(): Promise<void> {
    const { isEmbeddedMode } = await import('../../src/db/embedded-pg');
    vi.mocked(isEmbeddedMode).mockReturnValue(false);
}

async function setEmbeddedMode(): Promise<void> {
    const { isEmbeddedMode } = await import('../../src/db/embedded-pg');
    vi.mocked(isEmbeddedMode).mockReturnValue(true);
}

// ── Tests ───────────────────────────────────────────

describe('db/client', () => {
    beforeEach(() => {
        mockPoolQuery.mockReset();
        mockPoolEnd.mockReset();
        mockPoolOn.mockReset();
        mockEmbeddedQuery.mockReset();
        mockEmbeddedEnd.mockReset();
        mockEmbeddedOn.mockReset();
        mockEmbeddedExec.mockReset();
        MockPool.mockClear();
        vi.resetModules();
        // Default: external mode with an explicit URL
        process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
        delete process.env['KAGEOPS_DB_MODE'];
    });

    afterEach(() => {
        delete process.env['DATABASE_URL'];
        delete process.env['KAGEOPS_DB_MODE'];
    });

    describe('getPool() — external mode', () => {
        beforeEach(() => setExternalMode());

        it('creates a Pool singleton on first call', async () => {
            const { getPool } = await import('../../src/db/client');
            const pool = getPool();
            expect(pool).toBeDefined();
            expect(MockPool).toHaveBeenCalledTimes(1);
        });

        it('returns the same pool on subsequent calls', async () => {
            const { getPool } = await import('../../src/db/client');
            const pool1 = getPool();
            const pool2 = getPool();
            expect(pool1).toBe(pool2);
            expect(MockPool).toHaveBeenCalledTimes(1);
        });

        it('uses provided databaseUrl', async () => {
            const { getPool } = await import('../../src/db/client');
            getPool('postgres://custom:url@host:5432/db');
            expect(MockPool).toHaveBeenCalledWith(
                expect.objectContaining({
                    connectionString: 'postgres://custom:url@host:5432/db',
                })
            );
        });

        it('reads DATABASE_URL when no arg is passed', async () => {
            const { getPool } = await import('../../src/db/client');
            getPool();
            expect(MockPool).toHaveBeenCalledWith(
                expect.objectContaining({
                    connectionString: 'postgres://test:test@localhost:5432/test',
                })
            );
        });

        it('throws when external mode is forced but DATABASE_URL is missing', async () => {
            delete process.env['DATABASE_URL'];
            const { getPool } = await import('../../src/db/client');
            expect(() => getPool()).toThrow(/DATABASE_URL/);
        });

        it('registers error handler on pool', async () => {
            const { getPool } = await import('../../src/db/client');
            getPool();
            expect(mockPoolOn).toHaveBeenCalledWith('error', expect.any(Function));
        });
    });

    describe('getPool() — embedded mode', () => {
        beforeEach(() => setEmbeddedMode());

        it('returns EmbeddedPool facade when in embedded mode', async () => {
            const { getPool, getPoolMode } = await import('../../src/db/client');
            const pool = getPool();
            expect(pool).toBeDefined();
            expect(getPoolMode()).toBe('embedded');
            expect(MockPool).not.toHaveBeenCalled();
        });
    });

    describe('query() — external mode', () => {
        beforeEach(() => setExternalMode());

        it('executes parameterized SQL via pool.query', async () => {
            mockPoolQuery.mockResolvedValueOnce({
                rows: [{ id: '123', name: 'test' }],
                rowCount: 1,
            });

            const { query } = await import('../../src/db/client');
            const result = await query('SELECT * FROM projects WHERE id = $1', ['123']);

            expect(mockPoolQuery).toHaveBeenCalledWith('SELECT * FROM projects WHERE id = $1', ['123']);
            expect(result.rows).toHaveLength(1);
            expect(result.rows[0]).toEqual({ id: '123', name: 'test' });
            expect(result.rowCount).toBe(1);
        });

        it('returns frozen rows array (immutability)', async () => {
            mockPoolQuery.mockResolvedValueOnce({
                rows: [{ id: '1' }, { id: '2' }],
                rowCount: 2,
            });

            const { query } = await import('../../src/db/client');
            const result = await query('SELECT id FROM tasks');

            expect(Object.isFrozen(result.rows)).toBe(true);
        });

        it('defaults to empty params when none provided', async () => {
            mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

            const { query } = await import('../../src/db/client');
            await query('SELECT 1');

            expect(mockPoolQuery).toHaveBeenCalledWith('SELECT 1', []);
        });

        it('returns rowCount 0 when result.rowCount is null', async () => {
            mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: null });

            const { query } = await import('../../src/db/client');
            const result = await query('DELETE FROM tasks');

            expect(result.rowCount).toBe(0);
        });
    });

    describe('query() — embedded mode', () => {
        beforeEach(() => setEmbeddedMode());

        it('routes through EmbeddedPool.query', async () => {
            mockEmbeddedQuery.mockResolvedValueOnce({
                rows: [{ id: 'abc' }],
                rowCount: 1,
            });

            const { query } = await import('../../src/db/client');
            const result = await query('SELECT * FROM projects');

            expect(mockEmbeddedQuery).toHaveBeenCalled();
            expect(mockPoolQuery).not.toHaveBeenCalled();
            expect(result.rows).toHaveLength(1);
        });
    });

    describe('getOne()', () => {
        beforeEach(() => setExternalMode());

        it('returns first row when rows exist', async () => {
            mockPoolQuery.mockResolvedValueOnce({
                rows: [{ id: '1', name: 'first' }, { id: '2', name: 'second' }],
                rowCount: 2,
            });

            const { getOne } = await import('../../src/db/client');
            const result = await getOne('SELECT * FROM projects LIMIT 1');

            expect(result).toEqual({ id: '1', name: 'first' });
        });

        it('returns null when no rows', async () => {
            mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

            const { getOne } = await import('../../src/db/client');
            const result = await getOne('SELECT * FROM projects WHERE id = $1', ['nonexistent']);

            expect(result).toBeNull();
        });
    });

    describe('getMany()', () => {
        beforeEach(() => setExternalMode());

        it('returns all rows', async () => {
            const rows = [{ id: '1' }, { id: '2' }, { id: '3' }];
            mockPoolQuery.mockResolvedValueOnce({ rows, rowCount: 3 });

            const { getMany } = await import('../../src/db/client');
            const result = await getMany('SELECT id FROM tasks');

            expect(result).toHaveLength(3);
        });

        it('returns empty array when no rows', async () => {
            mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

            const { getMany } = await import('../../src/db/client');
            const result = await getMany('SELECT id FROM tasks WHERE status = $1', ['nonexistent']);

            expect(result).toEqual([]);
        });
    });

    describe('testConnection()', () => {
        beforeEach(() => setExternalMode());

        it('returns true on successful connection', async () => {
            mockPoolQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] });

            const { testConnection } = await import('../../src/db/client');
            const result = await testConnection({ maxRetries: 1, retryDelayMs: 10 });

            expect(result).toBe(true);
        });

        it('retries on failure up to maxRetries', async () => {
            mockPoolQuery
                .mockRejectedValueOnce(new Error('Connection refused'))
                .mockRejectedValueOnce(new Error('Connection refused'))
                .mockResolvedValueOnce({ rows: [{ ok: 1 }] });

            const { testConnection } = await import('../../src/db/client');
            const result = await testConnection({ maxRetries: 3, retryDelayMs: 10 });

            expect(result).toBe(true);
            expect(mockPoolQuery).toHaveBeenCalledTimes(3);
        });

        it('returns false after exhausting all retries', async () => {
            mockPoolQuery.mockRejectedValue(new Error('Connection refused'));

            const { testConnection } = await import('../../src/db/client');
            const result = await testConnection({ maxRetries: 2, retryDelayMs: 10 });

            expect(result).toBe(false);
        });
    });

    describe('closePool()', () => {
        beforeEach(() => setExternalMode());

        it('calls pool.end() and resets singleton', async () => {
            const { getPool, closePool } = await import('../../src/db/client');
            getPool();
            expect(MockPool).toHaveBeenCalledTimes(1);
            await closePool();
            expect(mockPoolEnd).toHaveBeenCalledTimes(1);
        });

        it('is no-op when pool is not created', async () => {
            const { closePool } = await import('../../src/db/client');
            await closePool();
            expect(mockPoolEnd).not.toHaveBeenCalled();
        });
    });

    describe('initDatabase()', () => {
        beforeEach(() => setExternalMode());

        it('skips schema init when tables already exist', async () => {
            mockPoolQuery
                .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
                .mockResolvedValueOnce({ rows: [{ exists: true }], rowCount: 1 })
                .mockResolvedValue({ rows: [], rowCount: 0 });

            const mod = await import('../../src/db/client');
            mod.getPool();
            await mod.initDatabase({ maxRetries: 1, retryDelayMs: 10 });

            expect(mockPoolQuery.mock.calls.length).toBeGreaterThanOrEqual(3);
        });

        it('throws when database connection fails', async () => {
            mockPoolQuery.mockRejectedValue(new Error('Connection refused'));

            const mod = await import('../../src/db/client');
            mod.getPool();

            await expect(
                mod.initDatabase({ maxRetries: 1, retryDelayMs: 10 })
            ).rejects.toThrow('Cannot initialize');
        });
    });
});
