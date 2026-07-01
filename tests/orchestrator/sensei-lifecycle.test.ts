/**
 * Sensei project-lifecycle unit tests (B-401 / B-402 / B-403).
 *
 * Covers:
 *   • cancelProject  — state transition, in-flight tasks failed, event shape
 *   • pauseProject   — state transition, intercept.pause fan-out, no-op guard
 *   • resumeProject  — state transition, intercept.resume, router re-drive
 *   • archiveProject — terminal-only guard, project.archived event
 *   • restoreProject — archived-only guard, project.restored event
 *   • getAllProjectsStatus filter semantics (include / exclude / includeArchived)
 *
 * We mock `db/client` so each method's query path is deterministic and
 * we can assert both the emitted SQL and the published event payloads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';

// ── Mock setup ───────────────────────────────────────

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

vi.mock('../../src/comms/comms-sender', () => ({
    CommsSender: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        enqueue: vi.fn(async () => 'msg-1'),
        processPending: vi.fn(async () => 0),
        getChannels: vi.fn(() => ['teams', 'email']),
    })),
}));

vi.mock('../../src/workspace/workspace-manager', () => ({
    WorkspaceManager: vi.fn(() => ({
        createProject: vi.fn(async () => '/tmp/projects/test'),
        getProjectPath: vi.fn(() => '/tmp/projects/test'),
        projectExists: vi.fn(() => false),
        deleteProject: vi.fn(async () => undefined),
    })),
}));

// P1-05a: iteration repo dynamic-import is captured here so assertions
// can verify Sensei called the right wiring (recordOriginal on start,
// recordReopen on reopen, closeCurrent on close).
const mockIterationRepo = vi.hoisted(() => ({
    recordOriginal: vi.fn(async (projectId: string) => ({
        id: 'it-fake', projectId, iterationIndex: 0,
        startedAt: '2026-05-24T00:00:00Z', endedAt: null, requirementText: null,
    })),
    recordReopen: vi.fn(async (projectId: string, requirementText: string | null) => ({
        id: 'it-fake-r1', projectId, iterationIndex: 1,
        startedAt: '2026-05-24T00:00:00Z', endedAt: null, requirementText,
    })),
    closeCurrent: vi.fn(async () => undefined),
    getCurrent: vi.fn(async () => null),
    listForProject: vi.fn(async () => []),
}));
vi.mock('../../src/db/iteration-repo', () => ({
    iterationRepository: mockIterationRepo,
    createInMemoryIterationRepository: vi.fn(() => mockIterationRepo),
}));

// Import AFTER mocks
import { Sensei } from '../../src/orchestrator/sensei';
import type { EventBus } from '../../src/orchestrator/event-bus';

// ── Helpers ──────────────────────────────────────────

function makeSensei(
    eventBus: ReturnType<typeof createMockEventBus>,
): Sensei {
    const sendPrompt = vi.fn(async () => '[]');
    return new Sensei({ sendPrompt }, eventBus as unknown as EventBus);
}

function lastPublished(
    eventBus: ReturnType<typeof createMockEventBus>,
    channel: string,
): { readonly channel: string; readonly event: Record<string, unknown> } | undefined {
    const matches = eventBus.publishedEvents.filter((e) => e.channel === channel);
    const last = matches[matches.length - 1];
    return last === undefined ? undefined : last;
}

// ── cancelProject ────────────────────────────────────

describe('Sensei.cancelProject (B-401)', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
    });

    it('transitions an active project to cancelled and fails in-flight tasks', async () => {
        const sensei = makeSensei(eventBus);

        // UPDATE projects ... RETURNING id → row returned = transition succeeded
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });
        // UPDATE tasks SET status='failed'
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 2 });

        await sensei.cancelProject('proj-1', 'user-requested');

        // First SQL: UPDATE projects SET status='cancelled' with RETURNING id guard
        const [firstSql, firstParams] = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(firstSql).toMatch(/UPDATE projects/i);
        expect(firstSql).toMatch(/status = 'cancelled'/i);
        expect(firstSql).toMatch(/NOT IN \('completed', 'archived'\)/i);
        expect(firstSql).toMatch(/RETURNING id/i);
        expect(firstParams).toEqual(['proj-1']);

        // Second SQL: UPDATE tasks → fail in-flight work
        const [taskSql, taskParams] = mockDb.query.mock.calls[1] as [string, unknown[]];
        expect(taskSql).toMatch(/UPDATE tasks/i);
        expect(taskSql).toMatch(/pending.*assigned.*in-progress|in-progress.*assigned.*pending/is);
        expect(taskParams[0]).toBe('proj-1');
        expect(String(taskParams[1])).toContain('user-requested');

        // Published project.cancelled event with top-level projectId (activity-bridge contract)
        const published = lastPublished(eventBus, 'project.cancelled');
        expect(published).toBeDefined();
        expect(published?.event['projectId']).toBe('proj-1');
        expect((published?.event['data'] as Record<string, unknown>)['reason']).toBe('user-requested');
    });

    it('is a no-op when the project is already in a terminal status', async () => {
        const sensei = makeSensei(eventBus);

        // RETURNING id → empty rows → the guard short-circuits
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await sensei.cancelProject('proj-done');

        // Only the guarded UPDATE ran — no task failure, no published event
        expect(mockDb.query.mock.calls.length).toBe(1);
        expect(eventBus.publishedEvents.some((e) => e.channel === 'project.cancelled')).toBe(false);
    });

    it('defaults reason to null when none is supplied', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await sensei.cancelProject('proj-1');

        const published = lastPublished(eventBus, 'project.cancelled');
        expect((published?.event['data'] as Record<string, unknown>)['reason']).toBeNull();
    });
});

// ── pauseProject ─────────────────────────────────────

describe('Sensei.pauseProject (B-403)', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
    });

    it('transitions active → paused and fans out intercept.pause to in-flight agents', async () => {
        const sensei = makeSensei(eventBus);

        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });
        mockDb.getMany.mockResolvedValueOnce([
            { id: 'task-a', assigned_agent: 'forge' },
            { id: 'task-b', assigned_agent: 'pixel' },
            { id: 'task-c', assigned_agent: null }, // unassigned — skipped
        ]);

        await sensei.pauseProject('proj-1');

        // Project SQL
        const [sql] = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/status = 'paused'/i);
        expect(sql).toMatch(/WHERE id = \$1 AND status = 'active'/i);

        // intercept.pause emitted for each assigned in-flight task
        const pauseEvents = eventBus.publishedEvents.filter((e) => e.channel === 'intercept.pause');
        expect(pauseEvents).toHaveLength(2);
        expect(pauseEvents.map((e) => e.event['agent']).sort()).toEqual(['forge', 'pixel']);
        expect(pauseEvents.map((e) => e.event['taskId']).sort()).toEqual(['task-a', 'task-b']);

        // project.paused payload carries top-level projectId + inflight count
        const published = lastPublished(eventBus, 'project.paused');
        expect(published).toBeDefined();
        expect(published?.event['projectId']).toBe('proj-1');
        expect((published?.event['data'] as Record<string, unknown>)['inflightCount']).toBe(3);
    });

    it('is a no-op when the project is not active', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await sensei.pauseProject('proj-1');

        expect(mockDb.getMany).not.toHaveBeenCalled();
        expect(eventBus.publishedEvents.some((e) => e.channel === 'project.paused')).toBe(false);
        expect(eventBus.publishedEvents.some((e) => e.channel === 'intercept.pause')).toBe(false);
    });
});

// ── resumeProject ────────────────────────────────────

describe('Sensei.resumeProject (B-403)', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
    });

    it('flips paused → active, fans out intercept.resume, and re-drives dispatch', async () => {
        const sensei = makeSensei(eventBus);

        // 1) getOne for project lookup — returns paused project
        mockDb.getOne.mockResolvedValueOnce({
            id: 'proj-1',
            name: 'X',
            description: 'd',
            phase: 'development',
            status: 'paused',
            trust_level: 'low',
            project_type: null,
            enabled_phases: null,
            tech_stack: null,
            goal: null,
            budget_usd: null,
        });
        // 2) UPDATE projects RETURNING id — success
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });
        // 3) getMany for in-flight tasks
        mockDb.getMany.mockResolvedValueOnce([
            { id: 'task-a', assigned_agent: 'forge' },
        ]);
        // 4) router.routePendingTasks first query (pending tasks SELECT)
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await sensei.resumeProject('proj-1');

        // Project status flipped back to 'active'
        const [sql] = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/status = 'active'/i);
        expect(sql).toMatch(/paused_at = NULL/i);
        expect(sql).toMatch(/WHERE id = \$1 AND status = 'paused'/i);

        // intercept.resume fired for each task
        const resumes = eventBus.publishedEvents.filter((e) => e.channel === 'intercept.resume');
        expect(resumes).toHaveLength(1);
        expect(resumes[0]?.event['agent']).toBe('forge');

        const published = lastPublished(eventBus, 'project.resumed');
        expect(published).toBeDefined();
        expect(published?.event['projectId']).toBe('proj-1');
    });

    it('throws when the project does not exist', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getOne.mockResolvedValueOnce(null);

        await expect(sensei.resumeProject('proj-1')).rejects.toThrow(/not found/i);

        expect(eventBus.publishedEvents.some((e) => e.channel === 'project.resumed')).toBe(false);
    });

    // ── P1-01e: in-progress task re-dispatch + checkpoint summary ──

    it('P1-01e: includes in-progress tasks in the resume SELECT (was just pending+assigned)', async () => {
        const sensei = makeSensei(eventBus);
        // active project, headless re-attach path
        mockDb.getOne.mockResolvedValueOnce({
            id: 'proj-1', name: 'X', description: 'd',
            phase: 'development', status: 'active', trust_level: 'low',
            project_type: null, enabled_phases: null,
            tech_stack: null, goal: null, budget_usd: null,
        });
        mockDb.getMany.mockResolvedValueOnce([]); // no rows — short-circuits to kickPhase fresh decompose path

        // This test asserts only the resume SELECT, not decomposition output.
        // Disable the BPF-37 fresh-phase fallback so the 0-task decompose path
        // doesn't reach storeTasks (whose query mock returns no id here).
        process.env.KAGEOPS_DECOMPOSE_FALLBACK = '0';
        try {
            await sensei.resumeProject('proj-1');
        } finally {
            delete process.env.KAGEOPS_DECOMPOSE_FALLBACK;
        }

        const [sql, params] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/status IN \('pending', 'assigned', 'in-progress', 'blocked'\)/i);
        expect(params).toEqual(['proj-1', 'development']);
    });

    /** Spy on TaskRouter.routePendingTasks so resume tests assert the BPF-21
     *  reset-then-route contract without driving the router's deep SQL. */
    function spyRoutePending(sensei: Sensei): ReturnType<typeof vi.spyOn> {
        const router = (sensei as unknown as {
            router: { routePendingTasks: (id: string) => Promise<void> };
        }).router;
        return vi.spyOn(router, 'routePendingTasks').mockResolvedValue(undefined);
    }

    it('BPF-21: resets an in-progress task to pending then routes (no bare re-publish)', async () => {
        const sensei = makeSensei(eventBus);
        const routeSpy = spyRoutePending(sensei);
        mockDb.getOne.mockResolvedValueOnce({
            id: 'proj-1', name: 'X', description: 'd',
            phase: 'development', status: 'active', trust_level: 'low',
            project_type: null, enabled_phases: null,
            tech_stack: null, goal: null, budget_usd: null,
        });
        // ONE in-progress task with an assigned_agent — would have deadlocked
        // under the old bare-re-publish path.
        mockDb.getMany.mockResolvedValueOnce([
            { id: 'task-inprog', assigned_agent: 'forge', status: 'in-progress' },
        ]);

        await sensei.resumeProject('proj-1');

        // Reset UPDATE flips every non-terminal task → a clean 'pending'.
        const resetCall = mockDb.query.mock.calls.find(([sql]) => {
            const s = sql as string;
            return /SET status = 'pending'/.test(s) && /IN \('assigned', 'in-progress', 'blocked'\)/.test(s);
        });
        expect(resetCall).toBeDefined();
        expect(resetCall![1]).toEqual(['proj-1', 'development']);
        // Then routePendingTasks — NOT a bare task.assigned re-publish.
        expect(routeSpy).toHaveBeenCalledWith('proj-1');
        expect(eventBus.publishedEvents.filter((e) => e.channel === 'task.assigned')).toHaveLength(0);
    });

    it('BPF-21: an already-assigned task is also reset + routed (regression)', async () => {
        const sensei = makeSensei(eventBus);
        const routeSpy = spyRoutePending(sensei);
        mockDb.getOne.mockResolvedValueOnce({
            id: 'proj-1', name: 'X', description: 'd',
            phase: 'development', status: 'active', trust_level: 'low',
            project_type: null, enabled_phases: null,
            tech_stack: null, goal: null, budget_usd: null,
        });
        mockDb.getMany.mockResolvedValueOnce([
            { id: 'task-assigned', assigned_agent: 'forge', status: 'assigned' },
        ]);

        await sensei.resumeProject('proj-1');

        const resetCall = mockDb.query.mock.calls.find(([sql]) => {
            const s = sql as string;
            return /SET status = 'pending'/.test(s) && /IN \('assigned', 'in-progress', 'blocked'\)/.test(s);
        });
        expect(resetCall).toBeDefined();
        expect(routeSpy).toHaveBeenCalledWith('proj-1');
        expect(eventBus.publishedEvents.filter((e) => e.channel === 'task.assigned')).toHaveLength(0);
    });

    it('P1-01e: logs checkpoint summary when KAGEOPS_TASK_CHECKPOINTS=true', async () => {
        const sensei = makeSensei(eventBus);
        const originalEnv = process.env['KAGEOPS_TASK_CHECKPOINTS'];
        process.env['KAGEOPS_TASK_CHECKPOINTS'] = 'true';
        try {
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-1', name: 'X', description: 'd',
                phase: 'development', status: 'active', trust_level: 'low',
                project_type: null, enabled_phases: null,
                tech_stack: null, goal: null, budget_usd: null,
            });
            // pending tasks SELECT
            mockDb.getMany.mockResolvedValueOnce([
                { id: 'task-a', assigned_agent: 'forge', status: 'in-progress' },
            ]);
            // checkpoint summary SELECT — returns the per-status row counts
            mockDb.getMany.mockResolvedValueOnce([
                { task_id: 'task-a', status: 'completed', count: '4' },
                { task_id: 'task-a', status: 'in-flight', count: '1' },
            ]);

            await sensei.resumeProject('proj-1');

            // Second getMany call is the checkpoint summary query
            const checkpointCall = mockDb.getMany.mock.calls[1] as [string, unknown[]];
            expect(checkpointCall[0]).toMatch(/FROM task_checkpoints/i);
            expect(checkpointCall[0]).toMatch(/task_id = ANY/i);
            expect(checkpointCall[1]).toEqual([['task-a']]);
        } finally {
            if (originalEnv === undefined) delete process.env['KAGEOPS_TASK_CHECKPOINTS'];
            else process.env['KAGEOPS_TASK_CHECKPOINTS'] = originalEnv;
        }
    });

    it('P1-01e: does NOT query task_checkpoints when the kill-switch is set (no overhead)', async () => {
        const sensei = makeSensei(eventBus);
        // Checkpoints default ON now; the no-overhead path needs the explicit
        // kill-switch (KAGEOPS_TASK_CHECKPOINTS=false), not merely "unset".
        const originalEnv = process.env['KAGEOPS_TASK_CHECKPOINTS'];
        process.env['KAGEOPS_TASK_CHECKPOINTS'] = 'false';
        try {
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-1', name: 'X', description: 'd',
                phase: 'development', status: 'active', trust_level: 'low',
                project_type: null, enabled_phases: null,
                tech_stack: null, goal: null, budget_usd: null,
            });
            mockDb.getMany.mockResolvedValueOnce([
                { id: 'task-a', assigned_agent: 'forge', status: 'in-progress' },
            ]);

            await sensei.resumeProject('proj-1');

            // Only ONE getMany call: the pending-tasks SELECT. No checkpoint query.
            expect(mockDb.getMany).toHaveBeenCalledTimes(1);
        } finally {
            if (originalEnv === undefined) delete process.env['KAGEOPS_TASK_CHECKPOINTS'];
            else process.env['KAGEOPS_TASK_CHECKPOINTS'] = originalEnv;
        }
    });

    it('P1-01e: checkpoint summary query failure does not block re-dispatch (non-fatal)', async () => {
        const sensei = makeSensei(eventBus);
        const routeSpy = spyRoutePending(sensei);
        const originalEnv = process.env['KAGEOPS_TASK_CHECKPOINTS'];
        process.env['KAGEOPS_TASK_CHECKPOINTS'] = 'true';
        try {
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-1', name: 'X', description: 'd',
                phase: 'development', status: 'active', trust_level: 'low',
                project_type: null, enabled_phases: null,
                tech_stack: null, goal: null, budget_usd: null,
            });
            mockDb.getMany.mockResolvedValueOnce([
                { id: 'task-a', assigned_agent: 'forge', status: 'in-progress' },
            ]);
            // checkpoint summary query fails (e.g. table doesn't exist on older data dirs)
            mockDb.getMany.mockRejectedValueOnce(new Error('relation "task_checkpoints" does not exist'));

            await sensei.resumeProject('proj-1');

            // Re-dispatch (reset + route) still happened despite the summary failure.
            expect(routeSpy).toHaveBeenCalledWith('proj-1');
        } finally {
            if (originalEnv === undefined) delete process.env['KAGEOPS_TASK_CHECKPOINTS'];
            else process.env['KAGEOPS_TASK_CHECKPOINTS'] = originalEnv;
        }
    });

    // ── P1-05a: iteration tracking on reopen ──

    it('P1-05a: reopenProject (completed→awaiting-input) UPDATE bumps reopen_count + last_reopened_at', async () => {
        const sensei = makeSensei(eventBus);
        // First UPDATE: completed → awaiting-input (succeeds — row returned)
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });

        await sensei.reopenProject('proj-1');

        const [sql] = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/reopen_count = reopen_count \+ 1/);
        expect(sql).toMatch(/last_reopened_at = NOW\(\)/);
        // Existing F-368 phase reset still in place.
        expect(sql).toMatch(/phase = CASE WHEN phase = 'launch-growth' THEN 'development' ELSE phase END/);
    });

    it('P1-05a: reopenProject (cancelled/archived→active) UPDATE also bumps reopen_count', async () => {
        const sensei = makeSensei(eventBus);
        // First UPDATE (completed path) returns no row → fall through
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // Second UPDATE: cancelled/archived → active
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });

        await sensei.reopenProject('proj-1');

        const [, secondSql] = [mockDb.query.mock.calls[0], mockDb.query.mock.calls[1]] as Array<[string, unknown[]]>;
        const [sql] = secondSql as [string, unknown[]];
        expect(sql).toMatch(/status = 'active'/);
        expect(sql).toMatch(/reopen_count = reopen_count \+ 1/);
        expect(sql).toMatch(/last_reopened_at = NOW\(\)/);
    });

    it('P1-05a: reopenProject calls iterationRepository.recordReopen', async () => {
        mockIterationRepo.recordReopen.mockClear();
        const sensei = makeSensei(eventBus);
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });

        await sensei.reopenProject('proj-1');

        expect(mockIterationRepo.recordReopen).toHaveBeenCalledTimes(1);
        expect(mockIterationRepo.recordReopen).toHaveBeenCalledWith('proj-1', null);
    });

    it('P1-05a: reopenProject does NOT touch iteration repo when project is not in a terminal state', async () => {
        mockIterationRepo.recordReopen.mockClear();
        const sensei = makeSensei(eventBus);
        // Both UPDATEs return empty → reopenProject short-circuits
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await sensei.reopenProject('proj-1');

        expect(mockIterationRepo.recordReopen).not.toHaveBeenCalled();
        expect(eventBus.publishedEvents.some((e) => e.channel === 'project.reopened')).toBe(false);
    });

    it('P1-05a: iteration repo failure during reopen does NOT block the reopen (non-fatal)', async () => {
        mockIterationRepo.recordReopen.mockClear();
        mockIterationRepo.recordReopen.mockRejectedValueOnce(new Error('relation "iterations" does not exist'));
        const sensei = makeSensei(eventBus);
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });

        await sensei.reopenProject('proj-1');

        // Iteration write failed but the reopen event still fired (the
        // operator-visible side-effect — Sensei must not strand the
        // operator just because a new schema piece is missing).
        const reopened = eventBus.publishedEvents.filter((e) => e.channel === 'project.reopened');
        expect(reopened).toHaveLength(1);
    });
});

