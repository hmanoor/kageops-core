/**
 * KageOps Orchestrator Bootstrap
 *
 * Initializes the full orchestration stack: database, event bus,
 * Sensei, specialist agents, and agent registry. Extracted from
 * main.ts to keep the entry point clean and enable testing.
 */

import { initDatabase, closePool } from '../db/client';
import { EventBus } from '../orchestrator/event-bus';
import { Sensei, SenseiConfig } from '../orchestrator/sensei';
import { AgentRegistry } from '../agents/agent-registry';
import { loadAgentConfig, getAgentModelConfig } from '../agents/agent-config';
import { sendPrompt, sendConversation, ConversationMessage } from '../agents/ai-adapter';
import { Scout } from '../agents/specialists/scout';
import { Blueprint } from '../agents/specialists/blueprint';
import { Forge } from '../agents/specialists/forge';
import { Vigil } from '../agents/specialists/vigil';
import { Aegis } from '../agents/specialists/aegis';
import { Pixel } from '../agents/specialists/pixel';
import { Cipher } from '../agents/specialists/cipher';
import { Herald } from '../agents/specialists/herald';
import { buildProviderRegistryFromEnv } from '../agents/design/registry-from-env';
import { getActiveDesignProvider, type DesignProviderId } from './app-config-store';
import { CommsSender } from '../comms/comms-sender';
import { WorkspaceManager } from '../workspace/workspace-manager';
import { CostTracker } from '../orchestrator/cost-tracker';
import { startStallWatchdog } from '../orchestrator/stall-watchdog';
import { BranchManager } from '../workspace/branch-manager';
import { getFallbackChain } from '../agents/model-fallback';
import { TaskPool } from '../orchestrator/task-pool';
import { ActivityBridge } from './activity-bridge';
import { getCommandCenterWindow } from './command-center-window';
import { createLogger } from '../shared/logger';
import { getOperationalCostTracker } from '../orchestrator/operational-cost-tracker';
import { getCodeGraphBridge } from '../workspace/code-graph-bridge';
import { getGraphifyBridge } from '../workspace/graphify-bridge';
import { getGitHubClient } from '../github/github-client';
import { GitHubIntegration } from '../github/github-integration';
import { SkillImporter } from '../skills/skill-importer';
import { SkillRegistry } from '../skills/skill-registry';
import { SkillStore } from '../skills/skill-store';
import * as fs from 'fs';
import * as path from 'path';

import { loadBootstrapExtensions } from '../orchestrator/bootstrap-extensions.commercial';
import { openPlanGate, type Plan } from '../shared/plan-gate';

const log = createLogger('Bootstrap');

// ── Last-failure diagnostic ──────────────────────────
// When bootstrap fails the orchestrator stays null and the top bar shows
// "DB offline · Orchestrator offline" with no clue why. The UI reads this
// via the system-status IPC so users see the actual error (e.g. PGlite
// wasm not found, port in use, schema migration failure) on hover instead
// of having to dig through %APPDATA%\KageOps\logs.
let lastBootstrapError: string | null = null;

export function getLastBootstrapError(): string | null {
    return lastBootstrapError;
}

// ── Types ────────────────────────────────────────────

export interface OrchestratorHandles {
    readonly sensei: Sensei;
    readonly agentRegistry: AgentRegistry;
    readonly eventBus: EventBus;
    readonly commsSender: CommsSender;
    readonly activityBridge: ActivityBridge;
    readonly operationalCostTracker: ReturnType<typeof getOperationalCostTracker>;
    readonly codeGraphBridge: ReturnType<typeof getCodeGraphBridge>;
    readonly graphifyBridge: ReturnType<typeof getGraphifyBridge>;
    readonly githubIntegration: GitHubIntegration;
    /** Stop the stall watchdog — called during app shutdown. */
    readonly stopStallWatchdog: () => void;
}

// ── Bootstrap ────────────────────────────────────────

/**
 * Initialize the full orchestration stack.
 * Returns null if initialization fails (e.g., database unavailable).
 * The app continues in UI-only mode when this returns null.
 */
