/**
 * v2.3 Agent Intercept — round-trip integration tests
 *
 * Exercises the full pipeline in one harness:
 *
 *   Sensei.<interceptAction>()
 *     → eventBus.publish('intercept.*')
 *       → AutonautAgent subscription callback
 *         → agent.pause() / resume() / injectGuidance() / takeover()
 *           → agent.checkPause() observes the state change
 *
 * Individual unit tests exist for each layer. These tests catch
 * integration-level breakage — e.g. a channel rename on one side
 * that the other side still expects, or the agent-name filter
 * getting dropped.
 *
 * The real postgres-backed EventBus is not needed: a dispatching
 * in-memory bus with the same surface delivers `publish` → `subscribe`
 * callbacks synchronously, which is enough to verify the contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ───────────────────────────────────────

const mockDb = vi.hoisted(() => {
    const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const getOneFn = vi.fn(async () => null);
    const getManyFn = vi.fn(async () => []);
    const initDatabaseFn = vi.fn(async () => undefined);
    const testConnectionFn = vi.fn(async () => true);
    const closePoolFn = vi.fn(async () => undefined);
    return { query: queryFn, getOne: getOneFn, getMany: getManyFn, initDatabase: initDatabaseFn, testConnection: testConnectionFn, closePool: closePoolFn };
});

vi.mock('../../src/db/client', () => mockDb);
vi.mock('../../src/agents/ai-adapter', () => ({
    sendPrompt: vi.fn(async () => ({ text: 'ok', tokensIn: 0, tokensOut: 0, costUsd: 0, model: 'x', durationMs: 1 })),
}));

import { Sensei } from '../../src/orchestrator/sensei';
import type { EventBus, EventPayload } from '../../src/orchestrator/event-bus';
import { AutonautAgent, type AgentModelConfig, type TaskInfo } from '../../src/agents/autonaut-agent';

// ── Dispatching in-memory EventBus ───────────────────

/**
 * A test double that matches the EventBus surface Sensei + AutonautAgent
 * use. Unlike `createMockEventBus`, publish() dispatches to all matching
 * subscribers so the agent actually reacts to Sensei's commands.
 */
function makeDispatchingBus(): EventBus {
    const subs = new Map<string, Set<(event: EventPayload) => void | Promise<void>>>();
    const all = new Set<(event: EventPayload) => void | Promise<void>>();

    return {
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        subscribe: vi.fn(async (channel: string, cb: (event: EventPayload) => void | Promise<void>) => {
            const existing = subs.get(channel);
            if (existing !== undefined) existing.add(cb);
            else subs.set(channel, new Set([cb]));
        }),
        subscribeAll: vi.fn((cb: (event: EventPayload) => void | Promise<void>) => { all.add(cb); }),
        unsubscribe: vi.fn(async () => undefined),
        unsubscribeAll: vi.fn(),
        publish: vi.fn(async (channel: string, event: Record<string, unknown>) => {
            const payload = { channel, timestamp: new Date().toISOString(), ...event } as EventPayload;
            const channelSubs = subs.get(channel);
            if (channelSubs !== undefined) {
                for (const cb of channelSubs) await cb(payload);
            }
            for (const cb of all) await cb(payload);
        }),
    } as unknown as EventBus;
}

// ── Fixtures ─────────────────────────────────────────

const MODEL: AgentModelConfig = {
    model: 'claude/claude-sonnet-4-20250514',
    temperature: 0.5,
    maxTokens: 1024,
};

const TASK: TaskInfo = {
    id: 'task-42',
    projectId: 'proj-42',
    title: 'Integration task',
    description: 'Round-trip subject',
    taskType: 'research',
    phase: 'discovery',
    outputPath: 'docs/out.md',
    repoPath: '/tmp/repo',
};

class HarnessAgent extends AutonautAgent {
    constructor(name: string) {
        super(name, 'tester', ['testing'] as const, MODEL, 'system prompt');
    }
    async executeTask(_task: TaskInfo): Promise<void> { /* no-op */ }
}

async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setImmediate(r));
}

// ── Tests ────────────────────────────────────────────

