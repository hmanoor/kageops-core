/**
 * BPF-1 — manual approveGate must run the development exit-gate chain.
 *
 * The B dogfood found that approving the development phase in the GUI advanced
 * straight to launch-growth without running the build → deploy-preview →
 * acceptance → credential-copilot chain (it lived only in the autonomous
 * checkGate path), so the app never deployed and the credential ledger never
 * fired. These tests pin the fix: approveGate('development') defers (does NOT
 * advance) while that chain has outstanding work, and advances only when clean.
 * Non-development phases advance as before.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';

const mockDb = vi.hoisted(() => {
    const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const getOneFn = vi.fn(async () => null);
    const getManyFn = vi.fn(async () => []);
    const reset = (): void => {
        queryFn.mockClear();
        getOneFn.mockClear();
        getManyFn.mockClear();
    };
    const surface = {
        query: queryFn,
        getOne: getOneFn,
        getMany: getManyFn,
        initDatabase: vi.fn(async () => undefined),
        testConnection: vi.fn(async () => true),
        closePool: vi.fn(async () => undefined),
        getPool: vi.fn(() => ({ query: queryFn, end: vi.fn() })),
    };
    return { ...surface, reset, module: () => surface };
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

interface GateStatusLike {
    readonly projectId: string;
    readonly currentPhase: string;
    readonly allTasksComplete: boolean;
    readonly requiresApproval: boolean;
    readonly trustLevel: string;
    readonly canAutoAdvance: boolean;
    readonly buildVerificationPassed?: boolean;
    readonly bundleAcceptanceKind?: string;
    readonly previewUrl?: string;
    readonly acceptancePassed?: boolean;
    readonly acceptanceViolations?: readonly unknown[];
}

function gate(overrides: Partial<GateStatusLike>): GateStatusLike {
    return {
        projectId: 'proj-dev',
        currentPhase: 'development',
        allTasksComplete: true,
        requiresApproval: true,
        trustLevel: 'medium',
        canAutoAdvance: false,
        ...overrides,
    };
}

/** Wire a Sensei with stubbed gateManager + spied private hooks. */
function makeHarness(gateStatus: GateStatusLike, opts?: { credentialRaised?: boolean }) {
    const eventBus = createMockEventBus();
    // The setup-copilot gate is commercial + injected; drive it via a fake.
    const maybeRaise = vi.fn(async () => opts?.credentialRaised === true);
    const sensei = new Sensei(
        { sendPrompt: vi.fn(async () => '[]'), setupCopilotGate: { maybeRaise } },
        eventBus as unknown as EventBus
    );

    const checkGate = vi.fn(async () => gateStatus);
    const gmApproveGate = vi.fn(async () => null);
    const requestApproval = vi.fn(async () => undefined);
    (sensei as unknown as { gateManager: unknown }).gateManager = {
        checkGate,
        approveGate: gmApproveGate,
        requestApproval,
    };

    const spies = {
        advanceToNextPhase: vi.fn(async () => undefined),
        scheduleDeployPreviewTask: vi.fn(async () => undefined),
        createBuildRemediationTask: vi.fn(async () => undefined),
        createAcceptanceRemediationTask: vi.fn(async () => undefined),
        maybeRaiseSetupCopilot: maybeRaise,
        sendCommsNotification: vi.fn(async () => undefined),
        checkGate,
    };
    Object.assign(sensei as unknown as Record<string, unknown>, {
        advanceToNextPhase: spies.advanceToNextPhase,
        scheduleDeployPreviewTask: spies.scheduleDeployPreviewTask,
        createBuildRemediationTask: spies.createBuildRemediationTask,
        createAcceptanceRemediationTask: spies.createAcceptanceRemediationTask,
        sendCommsNotification: spies.sendCommsNotification,
    });
    return { sensei, spies, eventBus };
}

/** BPF-6 — the `kind`s of any gate.deferred events published on a mock bus. */
function gateDeferredKinds(eventBus: ReturnType<typeof createMockEventBus>): string[] {
    const publish = (eventBus as unknown as { publish: { mock: { calls: unknown[][] } } }).publish;
    return publish.mock.calls
        .filter((c) => c[0] === 'gate.deferred')
        .map((c) => ((c[1] as { data?: { kind?: string } })?.data?.kind ?? ''));
}

