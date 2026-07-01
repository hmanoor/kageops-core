/**
 * ④ Durable recovery — pause-don't-fail on a credential/auth error.
 *
 * A 401 / missing-or-invalid API key must NOT consume the task retry
 * budget (re-running can't conjure a key). Sensei pauses the project and
 * surfaces the specific missing credential via the setup copilot instead;
 * with output checkpoints on (③) the resume after the operator adds the
 * key replays completed work at ~0 tokens.
 *
 * Mirrors the self-contained mock harness in sensei-retry-budget.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';

const mockDb = vi.hoisted(() => {
    const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const getOneFn = vi.fn(async () => null as unknown);
    const getManyFn = vi.fn(async () => [] as unknown[]);
    const initDatabaseFn = vi.fn(async () => undefined);
    const testConnectionFn = vi.fn(async () => true);
    const closePoolFn = vi.fn(async () => undefined);
    const getPoolFn = vi.fn(() => ({ query: queryFn, end: vi.fn() }));
    const reset = (): void => { queryFn.mockClear(); getOneFn.mockClear(); getManyFn.mockClear(); };
    const module = (): Record<string, unknown> => ({
        query: queryFn, getOne: getOneFn, getMany: getManyFn,
        initDatabase: initDatabaseFn, testConnection: testConnectionFn,
        closePool: closePoolFn, getPool: getPoolFn,
    });
    return { query: queryFn, getOne: getOneFn, getMany: getManyFn, reset, module };
});

vi.mock('../../src/db/client', () => mockDb.module());

vi.mock('../../src/comms/comms-sender', () => ({
    CommsSender: vi.fn(() => ({
        start: vi.fn(), stop: vi.fn(),
        enqueue: vi.fn(async () => 'msg-1'),
        processPending: vi.fn(async () => 0),
        getChannels: vi.fn(() => [] as string[]),
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

// Keep the post-failure reflector inert — it's fire-and-forget and would
// otherwise issue its own DB calls during the test.
vi.mock('../../src/orchestrator/reflector', () => ({
    reflectOnFailure: vi.fn(async () => undefined),
}));

import { Sensei } from '../../src/orchestrator/sensei';
import type { EventBus } from '../../src/orchestrator/event-bus';

type Privates = {
    matrix: { recordTaskOutcome: ReturnType<typeof vi.fn> };
    retryTask: (taskId: string, retryCount: number) => Promise<void>;
};

function makeSensei(eventBus: ReturnType<typeof createMockEventBus>): {
    sensei: Sensei;
    priv: Privates;
    maybeRaise: ReturnType<typeof vi.fn>;
} {
    // Inject a fake setup-copilot gate (the real one is commercial) so the flow
    // tests can drive its raise/no-raise decision and assert it was consulted.
    const maybeRaise = vi.fn(async () => false);
    const sensei = new Sensei(
        { sendPrompt: vi.fn(async () => '[]'), setupCopilotGate: { maybeRaise } },
        eventBus as unknown as EventBus,
    );
    const priv = sensei as unknown as Privates;
    // Stub matrix so recordTaskOutcome doesn't touch the DB sequence.
    priv.matrix = { recordTaskOutcome: vi.fn(async () => undefined) } as never;
    // handleEvent() no-ops unless the orchestrator is "running".
    (sensei as unknown as { running: boolean }).running = true;
    return { sensei, priv, maybeRaise };
}

function taskFailedEvent(errorMessage: string): Parameters<Sensei['handleEvent']>[0] {
    return {
        channel: 'task.failed',
        projectId: 'proj-cred',
        taskId: 'task-cred',
        agent: 'forge',
        timestamp: new Date().toISOString(),
        data: { errorMessage },
    } as Parameters<Sensei['handleEvent']>[0];
}

describe('Sensei ④ — pause-don\'t-fail on credential errors', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
        // retry_count 0 → under MAX_TASK_RETRIES, so the DEFAULT path would
        // retry. The credential short-circuit must override that.
        mockDb.getOne.mockImplementation(async (sql: unknown) => {
            const s = String(sql);
            if (s.includes('task_type') && s.includes('retry_count')) {
                return { task_type: 'code-generation', retry_count: 0 } as unknown;
            }
            if (s.includes('SELECT name')) return { name: 'CredTest' } as unknown;
            return null;
        });
    });

    it('does NOT retry on a 401 — pauses and raises the setup copilot', async () => {
        const { sensei, priv, maybeRaise } = makeSensei(eventBus);
        const retrySpy = vi.spyOn(priv, 'retryTask').mockResolvedValue(undefined);
        maybeRaise.mockResolvedValue(true);

        await sensei.handleEvent(taskFailedEvent('HTTP 401: Unauthorized'));

        expect(retrySpy).not.toHaveBeenCalled();
        expect(maybeRaise).toHaveBeenCalledWith('proj-cred');
        // Project parked in awaiting-approval.
        const parkCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && /status\s*=\s*'awaiting-approval'/.test(c[0] as string),
        );
        expect(parkCall).toBeDefined();
        // Copilot pinned the credential → no generic approval.required fallback.
        expect(eventBus.publishedEvents.some((e) => e.channel === 'approval.required')).toBe(false);
    });

    it('falls back to approval.required when the copilot can\'t pin the credential', async () => {
        const { sensei, priv, maybeRaise } = makeSensei(eventBus);
        const retrySpy = vi.spyOn(priv, 'retryTask').mockResolvedValue(undefined);
        maybeRaise.mockResolvedValue(false);

        // OpenRouter's 401 body — the stale-key bug that bit us in the dogfood.
        await sensei.handleEvent(taskFailedEvent('OpenRouter error: User not found'));

        expect(retrySpy).not.toHaveBeenCalled();
        const approval = eventBus.publishedEvents.find((e) => e.channel === 'approval.required');
        expect(approval).toBeDefined();
        expect(String(approval!.event.data.reason)).toMatch(/credential/i);
    });

    it('still retries a normal (non-credential) failure — no over-matching', async () => {
        const { sensei, priv, maybeRaise } = makeSensei(eventBus);
        const retrySpy = vi.spyOn(priv, 'retryTask').mockResolvedValue(undefined);
        maybeRaise.mockResolvedValue(false);

        await sensei.handleEvent(taskFailedEvent('TS2304: Cannot find name "foo"'));

        expect(retrySpy).toHaveBeenCalledWith('task-cred', 0);
        expect(maybeRaise).not.toHaveBeenCalled();
    });
});