export async function bootstrapOrchestrator(
    projectsDir: string,
    databaseUrl?: string
): Promise<OrchestratorHandles | null> {
    try {
        // 1. Database
        log.info('Initializing database...');
        await initDatabase({ maxRetries: 3, retryDelayMs: 1000 });
        log.info('Database ready.');

        // 1b. Phase-3 skills library: import `.claude/skills/*/SKILL.md` once
        // after the schema is up. Swallow failures — skill import is
        // best-effort and must never block bootstrap.
        try {
            const skillsDir = path.join(process.cwd(), '.claude', 'skills');
            if (fs.existsSync(skillsDir)) {
                const importer = new SkillImporter();
                const result = await importer.importFromClaudeDir(skillsDir);
                log.info(
                    { imported: result.imported, updated: result.updated, skipped: result.skipped },
                    'Skill library import complete'
                );
            } else {
                log.debug({ skillsDir }, 'No .claude/skills dir found — skipping skill import');
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg }, 'Skill import failed — continuing without it');
        }

        // 1c. Help docs RAG (v0.12 — Phase 2 of Help system).
        // Indexes docs/help/*.md into help_documents + help_chunks for
        // Sensei to query. Hash-gated so unchanged docs are no-ops.
        try {
            const { indexHelpDocs } = await import('../learning/help-indexer');
            await indexHelpDocs();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg }, 'Help docs indexing failed — continuing without it');
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : '';
        log.error({ err: msg }, 'Database initialization failed');
        log.warn('Running in UI-only mode (no orchestration).');
        lastBootstrapError = `Database init failed: ${msg}`;
        writeBootstrapErrorFile('Database init failed', msg, stack);
        return null;
    }

    try {
        // 2. Event Bus (don't connect yet — Sensei.start() will connect)
        // Pass through databaseUrl / DATABASE_URL as-is; EventBus picks
        // embedded mode when neither is set (v0.11+ zero-Docker default).
        const dbUrl = databaseUrl ?? process.env['DATABASE_URL'];
        const eventBus = new EventBus(dbUrl);
        log.info('EventBus created.');

        // OSS-split seam: load commercial bootstrap extensions once. In the open
        // build this resolves to {} and every capability below falls back to an
        // open default. Also installs the encrypted deployment_config reader
        // (open core leaves it null → app-env-file only).
        const commercial = await loadBootstrapExtensions();
        commercial.installDeploymentConfigReader?.();

        // Phase 2b (open, both builds): wire the OS-keychain "key register" as
        // the app-env fallback reader so secrets the operator ticked "Save to
        // key register" for are picked up on later runs. Best-effort — a missing
        // keychain must never block bootstrap.
        try {
            const { installAppEnvKeychainReader } = await import('./app-env-keychain');
            await installAppEnvKeychainReader();
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'app-env key register unavailable — deploy secrets from file/encrypted store only'
            );
        }

        // 3. Agent config — initial load for specialist construction
        const agentConfig = loadAgentConfig();

        // 4. Build Sensei's sendPrompt/sendConversation wrappers.
        // Resolve the model config on every call so preset switches in the UI
        // take effect without an Electron restart. The closure must NOT cache
        // the model string — it would pin Sensei to whatever preset was active
        // when bootstrap ran.
        const resolveSenseiConfig = () => getAgentModelConfig(loadAgentConfig(), 'sensei');

        const senseiSendPrompt = async (systemPrompt: string, userPrompt: string): Promise<string> => {
            const cfg = resolveSenseiConfig();
            const response = await sendPrompt(
                cfg.model,
                systemPrompt,
                userPrompt,
                { maxTokens: cfg.maxTokens, temperature: cfg.temperature }
            );
            return response.text;
        };

        const senseiSendConversation = async (
            systemPrompt: string,
            messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[]
        ): Promise<string> => {
            const convMessages: ConversationMessage[] = messages.map((m) => ({
                role: m.role,
                content: m.content,
            }));
            const cfg = resolveSenseiConfig();
            const response = await sendConversation(
                cfg.model,
                systemPrompt,
                convMessages,
                { maxTokens: cfg.maxTokens, temperature: cfg.temperature }
            );
            return response.text;
        };

        // 5. Create shared infrastructure (v0.6)
        const costTracker = new CostTracker(eventBus);
        const branchManager = new BranchManager();
        // Hard-cap at 3 to match Ollama cloud account concurrency limit.
        // Override with KAGEOPS_MAX_CONCURRENCY env var if the limit changes.
        const ollamaConcurrencyLimit = parseInt(process.env['KAGEOPS_MAX_CONCURRENCY'] ?? '3', 10);
        const taskPool = new TaskPool(ollamaConcurrencyLimit);
        log.info({ maxConcurrency: ollamaConcurrencyLimit }, 'CostTracker, BranchManager, and TaskPool created.');

        // 6. Create AgentRegistry early so Sensei's router can filter by availability
        const agentRegistry = new AgentRegistry();

        // 7. Create WorkspaceManager, CommsSender, and Sensei
        const workspaceManager = new WorkspaceManager();
        const commsSender = new CommsSender();
        // F-314: kick off plan resolution in the background so the cache is
        // warm by the time the user creates their first project. Doesn't block
        // bootstrap — Sensei.startProject's gate uses the synchronous accessor,
        // which falls back to 'free' until the resolve completes. Commercial
        // capabilities (plan resolver, tier gate, setup-copilot gate) come from
        // the bootstrap-extensions seam; open defaults otherwise.
        const getCurrentPlan: () => Plan = commercial.getCurrentPlan ?? (() => 'free');
        const planGate = commercial.planGate ?? openPlanGate;
        void (commercial.warmPlanCache?.() ?? Promise.resolve()).catch((err: unknown) => {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'Background plan resolution failed at bootstrap (continuing with free default)',
            );
        });

        // F-314+: snapshot of the live agent-routing config + active preset.
        // Sensei reads this on every chat turn so it can answer "what model
        // are you using?" truthfully. Loaded fresh per call so preset
        // switches reflect immediately without an Electron restart.
        const { getActivePresetName } = await import('../agents/agent-config');
        const { parseModelString } = await import('../agents/ai-adapter/model-parser');
        const KNOWN_AGENTS = ['sensei', 'scout', 'blueprint', 'pixel', 'forge', 'cipher', 'aegis', 'vigil', 'herald'] as const;
        const getAgentRouting = () => {
            const cfg = loadAgentConfig();
            return {
                preset: getActivePresetName(),
                agents: KNOWN_AGENTS.map((name) => {
                    const entry = cfg.agents[name as keyof typeof cfg.agents];
                    const model = entry?.model ?? '';
                    // Derive provider from the model string (same logic as
                    // dispatcher.ts) so the system prompt + /models CLI agree
                    // on what's actually in flight.
                    const provider = model === '' ? 'unknown' : parseModelString(model).provider;
                    return { name, model, provider };
                }),
            };
        };

        const senseiConfig: SenseiConfig = {
            sendPrompt: senseiSendPrompt,
            sendConversation: senseiSendConversation,
            projectsDir,
            commsSender,
            workspaceManager,
            costTracker,
            branchManager,
            taskPool,
            agentRegistry,
            resolvePlan: getCurrentPlan,
            planGate,
            setupCopilotGate: commercial.createSetupCopilotGate?.(eventBus),
            getAgentRouting,
        };
        const sensei = new Sensei(senseiConfig, eventBus);

        // 8. Create specialist agents
        const pixelModelConfig = getAgentModelConfig(agentConfig, 'pixel');
        const designRegistry = buildProviderRegistryFromEnv({
            inHouseModel: pixelModelConfig.model,
        });
        const activeDesignProvider: DesignProviderId = getActiveDesignProvider();
        log.info({ provider: activeDesignProvider }, 'Pixel design provider selected');

        const agents = [
            new Scout(getAgentModelConfig(agentConfig, 'scout')),
            new Blueprint(getAgentModelConfig(agentConfig, 'blueprint')),
            new Forge(getAgentModelConfig(agentConfig, 'forge')),
            new Vigil(getAgentModelConfig(agentConfig, 'vigil')),
            new Aegis(getAgentModelConfig(agentConfig, 'aegis'), commercial.postDeployHook),
            new Pixel(pixelModelConfig, {
                registry: designRegistry,
                providerId: activeDesignProvider,
            }),
            new Cipher(getAgentModelConfig(agentConfig, 'cipher')),
            new Herald(getAgentModelConfig(agentConfig, 'herald')),
        ];

        // 9. Inject v0.6 + v0.8 + v0.9 + v1.2 + P1-01 infrastructure into agents and register them
        const codeGraphBridge = getCodeGraphBridge();
        const graphifyBridge = getGraphifyBridge();
        const githubClient = getGitHubClient();
        const { taskCheckpointRepository } = await import('../db/task-checkpoint-repo');
        for (const agent of agents) {
            agent.setCostTracker(costTracker);
            agent.setBranchManager(branchManager);
            agent.setFallbackChain(getFallbackChain(agent.name, agent.modelConfig.model));
            agent.setCodeGraphBridge(codeGraphBridge);
            agent.setGraphifyBridge(graphifyBridge);
            agent.setGitHubClient(githubClient);
            // P1-01: always wire the checkpoint repo (per-call gate, on by
            // default — kill-switch KAGEOPS_TASK_CHECKPOINTS=false — decides
            // whether it's consulted).
            agent.setTaskCheckpointRepo(taskCheckpointRepository);
            agentRegistry.registerAgent(agent);
        }
        log.info('Injected CostTracker, BranchManager, FallbackChains, CodeGraphBridge, GraphifyBridge, GitHubClient into all agents.');

        // 9b. Phase-3 Loop A: wire skill hooks when enabled.
        // Opt-in — default off so existing behaviour is unchanged.
        if (process.env['KAGEOPS_SKILLS_HOOKS'] === 'true') {
            const skillRegistry = new SkillRegistry();
            const skillStore = new SkillStore();
            for (const agent of agents) {
                agent.setSkillInfra(skillRegistry, skillStore);
            }
            log.info(`Skill hooks enabled — ${agents.length} agents wired.`);
        }

        // 10. Connect agents to EventBus (registers subscriptions in memory)
        for (const agent of agents) {
            await agent.connect(eventBus);
        }

        // 11. Start Sensei (connects EventBus, which LISTENs on all pre-registered channels)
        await sensei.start();

        // 12. Start ActivityBridge (streams events to Command Center)
        const activityBridge = new ActivityBridge();
        activityBridge.start({ eventBus, getWindow: getCommandCenterWindow });

        // 13. Start OperationalCostTracker (syncs LiteLLM_SpendLogs → operational_costs)
        const operationalCostTracker = getOperationalCostTracker();
        operationalCostTracker.start();
        log.info('OperationalCostTracker started (60s sync interval).');

        // 14. Initialize CodeGraphBridge and subscribe to project.created events (v0.8)
        await codeGraphBridge.initialize();
        await eventBus.subscribe('project.created', async (event) => {
            const repoPath = typeof event.data?.['repoPath'] === 'string' ? event.data['repoPath'] : null;
            if (repoPath !== null) {
                log.info({ repoPath }, 'Building initial code graph for new project');
                await codeGraphBridge.ensureBuilt(repoPath);
            }
        });
        log.info('CodeGraphBridge initialized and subscribed to project.created events.');

        // 14b. Subscribe Graphify to project.created for knowledge graph building (v1.2)
        await eventBus.subscribe('project.created', async (event) => {
            const repoPath = typeof event.data?.['repoPath'] === 'string' ? event.data['repoPath'] : null;
            if (repoPath !== null) {
                log.info({ repoPath }, 'Building initial Graphify knowledge graph for new project');
                const result = await graphifyBridge.buildGraph(repoPath, { noViz: true });
                if (result.success) {
                    log.info({ repoPath, nodeCount: result.nodeCount, edgeCount: result.edgeCount }, 'Graphify graph built');
                } else {
                    log.warn({ repoPath, error: result.error }, 'Graphify graph build failed — agents will use raw files');
                }
            }
        });
        log.info('GraphifyBridge subscribed to project.created events.');

        // 15. Start GitHub Integration (subscribes to review.passed, auto-creates PRs)
        const githubIntegration = new GitHubIntegration(githubClient, eventBus);
        await githubIntegration.start();
        log.info('GitHubIntegration started — PRs auto-created on review.passed when configured.');

        // 16. Start stall watchdog (Electron parity with headless zombie-guard).
        // Durable-recovery (#1 priority): on a stall it AUTO-RECLAIMS first
        // (requeue in-flight tasks + re-dispatch via restartStalledProject),
        // bounded by KAGEOPS_MAX_AUTO_RECLAIMS, and only parks the project in
        // 'awaiting-approval' for a human once auto-recovery is exhausted.
        // Timing overridable via KAGEOPS_STALL_TIMEOUT_MS / KAGEOPS_STALL_POLL_MS;
        // disable auto-reclaim with KAGEOPS_AUTO_RECLAIM=0.
        const stopStallWatchdog = startStallWatchdog(eventBus, {
            reclaim: (projectId: string) => sensei.restartStalledProject(projectId),
        });

        lastBootstrapError = null;
        return { sensei, agentRegistry, eventBus, commsSender, activityBridge, operationalCostTracker, codeGraphBridge, graphifyBridge, githubIntegration, stopStallWatchdog };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : '';
        log.error({ err: msg }, 'Orchestrator bootstrap failed');
        log.warn('Running in UI-only mode (no orchestration).');
        lastBootstrapError = `Orchestrator init failed: ${msg}`;
        writeBootstrapErrorFile('Orchestrator init failed', msg, stack);

        // Attempt cleanup
        try { await closePool(); } catch { /* ignore cleanup errors */ }

        return null;
    }
}

