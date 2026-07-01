/**
 * Orchestrator bootstrap behavioral tests
 *
 * Tests the full initialization/shutdown lifecycle with mocked dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
    const mockAgentConnect = vi.fn(async () => undefined);

    const makeAgentMock = (name: string, role: string) => ({
        name,
        role,
        connect: mockAgentConnect,
        status: 'idle',
        skills: [],
        modelConfig: {
            model: 'claude/claude-sonnet-4-20250514',
            temperature: 0.7,
            maxTokens: 4096,
        },
        setCostTracker: vi.fn(),
        setBranchManager: vi.fn(),
        setFallbackChain: vi.fn(),
        setCodeGraphBridge: vi.fn(),
        setGraphifyBridge: vi.fn(),
        setGitHubClient: vi.fn(),
        setTaskCheckpointRepo: vi.fn(),
    });

    return {
        mockInitDatabase: vi.fn(async () => undefined),
        mockClosePool: vi.fn(async () => undefined),
        mockEventBusConnect: vi.fn(async () => undefined),
        mockEventBusSubscribeAll: vi.fn(),
        mockEventBusDisconnect: vi.fn(async () => undefined),
        mockSenseiStart: vi.fn(async () => undefined),
        mockSenseiStop: vi.fn(async () => undefined),
        mockSenseiHandleUserMessage: vi.fn(async () => 'response'),
        mockAgentConnect,
        mockRegisterAgent: vi.fn(),
        mockShutdownAll: vi.fn(async () => undefined),
        mockGetAllAgents: vi.fn(() => []),
        mockSendPrompt: vi.fn(async () => ({
            text: 'mock response',
            tokensIn: 10,
            tokensOut: 20,
            costUsd: 0,
            model: 'test',
            durationMs: 100,
        })),
        makeAgentMock,
    };
});

vi.mock('../../src/db/client', () => ({
    initDatabase: mocks.mockInitDatabase,
    closePool: mocks.mockClosePool,
}));

vi.mock('../../src/orchestrator/event-bus', () => ({
    EventBus: vi.fn(() => ({
        connect: mocks.mockEventBusConnect,
        subscribe: vi.fn(async () => undefined),
        subscribeAll: mocks.mockEventBusSubscribeAll,
        disconnect: mocks.mockEventBusDisconnect,
    })),
}));

vi.mock('../../src/orchestrator/sensei', () => ({
    Sensei: vi.fn(() => ({
        start: mocks.mockSenseiStart,
        stop: mocks.mockSenseiStop,
        handleUserMessage: mocks.mockSenseiHandleUserMessage,
    })),
}));

vi.mock('../../src/agents/agent-registry', () => ({
    AgentRegistry: vi.fn(() => ({
        registerAgent: mocks.mockRegisterAgent,
        shutdownAll: mocks.mockShutdownAll,
        getAllAgents: mocks.mockGetAllAgents,
        size: 5,
    })),
}));

vi.mock('../../src/agents/ai-adapter', () => ({
    sendPrompt: mocks.mockSendPrompt,
}));

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

vi.mock('../../src/orchestrator/cost-tracker', () => ({
    CostTracker: vi.fn(() => ({
        enforceBudget: vi.fn(async () => undefined),
        recordCost: vi.fn(async () => ({ budgetUsd: 10, spentUsd: 1, remainingUsd: 9, exceeded: false, warningThreshold: false })),
        getProjectBudget: vi.fn(async () => ({ budgetUsd: 10, spentUsd: 0, remainingUsd: 10, exceeded: false, warningThreshold: false })),
        setBudget: vi.fn(async () => undefined),
        checkBudget: vi.fn(async () => ({ budgetUsd: 10, spentUsd: 0, remainingUsd: 10, exceeded: false, warningThreshold: false })),
    })),
    BudgetExceededError: class BudgetExceededError extends Error {
        constructor(projectId: string, budgetUsd: number, spentUsd: number) {
            super(`Budget exceeded for project ${projectId}`);
            this.name = 'BudgetExceededError';
        }
    },
}));

vi.mock('../../src/workspace/branch-manager', () => ({
    BranchManager: vi.fn(() => ({
        createTaskBranch: vi.fn(async () => 'agent/test/abc12345'),
        mergeBranch: vi.fn(async () => ({ success: true, conflicted: false, mergeCommit: 'abc123' })),
        deleteBranch: vi.fn(async () => undefined),
        switchBranch: vi.fn(async () => undefined),
        getCurrentBranch: vi.fn(async () => 'main'),
        branchExists: vi.fn(async () => false),
        buildBranchName: vi.fn(() => 'agent/test/abc12345'),
    })),
}));

vi.mock('../../src/agents/model-fallback', () => ({
    getFallbackChain: vi.fn(() => ({
        models: [{ model: 'claude/claude-sonnet-4-20250514' }],
    })),
    executeFallbackChain: vi.fn(),
    DEFAULT_FALLBACK_CHAINS: {},
}));

vi.mock('../../src/main/activity-bridge', () => ({
    ActivityBridge: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
    })),
}));

vi.mock('../../src/main/command-center-window', () => ({
    getCommandCenterWindow: vi.fn(() => null),
}));

const mockOperationalCostTrackerStart = vi.fn();
const mockOperationalCostTrackerStop = vi.fn();
const mockGetOperationalSummary = vi.fn(async () => ({
    totalToday: 0,
    totalThisWeek: 0,
    totalThisMonth: 0,
    byAgent: [],
    byProvider: [],
    byProject: [],
    lastSyncAt: null,
}));

vi.mock('../../src/orchestrator/operational-cost-tracker', () => ({
    getOperationalCostTracker: vi.fn(() => ({
        start: mockOperationalCostTrackerStart,
        stop: mockOperationalCostTrackerStop,
        getOperationalSummary: mockGetOperationalSummary,
        syncFromLiteLLM: vi.fn(async () => undefined),
        recordDirectCost: vi.fn(async () => undefined),
    })),
    resetOperationalCostTrackerForTesting: vi.fn(),
}));

const mockCodeGraphInitialize = vi.fn(async () => undefined);
const mockCodeGraphShutdownAll = vi.fn(async () => undefined);
const mockCodeGraphGetStatus = vi.fn(() => ({ repoPath: '', state: 'not-started', nodeCount: 0, lastBuiltAt: null, error: null }));
const mockCodeGraphGetAllStatuses = vi.fn(() => []);

vi.mock('../../src/workspace/code-graph-bridge', () => ({
    getCodeGraphBridge: vi.fn(() => ({
        initialize: mockCodeGraphInitialize,
        shutdownAll: mockCodeGraphShutdownAll,
        getStatus: mockCodeGraphGetStatus,
        getAllStatuses: mockCodeGraphGetAllStatuses,
        isDegraded: false,
        buildGraph: vi.fn(async () => null),
        ensureBuilt: vi.fn(async () => undefined),
    })),
    resetCodeGraphBridgeForTesting: vi.fn(),
}));

vi.mock('../../src/workspace/graphify-bridge', () => ({
    getGraphifyBridge: vi.fn(() => ({
        getStatus: vi.fn(() => ({ repoPath: '', hasGraph: false, hasReport: false, hasWiki: false, nodeCount: 0, edgeCount: 0, communityCount: 0, lastModified: null })),
        buildGraph: vi.fn(async () => ({ success: true, nodeCount: 0, edgeCount: 0 })),
        getGodNodes: vi.fn(() => []),
        queryGraph: vi.fn(() => ({ nodes: [], edges: [], summary: '', tokenEstimate: 0 })),
        getReport: vi.fn(() => null),
        getStats: vi.fn(() => null),
    })),
    resetGraphifyBridgeForTesting: vi.fn(),
}));

const mockGitHubIntegrationStart = vi.fn(async () => undefined);
const mockGitHubIntegrationStop = vi.fn();

vi.mock('../../src/github/github-client', () => ({
    getGitHubClient: vi.fn(() => ({
        validateToken: vi.fn(),
        createPullRequest: vi.fn(),
        getCheckRuns: vi.fn(),
        triggerWorkflowDispatch: vi.fn(),
        pushBranch: vi.fn(),
        rateLimitInfo: { remaining: 5000, resetAt: 0 },
    })),
    resetGitHubClientForTesting: vi.fn(),
}));

vi.mock('../../src/github/github-integration', () => ({
    GitHubIntegration: vi.fn(() => ({
        start: mockGitHubIntegrationStart,
        stop: mockGitHubIntegrationStop,
        getTokenStatus: vi.fn(async () => false),
    })),
    resetGitHubIntegrationForTesting: vi.fn(),
}));

// StallWatchdog uses setInterval — mock to a no-op stop fn so tests don't
// leak timers and can assert that shutdownOrchestrator invokes the stop.
const stallMocks = vi.hoisted(() => {
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    return { start, stop };
});
vi.mock('../../src/orchestrator/stall-watchdog', () => ({
    startStallWatchdog: stallMocks.start,
    scanOnce: vi.fn(async () => [] as readonly string[]),
}));

// OSS-split note: the open build wires the orchestrator through the
// `bootstrap-extensions.commercial` stub (returns `noopBootstrapExtensions`),
// so bootstrap never imports the commercial plan-resolver — no mock needed.
// getCurrentPlan defaults to 'free' and planGate to openPlanGate.

vi.mock('../../src/agents/agent-config', () => ({
    loadAgentConfig: vi.fn(() => ({
        defaults: { model: 'claude/claude-sonnet-4-20250514', temperature: 0.7, maxTokens: 4096 },
        agents: {},
    })),
    getAgentModelConfig: vi.fn(() => ({
        model: 'claude/claude-sonnet-4-20250514',
        temperature: 0.7,
        maxTokens: 4096,
    })),
    // F-314+: bootstrap reads the active preset name to compose the
    // routing snapshot Sensei uses for chat replies. Stub it null so
    // the snapshot reports preset='default (custom)' in tests.
    getActivePresetName: vi.fn(() => null),
}));

// PR #74 — model-parser is loaded by orchestrator-bootstrap to derive
// `provider` from a `provider/model` model string for the routing snapshot.
vi.mock('../../src/agents/ai-adapter/model-parser', () => ({
    parseModelString: vi.fn((s: string) => {
        const slash = s.indexOf('/');
        return slash > 0
            ? { provider: s.slice(0, slash), model: s.slice(slash + 1) }
            : { provider: 'claude', model: s };
    }),
}));

// Mock all specialist agents — v0.6: Added setCostTracker, setBranchManager, setFallbackChain
vi.mock('../../src/agents/specialists/scout', () => ({
    Scout: vi.fn(() => mocks.makeAgentMock('scout', 'strategist')),
}));
vi.mock('../../src/agents/specialists/blueprint', () => ({
    Blueprint: vi.fn(() => mocks.makeAgentMock('blueprint', 'architect')),
}));
vi.mock('../../src/agents/specialists/forge', () => ({
    Forge: vi.fn(() => mocks.makeAgentMock('forge', 'engineer')),
}));
vi.mock('../../src/agents/specialists/vigil', () => ({
    Vigil: vi.fn(() => mocks.makeAgentMock('vigil', 'quality-guardian')),
}));
vi.mock('../../src/agents/specialists/aegis', () => ({
    Aegis: vi.fn(() => mocks.makeAgentMock('aegis', 'platform-engineer')),
}));
vi.mock('../../src/agents/specialists/pixel', () => ({
    Pixel: vi.fn(() => mocks.makeAgentMock('pixel', 'designer')),
}));
vi.mock('../../src/agents/specialists/cipher', () => ({
    Cipher: vi.fn(() => mocks.makeAgentMock('cipher', 'data-specialist')),
}));
vi.mock('../../src/agents/specialists/herald', () => ({
    Herald: vi.fn(() => mocks.makeAgentMock('herald', 'marketer')),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import {
    bootstrapOrchestrator,
    shutdownOrchestrator,
} from '../../src/main/orchestrator-bootstrap';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('orchestrator-bootstrap', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('bootstrapOrchestrator()', () => {
        it('returns OrchestratorHandles when database is available', async () => {
            const result = await bootstrapOrchestrator('/tmp/projects');

            expect(result).not.toBeNull();
            expect(result).toHaveProperty('sensei');
            expect(result).toHaveProperty('agentRegistry');
            expect(result).toHaveProperty('eventBus');
            expect(result).toHaveProperty('commsSender');
            expect(result).toHaveProperty('activityBridge');
            expect(result).toHaveProperty('operationalCostTracker');
            expect(result).toHaveProperty('codeGraphBridge');
            expect(result).toHaveProperty('graphifyBridge');
            expect(result).toHaveProperty('githubIntegration');
        });

        it('starts OperationalCostTracker during bootstrap', async () => {
            await bootstrapOrchestrator('/tmp/projects');
            expect(mockOperationalCostTrackerStart).toHaveBeenCalledTimes(1);
        });

        it('initializes CodeGraphBridge during bootstrap', async () => {
            await bootstrapOrchestrator('/tmp/projects');
            expect(mockCodeGraphInitialize).toHaveBeenCalledTimes(1);
        });

        it('starts GitHubIntegration during bootstrap', async () => {
            await bootstrapOrchestrator('/tmp/projects');
            expect(mockGitHubIntegrationStart).toHaveBeenCalledTimes(1);
        });

        it('returns null when initDatabase throws', async () => {
            mocks.mockInitDatabase.mockRejectedValueOnce(new Error('Connection refused'));

            const result = await bootstrapOrchestrator('/tmp/projects');

            expect(result).toBeNull();
        });

        it('calls initDatabase with retry config', async () => {
            await bootstrapOrchestrator('/tmp/projects');

            expect(mocks.mockInitDatabase).toHaveBeenCalledWith(
                expect.objectContaining({ maxRetries: 3, retryDelayMs: 1000 })
            );
        });

        it('registers all 8 specialist agents', async () => {
            await bootstrapOrchestrator('/tmp/projects');

            expect(mocks.mockRegisterAgent).toHaveBeenCalledTimes(8);
        });

        it('connects all agents to EventBus', async () => {
            await bootstrapOrchestrator('/tmp/projects');

            expect(mocks.mockAgentConnect).toHaveBeenCalledTimes(8);
        });

        it('injects CostTracker, BranchManager, and FallbackChain into all agents', async () => {
            await bootstrapOrchestrator('/tmp/projects');

            // Each specialist constructor was called once — verify injection methods
            const { Scout } = await import('../../src/agents/specialists/scout');
            const { Blueprint } = await import('../../src/agents/specialists/blueprint');
            const { Forge } = await import('../../src/agents/specialists/forge');
            const { Vigil } = await import('../../src/agents/specialists/vigil');
            const { Aegis } = await import('../../src/agents/specialists/aegis');
            const { Pixel } = await import('../../src/agents/specialists/pixel');
            const { Cipher } = await import('../../src/agents/specialists/cipher');
            const { Herald } = await import('../../src/agents/specialists/herald');

            const constructors = [Scout, Blueprint, Forge, Vigil, Aegis, Pixel, Cipher, Herald];
            for (const Ctor of constructors) {
                const instance = vi.mocked(Ctor).mock.results[0]?.value;
                expect(instance).toBeDefined();
                expect(instance.setCostTracker).toHaveBeenCalledTimes(1);
                expect(instance.setBranchManager).toHaveBeenCalledTimes(1);
                expect(instance.setFallbackChain).toHaveBeenCalledTimes(1);
            }
        });

        it('calls sensei.start()', async () => {
            await bootstrapOrchestrator('/tmp/projects');

            expect(mocks.mockSenseiStart).toHaveBeenCalledTimes(1);
        });

        it('returns null and calls closePool on non-DB error', async () => {
            mocks.mockSenseiStart.mockRejectedValueOnce(new Error('EventBus connect failed'));

            const result = await bootstrapOrchestrator('/tmp/projects');

            expect(result).toBeNull();
            expect(mocks.mockClosePool).toHaveBeenCalledTimes(1);
        });

        it('uses provided databaseUrl parameter', async () => {
            const { EventBus } = await import('../../src/orchestrator/event-bus');

            await bootstrapOrchestrator('/tmp/projects', 'postgres://custom:url@host/db');

            expect(EventBus).toHaveBeenCalledWith('postgres://custom:url@host/db');
        });
    });

    describe('shutdownOrchestrator()', () => {
        it('calls sensei.stop()', async () => {
            const handles = await bootstrapOrchestrator('/tmp/projects');
            expect(handles).not.toBeNull();

            await shutdownOrchestrator(handles!);

            expect(mocks.mockSenseiStop).toHaveBeenCalledTimes(1);
        });

        it('calls agentRegistry.shutdownAll()', async () => {
            const handles = await bootstrapOrchestrator('/tmp/projects');
            expect(handles).not.toBeNull();

            await shutdownOrchestrator(handles!);

            expect(mocks.mockShutdownAll).toHaveBeenCalledTimes(1);
        });

        it('calls closePool()', async () => {
            const handles = await bootstrapOrchestrator('/tmp/projects');
            expect(handles).not.toBeNull();

            mocks.mockClosePool.mockClear();
            await shutdownOrchestrator(handles!);

            expect(mocks.mockClosePool).toHaveBeenCalledTimes(1);
        });

        it('does not throw if sensei.stop() fails', async () => {
            const handles = await bootstrapOrchestrator('/tmp/projects');
            expect(handles).not.toBeNull();

            mocks.mockSenseiStop.mockRejectedValueOnce(new Error('stop failed'));

            await expect(shutdownOrchestrator(handles!)).resolves.toBeUndefined();
        });

        it('stops OperationalCostTracker during shutdown', async () => {
            const handles = await bootstrapOrchestrator('/tmp/projects');
            expect(handles).not.toBeNull();

            mockOperationalCostTrackerStop.mockClear();
            await shutdownOrchestrator(handles!);

            expect(mockOperationalCostTrackerStop).toHaveBeenCalledTimes(1);
        });

        it('calls codeGraphBridge.shutdownAll() during shutdown', async () => {
            const handles = await bootstrapOrchestrator('/tmp/projects');
            expect(handles).not.toBeNull();

            mockCodeGraphShutdownAll.mockClear();
            await shutdownOrchestrator(handles!);

            expect(mockCodeGraphShutdownAll).toHaveBeenCalledTimes(1);
        });

        it('calls githubIntegration.stop() during shutdown', async () => {
            const handles = await bootstrapOrchestrator('/tmp/projects');
            expect(handles).not.toBeNull();

            mockGitHubIntegrationStop.mockClear();
            await shutdownOrchestrator(handles!);

            expect(mockGitHubIntegrationStop).toHaveBeenCalledTimes(1);
        });

        it('starts the stall watchdog during bootstrap', async () => {
            stallMocks.start.mockClear();
            await bootstrapOrchestrator('/tmp/projects');
            expect(stallMocks.start).toHaveBeenCalledTimes(1);
        });

        it('stops the stall watchdog during shutdown', async () => {
            const handles = await bootstrapOrchestrator('/tmp/projects');
            expect(handles).not.toBeNull();

            stallMocks.stop.mockClear();
            await shutdownOrchestrator(handles!);
            expect(stallMocks.stop).toHaveBeenCalledTimes(1);
        });
    });
});