// ── archiveProject ───────────────────────────────────

describe('Sensei.archiveProject (B-402)', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
    });

    it('archives a terminal project and emits project.archived with projectId', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });

        await sensei.archiveProject('proj-1');

        const [sql] = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/status = 'archived'/i);
        expect(sql).toMatch(/archived_at = NOW\(\)/i);
        expect(sql).toMatch(/IN \('completed', 'cancelled'\)/i);
        expect(sql).toMatch(/RETURNING id/i);

        const published = lastPublished(eventBus, 'project.archived');
        expect(published).toBeDefined();
        expect(published?.event['projectId']).toBe('proj-1');
    });

    it('is a no-op when the project is not in a terminal status', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await sensei.archiveProject('proj-active');

        expect(eventBus.publishedEvents.some((e) => e.channel === 'project.archived')).toBe(false);
    });
});

// ── restoreProject ───────────────────────────────────

describe('Sensei.restoreProject (B-402 unarchive)', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
    });

    it('flips archived → active and emits project.restored with projectId', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });

        await sensei.restoreProject('proj-1');

        const [sql] = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/status = 'active'/i);
        expect(sql).toMatch(/archived_at = NULL/i);
        expect(sql).toMatch(/WHERE id = \$1 AND status = 'archived'/i);

        const published = lastPublished(eventBus, 'project.restored');
        expect(published).toBeDefined();
        expect(published?.event['projectId']).toBe('proj-1');
    });

    it('is a no-op when the project is not archived', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await sensei.restoreProject('proj-1');

        expect(eventBus.publishedEvents.some((e) => e.channel === 'project.restored')).toBe(false);
    });
});

