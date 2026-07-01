/**
 * Sensei.resumeProject() — unit tests for Feature #2 (Resume-from-phase).
 *
 * Covers the headless re-attach path:
 *  - Resuming an active project with pending tasks → re-dispatches them.
 *  - Resuming an active project with no tasks for current phase → decomposes.
 *  - Resuming a non-existent ID → throws.
 *  - Resuming a completed/cancelled project → throws.
 *  - Resuming a paused project → flips to active and re-routes (legacy path).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';

// ── Mock setup ───────────────────────────────────────────────────────────────

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

// Import AFTER mock registration.
import { Sensei } from '../../src/orchestrator/sensei';
import type { EventBus } from '../../src/orchestrator/event-bus';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface ProjectRow {
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
    readonly phase: string;
    readonly status: string;
    readonly trust_level: string;
    readonly project_type: string | null;
    readonly enabled_phases: readonly string[] | null;
    readonly tech_stack: string | null;
    readonly goal: string | null;
    readonly budget_usd: string | null;
}

function makeProjectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
    return {
        id: 'proj-resume-1',
        name: 'Resumed Project',
        description: 'A test resumed project',
        phase: 'development',
        status: 'active',
        trust_level: 'low',
        project_type: null,
        enabled_phases: null,
        tech_stack: null,
        goal: null,
        budget_usd: null,
        ...overrides,
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Sensei.resumeProject()', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;
    let sendPrompt: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
        sendPrompt = vi.fn(async () => '[]');
    });

    function makeSensei(): Sensei {
        return new Sensei({ sendPrompt }, eventBus as unknown as EventBus);
    }

    // ── Re-dispatch path (pending tasks exist) ───────────────────────────────

    /** Spy on the internal TaskRouter.routePendingTasks without driving its
     *  deep SQL — the BPF-21 contract is "reset non-terminal → pending, then
     *  routePendingTasks", and these tests assert that contract directly. */
    function spyRoutePending(sensei: Sensei): ReturnType<typeof vi.fn> {
        const router = (sensei as unknown as {
            router: { routePendingTasks: (id: string) => Promise<void> };
        }).router;
        return vi.spyOn(router, 'routePendingTasks').mockResolvedValue(undefined) as unknown as ReturnType<typeof vi.fn>;
    }

    it('resets non-terminal tasks to pending then routes (no decompose) on resume', async () => {
        // First getOne: project lookup
        mockDb.getOne.mockResolvedValueOnce(makeProjectRow({ phase: 'development' }));
        // getMany: non-terminal tasks for current phase
        mockDb.getMany.mockResolvedValueOnce([
            { id: 'task-pending-1', assigned_agent: null, status: 'pending' },
        ]);
        // reset UPDATE
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const sensei = makeSensei();
        const routeSpy = spyRoutePending(sensei);
        await sensei.resumeProject('proj-resume-1');

        // Decomposer must NOT have been called — the whole point of resume.
        expect(sendPrompt).not.toHaveBeenCalled();
        // routePendingTasks dispatches roots (deps = completed tasks) + cascades.
        expect(routeSpy).toHaveBeenCalledWith('proj-resume-1');
    });

    it('BPF-21: resets stuck assigned/in-progress tasks to pending, then routes (no bare re-publish)', async () => {
        // Regression for the resume deadlock: the old code bare-re-published
        // task.assigned for in-progress tasks WITHOUT clearing the claim, so a
        // dependency-gated graph never unblocked and the resume idled to the
        // wall-clock timeout. Now it reset-then-routes.
        mockDb.getOne.mockResolvedValueOnce(makeProjectRow({ phase: 'development' }));
        mockDb.getMany.mockResolvedValueOnce([
            { id: 'task-asg-1', assigned_agent: 'forge', status: 'assigned' },
            { id: 'task-ip-1', assigned_agent: 'forge', status: 'in-progress' },
        ]);
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 2 }); // reset UPDATE

        const sensei = makeSensei();
        const routeSpy = spyRoutePending(sensei);
        await sensei.resumeProject('proj-resume-1');

        expect(sendPrompt).not.toHaveBeenCalled();

        // The reset UPDATE flips every non-terminal task → a clean 'pending'
        // (drops the stale claim) so routePendingTasks can re-dispatch.
        const resetCall = mockDb.query.mock.calls.find(([sql]) => {
            const s = sql as string;
            return /SET status = 'pending'/.test(s) && /IN \('assigned', 'in-progress', 'blocked'\)/.test(s);
        });
        expect(resetCall).toBeDefined();

        // Routes via routePendingTasks — NOT a bare task.assigned re-publish.
        expect(routeSpy).toHaveBeenCalledWith('proj-resume-1');
        const bareReassign = eventBus.publishedEvents.filter((e) => e.channel === 'task.assigned');
        expect(bareReassign.length).toBe(0);
    });

    it('BPF-22: revives a BLOCKED gating task on resume (deadlock breaker)', async () => {
        // The real ClubHub deadlock: "Setup Project Scaffold" exhausted its
        // retries → status 'blocked'; every other dev task depended on it, so
        // the phase was permanently gated. The reset must include 'blocked' or
        // the gating task is never revived and the resume idles forever.
        mockDb.getOne.mockResolvedValueOnce(makeProjectRow({ phase: 'development' }));
        // The phase contains a blocked gating task + its dependents (pending).
        mockDb.getMany.mockResolvedValueOnce([
            { id: 'scaffold', assigned_agent: 'forge', status: 'blocked' },
            { id: 'landing', assigned_agent: 'forge', status: 'pending' },
        ]);
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 2 }); // reset UPDATE

        const sensei = makeSensei();
        const routeSpy = spyRoutePending(sensei);
        await sensei.resumeProject('proj-resume-1');

        // The blocked SELECT + reset both include 'blocked'.
        const selectCall = mockDb.getMany.mock.calls.find(([sql]) =>
            /status IN \('pending', 'assigned', 'in-progress', 'blocked'\)/.test(sql as string),
        );
        expect(selectCall).toBeDefined();
        const resetCall = mockDb.query.mock.calls.find(([sql]) => {
            const s = sql as string;
            return /SET status = 'pending'/.test(s) && /'blocked'/.test(s);
        });
        expect(resetCall).toBeDefined();
        expect(routeSpy).toHaveBeenCalledWith('proj-resume-1');

        // BPF-24: the revived blocked task's poisoned checkpoints are cleared
        // so it re-runs the AI fresh (not replay the cached failure output).
        const clearCall = mockDb.query.mock.calls.find(([sql]) =>
            /DELETE FROM task_checkpoints/.test(sql as string),
        );
        expect(clearCall).toBeDefined();
    });

    // ── Decompose path (no pending tasks) ────────────────────────────────────

    it('decomposes fresh tasks when current phase has zero pending tasks', async () => {
        mockDb.getOne.mockResolvedValueOnce(makeProjectRow({ phase: 'poc', name: 'PocApp' }));
        // getMany: no pending tasks
        mockDb.getMany.mockResolvedValueOnce([]);
        // Decomposer reads the project name+description it already has.
        // It will sendPrompt → return [] (empty task list, valid JSON).
        // Then INSERT INTO tasks won't run. Then routePendingTasks SELECT pending → empty.
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const sensei = makeSensei();
        await sensei.resumeProject('proj-resume-1');

        // Decomposer ran exactly once for the current phase ('poc').
        expect(sendPrompt).toHaveBeenCalledOnce();
        const [systemPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(systemPrompt.toLowerCase()).toContain('poc');
    });

    // ── Error paths ──────────────────────────────────────────────────────────

    it('throws when the project does not exist', async () => {
        mockDb.getOne.mockResolvedValueOnce(null);
        const sensei = makeSensei();
        await expect(sensei.resumeProject('missing-id')).rejects.toThrow(/not found/i);
    });

    it('throws when the project is already complete', async () => {
        mockDb.getOne.mockResolvedValueOnce(makeProjectRow({ status: 'completed' }));
        const sensei = makeSensei();
        await expect(sensei.resumeProject('proj-resume-1')).rejects.toThrow(/already complete/i);
    });

    it('throws when the project was cancelled', async () => {
        mockDb.getOne.mockResolvedValueOnce(makeProjectRow({ status: 'cancelled' }));
        const sensei = makeSensei();
        await expect(sensei.resumeProject('proj-resume-1')).rejects.toThrow(/cancelled/i);
    });

    // ── Pause/resume path (legacy, status='paused') ──────────────────────────

    it('flips a paused project back to active and re-routes pending', async () => {
        mockDb.getOne.mockResolvedValueOnce(makeProjectRow({ status: 'paused' }));
        // UPDATE projects status='active' RETURNING id
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-resume-1' }], rowCount: 1 });
        // getMany: in-flight tasks
        mockDb.getMany.mockResolvedValueOnce([]);
        // routePendingTasks SELECT — no pending
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const sensei = makeSensei();
        await sensei.resumeProject('proj-resume-1');

        const resumed = eventBus.publishedEvents.filter((e) => e.channel === 'project.resumed');
        expect(resumed.length).toBe(1);
        // Decomposer is NOT called for paused → active resumption.
        expect(sendPrompt).not.toHaveBeenCalled();
    });
});
