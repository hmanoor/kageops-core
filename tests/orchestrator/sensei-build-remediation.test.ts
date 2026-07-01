/**
 * P2-03 — Sensei.createBuildRemediationTask tests.
 *
 * Exercises the BuildVerificationGate-failure → build-fix dispatch loop:
 *   - In-flight guard prevents duplicate dispatches.
 *   - Retry-cap guard (MAX_BUILD_RETRIES = 2) escalates to human approval.
 *   - Task body includes the failed step + truncated stderr.
 *   - Falls back to requestApproval when failedStep is undefined.
 *
 * Mocks db/client + WorkspaceManager + CommsSender for hermetic isolation.
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

function makeGateStatus(overrides: Partial<BuildGateStatus> = {}): BuildGateStatus {
    return {
        projectId: 'proj-001',
        currentPhase: 'development',
        allTasksComplete: true,
        requiresApproval: false,
        trustLevel: 'medium',
        canAutoAdvance: false,
        buildVerificationPassed: false,
        buildFailedStep: 'build',
        buildFailedStderr: 'TS2304: Cannot find name "foo".\n  at app/page.tsx:42:5',
        ...overrides,
    };
}

describe('Sensei.createBuildRemediationTask (P2-03)', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;
    let sensei: Sensei;
    let routeTaskSpy: ReturnType<typeof vi.fn>;
    let requestApprovalSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
        sensei = new Sensei(
            { sendPrompt: vi.fn(async () => '[]') },
            eventBus as unknown as EventBus
        );

        // Stub router.routeTask + gateManager.requestApproval so we can
        // assert calls without exercising their internals.
        routeTaskSpy = vi.fn(async () => undefined);
        requestApprovalSpy = vi.fn(async () => undefined);
        (sensei as unknown as { router: { routeTask: typeof routeTaskSpy } }).router = {
            routeTask: routeTaskSpy,
        };
        (sensei as unknown as { gateManager: { requestApproval: typeof requestApprovalSpy } }).gateManager = {
            requestApproval: requestApprovalSpy,
        };
    });

    it('creates a build-fix task with failedStep + stderr embedded in the description', async () => {
        // getOne #1 (in-flight count) → 0
        // getOne #2 (terminal count) → 0
        mockDb.getOne
            .mockResolvedValueOnce({ in_flight: '0' })
            .mockResolvedValueOnce({ finished_count: '0' });
        // query #1 (INSERT tasks RETURNING id)
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-build-fix-1' }], rowCount: 1 });

        await (sensei as unknown as { createBuildRemediationTask: (id: string, gs: BuildGateStatus) => Promise<void> })
            .createBuildRemediationTask('proj-001', makeGateStatus());

        // Verify the INSERT was made with task_type='build-fix' + the right body
        expect(mockDb.query).toHaveBeenCalled();
        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        expect(insertCall).toBeDefined();
        const sql = insertCall![0] as string;
        const params = insertCall![1] as readonly unknown[];
        expect(sql).toMatch(/'build-fix'/);
        expect(params[0]).toBe('proj-001');
        expect(params[1]).toContain('build');
        expect(params[2]).toContain('Failed step: build');
        expect(params[2]).toContain('TS2304');
        expect(params[2]).toContain('retry 1/2');
        expect(routeTaskSpy).toHaveBeenCalledWith('task-build-fix-1');
        expect(requestApprovalSpy).not.toHaveBeenCalled();
    });

    it('skips dispatch when a build-fix task is already in flight', async () => {
        mockDb.getOne.mockResolvedValueOnce({ in_flight: '1' });

        await (sensei as unknown as { createBuildRemediationTask: (id: string, gs: BuildGateStatus) => Promise<void> })
            .createBuildRemediationTask('proj-001', makeGateStatus());

        // No INSERT, no routeTask, no approval — pure no-op
        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        expect(insertCall).toBeUndefined();
        expect(routeTaskSpy).not.toHaveBeenCalled();
        expect(requestApprovalSpy).not.toHaveBeenCalled();
    });

    it('escalates to requestApproval when MAX_BUILD_RETRIES (2) has been reached', async () => {
        mockDb.getOne
            .mockResolvedValueOnce({ in_flight: '0' })
            // 2 terminal tasks already → at the cap
            .mockResolvedValueOnce({ finished_count: '2' });
        mockDb.getOne.mockResolvedValueOnce({ name: 'TestApp' }); // getProjectName

        await (sensei as unknown as { createBuildRemediationTask: (id: string, gs: BuildGateStatus) => Promise<void> })
            .createBuildRemediationTask('proj-001', makeGateStatus());

        expect(requestApprovalSpy).toHaveBeenCalledTimes(1);
        const [calledProjId, reason] = requestApprovalSpy.mock.calls[0]!;
        expect(calledProjId).toBe('proj-001');
        expect(reason).toContain('build verification still failing');
        expect(reason).toContain('2 fix attempts');
        // No new task inserted on escalation
        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        expect(insertCall).toBeUndefined();
    });

    it('falls back to requestApproval when buildFailedStep is undefined (defensive)', async () => {
        await (sensei as unknown as { createBuildRemediationTask: (id: string, gs: BuildGateStatus) => Promise<void> })
            .createBuildRemediationTask(
                'proj-001',
                makeGateStatus({ buildFailedStep: undefined })
            );

        expect(requestApprovalSpy).toHaveBeenCalledTimes(1);
        expect(requestApprovalSpy.mock.calls[0]![1]).toContain('details unavailable');
        // No DB lookups should happen — the defensive guard short-circuits early
        expect(mockDb.getOne).not.toHaveBeenCalled();
    });

    it('embeds an "(no stderr captured)" fallback when buildFailedStderr is empty', async () => {
        mockDb.getOne
            .mockResolvedValueOnce({ in_flight: '0' })
            .mockResolvedValueOnce({ finished_count: '0' });
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-bf-2' }], rowCount: 1 });

        await (sensei as unknown as { createBuildRemediationTask: (id: string, gs: BuildGateStatus) => Promise<void> })
            .createBuildRemediationTask(
                'proj-001',
                makeGateStatus({ buildFailedStderr: '' })
            );

        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        const params = insertCall![1] as readonly unknown[];
        expect(params[2]).toContain('(no stderr captured)');
    });

    it('shows the second-attempt retry counter when one terminal task has already run', async () => {
        mockDb.getOne
            .mockResolvedValueOnce({ in_flight: '0' })
            .mockResolvedValueOnce({ finished_count: '1' });
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-bf-3' }], rowCount: 1 });

        await (sensei as unknown as { createBuildRemediationTask: (id: string, gs: BuildGateStatus) => Promise<void> })
            .createBuildRemediationTask('proj-001', makeGateStatus());

        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        const params = insertCall![1] as readonly unknown[];
        expect(params[2]).toContain('retry 2/2');
        expect(routeTaskSpy).toHaveBeenCalledWith('task-bf-3');
    });

    it('phrases a static-check failure as deploy-readiness (not "npm run static-check")', async () => {
        mockDb.getOne
            .mockResolvedValueOnce({ in_flight: '0' })
            .mockResolvedValueOnce({ finished_count: '0' });
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-sc-1' }], rowCount: 1 });

        await (sensei as unknown as { createBuildRemediationTask: (id: string, gs: BuildGateStatus) => Promise<void> })
            .createBuildRemediationTask(
                'proj-001',
                makeGateStatus({
                    buildFailedStep: 'static-check',
                    buildFailedStderr: 'Deploy-readiness: module-load-time initializer reads process.env',
                })
            );

        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        const params = insertCall![1] as readonly unknown[];
        expect(params[2]).toContain('Deploy-readiness static checks failed');
        expect(params[2]).not.toContain('npm run static-check');
        expect(params[2]).toContain('getStripe()');
        expect(routeTaskSpy).toHaveBeenCalledWith('task-sc-1');
    });

    it('phrases an e2e failure as a Playwright suite failure', async () => {
        mockDb.getOne
            .mockResolvedValueOnce({ in_flight: '0' })
            .mockResolvedValueOnce({ finished_count: '0' });
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-e2e-1' }], rowCount: 1 });

        await (sensei as unknown as { createBuildRemediationTask: (id: string, gs: BuildGateStatus) => Promise<void> })
            .createBuildRemediationTask(
                'proj-001',
                makeGateStatus({ buildFailedStep: 'e2e', buildFailedStderr: '1 e2e test failed' })
            );

        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        const params = insertCall![1] as readonly unknown[];
        expect(params[2]).toContain('Playwright e2e suite failed');
        expect(params[2]).not.toContain('npm run e2e failed');
    });

    it('honours the "test" failedStep correctly (npm test, not npm run test)', async () => {
        mockDb.getOne
            .mockResolvedValueOnce({ in_flight: '0' })
            .mockResolvedValueOnce({ finished_count: '0' });
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-bf-4' }], rowCount: 1 });

        await (sensei as unknown as { createBuildRemediationTask: (id: string, gs: BuildGateStatus) => Promise<void> })
            .createBuildRemediationTask(
                'proj-001',
                makeGateStatus({
                    buildFailedStep: 'test',
                    buildFailedStderr: 'Expected 2 to be 3',
                })
            );

        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        const params = insertCall![1] as readonly unknown[];
        expect(params[1]).toContain('test');
        // "npm test" not "npm run test"
        expect(params[2]).toContain('`npm test` failed');
        expect(params[2]).not.toContain('`npm run test` failed');
    });
});