// ── getAllProjectsStatus filter semantics (B-402) ────

describe('Sensei.getAllProjectsStatus filter semantics (B-402)', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
    });

    it('default call excludes completed + archived', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getMany.mockResolvedValueOnce([]);

        await sensei.getAllProjectsStatus();

        const [sql, params] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/status <> ALL\(\$1::text\[\]\)/i);
        expect(params[0]).toEqual(['completed', 'archived']);
    });

    it('{ includeArchived: true } surfaces archived rows (still excludes completed)', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getMany.mockResolvedValueOnce([]);

        await sensei.getAllProjectsStatus({ includeArchived: true });

        const [, params] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
        expect(params[0]).toEqual(['completed']);
    });

    it('{ include: [...] } uses an exact whitelist', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getMany.mockResolvedValueOnce([]);

        await sensei.getAllProjectsStatus({ include: ['archived'] });

        const [sql, params] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/status = ANY\(\$1::text\[\]\)/i);
        expect(params[0]).toEqual(['archived']);
    });

    it('{ exclude: [...] } overrides the default + includeArchived', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getMany.mockResolvedValueOnce([]);

        await sensei.getAllProjectsStatus({ exclude: ['paused'], includeArchived: true });

        const [sql, params] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/status <> ALL\(\$1::text\[\]\)/i);
        expect(params[0]).toEqual(['paused']);
    });

    it('{ include: [...] } with an empty array falls back to the exclude path', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getMany.mockResolvedValueOnce([]);

        await sensei.getAllProjectsStatus({ include: [] });

        const [sql] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/status <> ALL/i);
    });
});