/**
 * Persist the bootstrap error to a known file path so users can read it
 * without enabling debug logging or attaching a console. Pino logs go to
 * stdout which is swallowed in packaged Electron — this is the one
 * reliable way to surface the failure cause after-the-fact.
 *
 * Writes to `<userData>/startup-error.txt`. Best-effort: any failure to
 * write the file is silently dropped (we already failed bootstrap; we
 * don't want to crash the renderer over a diagnostic write).
 */
function writeBootstrapErrorFile(phase: string, msg: string, stack: string): void {
    try {
        // Lazy-require electron so this module stays unit-testable outside
        // Electron (tests stub orchestrator-bootstrap from plain Node).
        const electron = require('electron') as typeof import('electron');
        const userData = electron.app.getPath('userData');
        const target = path.join(userData, 'startup-error.txt');

        // F-349: pull the embedded-pg boot diagnostics so the file shows
        // what we observed (existing lock, cleanup outcome, PG_VERSION,
        // captured Emscripten output) rather than just the wrapped error.
        let diagSection = '';
        try {
            const { getLastEmbeddedDiagnostics } = require('../db/embedded-pg') as typeof import('../db/embedded-pg');
            const d = getLastEmbeddedDiagnostics();
            if (d !== null) {
                diagSection = [
                    'Embedded-PG diagnostics:',
                    `  pidFileExistedAtStart:  ${d.pidFileExistedAtStart}`,
                    `  pidFileFirstLine:       ${d.pidFileFirstLine ?? '(n/a)'}`,
                    `  cleanedStaleLock:       ${d.cleanedStaleLock}`,
                    `  cleanedStaleLockReason: ${d.cleanedStaleLockReason ?? '(n/a)'}`,
                    `  pgVersion (on-disk):    ${d.pgVersion ?? '(no PG_VERSION file — fresh dir)'}`,
                    '',
                    'Captured Emscripten stderr (last 30 lines):',
                    ...d.capturedStderr.slice(-30).map((l) => `  | ${l}`),
                    '',
                    'Captured Emscripten stdout (last 20 lines):',
                    ...d.capturedStdout.slice(-20).map((l) => `  | ${l}`),
                    '',
                ].join('\n');
            }
        } catch { /* embedded-pg not loaded — leave section empty */ }

        const body = [
            `KageOps bootstrap failure — ${new Date().toISOString()}`,
            `Phase: ${phase}`,
            `Message: ${msg}`,
            '',
            'Stack:',
            stack || '(no stack)',
            '',
            diagSection,
            'Process versions:',
            `  node     ${process.versions.node}`,
            `  electron ${process.versions.electron ?? '(none)'}`,
            `  v8       ${process.versions.v8}`,
            '',
            `Resources path: ${process.resourcesPath ?? '(unknown)'}`,
            `cwd:            ${process.cwd()}`,
            `KAGEOPS_DATA_DIR: ${process.env['KAGEOPS_DATA_DIR'] ?? '(unset — defaults to ~/.kageops)'}`,
            '',
        ].join('\n');
        fs.writeFileSync(target, body, 'utf8');
        log.info({ target }, 'Wrote bootstrap error diagnostic file');
    } catch (writeErr) {
        const wm = writeErr instanceof Error ? writeErr.message : String(writeErr);
        log.warn({ err: wm }, 'Failed to write startup-error.txt');
    }
}

/**
 * Gracefully shut down the orchestration stack.
 */
export async function shutdownOrchestrator(handles: OrchestratorHandles): Promise<void> {
    try {
        log.info('Shutting down orchestrator...');
        handles.stopStallWatchdog();
        handles.operationalCostTracker.stop();
        handles.githubIntegration.stop();
        await handles.codeGraphBridge.shutdownAll();
        handles.activityBridge.stop();
        await handles.sensei.stop();
        await handles.agentRegistry.shutdownAll();
        await closePool();
        log.info('Orchestrator shut down.');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'Error during orchestrator shutdown');
    }
}
