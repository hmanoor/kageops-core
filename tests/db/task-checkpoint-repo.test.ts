/**
 * Task-checkpoint repository unit tests (Devin-parity Phase 1 — P1-01).
 *
 * Two suites:
 *   1. In-memory fake — locks in the semantics every resume-path
 *      consumer will rely on (unique-op enforcement, status
 *      transitions, ordered listing, cascade-on-task-delete).
 *   2. Production repo — exercises the SQL parameter shapes via a
 *      `vi.mock` on `../../src/db/client` so we don't need a live
 *      PGlite to know the queries are wired correctly.
 *
 * No call-site integration tests in this PR — the wiring lands in
 * P1-01b/c/d, each with its own integration coverage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
    createInMemoryTaskCheckpointRepository,
    taskCheckpointsEnabled,
    type TaskCheckpointRepository,
    type TaskCheckpointRow,
} from '../../src/db/task-checkpoint-repo';

// ───────────────────────────────────────────────────────────────────
// Suite 0 — the on-by-default gate (output-cached resume kill-switch)
// ───────────────────────────────────────────────────────────────────

describe('taskCheckpointsEnabled — default-on with kill-switch', () => {
    const KEY = 'KAGEOPS_TASK_CHECKPOINTS';
    let original: string | undefined;
    beforeEach(() => { original = process.env[KEY]; delete process.env[KEY]; });
    afterEach(() => {
        if (original === undefined) delete process.env[KEY];
        else process.env[KEY] = original;
    });

    it('defaults ON when the env var is unset or empty', () => {
        expect(taskCheckpointsEnabled()).toBe(true);
        process.env[KEY] = '';
        expect(taskCheckpointsEnabled()).toBe(true);
    });

    it('stays ON for truthy values', () => {
        for (const v of ['true', '1', 'on', 'yes', 'anything-else']) {
            process.env[KEY] = v;
            expect(taskCheckpointsEnabled()).toBe(true);
        }
    });

    it('is the kill-switch only for explicit false-y values', () => {
        for (const v of ['false', '0', 'off', 'no', 'FALSE', ' Off ']) {
            process.env[KEY] = v;
            expect(taskCheckpointsEnabled()).toBe(false);
        }
    });
});

// ───────────────────────────────────────────────────────────────────
// Suite 1 — in-memory fake locks in resume-path semantics
// ───────────────────────────────────────────────────────────────────

describe('createInMemoryTaskCheckpointRepository — P1-01 semantics', () => {
    let repo: TaskCheckpointRepository;

    beforeEach(() => {
        repo = createInMemoryTaskCheckpointRepository();
    });

    it('recordStart returns an in-flight row with the supplied identity', async () => {
        const row = await repo.recordStart({
            taskId: 'task-1',
            opIndex: 0,
            opType: 'askai',
            payloadJson: { promptHash: 'abc', model: 'sonnet' },
        });
        expect(row.taskId).toBe('task-1');
        expect(row.opIndex).toBe(0);
        expect(row.opType).toBe('askai');
        expect(row.status).toBe('in-flight');
        expect(row.outputJson).toBeNull();
        expect(row.errorText).toBeNull();
        expect(row.completedAt).toBeNull();
        expect(row.payloadJson).toEqual({ promptHash: 'abc', model: 'sonnet' });
    });

    it('rejects duplicate (taskId, opIndex) — unique guarantee', async () => {
        await repo.recordStart({ taskId: 't', opIndex: 0, opType: 'write', payloadJson: {} });
        await expect(
            repo.recordStart({ taskId: 't', opIndex: 0, opType: 'write', payloadJson: {} }),
        ).rejects.toThrow(/duplicate checkpoint/);
    });

    it('allows the same opIndex across different tasks', async () => {
        await repo.recordStart({ taskId: 't1', opIndex: 0, opType: 'askai', payloadJson: {} });
        await expect(
            repo.recordStart({ taskId: 't2', opIndex: 0, opType: 'askai', payloadJson: {} }),
        ).resolves.toMatchObject({ taskId: 't2', opIndex: 0 });
    });

    it('markCompleted flips status + stores outputJson + sets completedAt', async () => {
        const start = await repo.recordStart({
            taskId: 't', opIndex: 0, opType: 'askai', payloadJson: {},
        });
        await repo.markCompleted(start.id, { text: 'hi', tokensOut: 10 });
        const row = await repo.findByOp('t', 0);
        expect(row).not.toBeNull();
        expect(row!.status).toBe('completed');
        expect(row!.outputJson).toEqual({ text: 'hi', tokensOut: 10 });
        expect(row!.completedAt).not.toBeNull();
        expect(row!.errorText).toBeNull();
    });

    it('markFailed records the error and flips status', async () => {
        const start = await repo.recordStart({
            taskId: 't', opIndex: 0, opType: 'exec', payloadJson: {},
        });
        await repo.markFailed(start.id, 'npm test exited 1');
        const row = await repo.findByOp('t', 0);
        expect(row!.status).toBe('failed');
        expect(row!.errorText).toBe('npm test exited 1');
        expect(row!.outputJson).toBeNull();
        expect(row!.completedAt).not.toBeNull();
    });

    it('findByOp returns null for a missed key (resume-path miss)', async () => {
        await repo.recordStart({ taskId: 't', opIndex: 0, opType: 'askai', payloadJson: {} });
        expect(await repo.findByOp('t', 1)).toBeNull();
        expect(await repo.findByOp('other-task', 0)).toBeNull();
    });

    it('listForTask returns rows ordered by opIndex regardless of insert order', async () => {
        await repo.recordStart({ taskId: 't', opIndex: 2, opType: 'exec', payloadJson: {} });
        await repo.recordStart({ taskId: 't', opIndex: 0, opType: 'askai', payloadJson: {} });
        await repo.recordStart({ taskId: 't', opIndex: 1, opType: 'write', payloadJson: {} });
        const rows = await repo.listForTask('t');
        expect(rows.map((r) => r.opIndex)).toEqual([0, 1, 2]);
        expect(rows.map((r) => r.opType)).toEqual(['askai', 'write', 'exec']);
    });

    it('listForTask returns empty array when no checkpoints exist', async () => {
        expect(await repo.listForTask('unknown-task')).toEqual([]);
    });

    it('listForTask isolates rows from other tasks', async () => {
        await repo.recordStart({ taskId: 't1', opIndex: 0, opType: 'askai', payloadJson: {} });
        await repo.recordStart({ taskId: 't2', opIndex: 0, opType: 'askai', payloadJson: {} });
        const rows = await repo.listForTask('t1');
        expect(rows).toHaveLength(1);
        expect(rows[0]!.taskId).toBe('t1');
    });

    it('deleteForTask wipes only the target task rows', async () => {
        await repo.recordStart({ taskId: 't1', opIndex: 0, opType: 'askai', payloadJson: {} });
        await repo.recordStart({ taskId: 't1', opIndex: 1, opType: 'write', payloadJson: {} });
        await repo.recordStart({ taskId: 't2', opIndex: 0, opType: 'askai', payloadJson: {} });
        await repo.deleteForTask('t1');
        expect(await repo.listForTask('t1')).toEqual([]);
        expect(await repo.listForTask('t2')).toHaveLength(1);
    });

    it('deleteForTask is a no-op when no rows match', async () => {
        await expect(repo.deleteForTask('never-existed')).resolves.toBeUndefined();
    });

    it('captures the resume-hit scenario end-to-end', async () => {
        // First run: record + complete askAI op #0.
        const ck = await repo.recordStart({
            taskId: 't', opIndex: 0, opType: 'askai',
            payloadJson: { promptHash: 'h1', model: 'sonnet' },
        });
        await repo.markCompleted(ck.id, { text: 'cached-response', tokensOut: 42 });

        // Second run (the "resume" case): a fresh agent sees a hit and
        // can short-circuit to the cached output.
        const hit = await repo.findByOp('t', 0);
        expect(hit?.status).toBe('completed');
        expect(hit?.outputJson).toEqual({ text: 'cached-response', tokensOut: 42 });
    });

    it('captures the crash-during-op scenario (in-flight stays in-flight)', async () => {
        // Pretend the process crashed between recordStart and
        // markCompleted/markFailed. The row sits at status='in-flight'.
        await repo.recordStart({ taskId: 't', opIndex: 0, opType: 'askai', payloadJson: {} });
        const hit = await repo.findByOp('t', 0);
        expect(hit?.status).toBe('in-flight');
        expect(hit?.completedAt).toBeNull();
        // The resume policy (lives in the caller, not the repo) will
        // overwrite this on re-execute. Tested via the call-site
        // wiring PRs (P1-01b/c/d), not here.
    });
});

// ───────────────────────────────────────────────────────────────────
// Suite 2 — production repo SQL shape (mock db/client)
// ───────────────────────────────────────────────────────────────────

const mockClient = vi.hoisted(() => {
    const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const getOneFn = vi.fn(async () => null as unknown);
    const getManyFn = vi.fn(async () => [] as unknown[]);
    return {
        query: queryFn,
        getOne: getOneFn,
        getMany: getManyFn,
        module: () => ({
            query: queryFn,
            getOne: getOneFn,
            getMany: getManyFn,
        }),
        reset: () => {
            queryFn.mockClear();
            getOneFn.mockClear();
            getManyFn.mockClear();
        },
    };
});

vi.mock('../../src/db/client', () => mockClient.module());

// Import AFTER the mock so the repo binds to the mocked exports.
const { taskCheckpointRepository } = await import('../../src/db/task-checkpoint-repo');

const sampleRow = {
    id: 'ck-1',
    task_id: 't-1',
    op_index: 0,
    op_type: 'askai' as const,
    status: 'in-flight' as const,
    payload_json: { promptHash: 'h' },
    output_json: null,
    error_text: null,
    created_at: '2026-05-22T12:34:56Z',
    completed_at: null,
};

describe('taskCheckpointRepository — SQL shape', () => {
    beforeEach(() => mockClient.reset());

    it('recordStart issues an INSERT...RETURNING with status=in-flight and serialised payload', async () => {
        mockClient.getOne.mockResolvedValueOnce(sampleRow);
        await taskCheckpointRepository.recordStart({
            taskId: 't-1', opIndex: 0, opType: 'askai', payloadJson: { promptHash: 'h' },
        });
        expect(mockClient.getOne).toHaveBeenCalledTimes(1);
        const [sql, params] = mockClient.getOne.mock.calls[0]!;
        expect(sql).toMatch(/INSERT INTO task_checkpoints/);
        expect(sql).toMatch(/'in-flight'/);
        expect(sql).toMatch(/RETURNING \*/);
        expect(params).toEqual([
            't-1',
            0,
            'askai',
            JSON.stringify({ promptHash: 'h' }),
        ]);
    });

    it('recordStart maps snake_case row → camelCase TaskCheckpointRow', async () => {
        mockClient.getOne.mockResolvedValueOnce(sampleRow);
        const row: TaskCheckpointRow = await taskCheckpointRepository.recordStart({
            taskId: 't-1', opIndex: 0, opType: 'askai', payloadJson: {},
        });
        expect(row).toMatchObject({
            id: 'ck-1',
            taskId: 't-1',
            opIndex: 0,
            opType: 'askai',
            status: 'in-flight',
            outputJson: null,
            errorText: null,
            completedAt: null,
        });
    });

    it('recordStart throws when the INSERT returns no row', async () => {
        mockClient.getOne.mockResolvedValueOnce(null);
        await expect(
            taskCheckpointRepository.recordStart({
                taskId: 't', opIndex: 0, opType: 'askai', payloadJson: {},
            }),
        ).rejects.toThrow(/no row/);
    });

    it('markCompleted issues UPDATE...status=completed with serialised outputJson', async () => {
        await taskCheckpointRepository.markCompleted('ck-1', { text: 'hi' });
        expect(mockClient.query).toHaveBeenCalledTimes(1);
        const [sql, params] = mockClient.query.mock.calls[0]!;
        expect(sql).toMatch(/UPDATE task_checkpoints/);
        expect(sql).toMatch(/SET status\s*=\s*'completed'/);
        expect(sql).toMatch(/completed_at = NOW\(\)/);
        expect(params).toEqual(['ck-1', JSON.stringify({ text: 'hi' })]);
    });

    it('markFailed issues UPDATE...status=failed with the error text', async () => {
        await taskCheckpointRepository.markFailed('ck-1', 'boom');
        const [sql, params] = mockClient.query.mock.calls[0]!;
        expect(sql).toMatch(/SET status\s*=\s*'failed'/);
        expect(sql).toMatch(/error_text\s*=\s*\$2/);
        expect(params).toEqual(['ck-1', 'boom']);
    });

    it('findByOp returns null when SELECT yields no row', async () => {
        mockClient.getOne.mockResolvedValueOnce(null);
        const row = await taskCheckpointRepository.findByOp('t', 0);
        expect(row).toBeNull();
    });

    it('findByOp returns mapped row on hit', async () => {
        mockClient.getOne.mockResolvedValueOnce({
            ...sampleRow,
            status: 'completed' as const,
            output_json: { text: 'cached' },
            completed_at: '2026-05-22T12:35:00Z',
        });
        const row = await taskCheckpointRepository.findByOp('t-1', 0);
        expect(row).toMatchObject({
            id: 'ck-1',
            status: 'completed',
            outputJson: { text: 'cached' },
            completedAt: '2026-05-22T12:35:00Z',
        });
    });

    it('listForTask issues SELECT ORDER BY op_index ASC', async () => {
        mockClient.getMany.mockResolvedValueOnce([sampleRow]);
        const rows = await taskCheckpointRepository.listForTask('t-1');
        expect(rows).toHaveLength(1);
        const [sql, params] = mockClient.getMany.mock.calls[0]!;
        expect(sql).toMatch(/SELECT \* FROM task_checkpoints/);
        expect(sql).toMatch(/ORDER BY op_index ASC/);
        expect(params).toEqual(['t-1']);
    });

    it('deleteForTask issues DELETE WHERE task_id = $1', async () => {
        await taskCheckpointRepository.deleteForTask('t-1');
        const [sql, params] = mockClient.query.mock.calls[0]!;
        expect(sql).toMatch(/DELETE FROM task_checkpoints WHERE task_id = \$1/);
        expect(params).toEqual(['t-1']);
    });
});
