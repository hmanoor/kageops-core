/**
 * Reusable mock factory for the db/client module.
 *
 * All orchestrator and agent tests need to mock db/client.
 * This centralizes the mock setup to avoid duplication.
 */

import { vi } from 'vitest';

// ── Types ────────────────────────────────────────────

export interface MockQueryCall {
    readonly sql: string;
    readonly params: readonly unknown[];
}

export interface MockDbClient {
    readonly query: ReturnType<typeof vi.fn>;
    readonly getOne: ReturnType<typeof vi.fn>;
    readonly getMany: ReturnType<typeof vi.fn>;
    readonly initDatabase: ReturnType<typeof vi.fn>;
    readonly testConnection: ReturnType<typeof vi.fn>;
    readonly closePool: ReturnType<typeof vi.fn>;
    readonly getPool: ReturnType<typeof vi.fn>;
    readonly calls: readonly MockQueryCall[];
    readonly reset: () => void;
}

// ── Factory ─────────────────────────────────────────

/**
 * Create a mock db/client module.
 * All functions are vi.fn() mocks that can be configured per test.
 *
 * Usage:
 *   const mockDb = createMockDbClient();
 *   vi.mock('../../src/db/client', () => mockDb.module());
 *   mockDb.query.mockResolvedValueOnce({ rows: [...], rowCount: 1 });
 */
export function createMockDbClient(): MockDbClient & { module: () => Record<string, unknown> } {
    const queryCalls: MockQueryCall[] = [];

    const queryFn = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        queryCalls.push({ sql, params });
        return { rows: [], rowCount: 0 };
    });

    const getOneFn = vi.fn(async () => null);
    const getManyFn = vi.fn(async () => []);
    const initDatabaseFn = vi.fn(async () => undefined);
    const testConnectionFn = vi.fn(async () => true);
    const closePoolFn = vi.fn(async () => undefined);
    const getPoolFn = vi.fn(() => ({
        query: queryFn,
        end: vi.fn(),
    }));

    const reset = (): void => {
        queryCalls.length = 0;
        queryFn.mockClear();
        getOneFn.mockClear();
        getManyFn.mockClear();
        initDatabaseFn.mockClear();
        testConnectionFn.mockClear();
        closePoolFn.mockClear();
        getPoolFn.mockClear();
    };

    return {
        query: queryFn,
        getOne: getOneFn,
        getMany: getManyFn,
        initDatabase: initDatabaseFn,
        testConnection: testConnectionFn,
        closePool: closePoolFn,
        getPool: getPoolFn,
        get calls() { return [...queryCalls]; },
        reset,
        module: () => ({
            query: queryFn,
            getOne: getOneFn,
            getMany: getManyFn,
            initDatabase: initDatabaseFn,
            testConnection: testConnectionFn,
            closePool: closePoolFn,
            getPool: getPoolFn,
        }),
    };
}
