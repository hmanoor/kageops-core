/**
 * Sensei.addRequirement unit tests (F-148 / #148).
 *
 * Covers:
 *   • Successful append on an active project — UPDATE description,
 *     decompose for current phase, route, publish requirement.added.
 *   • Terminal-status refusal (completed / cancelled / archived).
 *   • launch-growth refusal — no more development surface after launch.
 *   • Low-trust + development refusal — drive-by injection blocked.
 *   • Empty / oversized text refusal — input validation.
 *   • Missing-project refusal.
 *   • awaiting-input → active flip on successful injection.
 *
 * The decomposer is allowed to run with sendPrompt → '[]' so it
 * returns zero tasks; the test focuses on the orchestrator method's
 * gates and side effects, not the LLM parsing surface (which has its
 * own dedicated tests).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';

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

// P1-06a: iteration repo dynamic-import captured so the test can
// control which iteration the addRequirement call sees (0 = original
// build → NO revision stamp; 1+ = revision iteration → stamp).
const mockIterationRepo = vi.hoisted(() => ({
    recordOriginal: vi.fn(async () => ({
        id: 'it-0', projectId: 'proj-1', iterationIndex: 0,
        startedAt: '2026-05-24T00:00:00Z', endedAt: null, requirementText: null,
    })),
    recordReopen: vi.fn(async () => ({
        id: 'it-1', projectId: 'proj-1', iterationIndex: 1,
        startedAt: '2026-05-24T01:00:00Z', endedAt: null, requirementText: null,
    })),
    closeCurrent: vi.fn(async () => undefined),
    getCurrent: vi.fn(async () => null),
    listForProject: vi.fn(async () => []),
}));
vi.mock('../../src/db/iteration-repo', () => ({
    iterationRepository: mockIterationRepo,
    createInMemoryIterationRepository: vi.fn(() => mockIterationRepo),
}));

import { Sensei } from '../../src/orchestrator/sensei';
import type { EventBus } from '../../src/orchestrator/event-bus';

function makeSensei(
    eventBus: ReturnType<typeof createMockEventBus>,
    sendPromptOverride?: () => Promise<string>,
): Sensei {
    // Decomposer LLM returns an empty array by default → zero tasks
    // stored, but the addRequirement gates still run and publish.
    // Tests that need real task IDs pass a sendPromptOverride that
    // returns valid JSON; pair that with mocking the INSERT INTO tasks
    // call so storeTasks() returns canned ids.
    const sendPrompt = sendPromptOverride ?? vi.fn(async () => '[]');
    return new Sensei({ sendPrompt }, eventBus as unknown as EventBus);
}

function activeProjectRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'proj-1',
        name: 'Acme Landing',
        description: 'Build a landing page for Acme.',
        phase: 'design-planning',
        status: 'active',
        trust_level: 'medium',
        ...overrides,
    };
}

describe('Sensei.addRequirement (F-148 / #148)', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        // P1-06a: clear iteration-repo mock queues between tests so a
        // queued mockResolvedValueOnce from one test doesn't leak into
        // the next (would otherwise feed the wrong iteration to the
        // next stampRevisionMetadata call).
        mockIterationRepo.recordOriginal.mockClear();
        mockIterationRepo.recordReopen.mockClear();
        mockIterationRepo.closeCurrent.mockClear();
        mockIterationRepo.getCurrent.mockReset();
        mockIterationRepo.listForProject.mockClear();
        eventBus = createMockEventBus();
    });

    it('refuses empty text without touching the DB', async () => {
        const sensei = makeSensei(eventBus);

        const result = await sensei.addRequirement('proj-1', '   ');

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/empty/i);
        expect(mockDb.getOne).not.toHaveBeenCalled();
        expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('refuses oversized text', async () => {
        const sensei = makeSensei(eventBus);

        const result = await sensei.addRequirement('proj-1', 'a'.repeat(2001));

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/exceeds/i);
    });

    it('refuses when project not found', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getOne.mockResolvedValueOnce(null);

        const result = await sensei.addRequirement('missing', 'Add a contact form');

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/not found/i);
        expect(mockDb.query).not.toHaveBeenCalled();
    });

    it.each(['completed', 'cancelled', 'archived'] as const)(
        'refuses when project is %s and points operator at /reopen-project',
        async (terminalStatus) => {
            const sensei = makeSensei(eventBus);
            mockDb.getOne.mockResolvedValueOnce(activeProjectRow({ status: terminalStatus }));

            const result = await sensei.addRequirement('proj-1', 'Add a contact form');

            expect(result.ok).toBe(false);
            expect(result.error).toMatch(new RegExp(terminalStatus, 'i'));
            expect(result.error).toMatch(/reopen/i);
            expect(mockDb.query).not.toHaveBeenCalled();
            expect(eventBus.publishedEvents.length).toBe(0);
        },
    );

    it('refuses when an ACTIVE project is in launch-growth', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getOne.mockResolvedValueOnce(activeProjectRow({ phase: 'launch-growth' }));

        const result = await sensei.addRequirement('proj-1', 'Add a contact form');

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/launch-growth/i);
        // New guidance: wait + reopen, NOT the old misleading /retry-phase pointer.
        expect(result.error).toMatch(/reopen-project/i);
        expect(result.error).not.toMatch(/retry-phase/i);
        expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('auto-heals awaiting-input + launch-growth (reopen leftover) by resetting phase to development', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getOne.mockResolvedValueOnce(
            activeProjectRow({ phase: 'launch-growth', status: 'awaiting-input' }),
        );
        // 1st UPDATE: auto-heal phase reset
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        // 2nd UPDATE: description append
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        // 3rd UPDATE: awaiting-input → active flip
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        // 4th query: routePendingTasks select returns []
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await sensei.addRequirement('proj-1', 'Add a contact form');

        expect(result.ok).toBe(true);
        expect(result.affectedPhase).toBe('development');

        // First query must be the phase-reset UPDATE.
        const firstCall = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(firstCall[0]).toMatch(/UPDATE projects/i);
        expect(firstCall[0]).toMatch(/SET phase = 'development'/i);
        expect(firstCall[1]).toEqual(['proj-1']);

        // The published event reports the post-heal phase.
        const events = eventBus.publishedEvents.filter((e) => e.channel === 'project.requirement.added');
        expect(events).toHaveLength(1);
        const payload = events[0]?.event as Record<string, unknown>;
        expect((payload['data'] as Record<string, unknown>)['phase']).toBe('development');
    });

    it('refuses low-trust mid-development injection', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getOne.mockResolvedValueOnce(activeProjectRow({
            phase: 'development',
            trust_level: 'low',
        }));

        const result = await sensei.addRequirement('proj-1', 'Add a contact form');

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/approval queue/i);
        expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('allows medium-trust mid-development injection', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getOne.mockResolvedValueOnce(activeProjectRow({
            phase: 'development',
            trust_level: 'medium',
        }));
        // UPDATE description
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        // decomposer getPriorPhaseContext getMany returns []
        // routePendingTasks first query returns []
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await sensei.addRequirement('proj-1', 'Add a contact form');

        expect(result.ok).toBe(true);
        expect(result.affectedPhase).toBe('development');
        expect(result.newTaskCount).toBe(0);

        // The first UPDATE writes the new requirement section to description.
        const firstCall = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(firstCall[0]).toMatch(/UPDATE projects/i);
        expect(firstCall[0]).toMatch(/SET description = \$2/i);
        expect(String(firstCall[1]?.[1])).toContain('Add a contact form');
        expect(String(firstCall[1]?.[1])).toMatch(/\[Added \d{4}-\d{2}-\d{2}T/);
    });

    it('publishes project.requirement.added with text + phase on success', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getOne.mockResolvedValueOnce(activeProjectRow());
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await sensei.addRequirement('proj-1', 'Add a contact form');

        expect(result.ok).toBe(true);
        const events = eventBus.publishedEvents.filter((e) => e.channel === 'project.requirement.added');
        expect(events).toHaveLength(1);
        const payload = events[0]?.event as Record<string, unknown>;
        expect(payload['projectId']).toBe('proj-1');
        const data = payload['data'] as Record<string, unknown>;
        expect(data['text']).toBe('Add a contact form');
        expect(data['phase']).toBe('design-planning');
        expect(data['newTaskCount']).toBe(0);
        expect(typeof data['addedAt']).toBe('string');
    });

    it('flips awaiting-input → active when injecting work', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getOne.mockResolvedValueOnce(activeProjectRow({ status: 'awaiting-input' }));
        // 1) UPDATE description
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        // 2) UPDATE status='active'
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        // 3) routePendingTasks pending SELECT
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await sensei.addRequirement('proj-1', 'Add a contact form');

        expect(result.ok).toBe(true);

        const statusUpdate = mockDb.query.mock.calls[1] as [string, unknown[]];
        expect(statusUpdate[0]).toMatch(/SET status = 'active'/i);
        expect(statusUpdate[0]).toMatch(/AND status = 'awaiting-input'/i);
        expect(statusUpdate[1]).toEqual(['proj-1']);
    });

    it('does not flip status when project is already active', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getOne.mockResolvedValueOnce(activeProjectRow({ status: 'active' }));
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await sensei.addRequirement('proj-1', 'Add a contact form');

        // Only 2 query calls: UPDATE description + routePendingTasks SELECT.
        // No status flip when status was already 'active'.
        const statusFlips = mockDb.query.mock.calls.filter(
            (call) => typeof call[0] === 'string' && /SET status = 'active'/i.test(call[0] as string),
        );
        expect(statusFlips).toHaveLength(0);
    });

    it('returns projectName in the success result (used by chat reply)', async () => {
        const sensei = makeSensei(eventBus);
        mockDb.getOne.mockResolvedValueOnce(activeProjectRow({ name: 'Acme Landing' }));
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await sensei.addRequirement('proj-1', 'Add a contact form');

        expect(result.ok).toBe(true);
        expect(result.projectName).toBe('Acme Landing');
    });

    // ── P1-06a: revision metadata stamping ──

    /**
     * Make sendPrompt return a JSON array with N decomposer tasks. The
     * resulting INSERT calls in storeTasks will need matching id-returning
     * mocks (one per task) queued by the caller.
     */
    function jsonResponseFor(tasks: ReadonlyArray<{ readonly title: string; readonly taskType: string; readonly assignedAgent: string }>): () => Promise<string> {
        return vi.fn(async () => JSON.stringify(tasks.map((t) => ({
            title: t.title,
            description: 'desc',
            taskType: t.taskType,
            assignedAgent: t.assignedAgent,
            priority: 5,
            dependsOn: [],
        }))));
    }

    /**
     * Queue the addRequirement query mocks for a revision-iteration
     * path (iteration >= 1, requirement_text null on the iteration row).
     * Real call sequence on `query`:
     *   1. UPDATE description
     *   2. UPDATE awaiting-input → active     (only when startsAwaitingInput)
     *   3..N. INSERT INTO tasks RETURNING id  (one per task; no agent_logs side call in storeTasks)
     *   N+1. stampRevisionMetadata UPDATE tasks
     *   N+2. stampRevisionMetadata UPDATE iterations (because requirement_text was null)
     *   N+3. routePendingTasks SELECT (returns 0 rows)
     *
     * Decomposer side-queries (`getAllowedTaskTypes`, `getPriorPhaseContext`)
     * land on `getOne` / `getMany` and fall through to the default
     * (`null` / `[]`) — no explicit queuing needed for them.
     */
    function queueAddRequirementQueriesForRevision(taskIds: readonly string[], startsAwaitingInput: boolean): void {
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE description
        if (startsAwaitingInput) {
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // awaiting-input → active
        }
        for (const id of taskIds) {
            mockDb.query.mockResolvedValueOnce({ rows: [{ id }], rowCount: 1 }); // INSERT INTO tasks
        }
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: taskIds.length }); // stamp UPDATE tasks
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });            // stamp UPDATE iterations
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });            // routePendingTasks SELECT
    }

    it('P1-06a: stamps task_type=revision + iteration_id + revision_instruction when iteration >= 1', async () => {
        mockIterationRepo.getCurrent.mockResolvedValueOnce({
            id: 'it-1', projectId: 'proj-1', iterationIndex: 1,
            startedAt: '2026-05-24T01:00:00Z', endedAt: null, requirementText: null,
        });
        const sensei = makeSensei(eventBus, jsonResponseFor([
            { title: 'Add contact form', taskType: 'create-ui', assignedAgent: 'forge' },
        ]));
        mockDb.getOne.mockResolvedValueOnce(activeProjectRow({ status: 'awaiting-input', phase: 'development' }));
        queueAddRequirementQueriesForRevision(['task-A'], true);

        const result = await sensei.addRequirement('proj-1', 'add a contact form');

        expect(result.ok).toBe(true);
        expect(result.newTaskCount).toBe(1);

        // Find the stamping UPDATE in the recorded SQL calls.
        const updateCalls = mockDb.query.mock.calls.filter(
            (c) => typeof c[0] === 'string' && (c[0] as string).includes("SET task_type = 'revision'"),
        );
        expect(updateCalls).toHaveLength(1);
        const [sql, params] = updateCalls[0] as [string, unknown[]];
        expect(sql).toMatch(/iteration_id = \$2/);
        expect(sql).toMatch(/revision_instruction = \$3/);
        expect(sql).toMatch(/WHERE id = ANY\(\$1::uuid\[\]\)/);
        expect(params[0]).toEqual(['task-A']);
        expect(params[1]).toBe('it-1');
        expect(params[2]).toBe('add a contact form');
    });

    it('P1-06a: backfills iteration.requirement_text when the iteration row had it null', async () => {
        mockIterationRepo.getCurrent.mockResolvedValueOnce({
            id: 'it-1', projectId: 'proj-1', iterationIndex: 1,
            startedAt: '2026-05-24T01:00:00Z', endedAt: null, requirementText: null,
        });
        const sensei = makeSensei(eventBus, jsonResponseFor([
            { title: 'Add contact form', taskType: 'create-ui', assignedAgent: 'forge' },
        ]));
        mockDb.getOne.mockResolvedValueOnce(activeProjectRow({ status: 'awaiting-input', phase: 'development' }));
        queueAddRequirementQueriesForRevision(['task-A'], true);

        await sensei.addRequirement('proj-1', 'add a contact form');

        const iterationUpdate = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE iterations'),
        );
        expect(iterationUpdate).toBeDefined();
        const [sql, params] = iterationUpdate as [string, unknown[]];
        expect(sql).toMatch(/SET requirement_text = \$2/);
        expect(sql).toMatch(/requirement_text IS NULL/); // idempotency guard
        expect(params[0]).toBe('it-1');
        expect(params[1]).toBe('add a contact form');
    });

    it('P1-06a: does NOT backfill iteration.requirement_text when already set', async () => {
        mockIterationRepo.getCurrent.mockResolvedValueOnce({
            id: 'it-1', projectId: 'proj-1', iterationIndex: 1,
            startedAt: '2026-05-24T01:00:00Z', endedAt: null,
            requirementText: 'an earlier requirement',  // already populated
        });
        const sensei = makeSensei(eventBus, jsonResponseFor([
            { title: 'Another task', taskType: 'create-ui', assignedAgent: 'forge' },
        ]));
        mockDb.getOne.mockResolvedValueOnce(activeProjectRow({ status: 'awaiting-input', phase: 'development' }));
        // No iteration UPDATE expected this time — skip queueing it.
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE description
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE awaiting-input → active
        mockDb.getOne.mockResolvedValueOnce({ phase_task_selections: null });
        mockDb.getMany.mockResolvedValueOnce([]);
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-B' }], rowCount: 1 }); // INSERT task
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // agent_logs
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // stamp UPDATE tasks
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // routePendingTasks

        await sensei.addRequirement('proj-1', 'another requirement');

        const iterationUpdates = mockDb.query.mock.calls.filter(
            (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE iterations'),
        );
        expect(iterationUpdates).toHaveLength(0);
    });

    it('P1-06a: does NOT stamp revision metadata on iteration 0 (original build)', async () => {
        mockIterationRepo.getCurrent.mockResolvedValueOnce({
            id: 'it-0', projectId: 'proj-1', iterationIndex: 0,
            startedAt: '2026-05-24T00:00:00Z', endedAt: null, requirementText: null,
        });
        const sensei = makeSensei(eventBus, jsonResponseFor([
            { title: 'Mid-original-build addition', taskType: 'create-ui', assignedAgent: 'forge' },
        ]));
        mockDb.getOne.mockResolvedValueOnce(activeProjectRow({ status: 'active', phase: 'development' }));
        // No awaiting-input flip, no revision UPDATE, no iteration backfill.
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE description
        mockDb.getOne.mockResolvedValueOnce({ phase_task_selections: null });
        mockDb.getMany.mockResolvedValueOnce([]);
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-O' }], rowCount: 1 });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // routePendingTasks

        await sensei.addRequirement('proj-1', 'mid-original-build addition');

        const stampCalls = mockDb.query.mock.calls.filter(
            (c) => typeof c[0] === 'string' && (c[0] as string).includes("SET task_type = 'revision'"),
        );
        expect(stampCalls).toHaveLength(0);
        const iterationUpdates = mockDb.query.mock.calls.filter(
            (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE iterations'),
        );
        expect(iterationUpdates).toHaveLength(0);
    });

    it('P1-06a: skips stamping when decomposer returns zero tasks', async () => {
        mockIterationRepo.getCurrent.mockResolvedValueOnce({
            id: 'it-1', projectId: 'proj-1', iterationIndex: 1,
            startedAt: '2026-05-24T01:00:00Z', endedAt: null, requirementText: null,
        });
        const sensei = makeSensei(eventBus);  // default '[]' → 0 tasks
        mockDb.getOne.mockResolvedValueOnce(activeProjectRow({ status: 'awaiting-input', phase: 'development' }));
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE description
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE awaiting-input → active
        mockDb.getOne.mockResolvedValueOnce({ phase_task_selections: null });
        mockDb.getMany.mockResolvedValueOnce([]);
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // routePendingTasks

        const result = await sensei.addRequirement('proj-1', 'something the LLM ignored');

        expect(result.ok).toBe(true);
        expect(result.newTaskCount).toBe(0);
        // No revision stamping when there are no tasks to stamp.
        const stampCalls = mockDb.query.mock.calls.filter(
            (c) => typeof c[0] === 'string' && (c[0] as string).includes("SET task_type = 'revision'"),
        );
        expect(stampCalls).toHaveLength(0);
    });

    it('P1-06a: stampRevisionMetadata failure does NOT break addRequirement (non-fatal)', async () => {
        // Iteration repo throws — we still want the requirement to land.
        mockIterationRepo.getCurrent.mockRejectedValueOnce(new Error('relation "iterations" does not exist'));
        const sensei = makeSensei(eventBus, jsonResponseFor([
            { title: 'Add it', taskType: 'create-ui', assignedAgent: 'forge' },
        ]));
        mockDb.getOne.mockResolvedValueOnce(activeProjectRow({ status: 'awaiting-input', phase: 'development' }));
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE description
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE awaiting-input → active
        mockDb.getOne.mockResolvedValueOnce({ phase_task_selections: null });
        mockDb.getMany.mockResolvedValueOnce([]);
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-X' }], rowCount: 1 }); // INSERT task
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // agent_logs
        // No stamp queries (because iteration repo threw early); routePendingTasks fires:
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await sensei.addRequirement('proj-1', 'a thing');

        expect(result.ok).toBe(true);
        expect(result.newTaskCount).toBe(1);
    });
});

