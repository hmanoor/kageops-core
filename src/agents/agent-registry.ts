/**
 * KageOps Agent Registry
 *
 * Maintains a registry of all available agents, tracks their status,
 * and selects the best agent for a task using the speciality matrix.
 */

import { AutonautAgent, AgentStatus } from './autonaut-agent';
import { SpecialityMatrix, AgentScore } from '../orchestrator/speciality-matrix';
import { createLogger } from '../shared/logger';

const log = createLogger('AgentRegistry');

// ── Types ────────────────────────────────────────────

export interface AgentInfo {
    readonly name: string;
    readonly role: string;
    readonly skills: readonly string[];
    readonly status: AgentStatus;
    readonly currentTaskTitle: string | null;
    readonly activeTasks: number;
    readonly model: string;
}

// ── Agent Registry ───────────────────────────────────

export class AgentRegistry {
    private readonly agents = new Map<string, AutonautAgent>();
    private readonly matrix: SpecialityMatrix;

    constructor(matrix?: SpecialityMatrix) {
        this.matrix = matrix ?? new SpecialityMatrix();
    }

    /**
     * Register an agent in the registry.
     */
    registerAgent(agent: AutonautAgent): void {
        if (this.agents.has(agent.name)) {
            log.warn({ agentName: agent.name }, 'Agent already registered. Replacing.');
        }
        this.agents.set(agent.name, agent);
        log.info({ agentName: agent.name, role: agent.role }, 'Registered agent');
    }

    /**
     * Get an agent by name.
     */
    getAgent(name: string): AutonautAgent | undefined {
        return this.agents.get(name);
    }

    /**
     * Get all registered agents with their current status.
     */
    getAllAgents(): readonly AgentInfo[] {
        const infos: AgentInfo[] = [];
        for (const agent of this.agents.values()) {
            infos.push({
                name: agent.name,
                role: agent.role,
                skills: agent.skills,
                status: agent.status,
                currentTaskTitle: agent.currentTask?.title ?? null,
                activeTasks: agent.activeTasks,
                model: agent.modelConfig.model,
            });
        }
        return infos;
    }

    /**
     * Get all agents that are currently available to accept a new task.
     */
    getAvailableAgents(): readonly AgentInfo[] {
        const infos: AgentInfo[] = [];
        for (const agent of this.agents.values()) {
            if (agent.isAvailable()) {
                infos.push({
                    name: agent.name,
                    role: agent.role,
                    skills: agent.skills,
                    status: agent.status,
                    currentTaskTitle: agent.currentTask?.title ?? null,
                    activeTasks: agent.activeTasks,
                    model: agent.modelConfig.model,
                });
            }
        }
        return infos;
    }

    /**
     * Update the in-memory model configuration for a named agent.
     * Does nothing if the agent is not registered.
     */
    reconfigureAgent(agentName: string, model: string, provider: string): void {
        const agent = this.agents.get(agentName);
        if (agent === undefined) {
            log.warn({ agentName }, 'reconfigureAgent: agent not found');
            return;
        }
        // Agents store modelConfig as readonly; we cast to update the property
        // without mutating the object reference itself.
        (agent as { modelConfig: { model: string; provider?: string } }).modelConfig = {
            ...agent.modelConfig,
            model: `${provider}/${model}`.replace(/^claude\/claude-/, 'claude/'),
        };
        log.info({ agentName, model, provider }, 'Reconfigured agent model in-memory');
    }

    /**
     * Re-resolve every registered agent's model config from the current active
     * preset. Call this after the user switches presets in the UI so live agents
     * pick up the new model without an Electron restart.
     */
    reloadAgentConfigsFromPreset(): void {
        // Lazy import to avoid pulling agent-config into a circular dep during
        // test-time registry construction.
        const { loadAgentConfig, getAgentModelConfig } = require('./agent-config') as typeof import('./agent-config');
        const cfg = loadAgentConfig();
        for (const agent of this.agents.values()) {
            const fresh = getAgentModelConfig(cfg, agent.name);
            agent.modelConfig = fresh;
            log.info({ agentName: agent.name, model: fresh.model }, 'Agent model refreshed from active preset');
        }
    }

    /**
     * Get the best agent for a task, using the speciality matrix.
     */
    async getAgentForTask(taskType: string): Promise<AutonautAgent | undefined> {
        const best = await this.matrix.getBestAgent(taskType);
        if (best === null) {
            return undefined;
        }

        return this.agents.get(best.agent);
    }

    /**
     * Get all agents with a specific status.
     */
    getAgentsByStatus(status: AgentStatus): readonly AgentInfo[] {
        return this.getAllAgents().filter((a: AgentInfo) => a.status === status);
    }

    /**
     * Check if any agent is currently busy.
     */
    hasActiveAgents(): boolean {
        for (const agent of this.agents.values()) {
            if (agent.status === 'busy') {
                return true;
            }
        }
        return false;
    }

    /**
     * Shutdown all agents gracefully and clear the registry.
     */
    async shutdownAll(): Promise<void> {
        const names = [...this.agents.keys()];
        log.info({ count: names.length, agents: names }, 'Shutting down agents');

        // Future: call agent.disconnect() when agents support it
        this.agents.clear();

        log.info('All agents shut down.');
    }

    /**
     * Get agent count.
     */
    get size(): number {
        return this.agents.size;
    }
}
