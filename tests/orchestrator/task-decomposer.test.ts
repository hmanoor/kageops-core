/**
 * TaskDecomposer behavioral tests
 *
 * Covers all public behaviors: prompt construction, JSON parsing,
 * DB storage, dependency resolution, event publishing, and phase helpers.
 *
 * External dependencies are fully mocked — no live Postgres or AI calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';

// ── DB mock — vi.hoisted ensures the factory is available when vi.mock hoists ─
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

// ── Import under test (after mock registration) ───────────────────────────────
import { TaskDecomposer, type DecomposerConfig, type Phase } from '../../src/orchestrator/task-decomposer';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal valid DecomposerConfig with an optionally-overridable sendPrompt. */
function makeConfig(
    sendPrompt: DecomposerConfig['sendPrompt'] = vi.fn().mockResolvedValue('[]')
): DecomposerConfig {
    return { sendPrompt };
}

/** A single valid task JSON the AI might return. */
const SINGLE_TASK_JSON = JSON.stringify([
    {
        title: 'Market research',
        description: 'Research the target market.',
        taskType: 'research',
        assignedAgent: 'scout',
        priority: 8,
        dependsOn: [],
    },
]);

/** Two tasks where the second depends on the first. */
const TWO_TASK_JSON_WITH_DEP = JSON.stringify([
    {
        title: 'Define architecture',
        description: 'Design the system architecture.',
        taskType: 'architecture',
        assignedAgent: 'blueprint',
        priority: 9,
        dependsOn: [],
    },
    {
        title: 'Implement API',
        description: 'Build the REST API.',
        taskType: 'coding',
        assignedAgent: 'forge',
        priority: 7,
        dependsOn: ['Define architecture'],
    },
]);

/** Helper: make query() return a fresh UUID for each INSERT call. */
let uuidCounter = 0;
function setupQueryReturnsIds(): void {
    uuidCounter = 0;
    mockDb.query.mockImplementation(async () => {
        const id = `task-id-${++uuidCounter}`;
        return { rows: [{ id }], rowCount: 1 };
    });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
    mockDb.reset();
    uuidCounter = 0;
});

// ── prompt construction ───────────────────────────────────────────────────────