describe('v2.3 intercept round-trip — Sensei → EventBus → AutonautAgent', () => {
    let bus: EventBus;
    let sensei: Sensei;
    let agent: HarnessAgent;

    beforeEach(async () => {
        bus = makeDispatchingBus();
        sensei = new Sensei(
            { sendPrompt: vi.fn(async () => ({ text: '', tokensIn: 0, tokensOut: 0, costUsd: 0, model: 'x', durationMs: 1 })) },
            bus,
        );
        await sensei.start();
        agent = new HarnessAgent('forge');
        await agent.connect(bus);
    });

    it('pauseAgent → agent.paused becomes true', async () => {
        expect(agent.paused).toBe(false);
        await sensei.pauseAgent('forge', TASK.id);
        expect(agent.paused).toBe(true);
    });

    it('pauseAgent only pauses the targeted agent (name filter)', async () => {
        const otherAgent = new HarnessAgent('vigil');
        await otherAgent.connect(bus);

        await sensei.pauseAgent('vigil', TASK.id);

        expect(agent.paused).toBe(false);
        expect(otherAgent.paused).toBe(true);
    });

    it('resumeAgent unblocks a parked checkPause', async () => {
        await sensei.pauseAgent('forge', TASK.id);

        let resolved = false;
        const pending = agent.checkPause(TASK).then(() => { resolved = true; });

        await flushMicrotasks();
        expect(resolved).toBe(false);

        await sensei.resumeAgent('forge', TASK.id);
        await pending;

        expect(resolved).toBe(true);
        expect(agent.paused).toBe(false);
    });

    it('injectGuidance delivers the guidance to the agent and auto-resumes', async () => {
        await sensei.pauseAgent('forge', TASK.id);
        const pending = agent.checkPause(TASK);

        await sensei.injectGuidance('forge', TASK.id, 'focus on input validation');

        const guidance = await pending;
        expect(guidance).toBe('focus on input validation');
        expect(agent.paused).toBe(false);
    });

    it('injectGuidance is one-shot — second checkPause returns null', async () => {
        await sensei.pauseAgent('forge', TASK.id);
        const first = agent.checkPause(TASK);
        await sensei.injectGuidance('forge', TASK.id, 'hint');

        expect(await first).toBe('hint');
        expect(await agent.checkPause(TASK)).toBeNull();
    });

    it('takeoverTask causes the next checkPause to throw a human-takeover error', async () => {
        await sensei.pauseAgent('forge', TASK.id);
        const pending = agent.checkPause(TASK);

        await sensei.takeoverTask('forge', TASK.id);

        await expect(pending).rejects.toThrow(/human takeover/i);
    });

    it('resume on a non-paused agent is a no-op (no crash, still not paused)', async () => {
        expect(agent.paused).toBe(false);
        await sensei.resumeAgent('forge', TASK.id);
        expect(agent.paused).toBe(false);
    });

    it('guidance intended for a different agent is ignored', async () => {
        const otherAgent = new HarnessAgent('vigil');
        await otherAgent.connect(bus);

        await sensei.pauseAgent('forge', TASK.id);
        const pending = agent.checkPause(TASK);

        // Guidance is routed to vigil, not forge — forge must stay parked.
        await sensei.injectGuidance('vigil', TASK.id, 'for-vigil-only');

        let resolved = false;
        void pending.then(() => { resolved = true; });
        await flushMicrotasks();
        expect(resolved).toBe(false);
        expect(agent.paused).toBe(true);

        // Release forge so vitest doesn't leak a pending promise.
        await sensei.resumeAgent('forge', TASK.id);
        await pending;
    });

    it('pause → guidance → takeover: takeover still wins over prior guidance', async () => {
        await sensei.pauseAgent('forge', TASK.id);
        const pending = agent.checkPause(TASK);

        await sensei.injectGuidance('forge', TASK.id, 'this should be discarded');
        // The guidance already auto-resumed the agent and delivered the text;
        // a takeover after that point affects the NEXT checkPause.
        const first = await pending;
        expect(first).toBe('this should be discarded');

        await sensei.pauseAgent('forge', TASK.id);
        const next = agent.checkPause(TASK);
        await sensei.takeoverTask('forge', TASK.id);
        await expect(next).rejects.toThrow(/human takeover/i);
    });

    it('Sensei emits the canonical channel names the agent subscribes to', async () => {
        // Tight coupling check — if either side renames a channel, this fails.
        const publishSpy = bus.publish as unknown as ReturnType<typeof vi.fn>;

        await sensei.pauseAgent('forge', TASK.id);
        await sensei.resumeAgent('forge', TASK.id);
        await sensei.injectGuidance('forge', TASK.id, 'x');
        await sensei.takeoverTask('forge', TASK.id);

        const channels = publishSpy.mock.calls.map((c) => c[0]);
        expect(channels).toEqual(
            expect.arrayContaining([
                'intercept.pause',
                'intercept.resume',
                'intercept.guidance',
                'intercept.takeover',
            ]),
        );
    });
});
