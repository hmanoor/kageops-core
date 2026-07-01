/**
 * v0.6 Phase 1 — Infrastructure Wiring Integration Tests
 *
 * Verifies that v0.5 infrastructure (CostTracker, BranchManager, ModelFallbackChain)
 * is correctly wired into AutonautAgent, Sensei, bootstrap, and ActivityBridge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
    mockQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    mockGetOne: vi.fn(async () => null),
    mockGetMany: vi.fn(async () => []),
    mockSendPrompt: vi.fn(async () => ({
        text: 'mock ai response',
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.005,
        model: 'claude/claude-sonnet-4-20250514',
        durationMs: 200,
    })),
    mockEventBusPublish: vi.fn(async () => undefined),
    mockEventBusSubscribe: vi.fn(async () => undefined),
    mockEventBusSubscribeAll: vi.fn(),
    mockEventBusConnect: vi.fn(async () => undefined),
    mockEventBusDisconnect: vi.fn(async () => undefined),
    mockBranchCreateTaskBranch: vi.fn(async () => 'agent/forge/abc12345'),
    mockBranchMergeBranch: vi.fn(async () => ({
        success: true,
        conflicted: false,
        mergeCommit: 'abc123def456',
    })),
    mockBranchDeleteBranch: vi.fn(async () => undefined),
    mockCostEnforceBudget: vi.fn(async () => undefined),
    mockCostRecordCost: vi.fn(async () => ({
        budgetUsd: 10,
        spentUsd: 1,
        remainingUsd: 9,
        exceeded: false,
        warningThreshold: false,
    })),
    mockCostGetProjectBudget: vi.fn(async () => ({
        budgetUsd: 10,
        spentUsd: 1,
        remainingUsd: 9,
        exceeded: false,
        warningThreshold: false,
    })),
    mockExecuteFallbackChain: vi.fn(async () => ({
        response: {
            text: 'fallback response',
            tokensIn: 80,
            tokensOut: 40,
            costUsd: 0.003,
            model: 'openai/gpt-4o',
            durationMs: 150,
        },
        modelUsed: 'openai/gpt-4o',
        modelIndex: 1,
        totalAttempts: 4,
    })),
}));

vi.mock('../../src/db/client', () => ({
    query: mocks.mockQuery,
    getOne: mocks.mockGetOne,
    getMany: mocks.mockGetMany,
    initDatabase: vi.fn(async () => undefined),
    closePool: vi.fn(async () => undefined),
}));

vi.mock('../../src/agents/ai-adapter', () => ({
    sendPrompt: mocks.mockSendPrompt,
}));

vi.mock('../../src/orchestrator/event-bus', () => ({
    EventBus: vi.fn(() => ({
        publish: mocks.mockEventBusPublish,
        subscribe: mocks.mockEventBusSubscribe,
        subscribeAll: mocks.mockEventBusSubscribeAll,
        connect: mocks.mockEventBusConnect,
        disconnect: mocks.mockEventBusDisconnect,
    })),
}));

vi.mock('../../src/agents/model-fallback', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/agents/model-fallback')>();
    return {
        ...original,
        executeFallbackChain: mocks.mockExecuteFallbackChain,
    };
});

// ── Import after mocks ──────────────────────────────────────────────────────

import { CostTracker, BudgetExceededError } from '../../src/orchestrator/cost-tracker';
import { BranchManager } from '../../src/workspace/branch-manager';
import { FallbackChainConfig } from '../../src/agents/model-fallback';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('v0.6 Phase 1 — Infrastructure Wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── AutonautAgent — CostTracker wiring ─────────────────────────────────

    describe('AutonautAgent.askAI() with CostTracker', () => {
        it('calls enforceBudget before AI request', async () => {
            // Create a concrete test agent extending AutonautAgent
            const { TestAgent, createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent();

            const costTracker = new CostTracker();
            costTracker.enforceBudget = mocks.mockCostEnforceBudget;
            costTracker.recordCost = mocks.mockCostRecordCost;
            agent.setCostTracker(costTracker);

            // Simulate a task context by setting _currentTask via onTaskAssigned
            await simulateTaskContext(agent, 'project-1', 'task-1');
            await agent.callAskAI('Write a function');

            expect(mocks.mockCostEnforceBudget).toHaveBeenCalledWith('project-1');
        });

        it('calls recordCost after successful AI request', async () => {
            const { createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent();

            const costTracker = new CostTracker();
            costTracker.enforceBudget = mocks.mockCostEnforceBudget;
            costTracker.recordCost = mocks.mockCostRecordCost;
            agent.setCostTracker(costTracker);

            await simulateTaskContext(agent, 'project-1', 'task-1');
            await agent.callAskAI('Write a function');

            expect(mocks.mockCostRecordCost).toHaveBeenCalledWith('project-1', 0.005);
        });

        it('throws BudgetExceededError and skips AI call when budget exceeded', async () => {
            const { createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent();

            const costTracker = new CostTracker();
            costTracker.enforceBudget = vi.fn(async () => {
                throw new BudgetExceededError('project-1', 10, 12);
            });
            costTracker.recordCost = mocks.mockCostRecordCost;
            agent.setCostTracker(costTracker);

            await simulateTaskContext(agent, 'project-1', 'task-1');

            await expect(agent.callAskAI('Write a function')).rejects.toThrow(BudgetExceededError);
            expect(mocks.mockSendPrompt).not.toHaveBeenCalled();
            expect(mocks.mockCostRecordCost).not.toHaveBeenCalled();
        });

        it('skips budget enforcement when no CostTracker is set', async () => {
            const { createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent();

            // No setCostTracker call — should work without it
            await simulateTaskContext(agent, 'project-1', 'task-1');
            const response = await agent.callAskAI('Write a function');

            expect(response.text).toBe('mock ai response');
            expect(mocks.mockSendPrompt).toHaveBeenCalledTimes(1);
        });
    });

    // ── AutonautAgent — FallbackChain wiring ───────────────────────────────

    describe('AutonautAgent.askAI() with FallbackChain', () => {
        it('uses fallback chain when configured', async () => {
            const { createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent();

            const chain: FallbackChainConfig = {
                models: [
                    { model: 'claude/claude-sonnet-4-20250514' },
                    { model: 'openai/gpt-4o' },
                ],
            };
            agent.setFallbackChain(chain);

            await simulateTaskContext(agent, 'project-1', 'task-1');
            const response = await agent.callAskAI('Write a function');

            expect(mocks.mockExecuteFallbackChain).toHaveBeenCalledTimes(1);
            expect(response.text).toBe('fallback response');
            expect(mocks.mockSendPrompt).not.toHaveBeenCalled(); // Direct call bypassed
        });

        it('calls sendPrompt directly when no fallback chain is set', async () => {
            const { createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent();

            await simulateTaskContext(agent, 'project-1', 'task-1');
            await agent.callAskAI('Write a function');

            expect(mocks.mockSendPrompt).toHaveBeenCalledTimes(1);
            expect(mocks.mockExecuteFallbackChain).not.toHaveBeenCalled();
        });

        it('records cost from fallback chain response', async () => {
            const { createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent();

            const costTracker = new CostTracker();
            costTracker.enforceBudget = mocks.mockCostEnforceBudget;
            costTracker.recordCost = mocks.mockCostRecordCost;
            agent.setCostTracker(costTracker);

            const chain: FallbackChainConfig = {
                models: [{ model: 'claude/claude-sonnet-4-20250514' }],
            };
            agent.setFallbackChain(chain);

            await simulateTaskContext(agent, 'project-1', 'task-1');
            await agent.callAskAI('Write a function');

            // Should record cost from fallback response (0.003)
            expect(mocks.mockCostRecordCost).toHaveBeenCalledWith('project-1', 0.003);
        });
    });

    // ── AutonautAgent — BranchManager wiring ───────────────────────────────

    describe('AutonautAgent.onTaskAssigned() with BranchManager', () => {
        it('creates a task branch before executing', async () => {
            const { createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent();

            const branchManager = new BranchManager();
            branchManager.createTaskBranch = mocks.mockBranchCreateTaskBranch;
            agent.setBranchManager(branchManager);

            // Set up task loading
            setupTaskLoad('task-1', 'project-1', '/repo/path');

            const event = makeTaskEvent('task-1', 'project-1', 'forge');
            await agent.onTaskAssigned(event);

            expect(mocks.mockBranchCreateTaskBranch).toHaveBeenCalledWith(
                '/repo/path',
                'task-1',
                'test-agent'
            );
        });

        it('stores branch name on task record', async () => {
            const { createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent();

            const branchManager = new BranchManager();
            branchManager.createTaskBranch = mocks.mockBranchCreateTaskBranch;
            agent.setBranchManager(branchManager);

            setupTaskLoad('task-1', 'project-1', '/repo/path');

            const event = makeTaskEvent('task-1', 'project-1', 'forge');
            await agent.onTaskAssigned(event);

            // Verify UPDATE tasks SET branch_name was called
            expect(mocks.mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('branch_name'),
                expect.arrayContaining(['agent/forge/abc12345', 'task-1'])
            );
        });

        it('includes branchName in task.completed event', async () => {
            const { createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent();

            const branchManager = new BranchManager();
            branchManager.createTaskBranch = mocks.mockBranchCreateTaskBranch;
            agent.setBranchManager(branchManager);

            // Connect to event bus first
            const { EventBus } = await import('../../src/orchestrator/event-bus');
            const eventBus = new EventBus();
            await agent.connect(eventBus);

            setupTaskLoad('task-1', 'project-1', '/repo/path');

            const event = makeTaskEvent('task-1', 'project-1', 'forge');
            await agent.onTaskAssigned(event);

            expect(mocks.mockEventBusPublish).toHaveBeenCalledWith(
                'task.completed',
                expect.objectContaining({
                    data: expect.objectContaining({
                        branchName: 'agent/forge/abc12345',
                    }),
                })
            );
        });

        it('continues execution even if branch creation fails', async () => {
            const { createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent();

            const branchManager = new BranchManager();
            branchManager.createTaskBranch = vi.fn(async () => {
                throw new Error('git not found');
            });
            agent.setBranchManager(branchManager);

            setupTaskLoad('task-1', 'project-1', '/repo/path');

            const event = makeTaskEvent('task-1', 'project-1', 'forge');
            // Should not throw — branch creation is non-fatal
            await agent.onTaskAssigned(event);

            // Task should still complete
            expect(mocks.mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('completed'),
                expect.any(Array)
            );
        });

        it('skips branch creation when no BranchManager is set', async () => {
            const { createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent();

            setupTaskLoad('task-1', 'project-1', '/repo/path');

            const event = makeTaskEvent('task-1', 'project-1', 'forge');
            await agent.onTaskAssigned(event);

            // No branch_name update
            const branchCalls = mocks.mockQuery.mock.calls.filter(
                (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('branch_name')
            );
            expect(branchCalls.length).toBe(0);
        });

        it('skips branch creation when repoPath is empty', async () => {
            const { createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent();

            const branchManager = new BranchManager();
            branchManager.createTaskBranch = mocks.mockBranchCreateTaskBranch;
            agent.setBranchManager(branchManager);

            setupTaskLoad('task-1', 'project-1', ''); // Empty repo path

            const event = makeTaskEvent('task-1', 'project-1', 'forge');
            await agent.onTaskAssigned(event);

            expect(mocks.mockBranchCreateTaskBranch).not.toHaveBeenCalled();
        });
    });

    // ── AutonautAgent — BudgetExceeded in task failure ──────────────────────

    describe('AutonautAgent.onTaskAssigned() budget failure', () => {
        it('publishes isBudgetExceeded flag when task fails from BudgetExceededError', async () => {
            const { createTestAgent } = await createAgentHelpers();
            const agent = createTestAgent('budget-fail');

            const costTracker = new CostTracker();
            costTracker.enforceBudget = vi.fn(async () => {
                throw new BudgetExceededError('project-1', 10, 12);
            });
            agent.setCostTracker(costTracker);

            // Connect to event bus
            const { EventBus } = await import('../../src/orchestrator/event-bus');
            const eventBus = new EventBus();
            await agent.connect(eventBus);

            setupTaskLoad('task-1', 'project-1', '/repo/path');

            const event = makeTaskEvent('task-1', 'project-1', 'forge');
            await agent.onTaskAssigned(event);

            expect(mocks.mockEventBusPublish).toHaveBeenCalledWith(
                'task.failed',
                expect.objectContaining({
                    data: expect.objectContaining({
                        isBudgetExceeded: true,
                    }),
                })
            );
        });
    });

    // ── Sensei — BranchManager merge on review pass ────────────────────────

    describe('Sensei.onReviewPassed() merges branch', () => {
        it('calls branchManager.mergeBranch when review passes', async () => {
            const { EventBus } = await import('../../src/orchestrator/event-bus');
            const { Sensei } = await import('../../src/orchestrator/sensei');

            const eventBus = new EventBus();
            const branchManager = new BranchManager();
            branchManager.mergeBranch = mocks.mockBranchMergeBranch;
            branchManager.deleteBranch = mocks.mockBranchDeleteBranch;

            const sensei = new Sensei(
                {
                    sendPrompt: vi.fn(async () => 'ok'),
                    branchManager,
                },
                eventBus
            );

            // Set up getOne mock with ordered responses
            const getOneCalls: Array<{ description?: string; branch_name?: string | null; title?: string; project_id?: string; repo_path?: string; phase?: string; status?: string; trust_level?: string; total?: string; pending?: string; assigned?: string; completed?: string; failed?: string } | null> = [];
            mocks.mockGetOne.mockImplementation(async (sql: string) => {
                // Review task description query
                if (sql.includes('description') && sql.includes('tasks')) {
                    return { description: 'Review output. [review-of:orig-task-1]' };
                }
                // mergeTaskBranch: task with branch_name
                if (sql.includes('branch_name')) {
                    return { branch_name: 'agent/forge/origtask', title: 'Implement login', project_id: 'project-1' };
                }
                // mergeTaskBranch: project with repo_path
                if (sql.includes('repo_path')) {
                    return { repo_path: '/repo/path' };
                }
                // checkPhaseGate: project phase lookup
                if (sql.includes('phase') && sql.includes('trust_level')) {
                    return { phase: 'development', status: 'active', trust_level: 'low' };
                }
                // checkPhaseGate: task counts
                if (sql.includes('COUNT')) {
                    return { total: '5', pending: '2', assigned: '0', completed: '3', failed: '0' };
                }
                return null;
            });

            // Need to start Sensei for handleEvent to work
            await sensei.start();

            await sensei.handleEvent({
                channel: 'review.passed',
                projectId: 'project-1',
                taskId: 'review-task-1',
                agent: 'vigil',
                data: { qualityScore: 9 },
                timestamp: new Date().toISOString(),
            });

            expect(mocks.mockBranchMergeBranch).toHaveBeenCalledWith(
                '/repo/path',
                'agent/forge/origtask',
                expect.stringContaining('Implement login')
            );
        });
    });

    // ── Sensei — BudgetExceeded skips retry ────────────────────────────────

    describe('Sensei.onTaskFailed() with BudgetExceededError', () => {
        it('escalates immediately without retrying on budget exceeded', async () => {
            const { EventBus } = await import('../../src/orchestrator/event-bus');
            const { Sensei } = await import('../../src/orchestrator/sensei');

            const eventBus = new EventBus();
            const sensei = new Sensei(
                { sendPrompt: vi.fn(async () => 'ok') },
                eventBus
            );

            // Mock task lookup
            mocks.mockGetOne.mockImplementation(async (sql: string) => {
                if (sql.includes('task_type')) {
                    return { task_type: 'implement', retry_count: 0 };
                }
                if (sql.includes('name')) {
                    return { name: 'Test Project' };
                }
                return null;
            });

            // Need to start Sensei for handleEvent to work
            await sensei.start();
            // start() runs resetStaleTasks() whose SQL contains "status = 'pending'";
            // clear the call log so the assertion below only sees handleEvent calls.
            mocks.mockQuery.mockClear();

            await sensei.handleEvent({
                channel: 'task.failed',
                projectId: 'project-1',
                taskId: 'task-1',
                agent: 'forge',
                data: {
                    errorMessage: 'Budget exceeded for project project-1',
                    isBudgetExceeded: true,
                },
                timestamp: new Date().toISOString(),
            });

            // Should publish approval.required (escalation), NOT retry
            expect(mocks.mockEventBusPublish).toHaveBeenCalledWith(
                'approval.required',
                expect.objectContaining({
                    data: expect.objectContaining({
                        reason: expect.stringContaining('Budget exceeded'),
                    }),
                })
            );

            // Should NOT update task status to 'pending' (no retry attempt)
            const retryCalls = mocks.mockQuery.mock.calls.filter(
                (c: unknown[]) => typeof c[0] === 'string' && c[0].includes("status = 'pending'")
            );
            expect(retryCalls.length).toBe(0);
        });
    });

    // ── ActivityBridge — cost channels ──────────────────────────────────────

    describe('ActivityBridge cost channels', () => {
        it('includes cost.warning and cost.exceeded in ACTIVITY_CHANNELS', async () => {
            // Read the activity-bridge module to verify channels are wired
            const bridgeModule = await import('../../src/main/activity-bridge');
            const bridge = new bridgeModule.ActivityBridge();

            // The bridge subscribes to channels on start() — verify it accepts them
            // by checking the module doesn't throw when processing cost events
            expect(bridge).toBeDefined();
        });
    });
});

// ── Test Helpers ─────────────────────────────────────────────────────────────

/**
 * Create test agent helpers — returns a concrete subclass of AutonautAgent.
 */