describe('decompose() — prompt construction', () => {
    it('calls sendPrompt exactly once', async () => {
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        await decomposer.decompose('proj-1', 'My App', 'A cool app.', 'discovery');

        expect(sendPrompt).toHaveBeenCalledTimes(1);
    });

    it('passes the current phase in the system prompt', async () => {
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        await decomposer.decompose('proj-1', 'My App', 'A cool app.', 'poc');

        const [systemPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(systemPrompt).toContain('poc');
    });

    it('includes the available agents for the phase in the system prompt', async () => {
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        // discovery phase agents: scout, blueprint
        await decomposer.decompose('proj-1', 'My App', 'A cool app.', 'discovery');

        const [systemPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(systemPrompt).toContain('scout');
        expect(systemPrompt).toContain('blueprint');
    });

    it('does NOT include agents from a different phase in the system prompt', async () => {
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        // discovery phase must not list development-only agents like forge
        await decomposer.decompose('proj-1', 'My App', 'A cool app.', 'discovery');

        const [systemPrompt] = sendPrompt.mock.calls[0] as [string, string];
        // 'forge' only appears in poc/development phases, not discovery
        // Guard: check available-agents section only (not the capabilities list)
        expect(systemPrompt).toContain('Available agents for this phase: scout, blueprint');
    });

    it('passes the project name in the user prompt', async () => {
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        await decomposer.decompose('proj-1', 'Ninja Todo App', 'A todo app.', 'discovery');

        const [, userPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(userPrompt).toContain('Ninja Todo App');
    });

    it('passes the project description in the user prompt', async () => {
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        await decomposer.decompose('proj-1', 'My App', 'A next-gen billing platform.', 'discovery');

        const [, userPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(userPrompt).toContain('A next-gen billing platform.');
    });

    it('includes the phase in the user prompt', async () => {
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'design-planning');

        const [, userPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(userPrompt).toContain('design-planning');
    });
});

// ── JSON parsing ──────────────────────────────────────────────────────────────

describe('decompose() — JSON parsing', () => {
    it('parses a plain JSON array response into DecomposedTask objects', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        expect(ids).toHaveLength(1);
    });

    it('parses JSON wrapped in markdown code fences (```json ... ```)', async () => {
        setupQueryReturnsIds();
        const wrapped = `Here are the tasks:\n\`\`\`json\n${SINGLE_TASK_JSON}\n\`\`\`\nDone.`;
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(wrapped)),
            bus as never
        );

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        expect(ids).toHaveLength(1);
    });

    it('parses JSON wrapped in plain code fences (``` ... ```)', async () => {
        setupQueryReturnsIds();
        const wrapped = '```\n' + SINGLE_TASK_JSON + '\n```';
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(wrapped)),
            bus as never
        );

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        expect(ids).toHaveLength(1);
    });

    it('returns an empty array when the AI response contains no JSON array (fallback off)', async () => {
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue('Sorry, I cannot help with that.')),
            bus as never
        );

        process.env.KAGEOPS_DECOMPOSE_FALLBACK = '0';
        try {
            const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');
            expect(ids).toEqual([]);
        } finally {
            delete process.env.KAGEOPS_DECOMPOSE_FALLBACK;
        }
    });

    it('BPF-37: an unparseable response yields a deterministic phase-fallback task (fallback on)', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue('Sorry, I cannot help with that.')),
            bus as never
        );

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        // The never-wedge fallback drops in one concept-brief task for discovery.
        expect(ids).toHaveLength(1);
        const call = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(call[1][3]).toBe('concept-brief'); // taskType
        expect(call[1][5]).toBe('scout');          // assignedAgent
    });

    it('returns an empty array when the AI response is an empty string (fallback off)', async () => {
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue('')),
            bus as never
        );

        process.env.KAGEOPS_DECOMPOSE_FALLBACK = '0';
        try {
            const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');
            expect(ids).toEqual([]);
        } finally {
            delete process.env.KAGEOPS_DECOMPOSE_FALLBACK;
        }
    });

    it('BPF-37: an empty development phase always gets a build fallback task', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        // A deliberate empty array — parse SUCCEEDS but development must still
        // attempt to build something, so the fallback fires on devMustBuild.
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue('[]')),
            bus as never
        );

        const ids = await decomposer.decompose('proj-1', 'My App', 'A next-gen billing platform.', 'development');

        expect(ids).toHaveLength(1);
        const call = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(call[1][5]).toBe('forge'); // non-simple → forge implement
    });

    it('returns an empty array when the JSON is malformed (fallback off)', async () => {
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue('[{"title": "broken"')),
            bus as never
        );

        process.env.KAGEOPS_DECOMPOSE_FALLBACK = '0';
        try {
            const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');
            expect(ids).toEqual([]);
        } finally {
            delete process.env.KAGEOPS_DECOMPOSE_FALLBACK;
        }
    });

    it('BPF-36: salvages valid task objects when one sibling object is malformed', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        // Two good objects, one broken (unquoted value) — whole-array parse
        // throws, but per-object salvage recovers the two good ones.
        const partial =
            '[{"title":"A","taskType":"concept-brief","assignedAgent":"scout","priority":5},' +
            '{"title":"B", broken },' +
            '{"title":"C","taskType":"market-research","assignedAgent":"scout","priority":5}]';
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(partial)),
            bus as never
        );

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        expect(ids).toHaveLength(2);
    });

    it('returns an empty array when the AI returns an empty JSON array', async () => {
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue('[]')),
            bus as never
        );

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        expect(ids).toEqual([]);
    });

    it('applies fallback defaults for missing task fields', async () => {
        // Minimal task — all optional fields omitted
        const minimalResponse = JSON.stringify([{ title: 'Minimal task' }]);
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const sendPrompt = vi.fn().mockResolvedValue(minimalResponse);
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'development');

        // Should store exactly one task without throwing
        expect(ids).toHaveLength(1);
        // The INSERT should have been called with sensible fallback values
        const call = mockDb.query.mock.calls[0] as [string, unknown[]];
        const params = call[1];
        expect(params[1]).toBe('Minimal task');     // title
        expect(params[3]).toBe('general');          // taskType fallback
        expect(params[5]).toBe('scout');            // assignedAgent fallback
        expect(params[6]).toBe(5);                  // priority fallback
    });

    it('filters out non-object items in the parsed array', async () => {
        const mixedResponse = JSON.stringify([
            null,
            42,
            'a string',
            { title: 'Valid task', assignedAgent: 'scout', priority: 5, dependsOn: [] },
        ]);
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(mixedResponse)),
            bus as never
        );

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        // Only the valid object should survive
        expect(ids).toHaveLength(1);
    });
});

