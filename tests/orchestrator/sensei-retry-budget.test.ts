/**
 * PR-6 — Sensei honours the env-configurable retry budget.
 *
 * Proves the KAGEOPS_MAX_BUILD_RETRIES override actually flows through the
 * build-fix self-heal loop:
 *   - budget 0  → escalate to a human on the FIRST failure (no fix task).
 *   - budget 4  → a project already at 2 terminal attempts still gets a
 *                 third fix task ("retry 3/4"), where the hardcoded default
 *                 (2) would have escalated.
 *
 * Mirrors the mock harness in sensei-build-remediation.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';
import { RETRY_ENV } from '../../src/orchestrator/retry-budget';

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
        getChannels: vi.fn(() => ['teams']),
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

import { Sensei } from '../../src/orchestrator/sensei';
import type { EventBus } from '../../src/orchestrator/event-bus';

interface BuildGateStatus {
    readonly projectId: string;
    readonly currentPhase: string;
    readonly allTasksComplete: boolean;
    readonly requiresApproval: boolean;
    readonly trustLevel: string;
    readonly canAutoAdvance: boolean;
    readonly buildVerificationPassed: boolean;
    readonly buildFailedStep?: 'install' | 'build' | 'test' | 'e2e' | 'static-check';
    readonly buildFailedStderr?: string;
}

function makeGateStatus(): BuildGateStatus {
    return {
        projectId: 'proj-001',
        currentPhase: 'development',
        allTasksComplete: true,
        requiresApproval: false,
        trustLevel: 'medium',
        canAutoAdvance: false,
        buildVerificationPassed: false,
        buildFailedStep: 'build',
        buildFailedStderr: 'TS2304: Cannot find name "foo".',
    };
}

type CreateBuildRemediation = {
    createBuildRemediationTask: (id: string, gs: BuildGateStatus) => Promise<void>;
};

describe('Sensei build-fix loop honours KAGEOPS_MAX_BUILD_RETRIES (PR-6)', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;
    let sensei: Sensei;
    let routeTaskSpy: ReturnType<typeof vi.fn>;
    let requestApprovalSpy: ReturnType<typeof vi.fn>;
    const prevEnv = process.env[RETRY_ENV.build];

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
        sensei = new Sensei(
            { sendPrompt: vi.fn(async () => '[]') },
            eventBus as unknown as EventBus
        );
        routeTaskSpy = vi.fn(async () => undefined);
        requestApprovalSpy = vi.fn(async () => undefined);
        (sensei as unknown as { router: { routeTask: typeof routeTaskSpy } }).router = {
            routeTask: routeTaskSpy,
        };
        (sensei as unknown as { gateManager: { requestApproval: typeof requestApprovalSpy } }).gateManager = {
            requestApproval: requestApprovalSpy,
        };
    });

    afterEach(() => {
        if (prevEnv === undefined) delete process.env[RETRY_ENV.build];
        else process.env[RETRY_ENV.build] = prevEnv;
    });

    it('budget 0 escalates on the first failure — no fix task created', async () => {
        process.env[RETRY_ENV.build] = '0';
        mockDb.getOne
            .mockResolvedValueOnce({ in_flight: '0' })
            .mockResolvedValueOnce({ finished_count: '0' })
            .mockResolvedValueOnce({ name: 'TestApp' }); // getProjectName on escalation

        await (sensei as unknown as CreateBuildRemediation)
            .createBuildRemediationTask('proj-001', makeGateStatus());

        expect(requestApprovalSpy).toHaveBeenCalledTimes(1);
        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        expect(insertCall).toBeUndefined();
        expect(routeTaskSpy).not.toHaveBeenCalled();
    });

    it('budget 4 lets a project past the default-2 cap keep self-healing ("retry 3/4")', async () => {
        process.env[RETRY_ENV.build] = '4';
        mockDb.getOne
            .mockResolvedValueOnce({ in_flight: '0' })
            // 2 terminal tasks — would escalate under the default budget of 2
            .mockResolvedValueOnce({ finished_count: '2' });
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-bf-x' }], rowCount: 1 });

        await (sensei as unknown as CreateBuildRemediation)
            .createBuildRemediationTask('proj-001', makeGateStatus());

        expect(requestApprovalSpy).not.toHaveBeenCalled();
        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        expect(insertCall).toBeDefined();
        const params = insertCall![1] as readonly unknown[];
        expect(params[2]).toContain('retry 3/4');
        expect(routeTaskSpy).toHaveBeenCalledWith('task-bf-x');
    });
});
