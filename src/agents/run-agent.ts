/**
 * KageOps Agent Container Entry Point
 *
 * Entry point for containerized agents. Reads AGENT_ROLE from env,
 * instantiates the correct specialist, and starts listening for tasks.
 */

import { initDatabase } from '../db/client';
import { EventBus } from '../orchestrator/event-bus';
import { loadAgentConfig, getAgentModelConfig } from './agent-config';
import { createLogger } from '../shared/logger';

const log = createLogger('RunAgent');

// ── Main ─────────────────────────────────────────────

async function main(): Promise<void> {
    const agentRole = process.env.AGENT_ROLE;

    if (agentRole === undefined || agentRole === '') {
        log.error('AGENT_ROLE environment variable is required.');
        process.exit(1);
    }

    log.info({ agentRole }, 'Starting agent');

    // Initialize database connection
    try {
        await initDatabase();
    } catch (err) {
        log.error({ err }, 'Failed to initialize database');
        process.exit(1);
    }

    // Load agent config
    const config = loadAgentConfig();
    const modelConfig = getAgentModelConfig(config, agentRole);

    // Create event bus
    const eventBus = new EventBus();

    // Dynamically import and instantiate the specialist agent
    const agent = await createAgent(agentRole, modelConfig);

    if (agent === null) {
        log.error({ agentRole }, 'Unknown agent role');
        process.exit(1);
    }

    // Connect to event bus and start listening
    await agent.connect(eventBus);

    log.info({ agentRole }, 'Agent is ready and listening for tasks.');

    // Graceful shutdown
    const shutdown = async (): Promise<void> => {
        log.info({ agentRole }, 'Shutting down agent');
        await eventBus.disconnect();
        process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());
}

async function createAgent(
    role: string,
    modelConfig: { model: string; temperature?: number; maxTokens?: number }
): Promise<import('./autonaut-agent').AutonautAgent | null> {
    // Dynamic imports to avoid loading all specialists upfront
    try {
        switch (role) {
            case 'scout': {
                const { Scout } = await import('./specialists/scout');
                return new Scout(modelConfig);
            }
            case 'blueprint': {
                const { Blueprint } = await import('./specialists/blueprint');
                return new Blueprint(modelConfig);
            }
            case 'forge': {
                const { Forge } = await import('./specialists/forge');
                return new Forge(modelConfig);
            }
            case 'vigil': {
                const { Vigil } = await import('./specialists/vigil');
                return new Vigil(modelConfig);
            }
            case 'aegis': {
                const { Aegis } = await import('./specialists/aegis');
                // Commercial post-deploy hook via the bootstrap-extensions seam
                // (stubbed to no-op in the open build → Aegis uses its default).
                const { loadBootstrapExtensions } = await import('../orchestrator/bootstrap-extensions.commercial');
                const commercial = await loadBootstrapExtensions();
                return new Aegis(modelConfig, commercial.postDeployHook);
            }
            default:
                return null;
        }
    } catch (err) {
        log.error({ role, err }, 'Failed to load specialist for role');
        return null;
    }
}

// Start
void main();