// ── DB storage ────────────────────────────────────────────────────────────────

describe('decompose() — DB storage', () => {
    it('executes one parameterized INSERT per task', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(TWO_TASK_JSON_WITH_DEP)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'development');

        expect(mockDb.query).toHaveBeenCalledTimes(2);
    });

    it('passes projectId as the first query parameter', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        await decomposer.decompose('project-abc', 'My App', 'Desc.', 'discovery');

        const call = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(call[1][0]).toBe('project-abc');
    });

    it('passes task title as the second query parameter', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const call = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(call[1][1]).toBe('Market research');
    });

    it('passes phase as the fifth query parameter', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const call = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(call[1][4]).toBe('discovery');
    });

    it('uses a parameterized INSERT query (contains $1)', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const call = mockDb.query.mock.calls[0] as [string, unknown[]];
        const sql: string = call[0];
        expect(sql).toContain('$1');
        expect(sql).toContain('$2');
    });

    it('inserts tasks into the tasks table', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const call = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(call[0]).toContain('INSERT INTO tasks');
    });

    it('returns task IDs from the RETURNING clause', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(TWO_TASK_JSON_WITH_DEP)),
            bus as never
        );

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'development');

        expect(ids).toEqual(['task-id-1', 'task-id-2']);
    });

    it('does not call query when AI returns no tasks', async () => {
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue('[]')),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        expect(mockDb.query).not.toHaveBeenCalled();
    });
});

// ── Dependency resolution ─────────────────────────────────────────────────────

describe('decompose() — dependency title-to-ID resolution', () => {
    it('resolves a dependency title to its stored ID for the second task', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(TWO_TASK_JSON_WITH_DEP)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'development');

        // The second INSERT should have depends_on set to {task-id-1}
        const secondCall = mockDb.query.mock.calls[1] as [string, unknown[]];
        const dependsOnParam = secondCall[1][7]; // 8th param: depends_on
        expect(dependsOnParam).toContain('task-id-1');
    });

    it('stores an empty depends_on array for a task with no dependencies', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(TWO_TASK_JSON_WITH_DEP)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'development');

        // First INSERT has no deps
        const firstCall = mockDb.query.mock.calls[0] as [string, unknown[]];
        const dependsOnParam = firstCall[1][7];
        expect(dependsOnParam).toBe('{}');
    });

    it('silently skips an unresolvable dependency title', async () => {
        const taskWithUnknownDep = JSON.stringify([
            {
                title: 'Lone task',
                description: 'No real dep.',
                taskType: 'general',
                assignedAgent: 'scout',
                priority: 5,
                dependsOn: ['Non-existent task title'],
            },
        ]);
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(taskWithUnknownDep)),
            bus as never
        );

        // Should not throw; unknown dep is ignored
        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        expect(ids).toHaveLength(1);
        const call = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(call[1][7]).toBe('{}');
    });

    it('resolves multiple dependencies for a single task', async () => {
        const threeTasksJson = JSON.stringify([
            { title: 'Task A', description: '', taskType: 'a', assignedAgent: 'scout', priority: 9, dependsOn: [] },
            { title: 'Task B', description: '', taskType: 'b', assignedAgent: 'blueprint', priority: 8, dependsOn: [] },
            { title: 'Task C', description: '', taskType: 'c', assignedAgent: 'forge', priority: 7, dependsOn: ['Task A', 'Task B'] },
        ]);
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(threeTasksJson)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'development');

        const thirdCall = mockDb.query.mock.calls[2] as [string, unknown[]];
        const dependsOnParam = thirdCall[1][7] as string;
        expect(dependsOnParam).toContain('task-id-1');
        expect(dependsOnParam).toContain('task-id-2');
    });
});

// ── Event publishing ──────────────────────────────────────────────────────────