// ── /add-requirement chat dispatch (#155 — global-chat fix) ──────────

describe('Sensei chat dispatch — /add-requirement (#155)', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
    });

    /**
     * Helper — drive a chat turn through handleUserMessage and return the
     * assistant reply. Stubs the LLM so a fall-through path is detectable
     * (its reply differs from the slash-command reply).
     */
    async function chat(
        sensei: Sensei,
        message: string,
        channelId: string = 'command-center',
    ): Promise<string> {
        return sensei.handleUserMessage(message, channelId);
    }

    function senseiWithLLM(reply: string): Sensei {
        const sendPrompt = vi.fn(async () => reply);
        const sendConversation = vi.fn(async () => reply);
        return new Sensei(
            { sendPrompt, sendConversation },
            eventBus as unknown as EventBus,
        );
    }

    it('global chat with /add-requirement and exactly one active project dispatches to that project', async () => {
        const sensei = senseiWithLLM('LLM fallback should not run');

        // 1) handleUserMessage → buildProjectStateBlock → getAllProjectsStatus
        //    getMany returns [] (so the LLM grounding block is empty)
        // BUT tryAddRequirementCommand short-circuits BEFORE that.
        //
        // tryAddRequirementCommand → resolveActiveProject → getMany 'active' projects
        mockDb.getMany.mockResolvedValueOnce([{ id: 'proj-acme', name: 'Acme Landing' }]);
        // Then addRequirement → getOne project row
        mockDb.getOne.mockResolvedValueOnce({
            id: 'proj-acme',
            name: 'Acme Landing',
            description: 'd',
            phase: 'design-planning',
            status: 'active',
            trust_level: 'medium',
        });
        // UPDATE description + routePendingTasks SELECT
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const reply = await chat(sensei, '/add-requirement add a contact form');

        expect(reply).toMatch(/Added the requirement to \*\*Acme Landing\*\*/);
        expect(reply).toMatch(/design-planning phase/);
        expect(reply).not.toMatch(/LLM fallback/);
    });

    it('global chat with /add-requirement and zero active projects refuses with helpful message', async () => {
        const sensei = senseiWithLLM('LLM fallback should not run');
        // resolveActiveProject getMany → no active projects
        mockDb.getMany.mockResolvedValueOnce([]);

        const reply = await chat(sensei, '/add-requirement add a contact form');

        expect(reply).toMatch(/No active projects/i);
        expect(reply).toMatch(/Mission Control/);
        expect(reply).not.toMatch(/LLM fallback/);
        // Did NOT call addRequirement — no UPDATE projects query fired.
        const dbCalls = mockDb.query.mock.calls.filter(
            (c) => typeof c[0] === 'string' && /UPDATE projects/i.test(c[0] as string),
        );
        expect(dbCalls).toHaveLength(0);
    });

    it('global chat with /add-requirement and multiple active projects refuses and lists them', async () => {
        const sensei = senseiWithLLM('LLM fallback should not run');
        mockDb.getMany.mockResolvedValueOnce([
            { id: 'proj-a', name: 'Acme Landing' },
            { id: 'proj-b', name: 'Bravo App' },
            { id: 'proj-c', name: 'Charlie SaaS' },
        ]);

        const reply = await chat(sensei, '/add-requirement add a contact form');

        expect(reply).toMatch(/3 active projects/);
        expect(reply).toMatch(/Acme Landing/);
        expect(reply).toMatch(/Bravo App/);
        expect(reply).toMatch(/Charlie SaaS/);
        expect(reply).toMatch(/--project <id>/);
        // Did NOT dispatch.
        const dbCalls = mockDb.query.mock.calls.filter(
            (c) => typeof c[0] === 'string' && /UPDATE projects/i.test(c[0] as string),
        );
        expect(dbCalls).toHaveLength(0);
    });

    it('global chat with --project <id> targets that explicit project, skipping resolver', async () => {
        const sensei = senseiWithLLM('LLM fallback should not run');
        // addRequirement → getOne for the explicit project id
        mockDb.getOne.mockResolvedValueOnce({
            id: 'proj-explicit',
            name: 'Explicit Pick',
            description: 'd',
            phase: 'development',
            status: 'active',
            trust_level: 'high',
        });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const reply = await chat(
            sensei,
            '/add-requirement --project proj-explicit add a contact form',
        );

        expect(reply).toMatch(/\*\*Explicit Pick\*\*/);
        expect(reply).toMatch(/development phase/);
        // resolveActiveProject was NOT consulted (no getMany active call).
        const activeQueries = mockDb.getMany.mock.calls.filter(
            (c) => typeof c[0] === 'string' && /status = 'active'/i.test(c[0] as string),
        );
        expect(activeQueries).toHaveLength(0);
    });

    it('focusProjectId trumps the active-project resolver', async () => {
        const sensei = senseiWithLLM('LLM fallback should not run');
        sensei.setFocusProject('proj-focused');

        mockDb.getOne.mockResolvedValueOnce({
            id: 'proj-focused',
            name: 'Focused Run',
            description: 'd',
            phase: 'discovery',
            status: 'active',
            trust_level: 'medium',
        });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const reply = await chat(sensei, '/add-requirement add a contact form');

        expect(reply).toMatch(/\*\*Focused Run\*\*/);
        // Resolver short-circuited on focus — no `status='active'` query.
        const activeQueries = mockDb.getMany.mock.calls.filter(
            (c) => typeof c[0] === 'string' && /status = 'active'/i.test(c[0] as string),
        );
        expect(activeQueries).toHaveLength(0);
    });

    it('bare /add-requirement with no body returns usage help, not a refusal', async () => {
        const sensei = senseiWithLLM('LLM fallback should not run');

        const reply = await chat(sensei, '/add-requirement');

        expect(reply).toMatch(/Usage: `\/add-requirement <text>`/);
        // No DB writes — pure usage hint.
        expect(mockDb.query).not.toHaveBeenCalled();
        expect(mockDb.getOne).not.toHaveBeenCalled();
    });

    it('non-slash messages fall through to the LLM (regression guard)', async () => {
        const sensei = senseiWithLLM('LLM response from fallback');
        // buildProjectStateBlock getMany, getActiveWorkByAgent getMany,
        // searchHelp may not be wired — just make sure DB calls don't break.
        mockDb.getMany.mockResolvedValue([]);

        const reply = await chat(sensei, 'how are you?');

        expect(reply).toBe('LLM response from fallback');
    });

    // ── @AgentName: prefix support (#158 — Plant Maintenance Book repro) ──

    it('strips leading @AgentName: prefix from Autonauts agent-detail chat', async () => {
        const sensei = senseiWithLLM('LLM fallback should not run');
        mockDb.getMany.mockResolvedValueOnce([{ id: 'proj-pmb', name: 'Plant Maintenance Book' }]);
        mockDb.getOne.mockResolvedValueOnce({
            id: 'proj-pmb',
            name: 'Plant Maintenance Book',
            description: 'd',
            phase: 'development',
            status: 'active',
            trust_level: 'medium',
        });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        // What the Autonauts view actually sends today: `@Herald: /add-requirement ...`
        // Verifies the regex strips the prefix and dispatches correctly.
        const reply = await chat(
            sensei,
            '@Herald: /add-requirement Generate a PDF version of the Plant Maintenance book',
        );

        expect(reply).toMatch(/Added the requirement to \*\*Plant Maintenance Book\*\*/);
        expect(reply).not.toMatch(/LLM fallback/);
    });

    it('strips @-prefix variants — different agent names, casing, hyphens', async () => {
        const sensei = senseiWithLLM('LLM fallback should not run');

        // Sticky mocks — each chat() turn calls getMany twice (once for
        // resolveActiveProject, once for decompose.getPriorPhaseContext)
        // and getOne once. Setting them as default-return rather than
        // queue-once lets the loop run cleanly without per-iteration
        // re-priming.
        mockDb.getMany.mockResolvedValue([{ id: 'proj-x', name: 'Acme' }]);
        mockDb.getOne.mockResolvedValue({
            id: 'proj-x',
            name: 'Acme',
            description: 'd',
            phase: 'development',
            status: 'active',
            trust_level: 'medium',
        });
        mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });

        const variants = [
            '@Forge: /add-requirement add a contact form',
            '@pixel: /add-requirement add a contact form',         // lowercase agent
            '@vendor-team: /add-requirement add a contact form',   // hyphenated mention
        ];
        for (const msg of variants) {
            const reply = await chat(sensei, msg);
            expect(reply).toMatch(/Added the requirement to \*\*Acme\*\*/);
        }
    });

    it('non-mention @ prefixes do NOT strip — preserves user intent', async () => {
        const sensei = senseiWithLLM('LLM response from fallback');
        mockDb.getMany.mockResolvedValue([]);

        // Edge case: a message that starts with @ but isn't a mention
        // (e.g. talking about an email address) should NOT be stripped
        // and should fall through to the LLM normally.
        const reply = await chat(sensei, '@user@example.com is the contact');

        // Regex requires `:` after the @<word> — "@user@..." doesn't match.
        // Falls through to LLM.
        expect(reply).toBe('LLM response from fallback');
    });
});
