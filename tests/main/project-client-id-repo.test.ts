/**
 * Pillar 2.4 / PR-B — projects.client_id repo tests.
 */

import { describe, it, expect } from 'vitest';
import type { Pool, QueryResult, QueryResultRow } from 'pg';

import {
    setProjectClientId,
    getProjectClientId,
} from '../../src/main/project-client-id-repo';

function inMemoryPool(): Pool {
    const store = new Map<string, string | null>();
    const queryFn = async <T extends QueryResultRow = QueryResultRow>(
        sql: string,
        params: readonly unknown[]
    ): Promise<QueryResult<T>> => {
        const n = sql.replace(/\s+/g, ' ').trim();
        if (n.startsWith('UPDATE projects SET client_id = $1 WHERE id = $2')) {
            const [value, id] = params as [string | null, string];
            store.set(id, value);
            return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] } as unknown as QueryResult<T>;
        }
        if (n.startsWith('SELECT client_id FROM projects WHERE id = $1')) {
            const id = params[0] as string;
            if (!store.has(id)) {
                return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as unknown as QueryResult<T>;
            }
            return {
                rows: [{ client_id: store.get(id) ?? null }] as unknown as T[],
                rowCount: 1,
                command: 'SELECT',
                oid: 0,
                fields: [],
            } as unknown as QueryResult<T>;
        }
        throw new Error(`unexpected SQL: ${n}`);
    };
    return { query: queryFn } as unknown as Pool;
}

describe('setProjectClientId() + getProjectClientId()', () => {
    it('round-trips a trimmed client_id', async () => {
        const pool = inMemoryPool();
        const result = await setProjectClientId('proj-1', '  acme-corp  ', { pool });
        expect(result).toBe('acme-corp');
        expect(await getProjectClientId('proj-1', { pool })).toBe('acme-corp');
    });

    it('collapses null → NULL', async () => {
        const pool = inMemoryPool();
        await setProjectClientId('proj-1', 'acme', { pool });
        const cleared = await setProjectClientId('proj-1', null, { pool });
        expect(cleared).toBeNull();
        expect(await getProjectClientId('proj-1', { pool })).toBeNull();
    });

    it('collapses empty string → NULL', async () => {
        const pool = inMemoryPool();
        const result = await setProjectClientId('proj-1', '   ', { pool });
        expect(result).toBeNull();
        expect(await getProjectClientId('proj-1', { pool })).toBeNull();
    });

    it('getProjectClientId returns null for unknown project', async () => {
        const pool = inMemoryPool();
        expect(await getProjectClientId('does-not-exist', { pool })).toBeNull();
    });

    it('multiple projects are isolated', async () => {
        const pool = inMemoryPool();
        await setProjectClientId('proj-a', 'client-1', { pool });
        await setProjectClientId('proj-b', 'client-2', { pool });
        expect(await getProjectClientId('proj-a', { pool })).toBe('client-1');
        expect(await getProjectClientId('proj-b', { pool })).toBe('client-2');
    });
});