describe('Sensei.approveGate — development exit gate (BPF-1)', () => {
    // Number of genuinely pending/in-flight development tasks the COUNT query returns.
    let pendingDevTasks = 0;
    beforeEach(() => {
        mockDb.reset();
        pendingDevTasks = 0;
        // Route the SQL: the pending-task COUNT vs the phase/name reads.
        mockDb.getOne.mockImplementation(async (sql: string) => {
            if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
                return { n: String(pendingDevTasks) };
            }
            return { phase: 'development', name: 'ClubHub' };
        });
    });

    it('DEFERS (no advance) when development tasks are still in flight (pending > 0)', async () => {
        pendingDevTasks = 2;
        const { sensei, spies } = makeHarness(gate({ allTasksComplete: false }));
        await sensei.approveGate('proj-dev');
        expect(spies.advanceToNextPhase).not.toHaveBeenCalled();
        expect(spies.sendCommsNotification).toHaveBeenCalledTimes(1);
        expect(spies.scheduleDeployPreviewTask).not.toHaveBeenCalled();
    });

    it('does NOT deadlock on a zero-task development phase — advances (BPF-1 regression)', async () => {
        // total===0 → allPhaseTasksComplete returns false, but there is NO
        // pending work, so approval must advance instead of looping forever.
        pendingDevTasks = 0;
        const { sensei, spies } = makeHarness(gate({ allTasksComplete: false }));
        await sensei.approveGate('proj-dev');
        expect(spies.advanceToNextPhase).toHaveBeenCalledTimes(1);
    });

    it('DEFERS and schedules a deploy-preview when build passed but no preview URL', async () => {
        const { sensei, spies } = makeHarness(
            gate({ buildVerificationPassed: true, bundleAcceptanceKind: 'build-tests-preview', previewUrl: undefined })
        );
        await sensei.approveGate('proj-dev');
        expect(spies.scheduleDeployPreviewTask).toHaveBeenCalledTimes(1);
        expect(spies.advanceToNextPhase).not.toHaveBeenCalled();
    });

    it('BPF-15: raises the credential copilot AND still creates the build-fix task (no masking)', async () => {
        // A credential gap must NOT mask an unrelated code build failure — both
        // the copilot prompt and the Forge build-fix task must fire.
        const { sensei, spies } = makeHarness(gate({ buildVerificationPassed: false }), { credentialRaised: true });
        await sensei.approveGate('proj-dev');
        expect(spies.maybeRaiseSetupCopilot).toHaveBeenCalledTimes(1);
        expect(spies.createBuildRemediationTask).toHaveBeenCalledTimes(1);
        expect(spies.advanceToNextPhase).not.toHaveBeenCalled();
    });

    it('DEFERS and creates a build remediation task on a code build failure (no credential gap)', async () => {
        const { sensei, spies } = makeHarness(gate({ buildVerificationPassed: false }), { credentialRaised: false });
        await sensei.approveGate('proj-dev');
        expect(spies.createBuildRemediationTask).toHaveBeenCalledTimes(1);
        expect(spies.advanceToNextPhase).not.toHaveBeenCalled();
    });

    it('DEFERS and creates an acceptance remediation task on an acceptance failure', async () => {
        const { sensei, spies } = makeHarness(
            gate({
                buildVerificationPassed: true,
                previewUrl: 'https://clubhub.vercel.app',
                acceptancePassed: false,
                acceptanceViolations: [{ id: 'missing-hero' }],
            }),
            { credentialRaised: false }
        );
        await sensei.approveGate('proj-dev');
        expect(spies.createAcceptanceRemediationTask).toHaveBeenCalledTimes(1);
        expect(spies.advanceToNextPhase).not.toHaveBeenCalled();
    });

    it('ADVANCES when the exit gate is clean (build passed + preview set + acceptance passed)', async () => {
        const { sensei, spies } = makeHarness(
            gate({
                buildVerificationPassed: true,
                bundleAcceptanceKind: 'build-tests-preview',
                previewUrl: 'https://clubhub.vercel.app',
                acceptancePassed: true,
            })
        );
        await sensei.approveGate('proj-dev');
        expect(spies.advanceToNextPhase).toHaveBeenCalledTimes(1);
        expect(spies.scheduleDeployPreviewTask).not.toHaveBeenCalled();
        expect(spies.createBuildRemediationTask).not.toHaveBeenCalled();
    });
});

