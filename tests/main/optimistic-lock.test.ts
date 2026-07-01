/**
 * Tests for src/main/optimistic-lock.ts (PR C of F-302 V1).
 *
 * The helper is the only line of defence against silent concurrent-write
 * races on lifecycle / claim handlers — every behaviour worth pinning is
 * covered here so future refactors of the IPC layer don't accidentally
 * weaken the contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => {
    const getOne = vi.fn(async (_sql: string, _params?: unknown[]) => null as unknown);
    const reset = (): void => {
        getOne.mockReset();
    };
    return { getOne, reset };
});

vi.mock('../../src/db/client', () => ({
    getOne: mockDb.getOne,
}));

import { checkOptimisticLock, conflictResponse } from '../../src/main/optimistic-lock';

describe('checkOptimisticLock', () => {
    beforeEach(() => mockDb.reset());

    it('returns ok when expectedUpdatedAt is null (back-compat path)', async () => {
        const result = await checkOptimisticLock('projects', 'p1', null);
        expect(result.ok).toBe(true);
        // No DB lookup — null = caller skipped the check.
        expect(mockDb.getOne).not.toHaveBeenCalled();
    });

    it('returns ok when expectedUpdatedAt is undefined (back-compat path)', async () => {
        const result = await checkOptimisticLock('projects', 'p1', undefined);
        expect(result.ok).toBe(true);
        expect(mockDb.getOne).not.toHaveBeenCalled();
    });

    it('returns ok when the live updated_at matches the expected value exactly', async () => {
        const ts = '2026-05-10T12:00:00.000Z';
        mockDb.getOne.mockResolvedValueOnce({ updated_at: ts });
        const result = await checkOptimisticLock('projects', 'p1', ts);
        expect(result.ok).toBe(true);
    });

    it('returns ok when timestamps differ in format but represent the same instant', async () => {
        // Postgres returns `+00`, the renderer might pass `Z` — both equal.
        const pgFmt = '2026-05-10 12:00:00.000+00';
        const renderFmt = '2026-05-10T12:00:00.000Z';
        mockDb.getOne.mockResolvedValueOnce({ updated_at: pgFmt });
        const result = await checkOptimisticLock('projects', 'p1', renderFmt);
        expect(result.ok).toBe(true);
    });

    it('returns conflict when the live updated_at differs from expected', async () => {
        const expected = '2026-05-10T12:00:00.000Z';
        const live     = '2026-05-10T12:00:05.000Z';
        const fresh    = { id: 'p1', name: 'Project X', updated_at: live, status: 'paused' };
        mockDb.getOne
            .mockResolvedValueOnce({ updated_at: live })  // version probe
            .mockResolvedValueOnce(fresh);                // full row fetch

        const result = await checkOptimisticLock('projects', 'p1', expected);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.conflict).toBe(true);
        expect(result.currentUpdatedAt).toBe(live);
        expect(result.currentRow).toEqual(fresh);
    });

    it('returns conflict with null currentRow when the row vanished mid-flight', async () => {
        // Row deleted by a concurrent action. Probe returns null →
        // conflict result with no fresh row.
        mockDb.getOne.mockResolvedValueOnce(null);
        const result = await checkOptimisticLock('projects', 'p1', '2026-05-10T12:00:00.000Z');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.conflict).toBe(true);
        expect(result.currentRow).toBeNull();
        expect(result.currentUpdatedAt).toBeNull();
    });

    it('queries the right table — happy path on tasks', async () => {
        const ts = '2026-05-10T12:00:00.000Z';
        mockDb.getOne.mockResolvedValueOnce({ updated_at: ts });
        await checkOptimisticLock('tasks', 't1', ts);
        const sql = mockDb.getOne.mock.calls[0]?.[0] as string;
        expect(sql).toMatch(/FROM tasks/);
    });

    it('queries the right table — conflict path on projects fetches full row', async () => {
        mockDb.getOne
            .mockResolvedValueOnce({ updated_at: '2026-05-10T12:00:01.000Z' })
            .mockResolvedValueOnce({ id: 'p1', updated_at: '2026-05-10T12:00:01.000Z' });

        await checkOptimisticLock('projects', 'p1', '2026-05-10T12:00:00.000Z');

        const probeCall = mockDb.getOne.mock.calls[0]?.[0] as string;
        const fetchCall = mockDb.getOne.mock.calls[1]?.[0] as string;
        expect(probeCall).toMatch(/SELECT updated_at FROM projects/);
        expect(fetchCall).toMatch(/SELECT \* FROM projects/);
    });

    it('returns conflict when one of the timestamps is unparseable', async () => {
        // Defensive — shouldn't happen in production but a malformed
        // Postgres response shouldn't silently pass the lock check.
        mockDb.getOne
            .mockResolvedValueOnce({ updated_at: 'not-a-timestamp' })
            .mockResolvedValueOnce({ id: 'p1' });
        const result = await checkOptimisticLock('projects', 'p1', '2026-05-10T12:00:00.000Z');
        expect(result.ok).toBe(false);
    });
});

describe('conflictResponse', () => {
    it('returns a uniform envelope for IPC handlers', () => {
        const env = conflictResponse('2026-05-10T12:00:05.000Z');
        expect(env.success).toBe(false);
        expect(env.conflict).toBe(true);
        expect(env.error).toContain('Refresh');
        expect(env.currentUpdatedAt).toBe('2026-05-10T12:00:05.000Z');
    });

    it('handles a missing currentUpdatedAt (row deleted)', () => {
        const env = conflictResponse(null);
        expect(env.currentUpdatedAt).toBeNull();
        expect(env.error).toContain('Refresh');
    });
});
