/**
 * Sensei orchestrator unit tests
 *
 * Sensei constructs TaskDecomposer, TaskRouter, PhaseGateManager, and
 * SpecialityMatrix internally — all of which call db/client.
 * Mocking db/client is sufficient to control all internal module behaviour.
 *
 * EventBus is provided externally via constructor so it is mocked directly.
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

// Import AFTER mock registration.
import { Sensei } from '../../src/orchestrator/sensei';
import { tierPlanGate } from '../../src/shared/plan-gate';
import type { EventBus, EventPayload } from '../../src/orchestrator/event-bus';
import type { CommsSender } from '../../src/comms/comms-sender';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal valid JSON task list that the decomposer will accept. */
const VALID_TASK_JSON = JSON.stringify([
    {
        title: 'Market Research',
        description: 'Conduct market research',
        taskType: 'research',
        assignedAgent: 'scout',
        priority: 8,
        dependsOn: [],
    },
]);

function makeSendPrompt(response = VALID_TASK_JSON): ReturnType<typeof vi.fn> {
    return vi.fn(async (_sys: string, _user: string) => response);
}

/**
 * Configure mockDb so startProject() can complete without throwing.
 *
 * Call order inside startProject:
 *   1. query (SELECT id,status … duplicate check)   → empty rows = no duplicate
 *   2. query (INSERT projects RETURNING id)         → needs { rows: [{ id }] }
 *   3. query (INSERT tasks RETURNING id) × N tasks  → needs { rows: [{ id }] }
 *   4. query (SELECT pending tasks for router)      → returns { rows: [] }
 */