describe('decompose() — event publishing', () => {
    it('publishes a task.created event for each task stored', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(TWO_TASK_JSON_WITH_DEP)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'development');

        expect(bus.publish).toHaveBeenCalledTimes(2);
    });

    it('publishes task.created on the correct channel', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        expect(bus.publish).toHaveBeenCalledWith(
            'task.created',
            expect.objectContaining({})
        );
    });

    it('includes the projectId in every published event', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        await decomposer.decompose('proj-xyz', 'My App', 'Desc.', 'discovery');

        const [, payload] = bus.publish.mock.calls[0] as [string, Record<string, unknown>];
        expect(payload.projectId).toBe('proj-xyz');
    });

    it('includes the correct taskId in each published event', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(TWO_TASK_JSON_WITH_DEP)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'development');

        const [, payload1] = bus.publish.mock.calls[0] as [string, Record<string, unknown>];
        const [, payload2] = bus.publish.mock.calls[1] as [string, Record<string, unknown>];
        expect(payload1.taskId).toBe('task-id-1');
        expect(payload2.taskId).toBe('task-id-2');
    });

    it('includes assignedAgent in the event data', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const [, payload] = bus.publish.mock.calls[0] as [string, { data: Record<string, unknown> }];
        expect(payload.data.assignedAgent).toBe('scout');
    });

    it('includes phase in the event data', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const [, payload] = bus.publish.mock.calls[0] as [string, { data: Record<string, unknown> }];
        expect(payload.data.phase).toBe('discovery');
    });

    it('includes priority in the event data', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const [, payload] = bus.publish.mock.calls[0] as [string, { data: Record<string, unknown> }];
        expect(payload.data.priority).toBe(8);
    });

    it('includes the task title in the event data', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const [, payload] = bus.publish.mock.calls[0] as [string, { data: Record<string, unknown> }];
        expect(payload.data.title).toBe('Market research');
    });

    it('sets agent to "sensei" in every published event', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const [, payload] = bus.publish.mock.calls[0] as [string, Record<string, unknown>];
        expect(payload.agent).toBe('sensei');
    });

    it('does not publish any events when AI returns no tasks', async () => {
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue('[]')),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        expect(bus.publish).not.toHaveBeenCalled();
    });

    it('captures published events via publishedEvents on the mock bus', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(SINGLE_TASK_JSON)),
            bus as never
        );

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        expect(bus.publishedEvents).toHaveLength(1);
        expect(bus.publishedEvents[0].channel).toBe('task.created');
    });
});

// ── Return value ──────────────────────────────────────────────────────────────

describe('decompose() — return value', () => {
    it('returns an array of task IDs with length equal to parsed task count', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(TWO_TASK_JSON_WITH_DEP)),
            bus as never
        );

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'development');

        expect(ids).toHaveLength(2);
    });

    it('returns IDs in insertion order (first task first)', async () => {
        setupQueryReturnsIds();
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(TWO_TASK_JSON_WITH_DEP)),
            bus as never
        );

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'development');

        expect(ids[0]).toBe('task-id-1');
        expect(ids[1]).toBe('task-id-2');
    });
});

// ── getNextPhase ──────────────────────────────────────────────────────────────

describe('getNextPhase()', () => {
    it('returns "poc" when current phase is "discovery"', () => {
        const decomposer = new TaskDecomposer(makeConfig(), createMockEventBus() as never);
        expect(decomposer.getNextPhase('discovery')).toBe('poc');
    });

    it('returns "business-viability" when current phase is "poc"', () => {
        const decomposer = new TaskDecomposer(makeConfig(), createMockEventBus() as never);
        expect(decomposer.getNextPhase('poc')).toBe('business-viability');
    });

    it('returns "design-planning" when current phase is "business-viability"', () => {
        const decomposer = new TaskDecomposer(makeConfig(), createMockEventBus() as never);
        expect(decomposer.getNextPhase('business-viability')).toBe('design-planning');
    });

    it('returns "development" when current phase is "design-planning"', () => {
        const decomposer = new TaskDecomposer(makeConfig(), createMockEventBus() as never);
        expect(decomposer.getNextPhase('design-planning')).toBe('development');
    });

    it('returns "launch-growth" when current phase is "development"', () => {
        const decomposer = new TaskDecomposer(makeConfig(), createMockEventBus() as never);
        expect(decomposer.getNextPhase('development')).toBe('launch-growth');
    });

    it('returns null when current phase is "launch-growth" (last phase)', () => {
        const decomposer = new TaskDecomposer(makeConfig(), createMockEventBus() as never);
        expect(decomposer.getNextPhase('launch-growth')).toBeNull();
    });

    it('covers all 5 forward transitions without returning null mid-sequence', () => {
        const decomposer = new TaskDecomposer(makeConfig(), createMockEventBus() as never);
        const phases: Phase[] = ['discovery', 'poc', 'business-viability', 'design-planning', 'development'];
        for (const phase of phases) {
            expect(decomposer.getNextPhase(phase)).not.toBeNull();
        }
    });
});

