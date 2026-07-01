/**
 * Agent Framework + Specialist Agent tests
 *
 * Tests module exports, instantiation, and configuration
 * without requiring live AI or Postgres connections.
 */

import { describe, it, expect } from 'vitest';

describe('agents/ai-adapter module', () => {
    it('exports sendPrompt function', async () => {
        const mod = await import('../../src/agents/ai-adapter');
        expect(typeof mod.sendPrompt).toBe('function');
    });
});

describe('agents/autonaut-agent module', () => {
    it('exports AutonautAgent class', async () => {
        const mod = await import('../../src/agents/autonaut-agent');
        expect(typeof mod.AutonautAgent).toBe('function');
    });
});

describe('agents/agent-registry module', () => {
    it('exports AgentRegistry class', async () => {
        const mod = await import('../../src/agents/agent-registry');
        expect(typeof mod.AgentRegistry).toBe('function');
    });

    it('AgentRegistry can be instantiated', async () => {
        const { AgentRegistry } = await import('../../src/agents/agent-registry');
        const registry = new AgentRegistry();
        expect(registry.size).toBe(0);
    });

    it('AgentRegistry.getAllAgents returns empty array when no agents registered', async () => {
        const { AgentRegistry } = await import('../../src/agents/agent-registry');
        const registry = new AgentRegistry();
        expect(registry.getAllAgents()).toEqual([]);
    });
});

describe('agents/agent-config module', () => {
    it('exports loadAgentConfig function', async () => {
        const mod = await import('../../src/agents/agent-config');
        expect(typeof mod.loadAgentConfig).toBe('function');
    });

    it('exports getAgentModelConfig function', async () => {
        const mod = await import('../../src/agents/agent-config');
        expect(typeof mod.getAgentModelConfig).toBe('function');
    });

    it('getDefaultConfig returns valid config', async () => {
        const { getDefaultConfig } = await import('../../src/agents/agent-config');
        const config = getDefaultConfig();
        expect(config.defaults).toBeDefined();
        expect(config.defaults.model).toBeTruthy();
        expect(config.agents).toBeDefined();
    });

    it('getAgentModelConfig merges defaults with overrides', async () => {
        const { getDefaultConfig, getAgentModelConfig } = await import('../../src/agents/agent-config');
        const config = getDefaultConfig();
        const forgeConfig = getAgentModelConfig(config, 'forge');
        expect(forgeConfig.model).toBeTruthy();
        expect(forgeConfig.maxTokens).toBeGreaterThan(0);
    });

    it('getAgentModelConfig falls back to defaults for unknown agent', async () => {
        const { getDefaultConfig, getAgentModelConfig } = await import('../../src/agents/agent-config');
        const config = getDefaultConfig();
        const unknownConfig = getAgentModelConfig(config, 'nonexistent-agent');
        expect(unknownConfig.model).toBe(config.defaults.model);
    });

    it('validateConfigEntry catches invalid temperature', async () => {
        const { validateConfigEntry } = await import('../../src/agents/agent-config');
        const errors = validateConfigEntry({ temperature: 5.0 });
        expect(errors.length).toBeGreaterThan(0);
    });

    it('validateConfigEntry passes valid values', async () => {
        const { validateConfigEntry } = await import('../../src/agents/agent-config');
        const errors = validateConfigEntry({ temperature: 0.7, maxTokens: 4096 });
        expect(errors.length).toBe(0);
    });
});

describe('specialist agents', () => {
    it('Scout can be imported and instantiated', async () => {
        const { Scout } = await import('../../src/agents/specialists/scout');
        const scout = new Scout({ model: 'claude/claude-sonnet-4-20250514' });
        expect(scout.name).toBe('scout');
        expect(scout.role).toBe('strategist');
        expect(scout.skills.length).toBeGreaterThan(0);
    });

    it('Blueprint can be imported and instantiated', async () => {
        const { Blueprint } = await import('../../src/agents/specialists/blueprint');
        const blueprint = new Blueprint({ model: 'claude/claude-sonnet-4-20250514' });
        expect(blueprint.name).toBe('blueprint');
        expect(blueprint.role).toBe('architect');
    });

    it('Forge can be imported and instantiated', async () => {
        const { Forge } = await import('../../src/agents/specialists/forge');
        const forge = new Forge({ model: 'claude/claude-sonnet-4-20250514' });
        expect(forge.name).toBe('forge');
        expect(forge.role).toBe('engineer');
    });

    it('Vigil can be imported and instantiated', async () => {
        const { Vigil } = await import('../../src/agents/specialists/vigil');
        const vigil = new Vigil({ model: 'claude/claude-sonnet-4-20250514' });
        expect(vigil.name).toBe('vigil');
        expect(vigil.role).toBe('quality-guardian');
    });

    it('Aegis can be imported and instantiated', async () => {
        const { Aegis } = await import('../../src/agents/specialists/aegis');
        const aegis = new Aegis({ model: 'claude/claude-sonnet-4-20250514' });
        expect(aegis.name).toBe('aegis');
        expect(aegis.role).toBe('platform-engineer');
    });

    it('all agents start with idle status', async () => {
        const { Scout } = await import('../../src/agents/specialists/scout');
        const scout = new Scout({ model: 'claude/claude-sonnet-4-20250514' });
        expect(scout.status).toBe('idle');
        expect(scout.currentTask).toBeNull();
    });
});
