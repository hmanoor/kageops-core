/**
 * KageOps End-to-End Smoke Test
 *
 * Verifies the core system components can be initialized and work together
 * without requiring a running Electron window. Tests against a real (or mocked)
 * Postgres connection when available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// ── Module Import Tests ──────────────────────────────
// These verify the system can be assembled without runtime errors.

describe('E2E Smoke Test — Module Assembly', () => {

    it('can import and assemble all core modules', async () => {
        // Database client
        const dbClient = await import('../../src/db/client');
        expect(dbClient.getPool).toBeDefined();
        expect(dbClient.query).toBeDefined();
        expect(dbClient.initDatabase).toBeDefined();

        // Event bus
        const { EventBus } = await import('../../src/orchestrator/event-bus');
        const bus = new EventBus('postgres://test:test@localhost:5432/test');
        expect(bus).toBeDefined();

        // Task decomposer
        const { TaskDecomposer } = await import('../../src/orchestrator/task-decomposer');
        expect(TaskDecomposer).toBeDefined();

        // Task router
        const { TaskRouter } = await import('../../src/orchestrator/task-router');
        expect(TaskRouter).toBeDefined();

        // Phase gates
        const { PhaseGateManager } = await import('../../src/orchestrator/phase-gates');
        expect(PhaseGateManager).toBeDefined();

        // Speciality matrix
        const { SpecialityMatrix } = await import('../../src/orchestrator/speciality-matrix');
        const matrix = new SpecialityMatrix();
        expect(matrix).toBeDefined();

        // Sensei
        const { Sensei } = await import('../../src/orchestrator/sensei');
        expect(Sensei).toBeDefined();
    });

    it('can instantiate Sensei with mock AI adapter', async () => {
        const { EventBus } = await import('../../src/orchestrator/event-bus');
        const { Sensei } = await import('../../src/orchestrator/sensei');

        const bus = new EventBus('postgres://test:test@localhost:5432/test');
        const mockSendPrompt = async (_sys: string, _user: string): Promise<string> => {
            return JSON.stringify([
                {
                    title: 'Test Task',
                    description: 'A test task',
                    taskType: 'concept-brief',
                    assignedAgent: 'scout',
                    priority: 8,
                    dependsOn: [],
                },
            ]);
        };

        const sensei = new Sensei({ sendPrompt: mockSendPrompt }, bus);
        expect(sensei).toBeDefined();
    });

    it('can instantiate all 5 specialist agents', async () => {
        const { Scout } = await import('../../src/agents/specialists/scout');
        const { Blueprint } = await import('../../src/agents/specialists/blueprint');
        const { Forge } = await import('../../src/agents/specialists/forge');
        const { Vigil } = await import('../../src/agents/specialists/vigil');
        const { Aegis } = await import('../../src/agents/specialists/aegis');

        const modelConfig = { model: 'claude/claude-sonnet-4-20250514' };

        const agents = [
            new Scout(modelConfig),
            new Blueprint(modelConfig),
            new Forge(modelConfig),
            new Vigil(modelConfig),
            new Aegis(modelConfig),
        ];

        expect(agents).toHaveLength(5);
        expect(agents.every((a) => a.status === 'idle')).toBe(true);
    });

    it('can register all agents in the registry', async () => {
        const { AgentRegistry } = await import('../../src/agents/agent-registry');
        const { Scout } = await import('../../src/agents/specialists/scout');
        const { Blueprint } = await import('../../src/agents/specialists/blueprint');
        const { Forge } = await import('../../src/agents/specialists/forge');
        const { Vigil } = await import('../../src/agents/specialists/vigil');
        const { Aegis } = await import('../../src/agents/specialists/aegis');

        const modelConfig = { model: 'claude/claude-sonnet-4-20250514' };
        const registry = new AgentRegistry();

        registry.registerAgent(new Scout(modelConfig));
        registry.registerAgent(new Blueprint(modelConfig));
        registry.registerAgent(new Forge(modelConfig));
        registry.registerAgent(new Vigil(modelConfig));
        registry.registerAgent(new Aegis(modelConfig));

        expect(registry.size).toBe(5);

        const allAgents = registry.getAllAgents();
        expect(allAgents).toHaveLength(5);
        expect(allAgents.map((a) => a.name).sort()).toEqual([
            'aegis', 'blueprint', 'forge', 'scout', 'vigil',
        ]);
    });

    it('event bus can create subscriptions without connecting', async () => {
        const { EventBus } = await import('../../src/orchestrator/event-bus');
        const bus = new EventBus('postgres://test:test@localhost:5432/test');

        let received = false;
        bus.subscribeAll(() => { received = true; });

        // subscribeAll should not throw
        expect(received).toBe(false);
    });

    it('speciality matrix module exports correct interface', async () => {
        const { SpecialityMatrix } = await import('../../src/orchestrator/speciality-matrix');
        const matrix = new SpecialityMatrix();

        expect(typeof matrix.getMatrix).toBe('function');
        expect(typeof matrix.getAgentScores).toBe('function');
        expect(typeof matrix.getBestAgent).toBe('function');
        expect(typeof matrix.updateScore).toBe('function');
        expect(typeof matrix.recordTaskOutcome).toBe('function');
        expect(typeof matrix.findSkillGaps).toBe('function');
        expect(typeof matrix.getSummary).toBe('function');
    });

    it('agent config loads defaults correctly', async () => {
        const { getDefaultConfig, getAgentModelConfig } = await import('../../src/agents/agent-config');
        const config = getDefaultConfig();

        // All 8 agents + sensei should have config entries
        const agentNames = Object.keys(config.agents);
        expect(agentNames).toContain('scout');
        expect(agentNames).toContain('blueprint');
        expect(agentNames).toContain('forge');
        expect(agentNames).toContain('vigil');
        expect(agentNames).toContain('aegis');
        expect(agentNames).toContain('sensei');

        // Each agent should get a valid model config
        for (const name of agentNames) {
            const mc = getAgentModelConfig(config, name);
            expect(mc.model).toBeTruthy();
            expect(mc.maxTokens).toBeGreaterThan(0);
        }
    });

    it('AI adapter module exports sendPrompt', async () => {
        const { sendPrompt } = await import('../../src/agents/ai-adapter');
        expect(typeof sendPrompt).toBe('function');
    });

    it('task decomposer parses phase definitions correctly', async () => {
        const { TaskDecomposer } = await import('../../src/orchestrator/task-decomposer');
        const { EventBus } = await import('../../src/orchestrator/event-bus');

        const bus = new EventBus('postgres://test:test@localhost:5432/test');
        const decomposer = new TaskDecomposer(
            { sendPrompt: async () => '[]' },
            bus
        );

        const phases = decomposer.getPhases();
        expect(phases).toContain('discovery');
        expect(phases).toContain('development');
        expect(phases).toContain('launch-growth');
        expect(phases).toHaveLength(6);

        // Test phase progression
        expect(decomposer.getNextPhase('discovery')).toBe('poc');
        expect(decomposer.getNextPhase('poc')).toBe('business-viability');
        expect(decomposer.getNextPhase('launch-growth')).toBeNull();
    });
});