// ── getPhases ─────────────────────────────────────────────────────────────────

describe('getPhases()', () => {
    it('returns exactly 6 phases', () => {
        const decomposer = new TaskDecomposer(makeConfig(), createMockEventBus() as never);
        expect(decomposer.getPhases()).toHaveLength(6);
    });

    it('returns phases in the correct lifecycle order', () => {
        const decomposer = new TaskDecomposer(makeConfig(), createMockEventBus() as never);
        expect(decomposer.getPhases()).toEqual([
            'discovery',
            'poc',
            'business-viability',
            'design-planning',
            'development',
            'launch-growth',
        ]);
    });

    it('starts with "discovery"', () => {
        const decomposer = new TaskDecomposer(makeConfig(), createMockEventBus() as never);
        expect(decomposer.getPhases()[0]).toBe('discovery');
    });

    it('ends with "launch-growth"', () => {
        const decomposer = new TaskDecomposer(makeConfig(), createMockEventBus() as never);
        const phases = decomposer.getPhases();
        expect(phases[phases.length - 1]).toBe('launch-growth');
    });

    it('getNextPhase and getPhases are consistent — every phase except last has a successor', () => {
        const decomposer = new TaskDecomposer(makeConfig(), createMockEventBus() as never);
        const phases = decomposer.getPhases();
        for (let i = 0; i < phases.length - 1; i++) {
            expect(decomposer.getNextPhase(phases[i])).toBe(phases[i + 1]);
        }
        expect(decomposer.getNextPhase(phases[phases.length - 1])).toBeNull();
    });
});

// ── #165 — phase_task_selections (operator-picked task-type allowlist) ─────────
//
// When the operator picks a per-phase task-type checklist in the New Project
// modal, the decomposer must (1) inject a HARD CONSTRAINT block into the
// system prompt and (2) deterministically filter LLM output to that
// allowlist. NULL or unset selections fall back to today's behaviour.