describe('Sensei.approveGate — non-development phases advance unchanged (BPF-1 regression)', () => {
    beforeEach(() => {
        mockDb.reset();
    });

    it('advances a non-development phase without running checkGate / the exit gate', async () => {
        mockDb.getOne.mockResolvedValue({ phase: 'discovery', name: 'ClubHub' });
        const { sensei, spies } = makeHarness(gate({ currentPhase: 'discovery' }));
        await sensei.approveGate('proj-dev');
        expect(spies.checkGate).not.toHaveBeenCalled();
        expect(spies.advanceToNextPhase).toHaveBeenCalledTimes(1);
    });
});

describe('Sensei.approveGate — BPF-6 gate.deferred reason surfacing', () => {
    let pendingDevTasks = 0;
    beforeEach(() => {
        mockDb.reset();
        pendingDevTasks = 0;
        mockDb.getOne.mockImplementation(async (sql: string) => {
            if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
                return { n: String(pendingDevTasks) };
            }
            return { phase: 'development', name: 'ClubHub' };
        });
    });

    it('emits kind=pending-tasks when tasks are still in flight', async () => {
        pendingDevTasks = 3;
        const { sensei, eventBus } = makeHarness(gate({ allTasksComplete: false }));
        await sensei.approveGate('proj-dev');
        expect(gateDeferredKinds(eventBus)).toContain('pending-tasks');
    });

    it('emits kind=deploy-pending when a deploy preview is scheduled', async () => {
        const { sensei, eventBus } = makeHarness(
            gate({ buildVerificationPassed: true, bundleAcceptanceKind: 'build-tests-preview', previewUrl: undefined })
        );
        await sensei.approveGate('proj-dev');
        expect(gateDeferredKinds(eventBus)).toContain('deploy-pending');
    });

    it('BPF-7: run-locally mode ADVANCES (no deploy) instead of scheduling a preview', async () => {
        const prev = process.env['KAGEOPS_NO_HOSTING'];
        process.env['KAGEOPS_NO_HOSTING'] = '1';
        try {
            const { sensei, spies, eventBus } = makeHarness(
                gate({ buildVerificationPassed: true, bundleAcceptanceKind: 'build-tests-preview', previewUrl: undefined })
            );
            await sensei.approveGate('proj-dev');
            expect(spies.scheduleDeployPreviewTask).not.toHaveBeenCalled();
            expect(spies.advanceToNextPhase).toHaveBeenCalledTimes(1);
            expect(gateDeferredKinds(eventBus)).not.toContain('deploy-pending');
        } finally {
            if (prev === undefined) delete process.env['KAGEOPS_NO_HOSTING'];
            else process.env['KAGEOPS_NO_HOSTING'] = prev;
        }
    });

    it('emits kind=credential-needed when the setup copilot is raised', async () => {
        const { sensei, eventBus } = makeHarness(gate({ buildVerificationPassed: false }), { credentialRaised: true });
        await sensei.approveGate('proj-dev');
        expect(gateDeferredKinds(eventBus)).toContain('credential-needed');
    });

    it('emits kind=build-failing on a code build failure (no credential gap)', async () => {
        const { sensei, eventBus } = makeHarness(gate({ buildVerificationPassed: false }), { credentialRaised: false });
        await sensei.approveGate('proj-dev');
        expect(gateDeferredKinds(eventBus)).toContain('build-failing');
    });

    it('does NOT emit gate.deferred when the gate is clean and advances', async () => {
        const { sensei, eventBus } = makeHarness(
            gate({
                buildVerificationPassed: true,
                bundleAcceptanceKind: 'build-tests-preview',
                previewUrl: 'https://x.vercel.app',
                acceptancePassed: true,
            })
        );
        await sensei.approveGate('proj-dev');
        expect(gateDeferredKinds(eventBus)).toHaveLength(0);
    });
});