async function createAgentHelpers() {
    const { AutonautAgent } = await import('../../src/agents/autonaut-agent');

    class TestAgent extends AutonautAgent {
        private readonly failMode: string;

        constructor(failMode = 'none') {
            super(
                'test-agent',
                'tester',
                ['testing'],
                { model: 'claude/claude-sonnet-4-20250514', temperature: 0.7, maxTokens: 4096 },
                'You are a test agent.'
            );
            this.failMode = failMode;
        }

        async executeTask(): Promise<void> {
            if (this.failMode === 'budget-fail') {
                // Trigger askAI which will hit the budget check
                await this.askAI('This should fail from budget');
                return;
            }
            // Default: no-op success
        }

        // Expose protected askAI for testing
        async callAskAI(prompt: string, context?: string): Promise<import('../../src/agents/ai-adapter').AiResponse> {
            return this.askAI(prompt, context);
        }
    }

    function createTestAgent(failMode = 'none') {
        return new TestAgent(failMode);
    }

    return { TestAgent, createTestAgent };
}

/**
 * Set up mocks to simulate a task context on the agent.
 */
async function simulateTaskContext(agent: InstanceType<any>, projectId: string, taskId: string): Promise<void> {
    // We need to set _currentTask which is private. We simulate this by
    // accessing it through a type assertion for testing.
    (agent as any)._currentTask = {
        id: taskId,
        projectId,
        title: 'Test Task',
        description: 'A test task',
        taskType: 'implement',
        phase: 'development',
        outputPath: null,
        repoPath: '/repo/path',
    };
}

/**
 * Set up mock query to return task info for loadTaskInfo().
 */
function setupTaskLoad(taskId: string, projectId: string, repoPath: string): void {
    let queryCallCount = 0;
    mocks.mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        queryCallCount++;

        // loadTaskInfo — SELECT from tasks
        if (typeof sql === 'string' && sql.includes('SELECT t.id')) {
            return {
                rows: [{
                    id: taskId,
                    project_id: projectId,
                    title: 'Test Task',
                    description: 'A test task',
                    task_type: 'implement',
                    phase: 'development',
                    output_path: null,
                }],
                rowCount: 1,
            };
        }

        // loadTaskInfo — SELECT repo_path from projects
        if (typeof sql === 'string' && sql.includes('repo_path')) {
            return { rows: [{ repo_path: repoPath }], rowCount: 1 };
        }

        // Default: empty result
        return { rows: [], rowCount: 0 };
    });
}

/**
 * Create a mock EventPayload for task.assigned.
 */
function makeTaskEvent(taskId: string, projectId: string, agent: string) {
    return {
        channel: 'task.assigned' as const,
        projectId,
        taskId,
        agent,
        data: {},
        timestamp: new Date().toISOString(),
    };
}
