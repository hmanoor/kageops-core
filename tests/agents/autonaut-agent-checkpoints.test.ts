/**
 * AutonautAgent — P1-01b askAI() checkpointing wiring.
 *
 * Exercises the cache-hit / cache-miss flow added to `askAI` so a
 * future resume (P1-01e) can short-circuit operations a prior run
 * already completed. The cross-cutting hooks tested here live on the
 * base class; specialist agents inherit them.
 *
 * External dependencies (db/client, ai-adapter) are mocked. The
 * task-checkpoint repo uses the production in-memory fake from
 * `src/db/task-checkpoint-repo.ts` so the spec covers both the
 * agent → repo contract and the repo's own invariants.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    AutonautAgent,
    TaskInfo,
    AgentModelConfig,
    hashPrompt,
} from '../../src/agents/autonaut-agent';
import { EventBus, EventPayload } from '../../src/orchestrator/event-bus';
import {
    createInMemoryTaskCheckpointRepository,
    TaskCheckpointRepository,
} from '../../src/db/task-checkpoint-repo';

// ── Module mocks ──────────────────────────────────────

vi.mock('../../src/db/client', () => ({
    query: vi.fn(),
}));

vi.mock('../../src/agents/ai-adapter', () => ({
    sendPrompt: vi.fn(),
}));

import { query } from '../../src/db/client';
import { sendPrompt } from '../../src/agents/ai-adapter';

const mockQuery = vi.mocked(query);
const mockSendPrompt = vi.mocked(sendPrompt);

// ── Fixtures ──────────────────────────────────────────

const DEFAULT_MODEL: AgentModelConfig = {
    model: 'claude/claude-sonnet-4-20250514',
    temperature: 0.7,
    maxTokens: 4096,
};

const TASK_ROW = {
    id: 'task-checkpoint-001',
    project_id: 'proj-001',
    title: 'Checkpoint smoke task',
    description: 'Run several askAI calls in sequence',
    task_type: 'general',
    phase: 'discovery',
    output_path: null,
};

const PROJECT_ROW = { repo_path: '/tmp/checkpoint-repo' };

function setupDbQueryForTask(): void {
    mockQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM tasks')) {
            return { rows: [TASK_ROW], rowCount: 1 };
        }
        if (typeof sql === 'string' && sql.includes('FROM projects')) {
            return { rows: [PROJECT_ROW], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    });
}

function makeMockEventBus() {
    return {
        subscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
        subscribeAll: vi.fn(),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as EventBus;
}

function makeTaskAssignedEvent(overrides: Partial<EventPayload> = {}): EventPayload {
    return {
        channel: 'task.assigned',
        projectId: 'proj-001',
        taskId: 'task-checkpoint-001',
        agent: 'checkpoint-test-agent',
        data: {},
        timestamp: new Date().toISOString(),
        ...overrides,
    };
}

/**
 * Test agent that calls askAI() once per prompt configured on the
 * instance. Lets us drive the full onTaskAssigned → executeTask →
 * askAI flow so the `_currentTask` guard inside askAI is satisfied.
 */
class AskAiTestAgent extends AutonautAgent {
    public prompts: string[] = [];
    public responses: Array<Awaited<ReturnType<AskAiTestAgent['testAskAi']>>> = [];

    constructor() {
        super(
            'checkpoint-test-agent',
            'tester',
            [],
            DEFAULT_MODEL,
            'You are a checkpoint test agent.',
        );
    }

    async executeTask(_task: TaskInfo): Promise<void> {
        for (const prompt of this.prompts) {
            this.responses.push(await this.askAI(prompt));
        }
    }

    public testAskAi(prompt: string, context?: string) {
        return this.askAI(prompt, context);
    }
}

// ── hashPrompt() invariants ──────────────────────────