describe('decompose() — #165 phase_task_selections', () => {
    it('does NOT inject an ALLOWED TASK TYPES block when phase_task_selections is null (legacy)', async () => {
        setupQueryReturnsIds();
        // getOne returns null by default — the project has no selections
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const [systemPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(systemPrompt).not.toContain('ALLOWED TASK TYPES FOR THIS PHASE');
    });

    it('does NOT inject an ALLOWED block when phase_task_selections has no entry for this phase', async () => {
        // Selections object exists but only covers 'development' — discovery is unconstrained
        mockDb.getOne.mockResolvedValueOnce({
            phase_task_selections: { development: ['implement'] },
        });
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const [systemPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(systemPrompt).not.toContain('ALLOWED TASK TYPES FOR THIS PHASE');
    });

    it('injects an ALLOWED TASK TYPES block listing operator-picked types when set', async () => {
        mockDb.getOne.mockResolvedValueOnce({
            phase_task_selections: {
                discovery: ['concept-brief', 'feasibility-assessment'],
            },
        });
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const [systemPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(systemPrompt).toContain('ALLOWED TASK TYPES FOR THIS PHASE (HARD CONSTRAINT');
        expect(systemPrompt).toContain('- concept-brief');
        expect(systemPrompt).toContain('- feasibility-assessment');
        // Override clause must be present
        expect(systemPrompt).toMatch(/Emit ONLY these task types/i);
    });

    it('post-parse filters tasks whose taskType is not on the operator allowlist (defence in depth)', async () => {
        // Operator allows only concept-brief — LLM emits market-research too
        mockDb.getOne.mockResolvedValueOnce({
            phase_task_selections: { discovery: ['concept-brief'] },
        });
        setupQueryReturnsIds();
        const mixed = JSON.stringify([
            {
                title: 'Concept brief',
                description: 'Write the concept brief',
                taskType: 'concept-brief',
                assignedAgent: 'scout',
                priority: 9,
                dependsOn: [],
            },
            {
                title: 'Market research',
                description: 'Should NOT survive — operator opted out',
                taskType: 'market-research',
                assignedAgent: 'scout',
                priority: 7,
                dependsOn: [],
            },
        ]);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(mixed)),
            bus as never,
        );

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        // Only the concept-brief task should survive
        expect(ids).toHaveLength(1);
        const insertCall = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(insertCall[1][3]).toBe('concept-brief'); // task_type column
    });

    it('returns an empty array when every parsed task is outside the operator allowlist', async () => {
        mockDb.getOne.mockResolvedValueOnce({
            phase_task_selections: { discovery: ['concept-brief'] },
        });
        const allDisallowed = JSON.stringify([
            { title: 'X', description: '', taskType: 'market-research', assignedAgent: 'scout', priority: 5, dependsOn: [] },
            { title: 'Y', description: '', taskType: 'competitive-analysis', assignedAgent: 'scout', priority: 5, dependsOn: [] },
        ]);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(
            makeConfig(vi.fn().mockResolvedValue(allDisallowed)),
            bus as never,
        );

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        expect(ids).toEqual([]);
        expect(mockDb.query).not.toHaveBeenCalled(); // no INSERTs because tasks were all filtered
    });

    it('falls back to free-pick when phase_task_selections is malformed (defensive)', async () => {
        // A string instead of an object — should not throw, just skip the constraint
        mockDb.getOne.mockResolvedValueOnce({
            phase_task_selections: 'not-an-object',
        });
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        expect(ids).toHaveLength(1);
        const [systemPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(systemPrompt).not.toContain('ALLOWED TASK TYPES FOR THIS PHASE');
    });

    it('falls back to free-pick when the phase entry is not an array', async () => {
        mockDb.getOne.mockResolvedValueOnce({
            phase_task_selections: { discovery: 'concept-brief' }, // string, not array
        });
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const [systemPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(systemPrompt).not.toContain('ALLOWED TASK TYPES FOR THIS PHASE');
    });

    it('falls back to free-pick when the phase entry is an empty array', async () => {
        // Empty array = "operator picked nothing" — treat as no constraint
        // so the LLM can still emit *something*; otherwise the phase produces
        // zero tasks every time which is hostile UX. The UI should warn at
        // save-time if a phase is enabled but empty.
        mockDb.getOne.mockResolvedValueOnce({
            phase_task_selections: { discovery: [] },
        });
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const [systemPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(systemPrompt).not.toContain('ALLOWED TASK TYPES FOR THIS PHASE');
    });

    it('falls back to free-pick when the getOne query throws', async () => {
        mockDb.getOne.mockRejectedValueOnce(new Error('db is on fire'));
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        const ids = await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        expect(ids).toHaveLength(1); // decomposition still succeeds
        const [systemPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(systemPrompt).not.toContain('ALLOWED TASK TYPES FOR THIS PHASE');
    });

    it('per-phase scoping — discovery selections do not constrain a development decompose', async () => {
        // Operator picked concept-brief for discovery; development is unconstrained
        mockDb.getOne.mockResolvedValueOnce({
            phase_task_selections: { discovery: ['concept-brief'] },
        });
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'development');

        const [systemPrompt] = sendPrompt.mock.calls[0] as [string, string];
        expect(systemPrompt).not.toContain('ALLOWED TASK TYPES FOR THIS PHASE');
    });

    it('dedupes duplicate task-type entries in the operator allowlist', async () => {
        mockDb.getOne.mockResolvedValueOnce({
            phase_task_selections: {
                discovery: ['concept-brief', 'concept-brief', 'feasibility-assessment'],
            },
        });
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        await decomposer.decompose('proj-1', 'My App', 'Desc.', 'discovery');

        const [systemPrompt] = sendPrompt.mock.calls[0] as [string, string];
        // Each type appears exactly once in the bullet list
        expect(systemPrompt.match(/- concept-brief/g) ?? []).toHaveLength(1);
        expect(systemPrompt.match(/- feasibility-assessment/g) ?? []).toHaveLength(1);
    });
});

// ── BPF-10: robust parsing of weak-model JSON ─────────────────────────────────

describe('decompose() — BPF-10 weak-model JSON robustness', () => {
    it('recovers tasks from JSON with a trailing comma (repair, no retry)', async () => {
        setupQueryReturnsIds();
        const trailingComma = '[{"title":"T","description":"d","taskType":"research","assignedAgent":"scout","priority":5,"dependsOn":[]},]';
        const sendPrompt = vi.fn().mockResolvedValue(trailingComma);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        const ids = await decomposer.decompose('proj-1', 'App', 'desc', 'discovery');

        expect(ids.length).toBe(1);
        expect(sendPrompt).toHaveBeenCalledTimes(1); // repair handled it; no retry needed
    });

    it('retries once with reinforcement when the first response is unparseable, then recovers', async () => {
        setupQueryReturnsIds();
        const broken = '[{"title":"X" "description":"missing comma"}]'; // unrepairable by trailing-comma pass
        const sendPrompt = vi.fn()
            .mockResolvedValueOnce(broken)
            .mockResolvedValueOnce(SINGLE_TASK_JSON);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        const ids = await decomposer.decompose('proj-1', 'App', 'desc', 'development');

        expect(sendPrompt).toHaveBeenCalledTimes(2); // reinforced retry fired
        expect(ids.length).toBe(1); // recovered on retry
        // the retry prompt carries the "valid JSON only" reinforcement
        expect(String(sendPrompt.mock.calls[1][1])).toMatch(/valid JSON array/i);
    });

    it('keeps an empty decomposition (no throw) when every attempt is unparseable (fallback off)', async () => {
        setupQueryReturnsIds();
        const broken = 'sorry, I cannot help with that';
        const sendPrompt = vi.fn().mockResolvedValue(broken);
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        // Isolate the re-roll exhaustion path from the BPF-37 fallback so we can
        // assert the retry mechanism gives up cleanly (fallback proven separately).
        process.env.KAGEOPS_DECOMPOSE_FALLBACK = '0';
        try {
            const ids = await decomposer.decompose('proj-1', 'App', 'desc', 'development');
            // BPF-32: 1 initial + 3 reinforced re-rolls (default KAGEOPS_DECOMPOSE_RETRIES).
            expect(sendPrompt).toHaveBeenCalledTimes(4);
            expect(ids.length).toBe(0); // gave up cleanly after exhausting re-rolls, no throw
        } finally {
            delete process.env.KAGEOPS_DECOMPOSE_FALLBACK;
        }
    });

    it('BPF-37: development falls back to a build task when every attempt is unparseable', async () => {
        setupQueryReturnsIds();
        const sendPrompt = vi.fn().mockResolvedValue('sorry, I cannot help with that');
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        const ids = await decomposer.decompose('proj-1', 'App', 'A multi-tenant SaaS dashboard.', 'development');

        expect(sendPrompt).toHaveBeenCalledTimes(4); // exhausts re-rolls first
        expect(ids).toHaveLength(1);                 // then the never-wedge fallback fires
        const call = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(call[1][5]).toBe('forge');            // forge implement (non-simple)
    });

    it('BPF-32: recovers on a LATER re-roll (initial + 2 bad, 3rd parses)', async () => {
        setupQueryReturnsIds();
        const good = JSON.stringify([
            { title: 'T', description: 'd', taskType: 'setup-project', assignedAgent: 'forge', priority: 5, dependsOn: [] },
        ]);
        const sendPrompt = vi.fn()
            .mockResolvedValueOnce('garbage prose, no json')   // initial parse fails
            .mockResolvedValueOnce('still nope')               // re-roll 1 fails
            .mockResolvedValueOnce('nope again')               // re-roll 2 fails
            .mockResolvedValueOnce(good);                      // re-roll 3 parses
        const bus = createMockEventBus();
        const decomposer = new TaskDecomposer(makeConfig(sendPrompt), bus as never);

        const ids = await decomposer.decompose('proj-1', 'App', 'desc', 'development');

        expect(sendPrompt).toHaveBeenCalledTimes(4); // 1 initial + 3 re-rolls, recovered on the last
        expect(ids.length).toBe(1);
    });
});
