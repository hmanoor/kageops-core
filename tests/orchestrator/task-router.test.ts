/**
 * TaskRouter behavioral tests
 *
 * Tests routing logic, manual overrides, dependency blocking,
 * fallback behavior, DB writes, and event publishing.
 * All db/client calls and SpecialityMatrix are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';

// ── DB mock must be hoisted before any source import ─────────────────────────

const mockDb = vi.hoisted(() => {
    const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const getOneFn = vi.fn(async () => null);
    const getManyFn = vi.fn(async () => []);
    const initDatabaseFn = vi.fn(async () => undefined);
    const testConnectionFn = vi.fn(async () => true);
    const closePoolFn = vi.fn(async () => undefined);
    const getPoolFn = vi.fn(() => ({ query: queryFn, end: vi.fn() }));
    const reset = (): void => {
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
});

vi.mock('../../src/db/client', () => mockDb.module());

// ── Imports after mock setup ─────────────────────────────────────────────────

import { TaskRouter, type TaskRecord, type RouteResult } from '../../src/orchestrator/task-router';
import type { AgentScore } from '../../src/orchestrator/speciality-matrix';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
        id: 'task-001',
        projectId: 'proj-001',
        title: 'Write unit tests',
        description: 'Implement test suite',
        taskType: 'testing',
        phase: 'development',
        assignedAgent: null,
        status: 'pending',
        priority: 5,
        dependsOn: [],
        ...overrides,
    };
}

function makeMatrix(overrides: {
    getBestAgent?: (skill: string) => Promise<AgentScore | null>;
    getTopAgents?: (skill: string, limit?: number) => Promise<readonly AgentScore[]>;
} = {}): { getBestAgent: ReturnType<typeof vi.fn>; getTopAgents: ReturnType<typeof vi.fn> } {
    return {
        getBestAgent: vi.fn(overrides.getBestAgent ?? (() => Promise.resolve(null))),
        getTopAgents: vi.fn(overrides.getTopAgents ?? (() => Promise.resolve([]))),
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TaskRouter', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
    });

    // ── 1. Routes to highest-scoring agent from matrix ───────────────────────

    describe('routeTask()', () => {
        it('loads task from DB and assigns highest-scoring agent from matrix', async () => {
            const task = buildTask({ taskType: 'infrastructure' });
            mockDb.getOne.mockResolvedValueOnce(task);
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-001' }], rowCount: 1 }); // UPDATE

            const matrix = makeMatrix({
                getBestAgent: () => Promise.resolve({ agent: 'aegis', score: 8.5 }),
            });

            const router = new TaskRouter(matrix as never, eventBus as never);
            const result = await router.routeTask('task-001');

            expect(mockDb.getOne).toHaveBeenCalledOnce();
            expect(mockDb.getOne.mock.calls[0][1]).toEqual(['task-001']);
            expect(matrix.getBestAgent).toHaveBeenCalledWith('infrastructure');
            expect(result.agent).toBe('aegis');
            expect(result.score).toBe(8.5);
            expect(result.taskId).toBe('task-001');
        });

        // ── 2. Respects manual assignment ─────────────────────────────────────

        it('uses assignedAgent directly and skips matrix when manually set', async () => {
            const task = buildTask({ assignedAgent: 'vigil' });
            mockDb.getOne.mockResolvedValueOnce(task);
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-001' }], rowCount: 1 });

            const matrix = makeMatrix();
            const router = new TaskRouter(matrix as never, eventBus as never);
            const result = await router.routeTask('task-001');

            expect(matrix.getBestAgent).not.toHaveBeenCalled();
            expect(result.agent).toBe('vigil');
            expect(result.score).toBe(10);
            expect(result.reason).toMatch(/manual assignment/i);
        });

        // ── 3. Blocks task when dependencies are not all completed ────────────

        it('blocks task and returns score 0 when a dependency is not completed', async () => {
            const task = buildTask({ dependsOn: ['dep-001', 'dep-002'] });
            mockDb.getOne.mockResolvedValueOnce(task);
            // getDependencyStatuses query returns rows for the IN clause
            mockDb.query.mockResolvedValueOnce({
                rows: [{ status: 'completed' }, { status: 'pending' }],
                rowCount: 2,
            });

            const matrix = makeMatrix();
            const router = new TaskRouter(matrix as never, eventBus as never);
            const result = await router.routeTask('task-001');

            expect(result.score).toBe(0);
            expect(result.reason).toMatch(/blocked/i);
            // No UPDATE query and no event should have been published
            expect(eventBus.publishedEvents).toHaveLength(0);
            expect(matrix.getBestAgent).not.toHaveBeenCalled();
        });

        it('proceeds to assign when all dependencies are completed', async () => {
            const task = buildTask({ dependsOn: ['dep-001'] });
            mockDb.getOne.mockResolvedValueOnce(task);
            // Dependency status query
            mockDb.query
                .mockResolvedValueOnce({ rows: [{ status: 'completed' }], rowCount: 1 })
                // UPDATE query
                .mockResolvedValueOnce({ rows: [{ id: 'task-001' }], rowCount: 1 });

            const matrix = makeMatrix({
                getBestAgent: () => Promise.resolve({ agent: 'forge', score: 7 }),
            });

            const router = new TaskRouter(matrix as never, eventBus as never);
            const result = await router.routeTask('task-001');

            expect(result.agent).toBe('forge');
            expect(result.score).toBe(7);
        });

        // ── 4. Falls back to 'forge' when matrix returns null ─────────────────

        it('falls back to forge when matrix returns null for the task type', async () => {
            const task = buildTask({ taskType: 'unknown-skill' });
            mockDb.getOne.mockResolvedValueOnce(task);
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-001' }], rowCount: 1 });

            const matrix = makeMatrix({ getBestAgent: () => Promise.resolve(null) });
            const router = new TaskRouter(matrix as never, eventBus as never);
            const result = await router.routeTask('task-001');

            expect(result.agent).toBe('forge');
            expect(result.score).toBe(5);
        });

        // ── 5. Publishes task.assigned event ─────────────────────────────────

        it('publishes a task.assigned event after assignment', async () => {
            const task = buildTask({ projectId: 'proj-abc' });
            mockDb.getOne.mockResolvedValueOnce(task);
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-001' }], rowCount: 1 });

            const matrix = makeMatrix({
                getBestAgent: () => Promise.resolve({ agent: 'scout', score: 6 }),
            });

            const router = new TaskRouter(matrix as never, eventBus as never);
            await router.routeTask('task-001');

            expect(eventBus.publish).toHaveBeenCalledOnce();
            const [channel, payload] = eventBus.publish.mock.calls[0];
            expect(channel).toBe('task.assigned');
            expect(payload).toMatchObject({
                projectId: 'proj-abc',
                taskId: 'task-001',
                agent: 'scout',
            });
        });

        // ── 6. Updates task status to 'assigned' with started_at ─────────────

        it('issues an UPDATE setting status=assigned and started_at for the task', async () => {
            const task = buildTask();
            mockDb.getOne.mockResolvedValueOnce(task);
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-001' }], rowCount: 1 });

            const matrix = makeMatrix({
                getBestAgent: () => Promise.resolve({ agent: 'blueprint', score: 9 }),
            });

            const router = new TaskRouter(matrix as never, eventBus as never);
            await router.routeTask('task-001');

            const updateCall = mockDb.query.mock.calls.find(
                ([sql]: [string]) => sql.includes("status = 'assigned'")
            );
            expect(updateCall).toBeDefined();
            const [sql, params] = updateCall as [string, unknown[]];
            expect(sql).toMatch(/started_at\s*=\s*NOW\(\)/i);
            expect(params).toContain('blueprint');
            expect(params).toContain('task-001');
        });

        // ── 7. Throws when task not found ─────────────────────────────────────

        it('throws an error when the task is not found in DB', async () => {
            mockDb.getOne.mockResolvedValueOnce(null);

            const matrix = makeMatrix();
            const router = new TaskRouter(matrix as never, eventBus as never);

            await expect(router.routeTask('nonexistent-task')).rejects.toThrow(
                'Task not found: nonexistent-task'
            );
        });
    });

    // ── 8. routePendingTasks() processes in priority order ────────────────────

    describe('routePendingTasks()', () => {
        it('queries pending tasks ordered by priority DESC and routes each one', async () => {
            // Return two task IDs from the pending query
            mockDb.query.mockResolvedValueOnce({
                rows: [{ id: 'task-high' }, { id: 'task-low' }],
                rowCount: 2,
            });

            // getOne calls: one per routeTask call
            const taskHigh = buildTask({ id: 'task-high', priority: 10, taskType: 'ci' });
            const taskLow = buildTask({ id: 'task-low', priority: 2, taskType: 'testing' });
            mockDb.getOne
                .mockResolvedValueOnce(taskHigh)
                .mockResolvedValueOnce(taskLow);

            // UPDATE queries — one per task assignment (SELECT was already queued above)
            mockDb.query
                .mockResolvedValueOnce({ rows: [{ id: 'task-high' }], rowCount: 1 }) // UPDATE for task-high
                .mockResolvedValueOnce({ rows: [{ id: 'task-low' }], rowCount: 1 }); // UPDATE for task-low

            const matrix = makeMatrix({
                getBestAgent: () => Promise.resolve({ agent: 'aegis', score: 7 }),
            });

            const router = new TaskRouter(matrix as never, eventBus as never);
            const results = await router.routePendingTasks('proj-001');

            // Verify the initial SELECT uses the right project and ORDER BY priority DESC
            const selectCall = mockDb.query.mock.calls[0];
            expect(selectCall[0]).toMatch(/ORDER BY priority DESC/i);
            expect(selectCall[1]).toEqual(['proj-001']);

            expect(results).toHaveLength(2);
            expect(results[0].taskId).toBe('task-high');
            expect(results[1].taskId).toBe('task-low');
        });

        it('returns an empty array when no pending tasks exist', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

            const matrix = makeMatrix();
            const router = new TaskRouter(matrix as never, eventBus as never);
            const results = await router.routePendingTasks('proj-empty');

            expect(results).toHaveLength(0);
        });
    });

    // ── 9. manualAssign() overrides matrix routing ────────────────────────────

    describe('manualAssign()', () => {
        it('assigns the specified agent without consulting the matrix', async () => {
            mockDb.getOne.mockResolvedValueOnce({ project_id: 'proj-001' });
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-001' }], rowCount: 1 });

            const matrix = makeMatrix();
            const router = new TaskRouter(matrix as never, eventBus as never);
            const result = await router.manualAssign('task-001', 'cipher');

            expect(matrix.getBestAgent).not.toHaveBeenCalled();
            expect(result.agent).toBe('cipher');
            expect(result.score).toBe(10);
            expect(result.reason).toMatch(/manual assignment/i);
        });

        it('publishes task.assigned event with the manually chosen agent', async () => {
            mockDb.getOne.mockResolvedValueOnce({ project_id: 'proj-xyz' });
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-001' }], rowCount: 1 });

            const matrix = makeMatrix();
            const router = new TaskRouter(matrix as never, eventBus as never);
            await router.manualAssign('task-001', 'pixel');

            expect(eventBus.publish).toHaveBeenCalledOnce();
            const [channel, payload] = eventBus.publish.mock.calls[0];
            expect(channel).toBe('task.assigned');
            expect(payload).toMatchObject({ agent: 'pixel', taskId: 'task-001' });
        });

        it('throws when the task does not exist', async () => {
            mockDb.getOne.mockResolvedValueOnce(null);

            const matrix = makeMatrix();
            const router = new TaskRouter(matrix as never, eventBus as never);

            await expect(router.manualAssign('ghost-task', 'forge')).rejects.toThrow(
                'Task not found: ghost-task'
            );
        });
    });
});
