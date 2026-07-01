/**
 * P1-05a iteration repo — unit tests.
 *
 * Mirrors the task-checkpoint-repo test pattern: in-memory fake covers
 * the semantics every consumer relies on; production-repo SQL shape
 * tests assert the queries are wired correctly without needing a live
 * PGlite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    createInMemoryIterationRepository,
    IterationRepository,
} from '../../src/db/iteration-repo';

// ── In-memory fake — locks in the resume/reopen semantics ──

describe('createInMemoryIterationRepository()', () => {
    let repo: IterationRepository;

    beforeEach(() => {
        repo = createInMemoryIterationRepository();
    });

    it('recordOriginal writes iteration 0 with no requirement_text', async () => {
        const row = await repo.recordOriginal('proj-1');
        expect(row.iterationIndex).toBe(0);
        expect(row.projectId).toBe('proj-1');
        expect(row.requirementText).toBeNull();
        expect(row.endedAt).toBeNull();
        expect(row.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it('recordOriginal is idempotent — returns the existing iteration 0 on re-call', async () => {
        const first = await repo.recordOriginal('proj-1');
        const second = await repo.recordOriginal('proj-1');
        expect(second.id).toBe(first.id);
        expect((await repo.listForProject('proj-1')).length).toBe(1);
    });

    it('recordReopen creates iteration 1 after recordOriginal', async () => {
        await repo.recordOriginal('proj-1');
        const reopened = await repo.recordReopen('proj-1', 'fix the dark-mode bug');
        expect(reopened.iterationIndex).toBe(1);
        expect(reopened.requirementText).toBe('fix the dark-mode bug');
    });

    it('recordReopen monotonically increments across multiple reopens', async () => {
        await repo.recordOriginal('proj-1');
        const r1 = await repo.recordReopen('proj-1', null);
        const r2 = await repo.recordReopen('proj-1', 'add a contact form');
        const r3 = await repo.recordReopen('proj-1', null);
        expect([r1.iterationIndex, r2.iterationIndex, r3.iterationIndex]).toEqual([1, 2, 3]);
    });

    it('recordReopen backfills iteration 0 for legacy projects (no prior original)', async () => {
        // Simulates a project created before migration 026 — first reopen
        // should silently create iteration 0 + return iteration 1.
        const reopened = await repo.recordReopen('legacy-proj', 'late requirement');
        expect(reopened.iterationIndex).toBe(1);
        const all = await repo.listForProject('legacy-proj');
        expect(all.map((r) => r.iterationIndex)).toEqual([0, 1]);
    });

    it('closeCurrent sets ended_at on the latest open iteration only', async () => {
        await repo.recordOriginal('proj-1');
        await repo.recordReopen('proj-1', 'r1');
        const r2 = await repo.recordReopen('proj-1', 'r2');

        await repo.closeCurrent('proj-1');

        const all = await repo.listForProject('proj-1');
        // Original + reopen 1 should still be "open" (legacy: their ended_at
        // wasn't set by recordReopen — that's the close-handler's job).
        expect(all[0].endedAt).toBeNull();
        expect(all[1].endedAt).toBeNull();
        // The latest iteration is now closed.
        expect(all[2].id).toBe(r2.id);
        expect(all[2].endedAt).not.toBeNull();
    });

    it('closeCurrent is a no-op when no open iterations exist', async () => {
        // Empty project — nothing to close.
        await expect(repo.closeCurrent('proj-1')).resolves.toBeUndefined();

        // Closed project — closing again is also a no-op.
        await repo.recordOriginal('proj-2');
        await repo.closeCurrent('proj-2');
        const beforeSecondClose = (await repo.getCurrent('proj-2'))?.endedAt;
        await repo.closeCurrent('proj-2');
        const afterSecondClose = (await repo.getCurrent('proj-2'))?.endedAt;
        expect(afterSecondClose).toBe(beforeSecondClose); // unchanged
    });

    it('getCurrent returns the highest-index iteration', async () => {
        await repo.recordOriginal('proj-1');
        await repo.recordReopen('proj-1', null);
        const r2 = await repo.recordReopen('proj-1', 'latest');
        const current = await repo.getCurrent('proj-1');
        expect(current?.id).toBe(r2.id);
        expect(current?.iterationIndex).toBe(2);
    });

    it('getCurrent returns null for a project with no iterations', async () => {
        expect(await repo.getCurrent('proj-none')).toBeNull();
    });

    it('listForProject returns iterations in ascending order', async () => {
        await repo.recordOriginal('proj-1');
        await repo.recordReopen('proj-1', 'r1');
        await repo.recordReopen('proj-1', 'r2');

        const all = await repo.listForProject('proj-1');
        expect(all.map((r) => r.iterationIndex)).toEqual([0, 1, 2]);
    });

    it('isolates iterations across projects', async () => {
        await repo.recordOriginal('proj-A');
        await repo.recordOriginal('proj-B');
        await repo.recordReopen('proj-A', 'A-r1');

        const aList = await repo.listForProject('proj-A');
        const bList = await repo.listForProject('proj-B');
        expect(aList.length).toBe(2);
        expect(bList.length).toBe(1);
        expect(bList[0].iterationIndex).toBe(0);
    });
});

// ── Production repo SQL shape ──

vi.mock('../../src/db/client', () => ({
    query: vi.fn(),
    getOne: vi.fn(),
    getMany: vi.fn(),
}));

import { iterationRepository } from '../../src/db/iteration-repo';
import { query, getOne, getMany } from '../../src/db/client';

const mockQuery = vi.mocked(query);
const mockGetOne = vi.mocked(getOne);
const mockGetMany = vi.mocked(getMany);

describe('iterationRepository — production SQL shape', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('recordOriginal: SELECT-then-INSERT, returns existing iteration 0 if present', async () => {
        const existing = {
            id: 'it-existing', project_id: 'proj-1', iteration_index: 0,
            started_at: '2026-05-24T00:00:00Z', ended_at: null, requirement_text: null,
        };
        mockGetOne.mockResolvedValueOnce(existing);

        const row = await iterationRepository.recordOriginal('proj-1');

        expect(row.id).toBe('it-existing');
        expect(mockGetOne).toHaveBeenCalledTimes(1); // no INSERT path fired
        const [sql] = mockGetOne.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/SELECT \* FROM iterations/);
        expect(sql).toMatch(/iteration_index = 0/);
    });

    it('recordOriginal: INSERT when no row exists', async () => {
        mockGetOne
            .mockResolvedValueOnce(null) // SELECT existing → none
            .mockResolvedValueOnce({
                id: 'it-new', project_id: 'proj-1', iteration_index: 0,
                started_at: '2026-05-24T00:00:00Z', ended_at: null, requirement_text: null,
            });

        const row = await iterationRepository.recordOriginal('proj-1');

        expect(row.id).toBe('it-new');
        const [insertSql, insertParams] = mockGetOne.mock.calls[1] as [string, unknown[]];
        expect(insertSql).toMatch(/INSERT INTO iterations/);
        expect(insertSql).toMatch(/VALUES \(\$1, 0\)/);
        expect(insertSql).toMatch(/RETURNING \*/);
        expect(insertParams).toEqual(['proj-1']);
    });

    it('recordReopen: computes next index via MAX(iteration_index) + 1', async () => {
        mockGetOne
            .mockResolvedValueOnce({ max_index: 2 }) // MAX query
            .mockResolvedValueOnce({
                id: 'it-r3', project_id: 'proj-1', iteration_index: 3,
                started_at: '2026-05-24T00:00:00Z', ended_at: null,
                requirement_text: 'fix the dark mode',
            });

        const row = await iterationRepository.recordReopen('proj-1', 'fix the dark mode');

        expect(row.iterationIndex).toBe(3);
        expect(row.requirementText).toBe('fix the dark mode');

        const [maxSql] = mockGetOne.mock.calls[0] as [string, unknown[]];
        expect(maxSql).toMatch(/COALESCE\(MAX\(iteration_index\), -1\)/);

        const [insertSql, insertParams] = mockGetOne.mock.calls[1] as [string, unknown[]];
        expect(insertSql).toMatch(/INSERT INTO iterations/);
        expect(insertParams).toEqual(['proj-1', 3, 'fix the dark mode']);
    });

    it('closeCurrent: UPDATE with correlated subquery selecting the latest open iteration', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        await iterationRepository.closeCurrent('proj-1');

        const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/UPDATE iterations/);
        expect(sql).toMatch(/SET ended_at = NOW\(\)/);
        expect(sql).toMatch(/MAX\(iteration_index\)/);
        expect(params).toEqual(['proj-1']);
    });

    it('getCurrent: ORDER BY iteration_index DESC LIMIT 1', async () => {
        mockGetOne.mockResolvedValueOnce({
            id: 'it-x', project_id: 'proj-1', iteration_index: 5,
            started_at: '2026-05-24T00:00:00Z', ended_at: null, requirement_text: null,
        });
        const row = await iterationRepository.getCurrent('proj-1');
        expect(row?.iterationIndex).toBe(5);

        const [sql] = mockGetOne.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/ORDER BY iteration_index DESC/);
        expect(sql).toMatch(/LIMIT 1/);
    });

    it('listForProject: ORDER BY iteration_index ASC', async () => {
        mockGetMany.mockResolvedValueOnce([
            { id: 'it-0', project_id: 'proj-1', iteration_index: 0, started_at: 't0', ended_at: 't1', requirement_text: null },
            { id: 'it-1', project_id: 'proj-1', iteration_index: 1, started_at: 't2', ended_at: null, requirement_text: 'r1' },
        ]);
        const rows = await iterationRepository.listForProject('proj-1');
        expect(rows.map((r) => r.iterationIndex)).toEqual([0, 1]);

        const [sql] = mockGetMany.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/ORDER BY iteration_index ASC/);
    });
});