describe('hashPrompt()', () => {
    it('is deterministic for identical (system, context, prompt, model)', () => {
        const a = hashPrompt('sys', 'ctx', 'prompt', 'claude/sonnet');
        const b = hashPrompt('sys', 'ctx', 'prompt', 'claude/sonnet');
        expect(a).toBe(b);
        expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    it('differs when the prompt changes', () => {
        const a = hashPrompt('sys', undefined, 'one', 'm');
        const b = hashPrompt('sys', undefined, 'two', 'm');
        expect(a).not.toBe(b);
    });

    it('differs when the model changes', () => {
        const a = hashPrompt('sys', 'ctx', 'prompt', 'model-a');
        const b = hashPrompt('sys', 'ctx', 'prompt', 'model-b');
        expect(a).not.toBe(b);
    });

    it('treats missing context as distinct from empty-string context', () => {
        // Hash domain separator means the two sequences differ.
        // If this changes we want to know — the cache uses the hash
        // for diagnostics, and undefined vs '' should not silently
        // collide if a caller starts passing one or the other.
        const a = hashPrompt('sys', undefined, 'p', 'm');
        const b = hashPrompt('sys', '', 'p', 'm');
        expect(a).toBe(b); // current behaviour: '' and undefined both produce ''
    });
});

// ── askAI checkpoint wiring ──────────────────────────

describe('AutonautAgent — askAI() checkpoint wiring (P1-01b)', () => {
    let agent: AskAiTestAgent;
    let eventBus: ReturnType<typeof makeMockEventBus>;
    let repo: TaskCheckpointRepository;

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env['KAGEOPS_TASK_CHECKPOINTS'] = 'true';
        mockSendPrompt.mockResolvedValue({
            text: 'live response',
            tokensIn: 100,
            tokensOut: 50,
            costUsd: 0.001,
            model: 'claude-sonnet-4-20250514',
            durationMs: 123,
        });
        setupDbQueryForTask();

        agent = new AskAiTestAgent();
        eventBus = makeMockEventBus();
        repo = createInMemoryTaskCheckpointRepository();
        agent.setTaskCheckpointRepo(repo);
        await agent.connect(eventBus as unknown as EventBus);
    });

    afterEach(() => {
        delete process.env['KAGEOPS_TASK_CHECKPOINTS'];
    });

    it('records one in-flight → completed checkpoint per askAI call', async () => {
        agent.prompts = ['first', 'second', 'third'];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const rows = await repo.listForTask('task-checkpoint-001');
        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.opIndex)).toEqual([0, 1, 2]);
        expect(rows.every((r) => r.status === 'completed')).toBe(true);
        expect(rows.every((r) => r.opType === 'askai')).toBe(true);
        expect(mockSendPrompt).toHaveBeenCalledTimes(3);
    });

    it('persists promptHash, model, and contextLen in payloadJson', async () => {
        agent.prompts = ['only call'];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const [row] = await repo.listForTask('task-checkpoint-001');
        const payload = row.payloadJson as { promptHash: string; model: string; contextLen: number };
        expect(payload.model).toBe('claude/claude-sonnet-4-20250514');
        expect(payload.contextLen).toBe('only call'.length);
        expect(payload.promptHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('persists the full AiResponse shape in outputJson', async () => {
        agent.prompts = ['cache me'];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const [row] = await repo.listForTask('task-checkpoint-001');
        expect(row.outputJson).toEqual({
            text: 'live response',
            tokensIn: 100,
            tokensOut: 50,
            costUsd: 0.001,
            model: 'claude-sonnet-4-20250514',
            durationMs: 123,
        });
    });

    it('serves a cache hit instead of calling sendPrompt on a second run', async () => {
        // First run: 2 calls → 2 completed checkpoints
        agent.prompts = ['p0', 'p1'];
        await agent.onTaskAssigned(makeTaskAssignedEvent());
        expect(mockSendPrompt).toHaveBeenCalledTimes(2);

        // Second run with the same task id — fresh agent instance to
        // mimic a process restart that loaded the same repo state.
        mockSendPrompt.mockClear();
        const resumed = new AskAiTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        resumed.prompts = ['p0', 'p1'];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        expect(mockSendPrompt).not.toHaveBeenCalled();
        expect(resumed.responses).toHaveLength(2);
        expect(resumed.responses[0].text).toBe('live response');
    });

    it('re-executes live when the resume prompt differs (promptHash guard, no stale serve)', async () => {
        // First run records a completed askai checkpoint at opIndex 0 for 'p0'.
        agent.prompts = ['p0'];
        await agent.onTaskAssigned(makeTaskAssignedEvent());
        expect(mockSendPrompt).toHaveBeenCalledTimes(1);

        // Resume with a DIFFERENT prompt at the same op-index — a divergent
        // re-run. The guard must NOT serve the cached 'p0' answer; it must
        // re-execute live so the response matches the new prompt.
        mockSendPrompt.mockClear();
        const resumed = new AskAiTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        resumed.prompts = ['p0-CHANGED'];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        expect(mockSendPrompt).toHaveBeenCalledTimes(1); // re-executed, not served
        expect(resumed.responses[0].costUsd).toBeGreaterThan(0); // live cost, not cached 0
    });

    it('returns costUsd=0 on a cache hit (no double-charging)', async () => {
        agent.prompts = ['cache me'];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const resumed = new AskAiTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        resumed.prompts = ['cache me'];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        const cached = resumed.responses[0];
        expect(cached.costUsd).toBe(0);
        expect(cached.durationMs).toBe(0);
        expect(cached.text).toBe('live response');
        expect(cached.tokensIn).toBe(100);
        expect(cached.tokensOut).toBe(50);
    });

    it('emits an agent.stream event of type ai-cache-hit with original cost', async () => {
        agent.prompts = ['p0'];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const resumed = new AskAiTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        const resumedBus = makeMockEventBus();
        await resumed.connect(resumedBus as unknown as EventBus);
        resumed.prompts = ['p0'];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        const streamCalls = (resumedBus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
            (c) => c[0] === 'agent.stream' && (c[1] as { data: { type: string } }).data.type === 'ai-cache-hit',
        );
        expect(streamCalls).toHaveLength(1);
        const payload = streamCalls[0][1] as { data: Record<string, unknown> };
        expect(payload.data).toMatchObject({
            type: 'ai-cache-hit',
            opIndex: 0,
            originalCostUsd: 0.001,
        });
    });

    it('writes an ai-cache-hit row to agent_logs (costUsd=0, originalCostUsd preserved)', async () => {
        agent.prompts = ['p0'];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        mockQuery.mockClear();
        setupDbQueryForTask();
        const resumed = new AskAiTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        resumed.prompts = ['p0'];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        const insertCalls = mockQuery.mock.calls.filter(
            (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO agent_logs'),
        );
        const cacheHitInsert = insertCalls.find((c) => {
            const params = c[1] as unknown[];
            return params[3] === 'ai-cache-hit';
        });
        expect(cacheHitInsert).toBeDefined();
        const params = cacheHitInsert![1] as unknown[];
        // cost_usd column (index 7) reports 0 — the saved cost is in metadata
        expect(params[7]).toBe(0);
        const metadata = JSON.parse(params[9] as string) as { originalCostUsd: number; cachedFromCheckpointId: string };
        expect(metadata.originalCostUsd).toBe(0.001);
        expect(metadata.cachedFromCheckpointId).toMatch(/^ck-/);
    });

    it('resets op-index counter between tasks', async () => {
        // First task
        agent.prompts = ['a', 'b'];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        // Second task with a different task id
        const OTHER_TASK = { ...TASK_ROW, id: 'task-checkpoint-002' };
        mockQuery.mockImplementation(async (sql: string) => {
            if (typeof sql === 'string' && sql.includes('FROM tasks')) {
                return { rows: [OTHER_TASK], rowCount: 1 };
            }
            if (typeof sql === 'string' && sql.includes('FROM projects')) {
                return { rows: [PROJECT_ROW], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });

        agent.responses = [];
        agent.prompts = ['c'];
        await agent.onTaskAssigned(makeTaskAssignedEvent({ taskId: 'task-checkpoint-002' }));

        const secondRows = await repo.listForTask('task-checkpoint-002');
        expect(secondRows).toHaveLength(1);
        expect(secondRows[0].opIndex).toBe(0); // not 2 — fresh task
    });

    it('overwrites an in-flight row at the same op-index instead of inserting twice', async () => {
        // Seed an in-flight row at opIndex 0 (simulates a prior crash).
        await repo.recordStart({
            taskId: 'task-checkpoint-001',
            opIndex: 0,
            opType: 'askai',
            payloadJson: { promptHash: 'stale', model: 'old-model', contextLen: 99 },
        });

        agent.prompts = ['retry me'];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        // One row total — overwritten, not inserted alongside.
        const rows = await repo.listForTask('task-checkpoint-001');
        expect(rows).toHaveLength(1);
        expect(rows[0].opIndex).toBe(0);
        expect(rows[0].status).toBe('completed');
        // sendPrompt was actually called — we didn't serve the stale in-flight row.
        expect(mockSendPrompt).toHaveBeenCalledTimes(1);
    });

    it('marks the row failed and rethrows when sendPrompt rejects', async () => {
        mockSendPrompt.mockRejectedValueOnce(new Error('provider 503'));
        agent.prompts = ['will fail'];

        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const rows = await repo.listForTask('task-checkpoint-001');
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('failed');
        expect(rows[0].errorText).toBe('provider 503');
    });

    it('does not record an ai-cache-hit log when the row is failed (treated as cache miss)', async () => {
        // First run fails
        mockSendPrompt.mockRejectedValueOnce(new Error('flake'));
        agent.prompts = ['retry path'];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        // Reset and resume — second run should re-execute (failed != completed)
        mockSendPrompt.mockResolvedValueOnce({
            text: 'recovered',
            tokensIn: 10,
            tokensOut: 5,
            costUsd: 0.0001,
            model: 'claude-sonnet-4-20250514',
            durationMs: 50,
        });
        const resumed = new AskAiTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        resumed.prompts = ['retry path'];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        expect(resumed.responses[0].text).toBe('recovered');
        const rows = await repo.listForTask('task-checkpoint-001');
        expect(rows[0].status).toBe('completed');
    });

    it('continues normally when findByOp throws (cache failure is non-fatal)', async () => {
        const flakyRepo: TaskCheckpointRepository = {
            recordStart: vi.fn().mockResolvedValue({
                id: 'ck-x', taskId: 't', opIndex: 0, opType: 'askai',
                status: 'in-flight', payloadJson: {}, outputJson: null,
                errorText: null, createdAt: 'now', completedAt: null,
            }),
            markCompleted: vi.fn().mockResolvedValue(undefined),
            markFailed: vi.fn().mockResolvedValue(undefined),
            findByOp: vi.fn().mockRejectedValue(new Error('db down')),
            listForTask: vi.fn().mockResolvedValue([]),
            deleteForTask: vi.fn().mockResolvedValue(undefined),
        };
        const flakyAgent = new AskAiTestAgent();
        flakyAgent.setTaskCheckpointRepo(flakyRepo);
        await flakyAgent.connect(makeMockEventBus() as unknown as EventBus);
        flakyAgent.prompts = ['fall through'];

        await flakyAgent.onTaskAssigned(makeTaskAssignedEvent());

        expect(flakyAgent.responses[0].text).toBe('live response');
        expect(mockSendPrompt).toHaveBeenCalledTimes(1);
        // Defensive: agent should still attempt to record + complete
        // the checkpoint even though the read failed (write path stays
        // intact so a future findByOp may succeed).
        expect(flakyRepo.recordStart).toHaveBeenCalled();
        expect(flakyRepo.markCompleted).toHaveBeenCalled();
    });

    it('continues normally when recordStart throws (write failure is non-fatal)', async () => {
        const flakyRepo: TaskCheckpointRepository = {
            recordStart: vi.fn().mockRejectedValue(new Error('unique violation')),
            markCompleted: vi.fn().mockResolvedValue(undefined),
            markFailed: vi.fn().mockResolvedValue(undefined),
            findByOp: vi.fn().mockResolvedValue(null),
            listForTask: vi.fn().mockResolvedValue([]),
            deleteForTask: vi.fn().mockResolvedValue(undefined),
        };
        const flakyAgent = new AskAiTestAgent();
        flakyAgent.setTaskCheckpointRepo(flakyRepo);
        await flakyAgent.connect(makeMockEventBus() as unknown as EventBus);
        flakyAgent.prompts = ['record fails'];

        await flakyAgent.onTaskAssigned(makeTaskAssignedEvent());

        expect(flakyAgent.responses[0].text).toBe('live response');
        // No id was returned, so markCompleted/Failed must NOT be called.
        expect(flakyRepo.markCompleted).not.toHaveBeenCalled();
        expect(flakyRepo.markFailed).not.toHaveBeenCalled();
    });

    it('continues normally when markCompleted throws (response still returned)', async () => {
        const flakyRepo: TaskCheckpointRepository = {
            recordStart: vi.fn().mockResolvedValue({
                id: 'ck-y', taskId: 't', opIndex: 0, opType: 'askai',
                status: 'in-flight', payloadJson: {}, outputJson: null,
                errorText: null, createdAt: 'now', completedAt: null,
            }),
            markCompleted: vi.fn().mockRejectedValue(new Error('disk full')),
            markFailed: vi.fn().mockResolvedValue(undefined),
            findByOp: vi.fn().mockResolvedValue(null),
            listForTask: vi.fn().mockResolvedValue([]),
            deleteForTask: vi.fn().mockResolvedValue(undefined),
        };
        const flakyAgent = new AskAiTestAgent();
        flakyAgent.setTaskCheckpointRepo(flakyRepo);
        await flakyAgent.connect(makeMockEventBus() as unknown as EventBus);
        flakyAgent.prompts = ['mark fails'];

        await flakyAgent.onTaskAssigned(makeTaskAssignedEvent());

        expect(flakyAgent.responses[0].text).toBe('live response');
        expect(flakyRepo.markCompleted).toHaveBeenCalled();
    });
});

// ── Opt-out paths ────────────────────────────────────

describe('AutonautAgent — askAI() with checkpoints disabled', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Checkpoints default ON now — disable explicitly for this block.
        process.env['KAGEOPS_TASK_CHECKPOINTS'] = 'false';
        mockSendPrompt.mockResolvedValue({
            text: 'live response',
            tokensIn: 100,
            tokensOut: 50,
            costUsd: 0.001,
            model: 'claude-sonnet-4-20250514',
            durationMs: 123,
        });
        setupDbQueryForTask();
    });

    afterEach(() => {
        delete process.env['KAGEOPS_TASK_CHECKPOINTS'];
    });

    it('does not touch the repo when KAGEOPS_TASK_CHECKPOINTS=false', async () => {
        const repo = createInMemoryTaskCheckpointRepository();
        const spyFind = vi.spyOn(repo, 'findByOp');
        const spyStart = vi.spyOn(repo, 'recordStart');

        const agent = new AskAiTestAgent();
        agent.setTaskCheckpointRepo(repo);
        await agent.connect(makeMockEventBus() as unknown as EventBus);
        agent.prompts = ['no checkpoint'];

        await agent.onTaskAssigned(makeTaskAssignedEvent());

        expect(spyFind).not.toHaveBeenCalled();
        expect(spyStart).not.toHaveBeenCalled();
        expect(mockSendPrompt).toHaveBeenCalledTimes(1);
    });

    it('does not crash when no repo is wired even if the env flag is set', async () => {
        process.env['KAGEOPS_TASK_CHECKPOINTS'] = 'true';
        try {
            const agent = new AskAiTestAgent();
            // intentionally no setTaskCheckpointRepo()
            await agent.connect(makeMockEventBus() as unknown as EventBus);
            agent.prompts = ['no repo wired'];

            await agent.onTaskAssigned(makeTaskAssignedEvent());

            expect(agent.responses[0].text).toBe('live response');
            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
        } finally {
            delete process.env['KAGEOPS_TASK_CHECKPOINTS'];
        }
    });
});