// ── reopenProject (F-308 + F-309) ────────────────────

describe('Sensei.reopenProject (F-308 + F-309)', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
    });

    // F-368: reopen from `completed` now lands in `awaiting-input`, not `active`.
    // The legacy "flip to active" path is preserved only for cancelled/archived
    // reopens (which generally have incomplete work to resume).
    it('flips a completed project to awaiting-input and emits project.reopened', async () => {
        const sensei = makeSensei(eventBus);
        // First UPDATE (completed → awaiting-input) hits its row.
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });

        await sensei.reopenProject('proj-1');

        // Only the completed-path UPDATE should fire — the cancelled/archived
        // fallback is skipped because we already transitioned.
        expect(mockDb.query).toHaveBeenCalledTimes(1);
        const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/UPDATE projects/i);
        expect(sql).toMatch(/status = 'awaiting-input'/i);
        expect(sql).toMatch(/status = 'completed'/i);
        // Reopen also resets a terminal launch-growth phase back to
        // development so subsequent /add-requirement can iterate.
        expect(sql).toMatch(/phase = CASE WHEN phase = 'launch-growth' THEN 'development' ELSE phase END/i);
        expect(params).toEqual(['proj-1']);

        const published = lastPublished(eventBus, 'project.reopened');
        expect(published).toBeDefined();
        expect(published?.event['projectId']).toBe('proj-1');
        expect(published?.event['data']).toMatchObject({ fromStatus: 'completed' });
    });

    it('flips a cancelled or archived project back to active (legacy path)', async () => {
        const sensei = makeSensei(eventBus);
        // First UPDATE (completed → awaiting-input) misses — project is cancelled.
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // Second UPDATE (cancelled/archived → active) hits.
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-2' }], rowCount: 1 });

        await sensei.reopenProject('proj-2');

        expect(mockDb.query).toHaveBeenCalledTimes(2);
        const [sql2] = mockDb.query.mock.calls[1] as [string, unknown[]];
        expect(sql2).toMatch(/status = 'active'/i);
        expect(sql2).toMatch(/cancelled_at = NULL/i);
        expect(sql2).toMatch(/archived_at = NULL/i);
        expect(sql2).toMatch(/IN \('cancelled', 'archived'\)/i);

        const published = lastPublished(eventBus, 'project.reopened');
        expect(published).toBeDefined();
        expect(published?.event['data']).toMatchObject({ fromStatus: 'cancelled-or-archived' });
    });

    it('is a no-op when the project is not in a terminal state', async () => {
        const sensei = makeSensei(eventBus);
        // Both UPDATEs miss because status is e.g. 'active' or 'paused'.
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await sensei.reopenProject('proj-active');

        // Both guarded UPDATE queries fire — no event emitted.
        expect(mockDb.query).toHaveBeenCalledTimes(2);
        const published = lastPublished(eventBus, 'project.reopened');
        expect(published).toBeUndefined();
    });
});

// ── closeProject (F-308 + F-309) ─────────────────────

describe('Sensei.closeProject (F-308 + F-309)', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
    });

    it('flips a non-terminal project to completed and emits project.completed', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });
        mockDb.getOne.mockResolvedValueOnce({ name: 'Sample', phase: 'development' });

        await sensei.closeProject('proj-1');

        const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/UPDATE projects/i);
        expect(sql).toMatch(/status = 'completed'/i);
        expect(sql).toMatch(/NOT IN \('completed', 'cancelled', 'archived'\)/i);
        expect(params).toEqual(['proj-1']);

        const published = lastPublished(eventBus, 'project.completed');
        expect(published).toBeDefined();
        expect(published?.event['projectId']).toBe('proj-1');
        const data = published?.event['data'] as Record<string, unknown>;
        expect(data['name']).toBe('Sample');
        expect(data['finalPhase']).toBe('development');
        expect(data['manualClose']).toBe(true);
    });

    it('is a no-op when the project is already terminal', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await sensei.closeProject('proj-completed');

        expect(mockDb.query).toHaveBeenCalledTimes(1);
        const published = lastPublished(eventBus, 'project.completed');
        expect(published).toBeUndefined();
    });
});
