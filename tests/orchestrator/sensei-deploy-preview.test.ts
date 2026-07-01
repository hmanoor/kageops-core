/**
 * P2-05 — Sensei.scheduleDeployPreviewTask tests.
 *
 * Verifies the post-build-success scheduling logic:
 *   - Creates a deploy-preview task with task_type='deploy-preview'
 *   - In-flight guard prevents duplicates
 *   - Retry-cap guard (MAX_DEPLOY_PREVIEW_RETRIES = 2) escalates to approval
 *   - Routes the new task via the router
 *   - Emits task.created event
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

interface DeployPreviewGateStatus {
    readonly projectId: string;
    readonly currentPhase: string;
    readonly allTasksComplete: boolean;
    readonly requiresApproval: boolean;
    readonly trustLevel: string;
    readonly canAutoAdvance: boolean;
    readonly buildVerificationPassed: boolean;
    readonly bundleAcceptanceKind: 'build-tests-preview';
}

function makeGateStatus(): DeployPreviewGateStatus {
    return {
        projectId: 'proj-001',
        currentPhase: 'development',
        allTasksComplete: true,
        requiresApproval: false,
        trustLevel: 'medium',
        canAutoAdvance: false,
        buildVerificationPassed: true,
        bundleAcceptanceKind: 'build-tests-preview',
    };
}

describe('Sensei.scheduleDeployPreviewTask (P2-05)', () => {
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
        routeTaskSpy = vi.fn(async () => undefined);
        requestApprovalSpy = vi.fn(async () => undefined);
        (sensei as unknown as { router: { routeTask: typeof routeTaskSpy } }).router = {
            routeTask: routeTaskSpy,
        };
        (sensei as unknown as { gateManager: { requestApproval: typeof requestApprovalSpy } }).gateManager = {
            requestApproval: requestApprovalSpy,
        };
    });

    it('creates a deploy-preview task assigned to aegis', async () => {
        mockDb.getOne
            .mockResolvedValueOnce({ in_flight: '0' })
            .mockResolvedValueOnce({ finished_count: '0' });
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-dp-1' }], rowCount: 1 });

        await (sensei as unknown as {
            scheduleDeployPreviewTask: (id: string, gs: DeployPreviewGateStatus) => Promise<void>;
        }).scheduleDeployPreviewTask('proj-001', makeGateStatus());

        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        expect(insertCall).toBeDefined();
        const sql = insertCall![0] as string;
        const params = insertCall![1] as readonly unknown[];
        expect(sql).toMatch(/'deploy-preview'/);
        expect(sql).toMatch(/'aegis'/);
        expect(params[0]).toBe('proj-001');
        expect(params[1]).toContain('Deploy');
        expect(params[2]).toContain('Vercel');
        expect(params[2]).toContain('Retry 1/2');
        expect(routeTaskSpy).toHaveBeenCalledWith('task-dp-1');
        expect(requestApprovalSpy).not.toHaveBeenCalled();
    });

    it('skips when a deploy-preview is already in flight', async () => {
        mockDb.getOne.mockResolvedValueOnce({ in_flight: '1' });

        await (sensei as unknown as {
            scheduleDeployPreviewTask: (id: string, gs: DeployPreviewGateStatus) => Promise<void>;
        }).scheduleDeployPreviewTask('proj-001', makeGateStatus());

        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        expect(insertCall).toBeUndefined();
        expect(routeTaskSpy).not.toHaveBeenCalled();
    });

    it('escalates to requestApproval when MAX_DEPLOY_PREVIEW_RETRIES has been reached', async () => {
        mockDb.getOne
            .mockResolvedValueOnce({ in_flight: '0' })
            .mockResolvedValueOnce({ finished_count: '2' });

        await (sensei as unknown as {
            scheduleDeployPreviewTask: (id: string, gs: DeployPreviewGateStatus) => Promise<void>;
        }).scheduleDeployPreviewTask('proj-001', makeGateStatus());

        expect(requestApprovalSpy).toHaveBeenCalledTimes(1);
        const [, reason] = requestApprovalSpy.mock.calls[0]!;
        expect(reason).toContain('deploy-preview failed after 2 attempts');
        // No new task inserted
        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        expect(insertCall).toBeUndefined();
    });

    it('shows Retry 2/2 in the description on the second attempt', async () => {
        mockDb.getOne
            .mockResolvedValueOnce({ in_flight: '0' })
            .mockResolvedValueOnce({ finished_count: '1' });
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-dp-2' }], rowCount: 1 });

        await (sensei as unknown as {
            scheduleDeployPreviewTask: (id: string, gs: DeployPreviewGateStatus) => Promise<void>;
        }).scheduleDeployPreviewTask('proj-001', makeGateStatus());

        const insertCall = mockDb.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tasks')
        );
        const params = insertCall![1] as readonly unknown[];
        expect(params[2]).toContain('Retry 2/2');
        expect(routeTaskSpy).toHaveBeenCalledWith('task-dp-2');
    });
});