function setupStartProject(projectId = 'proj-abc'): void {
    // Call 1: duplicate-check SELECT → no existing project
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Call 2: INSERT projects
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: projectId }], rowCount: 1 });
    // Call 3: INSERT task (one task from VALID_TASK_JSON)
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 });
    // Call 4: SELECT pending tasks for router (no pending tasks → router does nothing more)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Sensei', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;
    let sendPrompt: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
        sendPrompt = makeSendPrompt();
    });

    function makeSensei(): Sensei {
        // Cast the mock to EventBus — structurally compatible at runtime.
        return new Sensei({ sendPrompt }, eventBus as unknown as EventBus);
    }

    // ── start() ──────────────────────────────────────────────────────────────

    describe('start()', () => {
        it('calls eventBus.connect() and subscribeAll() on first start', async () => {
            const sensei = makeSensei();

            await sensei.start();

            expect(eventBus.connect).toHaveBeenCalledOnce();
            expect(eventBus.subscribeAll).toHaveBeenCalledOnce();
        });

        it('is idempotent — second call is a no-op and does not connect again', async () => {
            const sensei = makeSensei();

            await sensei.start();
            await sensei.start();

            expect(eventBus.connect).toHaveBeenCalledOnce();
            expect(eventBus.subscribeAll).toHaveBeenCalledOnce();
        });

        it('registers a callback with subscribeAll', async () => {
            const sensei = makeSensei();

            await sensei.start();

            const [callback] = eventBus.subscribeAll.mock.calls[0] as [unknown];
            expect(typeof callback).toBe('function');
        });
    });

    // ── stop() ───────────────────────────────────────────────────────────────

    describe('stop()', () => {
        it('calls eventBus.disconnect()', async () => {
            const sensei = makeSensei();
            await sensei.start();

            await sensei.stop();

            expect(eventBus.disconnect).toHaveBeenCalledOnce();
        });

        it('can be called without a prior start() without throwing', async () => {
            const sensei = makeSensei();

            await expect(sensei.stop()).resolves.not.toThrow();
            expect(eventBus.disconnect).toHaveBeenCalledOnce();
        });
    });

    // ── startProject() ───────────────────────────────────────────────────────

    describe('startProject()', () => {
        it('inserts a project row into the DB and returns its id', async () => {
            setupStartProject('proj-123');
            const sensei = makeSensei();

            const id = await sensei.startProject('Test Project', 'A test', 'low');

            expect(id).toBe('proj-123');

            // calls[0] is the duplicate-check SELECT; calls[1] is the INSERT
            const [sql, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
            expect(sql).toMatch(/INSERT INTO projects/i);
            expect(params[0]).toBe('Test Project');
            expect(params[1]).toBe('A test');
        });

        it('inserts the project with the provided trust_level', async () => {
            setupStartProject('proj-trust');
            const sensei = makeSensei();

            await sensei.startProject('Trusted App', 'description', 'high');

            // calls[1] is the INSERT (calls[0] is the duplicate-check SELECT)
            // params: $1=name, $2=description, $3=repo_path, $4=phase, $5=trust_level
            const [, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
            expect(params[4]).toBe('high');
        });

        it('uses trust level "low" by default when not specified', async () => {
            setupStartProject('proj-default');
            const sensei = makeSensei();

            await sensei.startProject('Default Trust', 'description');

            // calls[1] is the INSERT (calls[0] is the duplicate-check SELECT)
            // params: $1=name, $2=description, $3=repo_path, $4=phase, $5=trust_level
            const [, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
            expect(params[4]).toBe('low');
        });

        it('calls sendPrompt to decompose tasks for the discovery phase', async () => {
            setupStartProject('proj-decompose');
            const sensei = makeSensei();

            await sensei.startProject('My App', 'An app description', 'medium');

            expect(sendPrompt).toHaveBeenCalledOnce();

            const [systemPrompt, userPrompt] = sendPrompt.mock.calls[0] as [string, string];
            expect(systemPrompt).toMatch(/discovery/i);
            expect(userPrompt).toContain('My App');
            expect(userPrompt).toContain('An app description');
        });

        it('inserts the task returned by the decomposer', async () => {
            setupStartProject('proj-tasks');
            const sensei = makeSensei();

            await sensei.startProject('Task Project', 'desc');

            // Second query call is the INSERT INTO tasks
            const insertTaskCall = mockDb.query.mock.calls.find(
                ([sql]) => (sql as string).match(/INSERT INTO tasks/i)
            );
            expect(insertTaskCall).toBeDefined();
        });

        it('derives repo_path from the project name (lowercased, spaces replaced with dashes)', async () => {
            setupStartProject('proj-path');
            const sensei = makeSensei();

            await sensei.startProject('My Cool Project', 'desc');

            // calls[1] is the INSERT (calls[0] is the duplicate-check SELECT)
            const [, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
            // No workspaceManager in test — uses absolute baseDir/slug fallback
            expect(params[2] as string).toMatch(/my-cool-project$/);
        });

        // ── #165 stage 2 — phase_task_selections persistence ─────────────

        it('passes NULL for phase_task_selections when the operator did not pick any (legacy)', async () => {
            setupStartProject('proj-no-selections');
            const sensei = makeSensei();

            await sensei.startProject('Legacy Project', 'desc', 'low');

            const [sql, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
            expect(sql).toMatch(/phase_task_selections/i);
            // params[10] is the new phase_task_selections column. Null = legacy.
            expect(params[10]).toBeNull();
        });

        it('persists phase_task_selections as a JSON string when the operator picks an allowlist', async () => {
            setupStartProject('proj-with-selections');
            const sensei = makeSensei();

            await sensei.startProject('POC Project', 'desc', {
                trustLevel: 'low',
                phaseTaskSelections: {
                    discovery: ['concept-brief', 'feasibility-assessment'],
                    development: ['implement'],
                },
            });

            const [sql, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
            expect(sql).toMatch(/phase_task_selections/i);
            expect(typeof params[10]).toBe('string');
            const parsed = JSON.parse(params[10] as string) as Record<string, string[]>;
            expect(parsed.discovery).toEqual(['concept-brief', 'feasibility-assessment']);
            expect(parsed.development).toEqual(['implement']);
        });

        it('drops empty-array entries and unknown phase keys from phase_task_selections before persisting', async () => {
            setupStartProject('proj-clean-selections');
            const sensei = makeSensei();

            await sensei.startProject('Sanitised Project', 'desc', {
                trustLevel: 'low',
                phaseTaskSelections: {
                    discovery: ['concept-brief'],
                    'fake-phase': ['x'],         // unknown phase — dropped
                    development: [],              // empty array — dropped
                } as unknown as Record<string, readonly string[]>,
            });

            const [, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
            expect(typeof params[10]).toBe('string');
            const parsed = JSON.parse(params[10] as string) as Record<string, unknown>;
            expect(Object.keys(parsed).sort()).toEqual(['discovery']);
        });

        it('writes NULL when phase_task_selections sanitises to an empty map', async () => {
            setupStartProject('proj-empty-selections');
            const sensei = makeSensei();

            await sensei.startProject('Empty Selections', 'desc', {
                trustLevel: 'low',
                phaseTaskSelections: {
                    'fake-phase': ['x'],
                    development: [],
                } as unknown as Record<string, readonly string[]>,
            });

            const [, params] = mockDb.query.mock.calls[1] as [string, unknown[]];
            expect(params[10]).toBeNull();
        });

        // ── Pillar 2.2 PR-E — operator bundle pick threads through to DB ──
        //
        // These tests use a SQL-pattern mock so any UPDATE selected_bundle
        // call (which lands BETWEEN the INSERT projects and INSERT tasks
        // calls when flag is on) doesn't shift the mockResolvedValueOnce
        // queue and break unrelated assertions.

        function setupStartProjectByPattern(projectId: string): void {
            mockDb.query.mockImplementation(async (sql: string) => {
                if (/^SELECT id, status FROM projects/i.test(sql)) {
                    return { rows: [], rowCount: 0 };
                }
                if (/INSERT INTO projects/i.test(sql)) {
                    return { rows: [{ id: projectId }], rowCount: 1 };
                }
                if (/INSERT INTO tasks/i.test(sql)) {
                    return { rows: [{ id: `task-${Math.random().toString(36).slice(2, 8)}` }], rowCount: 1 };
                }
                return { rows: [], rowCount: 0 };
            });
        }

        it('persists operator-picked selectedBundle to projects.selected_bundle (skips matcher)', async () => {
            setupStartProjectByPattern('proj-operator-pick');
            const sensei = makeSensei();

            await sensei.startProject('HabitForge', 'Habit tracker SaaS', {
                trustLevel: 'low',
                selectedBundle: 'nextjs-saas',
            });

            const updateCall = mockDb.query.mock.calls.find(
                ([sql, params]) =>
                    typeof sql === 'string' &&
                    /UPDATE projects SET selected_bundle/i.test(sql) &&
                    (params as unknown[])[0] === 'stack::nextjs-saas'
            );
            expect(updateCall).toBeDefined();
        });

        it('falls back to matcher when operator picks a bundle that does not exist', async () => {
            setupStartProjectByPattern('proj-bogus-pick');
            const sensei = makeSensei();

            await sensei.startProject('Bogus Pick', 'A vanilla landing page', {
                trustLevel: 'low',
                selectedBundle: 'bundle-that-does-not-exist',
            });

            // Operator's typo → no UPDATE with the typo value.
            const updateWithTypo = mockDb.query.mock.calls.find(
                ([sql, params]) =>
                    typeof sql === 'string' &&
                    /UPDATE projects SET selected_bundle/i.test(sql) &&
                    typeof (params as unknown[])[0] === 'string' &&
                    String((params as unknown[])[0]).includes('does-not-exist')
            );
            expect(updateWithTypo).toBeUndefined();
        });

        it('respects KAGEOPS_FEATURE_BUNDLES=false rollback knob', async () => {
            setupStartProjectByPattern('proj-flag-off');
            process.env['KAGEOPS_FEATURE_BUNDLES'] = 'false';
            try {
                const sensei = makeSensei();

                await sensei.startProject('Flag Off', 'A SaaS project', {
                    trustLevel: 'low',
                    selectedBundle: 'nextjs-saas',
                });

                // Flag explicitly off → assignBundleForProject is skipped
                // entirely; no UPDATE selected_bundle should fire at all.
                const anyUpdate = mockDb.query.mock.calls.find(
                    ([sql]) => typeof sql === 'string' && /UPDATE projects SET selected_bundle/i.test(sql)
                );
                expect(anyUpdate).toBeUndefined();
            } finally {
                delete process.env['KAGEOPS_FEATURE_BUNDLES'];
            }
        });
    });

    // ── F-314 — tier enforcement at startProject ────────────────────────────

    describe('startProject() tier enforcement (F-314)', () => {
        it('allows Free plan to start a project when no active project exists', async () => {
            setupStartProject('proj-free-ok');
            // Override the duplicate-check call to also include the active-count
            // SELECT that the gate fires before duplicate check.
            mockDb.query.mockReset();
            // Free has unlimited_projects now — the tier gate is skipped, so no
            // active-count query fires; go straight to the startProject sequence.
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });          // duplicate check
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-free-ok' }], rowCount: 1 }); // INSERT projects
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 });      // INSERT task
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });          // pending tasks

            const sensei = new Sensei(
                { sendPrompt, resolvePlan: () => 'free', planGate: tierPlanGate },
                eventBus as unknown as EventBus,
            );

            const id = await sensei.startProject('Single Project', 'desc', 'low');
            expect(id).toBe('proj-free-ok');
        });

        it('Free plan can start any number of projects (unlimited_projects is included free)', async () => {
            // No gate query for paid plans — goes straight to startProject sequence
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });          // duplicate check
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-free-unl' }], rowCount: 1 });
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

            const sensei = new Sensei(
                { sendPrompt, resolvePlan: () => 'free', planGate: tierPlanGate },
                eventBus as unknown as EventBus,
            );

            const id = await sensei.startProject('Tenth Project', 'desc', 'low');
            expect(id).toBe('proj-free-unl');
            // Importantly: getOne should NOT have been called for the active count.
            // Other getOne reads (e.g. decomposer's #165 phase_task_selections
            // lookup) are unrelated — narrow the assertion to the tier-gate SQL.
            const gateCalls = mockDb.getOne.mock.calls.filter(
                ([sql]: [string, ...unknown[]]) => typeof sql === 'string' && /COUNT.*projects/i.test(sql),
            );
            expect(gateCalls).toHaveLength(0);
        });

        it('TierLimitError carries plan + feature + requiredPlan when a plan lacks unlimited_projects', async () => {
            // In the 3-tier model every real tier includes unlimited_projects, so
            // force the limit path with a gate stub that denies it — this keeps the
            // TierLimitError mechanism (and its UI-facing shape) under test.
            mockDb.getOne.mockResolvedValueOnce({ count: '3' });
            const denyAll = { canUse: () => false };
            const sensei = new Sensei(
                { sendPrompt, resolvePlan: () => 'free', planGate: denyAll },
                eventBus as unknown as EventBus,
            );

            try {
                await sensei.startProject('Blocked', 'desc', 'low');
                expect.fail('should have thrown');
            } catch (err) {
                const { TierLimitError } = await import('../../src/shared/tier-limit-error');
                expect(TierLimitError.is(err)).toBe(true);
                if (TierLimitError.is(err)) {
                    expect(err.plan).toBe('free');
                    expect(err.feature).toBe('unlimited_projects');
                    expect(err.requiredPlan).toBe('team');
                    expect(err.message).toMatch(/Upgrade to Team/);
                }
            }
        });

        it('skips the gate entirely when resolvePlan is not wired (dev-trust mode)', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'p' }], rowCount: 1 });
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 't' }], rowCount: 1 });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

            // No resolvePlan → no enforcement
            const sensei = new Sensei({ sendPrompt }, eventBus as unknown as EventBus);

            const id = await sensei.startProject('Dev', 'desc', 'low');
            expect(id).toBe('p');
            // Tier gate is skipped — assert no COUNT(*) query against projects.
            // Other getOne reads from downstream subsystems (decomposer #165)
            // are unrelated and may fire.
            const gateCalls = mockDb.getOne.mock.calls.filter(
                ([sql]: [string, ...unknown[]]) => typeof sql === 'string' && /COUNT.*projects/i.test(sql),
            );
            expect(gateCalls).toHaveLength(0);
        });
    });

    // ── handleUserMessage — model-routing TRUTH BLOCK ──────────────────────

    describe('handleUserMessage() injects the active model routing into the system prompt', () => {
        it('renders preset + per-agent model rows when getAgentRouting is wired', async () => {
            // The chat path also runs `getAllProjectsStatus` (a getMany on projects);
            // make that resolve to an empty list so we don't hit unrelated branches.
            mockDb.getMany.mockResolvedValue([]);

            let capturedSystemPrompt = '';
            const sendConversation = vi.fn(async (sys: string, _hist: unknown) => {
                capturedSystemPrompt = sys;
                return 'roger';
            });

            const sensei = new Sensei(
                {
                    sendPrompt,
                    sendConversation,
                    getAgentRouting: () => ({
                        preset: 'codex-cli',
                        agents: [
                            { name: 'sensei',    model: 'codex-cli', provider: 'codex-cli' },
                            { name: 'scout',     model: 'codex-cli', provider: 'codex-cli' },
                            { name: 'blueprint', model: 'codex-cli', provider: 'codex-cli' },
                            { name: 'pixel',     model: 'codex-cli', provider: 'codex-cli' },
                            { name: 'forge',     model: 'codex-cli', provider: 'codex-cli' },
                            { name: 'cipher',    model: 'codex-cli', provider: 'codex-cli' },
                            { name: 'aegis',     model: 'codex-cli', provider: 'codex-cli' },
                            { name: 'vigil',     model: 'codex-cli', provider: 'codex-cli' },
                            { name: 'herald',    model: 'codex-cli', provider: 'codex-cli' },
                        ],
                    }),
                },
                eventBus as unknown as EventBus,
            );

            await sensei.handleUserMessage('what model are you running?');

            expect(capturedSystemPrompt).toContain('MODEL ROUTING — TRUTH BLOCK');
            expect(capturedSystemPrompt).toContain('Active preset: codex-cli');
            expect(capturedSystemPrompt).toContain('sensei');
            expect(capturedSystemPrompt).toContain('codex-cli');
            // The block must instruct Sensei to read FROM it, not infer
            expect(capturedSystemPrompt).toContain('read your answer FROM THIS BLOCK');
        });

        it('renders a placeholder when getAgentRouting is not wired', async () => {
            mockDb.getMany.mockResolvedValue([]);
            let capturedSystemPrompt = '';
            const sendConversation = vi.fn(async (sys: string, _hist: unknown) => {
                capturedSystemPrompt = sys;
                return 'roger';
            });

            const sensei = new Sensei(
                { sendPrompt, sendConversation },
                eventBus as unknown as EventBus,
            );

            await sensei.handleUserMessage('hi');

            expect(capturedSystemPrompt).toContain('MODEL ROUTING — TRUTH BLOCK');
            expect(capturedSystemPrompt).toContain('not available');
            // Sensei is told to defer to Settings → Model Routing
            expect(capturedSystemPrompt).toContain('Settings → Model Routing');
        });

        it('shows preset = "default (custom)" when no preset is active', async () => {
            mockDb.getMany.mockResolvedValue([]);
            let capturedSystemPrompt = '';
            const sendConversation = vi.fn(async (sys: string, _hist: unknown) => {
                capturedSystemPrompt = sys;
                return 'roger';
            });

            const sensei = new Sensei(
                {
                    sendPrompt, sendConversation,
                    getAgentRouting: () => ({
                        preset: null,
                        agents: [{ name: 'sensei', model: 'claude-sonnet-4-6', provider: 'claude' }],
                    }),
                },
                eventBus as unknown as EventBus,
            );

            await sensei.handleUserMessage('hi');
            expect(capturedSystemPrompt).toContain('Active preset: default (custom)');
        });
    });

    // ── handleUserMessage — CAPABILITY HONESTY RULE (issue #149, v0.1.36) ──

    describe('handleUserMessage() injects CAPABILITY HONESTY RULE (issue #149)', () => {
        /**
         * Pin the rule's presence in the system prompt so a future edit
         * doesn't accidentally drop it. The rule is what prevents Sensei
         * from inventing destructive recovery instructions (the v0.1.35
         * "rename your pgdata" incident) when it's asked to do something
         * it has no tool for.
         */
        it('includes the CAPABILITY HONESTY RULE block', async () => {
            mockDb.getMany.mockResolvedValue([]);
            let capturedSystemPrompt = '';
            const sendConversation = vi.fn(async (sys: string, _hist: unknown) => {
                capturedSystemPrompt = sys;
                return 'roger';
            });

            const sensei = new Sensei(
                { sendPrompt, sendConversation },
                eventBus as unknown as EventBus,
            );

            await sensei.handleUserMessage('hi');

            expect(capturedSystemPrompt).toContain('CAPABILITY HONESTY RULE');
            // F-148 (#148) shipped the /add-requirement slash command — the
            // rule now points operators at the command instead of refusing.
            expect(capturedSystemPrompt).toContain('/add-requirement');
            // Other cannot-do items the rule still enforces.
            expect(capturedSystemPrompt).toContain('repair the database');
            expect(capturedSystemPrompt).toContain('reassign tasks');
            // The specific destructive instruction that prompted the rule
            expect(capturedSystemPrompt).toContain('rename your pgdata');
        });

        it('forbids inventing technical excuses (DB corruption / lock conflicts / etc.)', async () => {
            mockDb.getMany.mockResolvedValue([]);
            let capturedSystemPrompt = '';
            const sendConversation = vi.fn(async (sys: string, _hist: unknown) => {
                capturedSystemPrompt = sys;
                return 'roger';
            });

            const sensei = new Sensei(
                { sendPrompt, sendConversation },
                eventBus as unknown as EventBus,
            );

            await sensei.handleUserMessage('add a task to the running project');

            // The fabricated excuses Sensei used in production must be
            // explicitly named in the prompt so the LLM associates them
            // with the prohibition.
            expect(capturedSystemPrompt).toContain('database corruption');
            expect(capturedSystemPrompt).toContain('lock conflicts');
            expect(capturedSystemPrompt).toContain('NEVER invent a technical excuse');
        });
    });

    // ── handleUserMessage — F-323 PROJECT STATE TRUTH BLOCK ────────────────

    describe('handleUserMessage() injects PROJECT STATE truth block (F-323)', () => {
        function captureSystemPrompt(): {
            sensei: Sensei;
            getCapturedPrompt: () => string;
        } {
            let captured = '';
            const sendConversation = vi.fn(async (sys: string, _hist: unknown) => {
                captured = sys;
                return 'reply';
            });
            const sensei = new Sensei(
                { sendPrompt, sendConversation },
                eventBus as unknown as EventBus,
            );
            return { sensei, getCapturedPrompt: () => captured };
        }

        it('renders the empty-state truth block when zero projects exist', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);

            const { sensei, getCapturedPrompt } = captureSystemPrompt();
            await sensei.handleUserMessage('start a new project for me');
            const prompt = getCapturedPrompt();

            expect(prompt).toContain('PROJECT STATE — TRUTH BLOCK');
            expect(prompt).toContain('No projects exist in the database');
            // The hallucination rule must reach Sensei verbatim
            expect(prompt).toContain('Do not invent an ID');
            expect(prompt).toContain('proj_001');
            expect(prompt).toContain('A free-form chat prompt by itself does NOT create a project');
        });

        it('renders each project with full UUID, phase, status, and task counts', async () => {
            // getMany returns the project ID list; getOne is called twice per
            // project (project row + task counts).
            mockDb.getMany.mockResolvedValueOnce([
                { id: '7c4f3a2e-1111-4aaa-9bbb-222233334444' },
                { id: '8d5f4b3f-2222-4ccc-aeee-555566667777' },
            ]);
            mockDb.getOne
                // project 1 — row
                .mockResolvedValueOnce({
                    id: '7c4f3a2e-1111-4aaa-9bbb-222233334444',
                    name: 'GridGuard AI',
                    phase: 'poc',
                    status: 'active',
                    trust_level: 'low',
                })
                // project 1 — counts (46 of 52 done, 4 pending, 2 failed)
                .mockResolvedValueOnce({
                    total: '52', pending: '4', assigned: '0', completed: '46', failed: '2',
                })
                // project 2 — row
                .mockResolvedValueOnce({
                    id: '8d5f4b3f-2222-4ccc-aeee-555566667777',
                    name: 'Almanac',
                    phase: 'design',
                    status: 'completed',
                    trust_level: 'low',
                })
                // project 2 — counts
                .mockResolvedValueOnce({
                    total: '14', pending: '0', assigned: '0', completed: '14', failed: '0',
                });

            const { sensei, getCapturedPrompt } = captureSystemPrompt();
            await sensei.handleUserMessage('what projects are running?');
            const prompt = getCapturedPrompt();

            // Real UUIDs make it to the prompt — the LLM cannot then justify
            // returning `proj_001` for either of these.
            expect(prompt).toContain('7c4f3a2e-1111-4aaa-9bbb-222233334444');
            expect(prompt).toContain('GridGuard AI');
            expect(prompt).toContain('phase=poc');
            expect(prompt).toContain('status=active');
            // Exact fraction so Sensei can quote it instead of guessing
            expect(prompt).toContain('tasks=46/52 completed');
            // Failure breakdown so "did anything fail?" answers come from data
            expect(prompt).toContain('2 failed');

            // The completed Almanac project is also surfaced (truth block
            // includes ALL projects regardless of status — completed/archived
            // are no longer hidden so Sensei can answer history questions).
            expect(prompt).toContain('Almanac');
            expect(prompt).toContain('status=completed');
        });

        it('queries getAllProjectsStatus with exclude=[] so completed and archived projects appear', async () => {
            // The fix removes the prior filter that hid completed+archived rows.
            // We assert by checking the SQL captured — getMany should be called
            // with the "exclude none" path (status <> ALL($1) where $1 = []).
            mockDb.getMany.mockResolvedValueOnce([]);

            const { sensei } = captureSystemPrompt();
            await sensei.handleUserMessage('hi');

            // First getMany call from handleUserMessage is the project ID query.
            const firstCall = mockDb.getMany.mock.calls[0];
            const sql = firstCall?.[0] as string;
            const params = firstCall?.[1] as unknown[];
            expect(sql).toMatch(/SELECT id FROM projects/);
            // exclude=[] means the bound array is empty — Sensei sees every row
            expect(params).toEqual([[]]);
        });
    });

    // ── handleUserMessage — F-336 ACTIVE WORK TRUTH BLOCK ──────────────────

    describe('handleUserMessage() injects ACTIVE WORK truth block (F-336)', () => {
        function captureSystemPrompt(): {
            sensei: Sensei;
            getCapturedPrompt: () => string;
        } {
            let captured = '';
            const sendConversation = vi.fn(async (sys: string, _hist: unknown) => {
                captured = sys;
                return 'reply';
            });
            const sensei = new Sensei(
                { sendPrompt, sendConversation },
                eventBus as unknown as EventBus,
            );
            return { sensei, getCapturedPrompt: () => captured };
        }

        it('emits the explicit empty-state when no agents have in-flight work', async () => {
            // Two getMany calls in handleUserMessage:
            //   1. getAllProjectsStatus → project ID list
            //   2. getActiveWorkByAgent → in-flight rows
            mockDb.getMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

            const { sensei, getCapturedPrompt } = captureSystemPrompt();
            await sensei.handleUserMessage('is Pixel working on anything?');
            const prompt = getCapturedPrompt();

            expect(prompt).toContain('ACTIVE WORK — TRUTH BLOCK');
            // The empty-state phrase is the only way for Sensei to know
            // every agent is idle. Without it the LLM tends to confabulate
            // ("Pixel may be reviewing the wireframes...").
            expect(prompt).toContain('All agents idle — no in-flight tasks');
            // The honesty rule itself must reach the prompt verbatim.
            expect(prompt).toContain(
                'If an agent name does NOT appear in the block, that agent is IDLE',
            );
            expect(prompt).toContain('never invent activity');
        });

        it('renders per-agent breakdown with task title, project, phase, status', async () => {
            mockDb.getMany
                .mockResolvedValueOnce([]) // no projects (skip project-state branch)
                .mockResolvedValueOnce([
                    {
                        agent: 'pixel',
                        taskId: 'task-aaa',
                        taskTitle: 'Hero section mockup',
                        projectId: 'proj-1',
                        projectName: 'GridGuard AI',
                        status: 'in-progress',
                        phase: 'design-planning',
                        startedAt: new Date(Date.now() - 30_000), // ran 30s ago
                    },
                    {
                        agent: 'forge',
                        taskId: 'task-bbb',
                        taskTitle: 'Build /api/health',
                        projectId: 'proj-1',
                        projectName: 'GridGuard AI',
                        status: 'assigned',
                        phase: 'development',
                        startedAt: null,
                    },
                ]);

            const { sensei, getCapturedPrompt } = captureSystemPrompt();
            await sensei.handleUserMessage('what is everyone doing right now?');
            const prompt = getCapturedPrompt();

            expect(prompt).toContain('ACTIVE WORK — TRUTH BLOCK');
            // Per-agent rendering — both names appear as headings.
            expect(prompt).toContain('pixel:');
            expect(prompt).toContain('forge:');
            // Task title is in the prompt so Sensei can quote it instead of
            // generalising ("Pixel is working on something visual").
            expect(prompt).toContain('Hero section mockup');
            expect(prompt).toContain('Build /api/health');
            // Project + phase + status data is rendered so Sensei can answer
            // "which project is Pixel working on?" / "what phase?" from data.
            expect(prompt).toContain('project=GridGuard AI');
            expect(prompt).toContain('phase=design-planning');
            expect(prompt).toContain('phase=development');
            expect(prompt).toContain('[in-progress]');
            expect(prompt).toContain('[assigned]');
            // Duration shape — Pixel has a startedAt, so a "running Xs" string;
            // Forge has startedAt=null, so "not yet started".
            expect(prompt).toMatch(/running \d+s/);
            expect(prompt).toContain('not yet started');
        });

        it('groups multiple tasks under the same agent', async () => {
            mockDb.getMany
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([
                    {
                        agent: 'forge',
                        taskId: 't1',
                        taskTitle: 'task one',
                        projectId: 'p1', projectName: 'Alpha',
                        status: 'in-progress', phase: 'development',
                        startedAt: new Date(),
                    },
                    {
                        agent: 'forge',
                        taskId: 't2',
                        taskTitle: 'task two',
                        projectId: 'p2', projectName: 'Beta',
                        status: 'assigned', phase: 'development',
                        startedAt: null,
                    },
                ]);

            const { sensei, getCapturedPrompt } = captureSystemPrompt();
            await sensei.handleUserMessage('what is forge doing?');
            const prompt = getCapturedPrompt();

            // Single `forge:` heading with both tasks indented under it —
            // not two separate forge: blocks.
            const forgeHeadingCount = (prompt.match(/^ {2}forge:$/gm) ?? []).length;
            expect(forgeHeadingCount).toBe(1);
            expect(prompt).toContain('task one');
            expect(prompt).toContain('task two');
            expect(prompt).toContain('project=Alpha');
            expect(prompt).toContain('project=Beta');
        });

        it('falls back to the empty-state block when the DB query fails (defensive)', async () => {
            // getAllProjectsStatus succeeds; getActiveWorkByAgent throws.
            mockDb.getMany
                .mockResolvedValueOnce([])
                .mockRejectedValueOnce(new Error('db is on fire'));

            const { sensei, getCapturedPrompt } = captureSystemPrompt();
            await sensei.handleUserMessage('any agent working?');
            const prompt = getCapturedPrompt();

            // Even when the DB is broken, the truth-block scaffold + empty
            // state still ship so Sensei doesn't fall back to LLM priors.
            expect(prompt).toContain('ACTIVE WORK — TRUTH BLOCK');
            expect(prompt).toContain('All agents idle — no in-flight tasks');
        });
    });

    // ── handleUserMessage — F-302 PR B shared chat persistence ─────────────

    describe('handleUserMessage() persists project-scoped chat (F-302 PR B)', () => {
        type ChatRepoCall =
            | { kind: 'append'; message: { projectId: string | null; role: 'user' | 'assistant'; content: string; authorName?: string; authorRole?: string | null } }
            | { kind: 'list'; projectId: string }
            | { kind: 'delete'; projectId: string };

        function makeFakeRepo(seed: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }> = []): {
            repo: {
                append(m: { projectId: string | null; role: 'user' | 'assistant'; authorUserId: string | null; authorName: string; authorRole: string | null; content: string }): Promise<void>;
                listForProject(projectId: string): Promise<readonly { id: string; projectId: string | null; orgId: string; role: 'user' | 'assistant'; authorUserId: string | null; authorName: string; authorRole: string | null; content: string; createdAt: string }[]>;
                deleteForProject(projectId: string): Promise<void>;
            };
            calls: ChatRepoCall[];
        } {
            const calls: ChatRepoCall[] = [];
            const seeded = seed.map((m, i) => ({
                id: `seed-${i}`,
                projectId: 'proj-uuid-1',
                orgId: 'default',
                role: m.role,
                authorUserId: m.role === 'user' ? 'user-1' : null,
                authorName: m.role === 'user' ? 'Alice' : 'Sensei',
                authorRole: m.role === 'user' ? 'reviewer' : null,
                content: m.content,
                createdAt: new Date(2026, 4, 10, 12, i).toISOString(),
            }));
            return {
                calls,
                repo: {
                    async append(m): Promise<void> {
                        calls.push({ kind: 'append', message: { projectId: m.projectId, role: m.role, content: m.content, authorName: m.authorName, authorRole: m.authorRole } });
                    },
                    async listForProject(projectId: string) {
                        calls.push({ kind: 'list', projectId });
                        return seeded;
                    },
                    async deleteForProject(projectId: string): Promise<void> {
                        calls.push({ kind: 'delete', projectId });
                    },
                },
            };
        }

        it('does NOT persist when channelId is the legacy command-center', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);
            const { repo, calls } = makeFakeRepo();
            const sensei = new Sensei(
                { sendPrompt, chatRepository: repo },
                eventBus as unknown as EventBus,
            );

            await sensei.handleUserMessage('hi sensei', 'command-center');

            // Repository must not be touched for legacy channels.
            expect(calls.length).toBe(0);
        });

        it('persists user message + assistant reply for project channels with full attribution', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);
            const { repo, calls } = makeFakeRepo();
            const sensei = new Sensei(
                { sendPrompt, chatRepository: repo },
                eventBus as unknown as EventBus,
            );

            await sensei.handleUserMessage(
                'start phase 3',
                'project:proj-uuid-1',
                { authorUserId: 'user-1', authorName: 'Alice', authorRole: 'reviewer' },
            );

            // Calls in order: list (hydration) → append user → append assistant.
            const listCalls = calls.filter((c) => c.kind === 'list');
            const appendCalls = calls.filter((c) => c.kind === 'append');
            expect(listCalls.length).toBe(1);
            expect(appendCalls.length).toBe(2);

            const userAppend = appendCalls[0];
            if (userAppend.kind !== 'append') throw new Error('shape');
            expect(userAppend.message.projectId).toBe('proj-uuid-1');
            expect(userAppend.message.role).toBe('user');
            expect(userAppend.message.content).toBe('start phase 3');
            expect(userAppend.message.authorName).toBe('Alice');
            expect(userAppend.message.authorRole).toBe('reviewer');

            const assistantAppend = appendCalls[1];
            if (assistantAppend.kind !== 'append') throw new Error('shape');
            expect(assistantAppend.message.role).toBe('assistant');
            expect(assistantAppend.message.authorName).toBe('Sensei');
        });

        it('hydrates conversation history from the repository on the first turn', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);
            const { repo, calls } = makeFakeRepo([
                { role: 'user', content: 'previous question' },
                { role: 'assistant', content: 'previous answer' },
            ]);

            let capturedHistory: readonly { role: 'user' | 'assistant'; content: string }[] = [];
            const sendConversation = vi.fn(async (_sys: string, hist: readonly { role: 'user' | 'assistant'; content: string }[]) => {
                // Snapshot so post-call assistant pushes don't mutate the
                // captured value — Sensei passes the live history array by
                // reference, which is fine for production but wrong for
                // a "what did sendConversation see?" assertion.
                capturedHistory = [...hist];
                return 'ok';
            });
            const sensei = new Sensei(
                { sendPrompt, sendConversation, chatRepository: repo },
                eventBus as unknown as EventBus,
            );

            await sensei.handleUserMessage('follow up', 'project:proj-uuid-1');

            // Hydration happens once — second call should reuse the in-memory cache.
            const listCalls = calls.filter((c) => c.kind === 'list');
            expect(listCalls.length).toBe(1);

            // Sensei sees the prior turn plus the new user message.
            expect(capturedHistory.length).toBe(3);
            expect(capturedHistory[0]).toEqual({ role: 'user', content: 'previous question' });
            expect(capturedHistory[1]).toEqual({ role: 'assistant', content: 'previous answer' });
            expect(capturedHistory[2]).toEqual({ role: 'user', content: 'follow up' });

            // Second turn — no second list call.
            await sensei.handleUserMessage('and another', 'project:proj-uuid-1');
            const listCallsAfter = calls.filter((c) => c.kind === 'list');
            expect(listCallsAfter.length).toBe(1);
        });

        it('falls back to fresh history when the repository read fails', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);
            const repo = {
                append: vi.fn(async () => undefined),
                listForProject: vi.fn(async (): Promise<readonly never[]> => {
                    throw new Error('db down');
                }),
                deleteForProject: vi.fn(async () => undefined),
            };
            const sensei = new Sensei(
                { sendPrompt, chatRepository: repo },
                eventBus as unknown as EventBus,
            );

            // Hydration fail-soft: chat must still answer even if the DB
            // read died. Sensei degrades to empty in-memory history and
            // proceeds with the LLM call.
            const reply = await sensei.handleUserMessage('hi', 'project:proj-uuid-1');
            expect(reply).not.toMatch(/encountered an error/);
            // Append still attempted (and succeeds via the mock) so the
            // current turn lands in the DB even though hydration failed.
            expect(repo.append).toHaveBeenCalled();
        });

        it('clearConversationHistory deletes persisted rows for project channels', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);
            const { repo, calls } = makeFakeRepo();
            const sensei = new Sensei(
                { sendPrompt, chatRepository: repo },
                eventBus as unknown as EventBus,
            );
            await sensei.handleUserMessage('hi', 'project:proj-uuid-1');

            sensei.clearConversationHistory('project:proj-uuid-1');

            // The void chatRepo.deleteForProject(projectId) call inside
            // clearConversationHistory is fire-and-forget; we let it run
            // in microtask drain order via flushPromises.
            await new Promise((resolve) => setImmediate(resolve));

            const deleteCalls = calls.filter((c) => c.kind === 'delete');
            expect(deleteCalls.length).toBe(1);
            if (deleteCalls[0].kind !== 'delete') throw new Error('shape');
            expect(deleteCalls[0].projectId).toBe('proj-uuid-1');
        });

        it('clearConversationHistory does NOT delete rows for legacy channels', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);
            const { repo, calls } = makeFakeRepo();
            const sensei = new Sensei(
                { sendPrompt, chatRepository: repo },
                eventBus as unknown as EventBus,
            );
            await sensei.handleUserMessage('hi', 'command-center');

            sensei.clearConversationHistory('command-center');
            await new Promise((resolve) => setImmediate(resolve));

            const deleteCalls = calls.filter((c) => c.kind === 'delete');
            expect(deleteCalls.length).toBe(0);
        });
    });

    // ── handleEvent() ────────────────────────────────────────────────────────

    describe('handleEvent()', () => {
        it('ignores events when Sensei is not running', async () => {
            const sensei = makeSensei();
            // Do NOT call start() — sensei.running is false

            await sensei.handleEvent({
                channel: 'task.completed',
                projectId: 'proj-1',
                taskId: 'task-1',
                agent: 'forge',
                timestamp: new Date().toISOString(),
                data: {},
            });

            // No DB calls should have been made
            expect(mockDb.getOne).not.toHaveBeenCalled();
            expect(mockDb.query).not.toHaveBeenCalled();
        });

        it('handles task.completed event by checking phase gate', async () => {
            const sensei = makeSensei();
            await sensei.start();

            // getOne: task record (for matrix update)
            mockDb.getOne.mockResolvedValueOnce({ task_type: 'research', quality_score: null });
            // getOne: getOne for matrix recordTaskOutcome (current score)
            mockDb.getOne.mockResolvedValueOnce({ score: 6.0 });
            // getOne: checkGate — project record
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-1',
                phase: 'discovery',
                trust_level: 'low',
                autonomous_after_design: false,
                status: 'active',
            });
            // getOne: allPhaseTasksComplete — task counts
            mockDb.getOne.mockResolvedValueOnce({ total: '3', done: '2' });

            // query for UPDATE speciality_matrix score
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            await sensei.handleEvent({
                channel: 'task.completed',
                projectId: 'proj-1',
                taskId: 'task-1',
                agent: 'scout',
                timestamp: new Date().toISOString(),
                data: {},
            });

            // Phase gate check makes a getOne call for the project
            const projectQueryCalls = mockDb.getOne.mock.calls.filter(([sql]) =>
                (sql as string).includes('projects')
            );
            expect(projectQueryCalls.length).toBeGreaterThanOrEqual(1);
        });

        it('does not throw when task.completed event has no taskId', async () => {
            const sensei = makeSensei();
            await sensei.start();

            // projectId present, taskId absent — should short-circuit gracefully
            // checkGate is still called because projectId exists
            mockDb.getOne.mockResolvedValueOnce(null); // task lookup returns null (no taskId)
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-1',
                phase: 'discovery',
                trust_level: 'low',
                autonomous_after_design: false,
                status: 'active',
            });
            mockDb.getOne.mockResolvedValueOnce({ total: '1', done: '0' });

            await expect(
                sensei.handleEvent({
                    channel: 'task.completed',
                    projectId: 'proj-1',
                    timestamp: new Date().toISOString(),
                    data: {},
                })
            ).resolves.not.toThrow();
        });

        it('does not propagate errors — handleEvent catches and logs them', async () => {
            const sensei = makeSensei();
            await sensei.start();

            // Make getOne throw to simulate DB error
            mockDb.getOne.mockRejectedValueOnce(new Error('DB connection lost'));

            await expect(
                sensei.handleEvent({
                    channel: 'task.completed',
                    projectId: 'proj-err',
                    taskId: 'task-err',
                    agent: 'forge',
                    timestamp: new Date().toISOString(),
                    data: {},
                })
            ).resolves.not.toThrow();
        });

        it('silently ignores unhandled event channels (e.g. agent.benchmark)', async () => {
            const sensei = makeSensei();
            await sensei.start();

            // 'agent.benchmark' is a valid EventChannel but has no handler in Sensei —
            // it hits the default branch and makes no DB calls.
            await expect(
                sensei.handleEvent({
                    channel: 'agent.benchmark',
                    projectId: 'proj-1',
                    timestamp: new Date().toISOString(),
                    data: {},
                } as EventPayload)
            ).resolves.not.toThrow();

            expect(mockDb.getOne).not.toHaveBeenCalled();
        });
    });

    // ── getProjectStatus() ───────────────────────────────────────────────────

    describe('getProjectStatus()', () => {
        it('returns a ProjectStatus object with correct shape for an existing project', async () => {
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-xyz',
                name: 'My Project',
                phase: 'poc',
                status: 'active',
                trust_level: 'medium',
            });
            mockDb.getOne.mockResolvedValueOnce({
                total: '5',
                pending: '2',
                assigned: '1',
                completed: '2',
                failed: '0',
            });

            const sensei = makeSensei();
            const status = await sensei.getProjectStatus('proj-xyz');

            expect(status).not.toBeNull();
            expect(status?.id).toBe('proj-xyz');
            expect(status?.name).toBe('My Project');
            expect(status?.phase).toBe('poc');
            expect(status?.status).toBe('active');
            expect(status?.trustLevel).toBe('medium');
            expect(status?.taskCounts).toEqual({
                total: 5,
                pending: 2,
                assigned: 1,
                completed: 2,
                failed: 0,
            });
        });

        it('returns null for a project id that does not exist', async () => {
            mockDb.getOne.mockResolvedValueOnce(null);

            const sensei = makeSensei();
            const result = await sensei.getProjectStatus('does-not-exist');

            expect(result).toBeNull();
        });

        it('queries the projects table with the provided projectId', async () => {
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-q',
                name: 'Q Project',
                phase: 'discovery',
                status: 'active',
                trust_level: 'low',
            });
            mockDb.getOne.mockResolvedValueOnce({
                total: '0', pending: '0', assigned: '0', completed: '0', failed: '0',
            });

            const sensei = makeSensei();
            await sensei.getProjectStatus('proj-q');

            const [sql, params] = mockDb.getOne.mock.calls[0] as [string, unknown[]];
            expect(sql).toMatch(/FROM projects WHERE id = \$1/i);
            expect(params).toEqual(['proj-q']);
        });

        it('coerces string counts from DB to integers', async () => {
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-int',
                name: 'Int Project',
                phase: 'development',
                status: 'active',
                trust_level: 'high',
            });
            mockDb.getOne.mockResolvedValueOnce({
                total: '10', pending: '3', assigned: '4', completed: '2', failed: '1',
            });

            const sensei = makeSensei();
            const status = await sensei.getProjectStatus('proj-int');

            expect(typeof status?.taskCounts.total).toBe('number');
            expect(status?.taskCounts.total).toBe(10);
            expect(status?.taskCounts.failed).toBe(1);
        });

        it('handles null counts row — defaults all counts to 0', async () => {
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-null-counts',
                name: 'No Tasks',
                phase: 'discovery',
                status: 'active',
                trust_level: 'low',
            });
            // Second getOne (task counts) returns null
            mockDb.getOne.mockResolvedValueOnce(null);

            const sensei = makeSensei();
            const status = await sensei.getProjectStatus('proj-null-counts');

            expect(status?.taskCounts).toEqual({
                total: 0,
                pending: 0,
                assigned: 0,
                completed: 0,
                failed: 0,
            });
        });
    });

    // ── approveGate() ────────────────────────────────────────────────────────

    describe('approveGate()', () => {
        it('delegates to PhaseGateManager — queries the project record', async () => {
            // PhaseGateManager.approveGate calls getOne for the project
            // BPF-1: approveGate reads phase first (dev exit gate only applies to 'development').
            mockDb.getOne.mockResolvedValueOnce({ phase: 'discovery' });
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-gate',
                phase: 'discovery',
                trust_level: 'low',
                status: 'awaiting-approval',
            });
            // Advance to 'poc'; query: UPDATE projects SET phase = 'poc'
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            // After advancing, Sensei calls decomposer — needs project name/desc
            mockDb.getOne.mockResolvedValueOnce({
                name: 'Gate Project',
                description: 'A gated project',
            });
            // Decomposer: INSERT task
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-poc-1' }], rowCount: 1 });
            // Router: SELECT pending tasks
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

            const sensei = makeSensei();
            await sensei.approveGate('proj-gate');

            // PhaseGateManager must have queried the project
            const projectLookup = mockDb.getOne.mock.calls.find(([sql]) =>
                (sql as string).includes('projects') && (sql as string).includes('$1')
            );
            expect(projectLookup).toBeDefined();
        });

        it('publishes approval.granted event via eventBus', async () => {
            mockDb.getOne.mockResolvedValueOnce({ phase: 'discovery' }); // BPF-1 phase read
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-approve',
                phase: 'discovery',
                trust_level: 'low',
                status: 'awaiting-approval',
            });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ name: 'Approval Project', description: 'desc' });
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-ap-1' }], rowCount: 1 });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

            const sensei = makeSensei();
            await sensei.approveGate('proj-approve');

            const approvalGranted = eventBus.publishedEvents.find(
                (e) => e.channel === 'approval.granted'
            );
            expect(approvalGranted).toBeDefined();
        });
    });

    // ── denyGate() ───────────────────────────────────────────────────────────

    describe('denyGate()', () => {
        it('delegates to PhaseGateManager — queries the project and publishes approval.denied', async () => {
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-deny',
                phase: 'poc',
                status: 'awaiting-approval',
            });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const sensei = makeSensei();
            await sensei.denyGate('proj-deny', 'Not good enough');

            const deniedEvent = eventBus.publishedEvents.find(
                (e) => e.channel === 'approval.denied'
            );
            expect(deniedEvent).toBeDefined();
        });

        it('sets status back to active in the DB', async () => {
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-deny-active',
                phase: 'poc',
                status: 'awaiting-approval',
            });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const sensei = makeSensei();
            await sensei.denyGate('proj-deny-active');

            const updateCall = mockDb.query.mock.calls.find(([sql]) =>
                (sql as string).match(/UPDATE projects SET status = 'active'/i)
            );
            expect(updateCall).toBeDefined();
        });

        it('passes reason through to PhaseGateManager when provided', async () => {
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-reason',
                phase: 'business-viability',
                status: 'awaiting-approval',
            });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const sensei = makeSensei();
            await sensei.denyGate('proj-reason', 'Market not ready');

            const deniedEvent = eventBus.publishedEvents.find(
                (e) => e.channel === 'approval.denied'
            );
            const reason = (deniedEvent?.event as Record<string, unknown>)?.data as Record<string, unknown>;
            expect(reason?.reason).toBe('Market not ready');
        });

        it('uses a default reason when none is provided', async () => {
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-default-reason',
                phase: 'poc',
                status: 'awaiting-approval',
            });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const sensei = makeSensei();
            await sensei.denyGate('proj-default-reason');

            const deniedEvent = eventBus.publishedEvents.find(
                (e) => e.channel === 'approval.denied'
            );
            const data = (deniedEvent?.event as Record<string, unknown>)?.data as Record<string, unknown>;
            expect(typeof data?.reason).toBe('string');
            expect((data?.reason as string).length).toBeGreaterThan(0);
        });
    });

    // ── intercept methods ────────────────────────────────────────────────────

    describe('intercept methods', () => {
        // ── pauseAgent() ─────────────────────────────────────────────────────

        describe('pauseAgent()', () => {
            it('publishes intercept.pause with agentName and taskId', async () => {
                const sensei = makeSensei();
                await sensei.start();

                await sensei.pauseAgent('forge', 'task-pause-1');

                const evt = eventBus.publishedEvents.find((e) => e.channel === 'intercept.pause');
                expect(evt).toBeDefined();
                expect(evt?.event.agent).toBe('forge');
                expect(evt?.event.taskId).toBe('task-pause-1');
            });

            it('publishes requestedBy: human in the event data', async () => {
                const sensei = makeSensei();
                await sensei.start();

                await sensei.pauseAgent('vigil', 'task-pause-2');

                const evt = eventBus.publishedEvents.find((e) => e.channel === 'intercept.pause');
                expect((evt?.event.data as Record<string, unknown>)?.requestedBy).toBe('human');
            });

            it('does not make any DB queries', async () => {
                const sensei = makeSensei();
                await sensei.start();
                mockDb.reset(); // clear any calls from start()

                await sensei.pauseAgent('scout', 'task-pause-3');

                expect(mockDb.query).not.toHaveBeenCalled();
                expect(mockDb.getOne).not.toHaveBeenCalled();
            });
        });

        // ── resumeAgent() ────────────────────────────────────────────────────

        describe('resumeAgent()', () => {
            it('publishes intercept.resume with agentName and taskId', async () => {
                const sensei = makeSensei();
                await sensei.start();

                await sensei.resumeAgent('blueprint', 'task-resume-1');

                const evt = eventBus.publishedEvents.find((e) => e.channel === 'intercept.resume');
                expect(evt).toBeDefined();
                expect(evt?.event.agent).toBe('blueprint');
                expect(evt?.event.taskId).toBe('task-resume-1');
            });

            it('publishes requestedBy: human in the event data', async () => {
                const sensei = makeSensei();
                await sensei.start();

                await sensei.resumeAgent('aegis', 'task-resume-2');

                const evt = eventBus.publishedEvents.find((e) => e.channel === 'intercept.resume');
                expect((evt?.event.data as Record<string, unknown>)?.requestedBy).toBe('human');
            });

            it('does not make any DB queries', async () => {
                const sensei = makeSensei();
                await sensei.start();
                mockDb.reset();

                await sensei.resumeAgent('forge', 'task-resume-3');

                expect(mockDb.query).not.toHaveBeenCalled();
                expect(mockDb.getOne).not.toHaveBeenCalled();
            });
        });

        // ── injectGuidance() ─────────────────────────────────────────────────

        describe('injectGuidance()', () => {
            it('publishes intercept.guidance with agentName, taskId, and guidance text', async () => {
                const sensei = makeSensei();
                await sensei.start();

                await sensei.injectGuidance('forge', 'task-guidance-1', 'Use a factory pattern here');

                const evt = eventBus.publishedEvents.find((e) => e.channel === 'intercept.guidance');
                expect(evt).toBeDefined();
                expect(evt?.event.agent).toBe('forge');
                expect(evt?.event.taskId).toBe('task-guidance-1');
                expect((evt?.event.data as Record<string, unknown>)?.guidance).toBe('Use a factory pattern here');
            });

            it('includes requestedBy: human in the event data', async () => {
                const sensei = makeSensei();
                await sensei.start();

                await sensei.injectGuidance('vigil', 'task-guidance-2', 'Focus on edge cases');

                const evt = eventBus.publishedEvents.find((e) => e.channel === 'intercept.guidance');
                expect((evt?.event.data as Record<string, unknown>)?.requestedBy).toBe('human');
            });

            it('preserves the full guidance string verbatim', async () => {
                const sensei = makeSensei();
                await sensei.start();

                const guidance = 'Multi-line\nguidance with "quotes" and special chars: $1 <>&';
                await sensei.injectGuidance('cipher', 'task-guidance-3', guidance);

                const evt = eventBus.publishedEvents.find((e) => e.channel === 'intercept.guidance');
                expect((evt?.event.data as Record<string, unknown>)?.guidance).toBe(guidance);
            });

            it('does not make any DB queries', async () => {
                const sensei = makeSensei();
                await sensei.start();
                mockDb.reset();

                await sensei.injectGuidance('scout', 'task-guidance-4', 'Some guidance');

                expect(mockDb.query).not.toHaveBeenCalled();
                expect(mockDb.getOne).not.toHaveBeenCalled();
            });
        });

        // ── takeoverTask() ───────────────────────────────────────────────────

        describe('takeoverTask()', () => {
            it('publishes intercept.takeover with agentName and taskId', async () => {
                const sensei = makeSensei();
                await sensei.start();

                await sensei.takeoverTask('forge', 'task-takeover-1');

                const evt = eventBus.publishedEvents.find((e) => e.channel === 'intercept.takeover');
                expect(evt).toBeDefined();
                expect(evt?.event.agent).toBe('forge');
                expect(evt?.event.taskId).toBe('task-takeover-1');
            });

            it('includes requestedBy: human in the event data', async () => {
                const sensei = makeSensei();
                await sensei.start();

                await sensei.takeoverTask('herald', 'task-takeover-2');

                const evt = eventBus.publishedEvents.find((e) => e.channel === 'intercept.takeover');
                expect((evt?.event.data as Record<string, unknown>)?.requestedBy).toBe('human');
            });

            it('does not make any DB queries', async () => {
                const sensei = makeSensei();
                await sensei.start();
                mockDb.reset();

                await sensei.takeoverTask('pixel', 'task-takeover-3');

                expect(mockDb.query).not.toHaveBeenCalled();
                expect(mockDb.getOne).not.toHaveBeenCalled();
            });
        });

        // ── handbackTask() ───────────────────────────────────────────────────

        describe('handbackTask()', () => {
            it('publishes intercept.handback with taskId and agentName', async () => {
                const sensei = makeSensei();
                await sensei.start();

                // UPDATE tasks SET status = 'pending'
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
                // SELECT project_id FROM tasks
                mockDb.getOne.mockResolvedValueOnce({ project_id: 'proj-hb-1' });
                // router.routePendingTasks → SELECT pending tasks
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

                await sensei.handbackTask('task-hb-1', 'forge');

                const evt = eventBus.publishedEvents.find((e) => e.channel === 'intercept.handback');
                expect(evt).toBeDefined();
                expect(evt?.event.taskId).toBe('task-hb-1');
                expect(evt?.event.agent).toBe('forge');
            });

            it('updates task status to pending when no guidance provided', async () => {
                const sensei = makeSensei();
                await sensei.start();

                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
                mockDb.getOne.mockResolvedValueOnce({ project_id: 'proj-hb-2' });
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

                await sensei.handbackTask('task-hb-2', 'vigil');

                const updateCall = mockDb.query.mock.calls.find(([sql]) =>
                    (sql as string).includes("SET status = 'pending'")
                );
                expect(updateCall).toBeDefined();
            });

            it('appends HUMAN GUIDANCE to task description when guidance is provided', async () => {
                const sensei = makeSensei();
                await sensei.start();

                // UPDATE tasks SET status = 'pending', description = description || $1
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
                // SELECT project_id FROM tasks
                mockDb.getOne.mockResolvedValueOnce({ project_id: 'proj-hb-3' });
                // router.routePendingTasks → SELECT pending tasks
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

                await sensei.handbackTask('task-hb-3', 'forge', 'Fix the null check on line 42');

                const updateCall = mockDb.query.mock.calls.find(([sql]) =>
                    (sql as string).includes('description = description ||')
                );
                expect(updateCall).toBeDefined();

                const params = (updateCall as [string, unknown[]])[1];
                expect(params[0]).toBe('\n\nHUMAN GUIDANCE: Fix the null check on line 42');
                expect(params[1]).toBe('task-hb-3');
            });

            it('looks up project_id from the tasks table', async () => {
                const sensei = makeSensei();
                await sensei.start();

                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
                mockDb.getOne.mockResolvedValueOnce({ project_id: 'proj-hb-4' });
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

                await sensei.handbackTask('task-hb-4', 'scout');

                const [sql, params] = mockDb.getOne.mock.calls[0] as [string, unknown[]];
                expect(sql).toMatch(/SELECT project_id FROM tasks WHERE id = \$1/i);
                expect(params).toEqual(['task-hb-4']);
            });

            it('routes pending tasks for the project after handback', async () => {
                const sensei = makeSensei();
                await sensei.start();

                // UPDATE tasks SET status = 'pending'
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
                // SELECT project_id FROM tasks (getOne for handbackTask)
                mockDb.getOne.mockResolvedValueOnce({ project_id: 'proj-hb-5' });
                // routePendingTasks SELECT — empty rows so the router loop does not call routeTask
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

                await sensei.handbackTask('task-hb-5', 'forge');

                // The router SELECT for pending tasks must have been called with the project id
                const routerCall = mockDb.query.mock.calls.find(([sql, params]) =>
                    (sql as string).includes("status = 'pending'") &&
                    (params as unknown[])[0] === 'proj-hb-5'
                );
                expect(routerCall).toBeDefined();
            });

            it('still publishes intercept.handback even when task row is not found', async () => {
                const sensei = makeSensei();
                await sensei.start();

                // UPDATE tasks SET status = 'pending'
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
                // getOne returns null — task not in DB
                mockDb.getOne.mockResolvedValueOnce(null);

                await sensei.handbackTask('task-missing', 'aegis');

                const evt = eventBus.publishedEvents.find((e) => e.channel === 'intercept.handback');
                expect(evt).toBeDefined();
                expect(evt?.event.taskId).toBe('task-missing');
            });

            it('sets hasGuidance: true in event data when guidance is supplied', async () => {
                const sensei = makeSensei();
                await sensei.start();

                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
                mockDb.getOne.mockResolvedValueOnce({ project_id: 'proj-hb-6' });
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

                await sensei.handbackTask('task-hb-6', 'forge', 'Some guidance');

                const evt = eventBus.publishedEvents.find((e) => e.channel === 'intercept.handback');
                expect((evt?.event.data as Record<string, unknown>)?.hasGuidance).toBe(true);
            });

            it('sets hasGuidance: false in event data when no guidance is supplied', async () => {
                const sensei = makeSensei();
                await sensei.start();

                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
                mockDb.getOne.mockResolvedValueOnce({ project_id: 'proj-hb-7' });
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

                await sensei.handbackTask('task-hb-7', 'vigil');

                const evt = eventBus.publishedEvents.find((e) => e.channel === 'intercept.handback');
                expect((evt?.event.data as Record<string, unknown>)?.hasGuidance).toBe(false);
            });
        });
    });

    // ── Comms Integration ────────────────────────────────────────────────────

    describe('comms integration', () => {
        function makeCommsMock(): {
            start: ReturnType<typeof vi.fn>;
            stop: ReturnType<typeof vi.fn>;
            enqueue: ReturnType<typeof vi.fn>;
            processPending: ReturnType<typeof vi.fn>;
            getChannels: ReturnType<typeof vi.fn>;
        } {
            return {
                start: vi.fn(),
                stop: vi.fn(),
                enqueue: vi.fn(async () => 'msg-1'),
                processPending: vi.fn(async () => 0),
                getChannels: vi.fn(() => ['teams', 'email']),
            };
        }

        function makeSenseiWithComms(
            commsMock: ReturnType<typeof makeCommsMock>
        ): Sensei {
            return new Sensei(
                { sendPrompt, commsSender: commsMock as unknown as CommsSender },
                eventBus as unknown as EventBus
            );
        }

        it('starts commsSender on start()', async () => {
            const comms = makeCommsMock();
            const sensei = makeSenseiWithComms(comms);

            await sensei.start();

            expect(comms.start).toHaveBeenCalledOnce();
        });

        it('stops commsSender on stop()', async () => {
            const comms = makeCommsMock();
            const sensei = makeSenseiWithComms(comms);
            await sensei.start();

            await sensei.stop();

            expect(comms.stop).toHaveBeenCalledOnce();
        });

        it('does not start commsSender when not configured', async () => {
            const sensei = makeSensei(); // no commsSender in config
            await sensei.start();

            // No error thrown — commsSender is null
            await expect(sensei.stop()).resolves.not.toThrow();
        });

        it('enqueues comms notification when phase gate requires approval', async () => {
            const comms = makeCommsMock();
            const sensei = makeSenseiWithComms(comms);
            await sensei.start();

            // 1. Task lookup (task_type, quality_score)
            mockDb.getOne.mockResolvedValueOnce({ task_type: 'research', quality_score: null });
            // 2. Matrix: current score
            mockDb.getOne.mockResolvedValueOnce({ score: 6.0 });
            // 3. Matrix: UPDATE score
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            // 4. checkGate: project record
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-comms-approval',
                phase: 'discovery',
                trust_level: 'low',
                autonomous_after_design: false,
                status: 'active',
            });
            // 5. allPhaseTasksComplete: all done
            mockDb.getOne.mockResolvedValueOnce({ total: '3', done: '3' });
            // 6. requestApproval: project lookup
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-comms-approval',
                phase: 'discovery',
                trust_level: 'low',
                status: 'active',
            });
            // 7. requestApproval: UPDATE status
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            // 8. getProjectName: project name
            mockDb.getOne.mockResolvedValueOnce({ name: 'Approval Notify Project' });

            await sensei.handleEvent({
                channel: 'task.completed',
                projectId: 'proj-comms-approval',
                taskId: 'task-final',
                agent: 'scout',
                timestamp: new Date().toISOString(),
                data: {},
            });

            // Should enqueue for each channel (teams + email)
            expect(comms.enqueue).toHaveBeenCalledTimes(2);

            const firstCall = comms.enqueue.mock.calls[0][0] as Record<string, unknown>;
            expect(firstCall.subject).toContain('Approval Required');
            expect(firstCall.body).toContain('Approval Notify Project');
            expect(firstCall.channel).toBe('teams');

            const secondCall = comms.enqueue.mock.calls[1][0] as Record<string, unknown>;
            expect(secondCall.channel).toBe('email');
        });

        it('enqueues comms notification when task exhausts all retries', async () => {
            const comms = makeCommsMock();
            const sensei = makeSenseiWithComms(comms);
            await sensei.start();

            // 1. Task lookup (retry_count >= MAX_TASK_RETRIES)
            mockDb.getOne.mockResolvedValueOnce({ task_type: 'code-generation', retry_count: 3 });
            // 2. Matrix: current score
            mockDb.getOne.mockResolvedValueOnce({ score: 5.0 });
            // 3. Matrix: UPDATE score
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            // 4. getProjectName: project name
            mockDb.getOne.mockResolvedValueOnce({ name: 'Failed Task Project' });

            await sensei.handleEvent({
                channel: 'task.failed',
                projectId: 'proj-fail',
                taskId: 'task-dead',
                agent: 'forge',
                timestamp: new Date().toISOString(),
                data: { errorMessage: 'Compilation error' },
            });

            expect(comms.enqueue).toHaveBeenCalledTimes(2);

            const firstCall = comms.enqueue.mock.calls[0][0] as Record<string, unknown>;
            expect(firstCall.subject).toContain('Task Failed');
            expect(firstCall.body).toContain('task-dead');
            expect(firstCall.body).toContain('Compilation error');
        });

        it('enqueues comms notification when project completes (all phases done)', async () => {
            const comms = makeCommsMock();
            const sensei = makeSenseiWithComms(comms);

            mockDb.getOne.mockResolvedValueOnce({ phase: 'launch-growth' }); // BPF-1 phase read
            // PhaseGateManager.approveGate: project at last phase
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-complete',
                phase: 'launch-growth',
                trust_level: 'low',
                status: 'awaiting-approval',
            });
            // getNextEnabledPhase: reads enabled_phases to determine if phase can be skipped
            mockDb.getOne.mockResolvedValueOnce({ enabled_phases: null });
            // PhaseGateManager.approveGate: UPDATE status to completed
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            // getProjectName: project name
            mockDb.getOne.mockResolvedValueOnce({ name: 'Finished Project' });

            await sensei.approveGate('proj-complete');

            expect(comms.enqueue).toHaveBeenCalledTimes(2);

            const firstCall = comms.enqueue.mock.calls[0][0] as Record<string, unknown>;
            expect(firstCall.subject).toContain('Project Complete');
            expect(firstCall.body).toContain('Finished Project');
            expect(firstCall.projectId).toBe('proj-complete');
        });

        it('does not enqueue when commsSender is not configured', async () => {
            const sensei = makeSensei(); // no commsSender
            await sensei.start();

            // Task failure that exhausts retries
            mockDb.getOne.mockResolvedValueOnce({ task_type: 'research', retry_count: 3 });
            mockDb.getOne.mockResolvedValueOnce({ score: 5.0 });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            await sensei.handleEvent({
                channel: 'task.failed',
                projectId: 'proj-no-comms',
                taskId: 'task-nocomms',
                agent: 'scout',
                timestamp: new Date().toISOString(),
                data: { errorMessage: 'Some error' },
            });

            // No crash — sendCommsNotification returns early when commsSender is null
        });

        it('does not propagate comms errors — orchestration continues', async () => {
            const comms = makeCommsMock();
            comms.enqueue.mockRejectedValue(new Error('Comms DB unreachable'));
            const sensei = makeSenseiWithComms(comms);

            mockDb.getOne.mockResolvedValueOnce({ phase: 'launch-growth' }); // BPF-1 phase read
            // PhaseGateManager.approveGate: project at last phase
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-comms-err',
                phase: 'launch-growth',
                trust_level: 'low',
                status: 'awaiting-approval',
            });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ name: 'Error Comms Project' });

            // Should not throw even though enqueue fails
            await expect(sensei.approveGate('proj-comms-err')).resolves.not.toThrow();
        });

        it('sends to all channels returned by getChannels()', async () => {
            const comms = makeCommsMock();
            comms.getChannels.mockReturnValue(['teams', 'email', 'slack']);
            const sensei = makeSenseiWithComms(comms);

            mockDb.getOne.mockResolvedValueOnce({ phase: 'launch-growth' }); // BPF-1 phase read
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-3ch',
                phase: 'launch-growth',
                trust_level: 'low',
                status: 'awaiting-approval',
            });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ name: 'Multi Channel Project' });

            await sensei.approveGate('proj-3ch');

            expect(comms.enqueue).toHaveBeenCalledTimes(3);

            const channels = comms.enqueue.mock.calls.map(
                (c: unknown[]) => (c[0] as Record<string, unknown>).channel
            );
            expect(channels).toEqual(['teams', 'email', 'slack']);
        });
    });

    // ── BPF-28: tier-3 blocked-task escalation ──────────────────────────────
    describe('BPF-28: tier-3 blocked-task escalation', () => {
        type RetryTask = { retryTask(id: string, n: number): Promise<void> };

        it('tier-3 marks the task blocked AND parks + emits approval.required + names the task', async () => {
            const sensei = makeSensei();
            // retryTask(taskId, currentRetryCount=2): atomic bump → 3 → tier-3.
            mockDb.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ retry_count: 3 }] });
            // escalateBlockedTask reads: task (project_id+title), project status, name.
            mockDb.getOne
                .mockResolvedValueOnce({ project_id: 'proj-x', title: 'Integrate Clerk authentication' })
                .mockResolvedValueOnce({ status: 'active' })
                .mockResolvedValueOnce({ name: 'ClubHubOSS' });

            await (sensei as unknown as RetryTask).retryTask('task-x', 2);

            // Marked blocked (tier-3 UPDATE) …
            const blockedUpdate = mockDb.query.mock.calls.find(([sql]) =>
                /UPDATE tasks SET status = 'blocked'/.test(sql as string));
            expect(blockedUpdate).toBeDefined();
            // … parked the project (BPF-28: no longer a silent dead-end) …
            const parkUpdate = mockDb.query.mock.calls.find(([sql]) =>
                /UPDATE projects[\s\S]*'awaiting-approval'/.test(sql as string));
            expect(parkUpdate).toBeDefined();
            // … and emitted ONE approval.required naming the blocked task.
            const approvals = eventBus.publishedEvents.filter((e) => e.channel === 'approval.required');
            expect(approvals.length).toBe(1);
            expect(String(approvals[0].event.data.reason)).toContain('Integrate Clerk authentication');
            expect(String(approvals[0].event.data.reason)).toMatch(/blocked after/i);
        });

        it('folds into the existing approval (no re-park / no spam) when already parked', async () => {
            const sensei = makeSensei();
            mockDb.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ retry_count: 3 }] });
            mockDb.getOne
                .mockResolvedValueOnce({ project_id: 'proj-x', title: 'Some blocked task' })
                .mockResolvedValueOnce({ status: 'awaiting-approval' }); // already parked

            await (sensei as unknown as RetryTask).retryTask('task-y', 2);

            // Still marks the task blocked …
            expect(mockDb.query.mock.calls.find(([sql]) =>
                /UPDATE tasks SET status = 'blocked'/.test(sql as string))).toBeDefined();
            // … but emits no second approval.required.
            expect(eventBus.publishedEvents.filter((e) => e.channel === 'approval.required').length).toBe(0);
        });
    });
});
