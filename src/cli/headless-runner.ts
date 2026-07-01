/**
 * KageOps Headless Runner
 *
 * Boots the full orchestration stack without Electron, creates a project,
 * and drives it through all phases until completion or timeout.
 *
 * Usage:
 *   npx tsx src/cli/headless-runner.ts --name "NinjaChat" --description "A chat app" [--trust high]
 *
 * Requires: Docker Postgres running, at least one AI provider configured.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectSimpleApp } from '../shared/simple-app-detector';
import { lintBrief } from '../orchestrator/brief-linter';
import { probeKeychainReachable } from '../main/secret-store';
import { appEnvFilePath } from '../orchestrator/app-env-file';

// ── Load .env before anything else ──────────────────
// The project-local .env (process.cwd()) is checked FIRST, then
// ~/.kageops/.env as a fallback. Earlier paths win (we skip the second
// file's values for any key the first file already set), so the project's
// own .env — the operator's most recent, deliberate config — always takes
// precedence over a stale global one. The search path is cross-platform
// (uses os.homedir()); Windows and macOS/Linux resolve the same way.
const ENV_SEARCH_PATHS = [
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.kageops', '.env'),
];

for (const envPath of ENV_SEARCH_PATHS) {
    try {
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf-8');
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx <= 0) continue;
                const key = trimmed.slice(0, eqIdx).trim();
                const val = trimmed.slice(eqIdx + 1).trim();
                // Don't overwrite existing env vars (CLI exports + earlier
                // .env files take precedence; this is the path-priority
                // mechanism — project .env wins over playground .env).
                if (process.env[key] === undefined) {
                    process.env[key] = val;
                }
            }
        }
    } catch {
        // Best effort — .env loading is optional
    }
}

import { initDatabase, closePool, getMany, getOne, query } from '../db/client';
import { EventBus } from '../orchestrator/event-bus';
import { Sensei, SenseiConfig, type StartProjectOptions } from '../orchestrator/sensei';
import { startStallWatchdog } from '../orchestrator/stall-watchdog';
import { getPreset, type QuickPreset } from '../shared/phase-task-catalogue';
import { AgentRegistry } from '../agents/agent-registry';
import { loadAgentConfig, getAgentModelConfig } from '../agents/agent-config';
import { sendPrompt, sendConversation, ConversationMessage } from '../agents/ai-adapter';
import { Scout } from '../agents/specialists/scout';
import { Blueprint } from '../agents/specialists/blueprint';
import { Forge } from '../agents/specialists/forge';
import { Vigil } from '../agents/specialists/vigil';
import { Aegis } from '../agents/specialists/aegis';
import { Pixel } from '../agents/specialists/pixel';
import { buildProviderRegistryFromEnv } from '../agents/design/registry-from-env';
import { getActiveDesignProvider, type DesignProviderId, DEFAULT_MAX_RUN_USD_BY_PRESET, PRESET_NAMES, type PresetName } from '../main/app-config-store';

/**
 * F-364: resolve the recommended budget cap for the active preset. Falls
 * back to the legacy $0.25 default if KAGEOPS_PRESET is unset or unknown.
 * Pure read — no side effects.
 */
function resolveDefaultMaxRunUsd(): string {
    const preset = process.env['KAGEOPS_PRESET'];
    if (preset !== undefined && (PRESET_NAMES as readonly string[]).includes(preset)) {
        return DEFAULT_MAX_RUN_USD_BY_PRESET[preset as PresetName].toFixed(2);
    }
    return '0.25';
}

/**
 * F-352: per-preset wall-clock cap for the headless runner. OS-preset gets
 * 90 min because open-weights models are slower per-token + verbose; paid
 * presets keep tighter caps so a runaway doesn't burn real money for an
 * hour before the timeout fires. Falls back to 10 min if KAGEOPS_PRESET
 * isn't set (legacy behaviour).
 */
const HEADLESS_TIMEOUT_MS_BY_PRESET: Readonly<Record<string, number>> = {
    'claude-cli':          1800_000, // 30 min — subscription, no per-call spend, still cap runaway
    'claude-cli-premium':  2700_000, // 45 min — Opus/Sonnet, longer for ambitious specs
    'codex-cli':           1800_000, // 30 min — same rationale as claude-cli
    'ollama':              5400_000, // 90 min — OS-weights slower per token, F-352
    'openrouter_budget':   1800_000, // 30 min — Gemini Flash + DeepSeek are fast
    'openrouter_standard': 2700_000, // 45 min — Sonnet on Forge is the bottleneck
};

function resolveDefaultHeadlessTimeoutMs(): string {
    const preset = process.env['KAGEOPS_PRESET'];
    if (preset !== undefined && HEADLESS_TIMEOUT_MS_BY_PRESET[preset] !== undefined) {
        return String(HEADLESS_TIMEOUT_MS_BY_PRESET[preset]);
    }
    return '600000';
}
import { Cipher } from '../agents/specialists/cipher';
import { Herald } from '../agents/specialists/herald';
import { WorkspaceManager } from '../workspace/workspace-manager';
import { CommsSender } from '../comms/comms-sender';
import { CostTracker } from '../orchestrator/cost-tracker';
import { BranchManager } from '../workspace/branch-manager';
import { getFallbackChain } from '../agents/model-fallback';
import { TaskPool } from '../orchestrator/task-pool';
import { getCodeGraphBridge } from '../workspace/code-graph-bridge';
import { getGraphifyBridge } from '../workspace/graphify-bridge';
import { getGitHubClient } from '../github/github-client';
import { createLogger } from '../shared/logger';

// ── Types ────────────────────────────────────────────

interface RunnerArgs {
    readonly name: string;
    readonly description: string;
    readonly trustLevel: 'low' | 'medium' | 'high';
    readonly timeoutMs: number;
    readonly projectsDir: string;
    readonly autoApprove: boolean;
    readonly dryRun: boolean;
    /** Project UUID to resume — when set, --name/--description are pulled from the DB. */
    readonly resume: string | null;
    /**
     * Quick-preset id from QUICK_PRESETS (e.g. "poc", "landing-page",
     * "iteration", "full-product"). When set, enabledPhases + phase_task_
     * selections are derived from the preset and passed to sensei. null =
     * legacy "LLM picks freely across every phase".
     */
    readonly phasePreset: string | null;
    /**
     * P1-09 smoke harness — when set with --resume, drives the same
     * `/add-requirement <text>` flow the operator uses in the Command
     * Center chat. Calls Sensei.addRequirement on the resumed project,
     * stamps revision metadata when iteration ≥ 1, then waits for the
     * follow-up tasks to complete via the existing dispatch loop.
     * Use with --close-first to first force the project terminal +
     * reopen it, so the revision-stamping gate (iteration ≥ 1) fires.
     */
    readonly addRequirement: string | null;
    /**
     * P1-09 smoke harness — when set with --resume + --add-requirement,
     * calls Sensei.closeProject + reopenProject before adding the
     * requirement. This forces a project that's mid-build to terminal
     * state + bumps the iteration counter so the new task gets stamped
     * as task_type='revision'. Skip when the project is already in
     * `awaiting-input` (already reopened — closeProject would no-op).
     */
    readonly closeFirst: boolean;
}

interface RunnerResult {
    readonly success: boolean;
    readonly projectId: string | null;
    readonly repoPath: string | null;
    readonly phase: string;
    readonly tasksCompleted: number;
    readonly tasksFailed: number;
    readonly durationMs: number;
    readonly error: string | null;
    readonly killedByBudget: boolean;
    readonly totalCostUsd: number;
}

// ── Helpers ──────────────────────────────────────────

const log = createLogger('HeadlessRunner');

/** RFC 4122 UUID format check. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build `StartProjectOptions` from the runner args, applying a phase-
 * preset if --phase-preset (or KAGEOPS_PHASE_PRESET) was set. When no
 * preset is set, returns just `trustLevel` — sensei falls back to the
 * legacy "LLM picks freely across every phase" behaviour.
 */
function buildStartOptions(args: RunnerArgs): StartProjectOptions {
    const opts: StartProjectOptions = { trustLevel: args.trustLevel };
    if (args.phasePreset === null) return opts;

    const preset: QuickPreset | undefined = getPreset(args.phasePreset);
    if (preset === undefined) {
        throw new Error(
            `Unknown --phase-preset "${args.phasePreset}". ` +
            `Valid ids: poc, landing-page, full-product, iteration.`
        );
    }
    return {
        ...opts,
        enabledPhases: preset.phases,
        ...(preset.selections !== undefined
            ? { phaseTaskSelections: preset.selections }
            : {}),
    };
}

export function parseArgs(argv: readonly string[]): RunnerArgs {
    const args: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = i + 1 < argv.length ? argv[i + 1] : undefined;
        if (next !== undefined && !next.startsWith('--')) {
            args[key] = next;
            i++;
        } else {
            // Bare flag (e.g. --dry-run) — set to 'true' regardless of position
            args[key] = 'true';
        }
    }

    // ── --resume <project-id> ───────────────────────────────────────
    // When set, --name/--description become optional — they're loaded
    // from the projects row identified by the UUID. Any name/desc the
    // user passes alongside --resume is rejected: it's almost always
    // a copy-paste mistake from a previous "fresh run" command and we
    // don't want to silently ignore it.
    const resumeRaw = args['resume'];
    const resume: string | null = resumeRaw !== undefined && resumeRaw !== 'true' && resumeRaw !== ''
        ? resumeRaw
        : null;
    if (resume !== null) {
        if (!UUID_RE.test(resume)) {
            throw new Error(`--resume requires a project UUID (got: "${resume}")`);
        }
        if (args['name'] !== undefined) {
            throw new Error(
                '--resume and --name are mutually exclusive. ' +
                'Resume loads name/description from the existing project row.'
            );
        }
        if (args['description'] !== undefined || args['description-file'] !== undefined) {
            throw new Error(
                '--resume and --description/--description-file are mutually exclusive. ' +
                'Resume loads name/description from the existing project row.'
            );
        }
    }

    const name = resume !== null
        ? `resume:${resume.slice(0, 8)}`
        : args['name'];
    if ((name === undefined || name === '') && resume === null) {
        throw new Error('--name is required (unless --resume <project-id> is set)');
    }

    // Wave 4 Day 1: support --description-file as a workaround for npx
    // mangling multi-line argv strings. Long specs with newlines were
    // getting truncated to just the first line — silently breaking
    // every downstream component (TaskDecomposer, parseSpec, etc.).
    let description = args['description'] ?? `A project called ${name ?? 'unnamed'}`;
    if (args['description-file'] !== undefined) {
        try {
            const filePath = args['description-file'];
            // Lazy require to avoid pulling fs into hot paths.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fsmod = require('fs') as typeof import('fs');
            description = fsmod.readFileSync(filePath, 'utf-8');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`--description-file read failed: ${msg}`);
        }
    }
    const trustLevel = (args['trust'] ?? 'high') as 'low' | 'medium' | 'high';
    // Wave 4 Day 1: support env-var override since `npx tsx --timeout` is
    // swallowed by npx as its own (nonexistent) flag. Precedence:
    // CLI flag → KAGEOPS_HEADLESS_TIMEOUT_MS env → per-preset default.
    // F-352: per-preset wall-clock cap. OS preset gets 90 min because
    // gpt-oss/qwen3-coder are slower per-token AND tend to produce verbose
    // outputs that the verifier then retries — the previous 45-min default
    // hit 50% of OS-preset runs on real briefs (wireup-os, solarsizer-os
    // both timed out on 2026-05-14). Subscription/paid presets keep
    // shorter caps because they're faster + spend money during the wait.
    const timeoutMs = parseInt(
        args['timeout'] ?? process.env['KAGEOPS_HEADLESS_TIMEOUT_MS'] ?? resolveDefaultHeadlessTimeoutMs(),
        10,
    );
    const projectsDir = args['projects-dir'] ?? process.env['KAGEOPS_PROJECTS_DIR'] ?? path.join(os.homedir(), '.kageops', 'projects');
    const autoApprove = args['auto-approve'] !== 'false';
    const dryRun = args['dry-run'] === 'true' || process.env['KAGEOPS_DRY_RUN'] === '1';

    const phasePresetRaw = args['phase-preset'] ?? process.env['KAGEOPS_PHASE_PRESET'];
    const phasePreset: string | null =
        phasePresetRaw !== undefined && phasePresetRaw !== '' && phasePresetRaw !== 'true'
            ? phasePresetRaw
            : null;

    // P1-09 smoke harness flags
    const addRequirementRaw = args['add-requirement'];
    const addRequirement: string | null =
        addRequirementRaw !== undefined && addRequirementRaw !== '' && addRequirementRaw !== 'true'
            ? addRequirementRaw
            : null;
    const closeFirst = args['close-first'] === 'true';

    if (addRequirement !== null && resume === null) {
        throw new Error('--add-requirement requires --resume <project-id> (it drives a flow against an existing project).');
    }
    if (closeFirst && addRequirement === null) {
        throw new Error('--close-first only makes sense alongside --add-requirement.');
    }

    return {
        name: name ?? `resume:${resume ?? 'unknown'}`,
        description,
        trustLevel,
        timeoutMs,
        projectsDir,
        autoApprove,
        dryRun,
        resume,
        phasePreset,
        addRequirement,
        closeFirst,
    };
}

function printBanner(args: RunnerArgs): void {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║       KageOps — Headless Project Runner      ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Project:     ${args.name}`);
    console.log(`  Description: ${args.description}`);
    console.log(`  Trust Level: ${args.trustLevel}`);
    console.log(`  Timeout:     ${args.timeoutMs / 1000}s`);
    console.log(`  Auto-approve: ${args.autoApprove}`);
    console.log(`  Projects Dir: ${args.projectsDir}`);
    if (args.phasePreset !== null) {
        console.log(`  Phase preset: ${args.phasePreset} (#165 — constrains enabled_phases + phase_task_selections)`);
    }
    // BPF-35: surface the headless self-deploy credential source so operators
    // can confirm the run will deploy itself (vs. needing a manual deploy).
    const appEnvFile = appEnvFilePath();
    if (appEnvFile !== null) {
        console.log(`  App-env file: ${appEnvFile} (BPF-35 — fed to .env.local + vercel --env)`);
        console.log(`  Vercel token: ${process.env['KAGEOPS_VERCEL_TOKEN'] !== undefined ? '✓ set' : '✗ missing (set KAGEOPS_VERCEL_TOKEN to self-deploy)'}`);
        if (process.env['KAGEOPS_VERCEL_SCOPE'] !== undefined) {
            console.log(`  Vercel scope: ${process.env['KAGEOPS_VERCEL_SCOPE']}`);
        }
    }
    // F-361: surface brief-quality warnings inline so operators see them
    // before paying for a run. Warnings are informational — runner does
    // NOT block on low-quality briefs, but the operator can ctrl-c out
    // and improve the brief if they care about acceptance-gate scores.
    const lintResult = lintBrief(args.description);
    if (lintResult.warnings.length > 0) {
        console.log('');
        console.log('  ⚠ Brief-quality lint (F-361):');
        for (const w of lintResult.warnings) {
            console.log(`     [${w.severity}] ${w.message}`);
            console.log(`           → ${w.suggestion}`);
        }
        console.log(`     scoreable by auto-rubric: ${lintResult.scoreable ? 'YES' : 'NO'}`);
    }
    console.log('');
}

// ── Dry-Run (offline, zero AI calls) ─────────────────

function printDryRun(args: RunnerArgs): void {
    const { simple, kind } = detectSimpleApp(args.description);
    const phases: readonly string[] = [
        'discovery', 'poc', 'business-viability', 'design-planning', 'development', 'launch-growth',
    ];
    console.log('');
    console.log('═══ DRY-RUN PLAN (no AI calls, no spend) ═══');
    console.log(`  Project:        ${args.name}`);
    console.log(`  Description:    ${args.description}`);
    console.log(`  Simple-app:     ${simple ? `YES (${kind})` : 'NO'}`);
    console.log(`  Active preset:  ${process.env['KAGEOPS_PRESET'] ?? '(none — using agent-config.json or default)'}`);
    console.log(`  Budget cap:     $${(process.env['KAGEOPS_MAX_RUN_USD'] ?? resolveDefaultMaxRunUsd())} (KAGEOPS_MAX_RUN_USD)`);
    console.log('');
    console.log('  Phase plan (max tasks per phase if simple):');
    const simpleCaps: Record<string, number> = {
        'discovery': 2, 'poc': 1, 'business-viability': 1,
        'design-planning': 1, 'development': 1, 'launch-growth': 1,
    };
    let totalTasksIfSimple = 0;
    let totalTasksIfFull = 0;
    for (const p of phases) {
        const simpleCap = simpleCaps[p] ?? 1;
        const fullEst = p === 'development' ? 8 : 4;
        totalTasksIfSimple += simpleCap;
        totalTasksIfFull += fullEst;
        console.log(`    ${p.padEnd(22)} simple: ${simpleCap} task(s)   full: ~${fullEst} task(s)`);
    }
    console.log('');
    console.log(`  Total tasks:    simple=${totalTasksIfSimple}   full=~${totalTasksIfFull}`);
    console.log('');
    console.log('  Estimated AI calls (assumes ~6 calls/task avg: decompose+execute+review+retry):');
    console.log(`    simple path:  ~${6 + totalTasksIfSimple * 6} calls`);
    console.log(`    full path:    ~${6 + totalTasksIfFull * 6} calls`);
    console.log('');
    console.log('  Estimated cost by preset (output-heavy):');
    const calls = simple ? (6 + totalTasksIfSimple * 6) : (6 + totalTasksIfFull * 6);
    const avgTokensOut = 1500;
    const totalTokensOut = calls * avgTokensOut;
    const presets: Array<[string, number]> = [
        ['openrouter_standard (Sonnet)', 15.0],
        ['openrouter_budget (DeepSeek/Gemini)', 0.5],
        ['ollama (cloud)', 0.0],
    ];
    for (const [label, ratePerM] of presets) {
        const est = (totalTokensOut / 1_000_000) * ratePerM;
        console.log(`    ${label.padEnd(40)} ~$${est.toFixed(4)}`);
    }
    console.log('');
    console.log('  Note: This is a pure heuristic. Real decomposition still requires AI calls.');
    console.log('        Run without --dry-run to execute (budget-kill enforced).');
    console.log('═══════════════════════════════════════════');
    console.log('');
}

// ── Bootstrap (headless variant — no Electron deps) ──

async function bootstrapHeadless(projectsDir: string): Promise<{
    readonly sensei: Sensei;
    readonly eventBus: EventBus;
    readonly agentRegistry: AgentRegistry;
    readonly stopStallWatchdog: () => void;
}> {
    // 1. Database
    log.info('Initializing database...');
    await initDatabase({ maxRetries: 3, retryDelayMs: 1000 });
    log.info('Database ready.');

    // 2. Event Bus — pass DATABASE_URL as-is (EventBus picks embedded mode when unset).
    const eventBus = new EventBus(process.env['DATABASE_URL']);

    // 3. Agent config
    const agentConfig = loadAgentConfig();

    // 4. Sensei AI wrappers
    const senseiModelConfig = getAgentModelConfig(agentConfig, 'sensei');
    const senseiSendPrompt = async (systemPrompt: string, userPrompt: string): Promise<string> => {
        const response = await sendPrompt(
            senseiModelConfig.model,
            systemPrompt,
            userPrompt,
            { maxTokens: senseiModelConfig.maxTokens, temperature: senseiModelConfig.temperature }
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
        const response = await sendConversation(
            senseiModelConfig.model,
            systemPrompt,
            convMessages,
            { maxTokens: senseiModelConfig.maxTokens, temperature: senseiModelConfig.temperature }
        );
        return response.text;
    };

    // 5. Shared infrastructure
    const costTracker = new CostTracker(eventBus);
    const branchManager = new BranchManager();
    const maxConcurrency = parseInt(process.env['KAGEOPS_MAX_CONCURRENCY'] ?? '3', 10);
    const taskPool = new TaskPool(maxConcurrency);

    // 6. Agent registry
    const agentRegistry = new AgentRegistry();

    // 7. Sensei
    const workspaceManager = new WorkspaceManager();
    const commsSender = new CommsSender();
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
    };
    const sensei = new Sensei(senseiConfig, eventBus);

    // 8. Create specialist agents
    const codeGraphBridge = getCodeGraphBridge();
    const graphifyBridge = getGraphifyBridge();
    const githubClient = getGitHubClient();

    // Design provider registry — env + persisted UI selection flow through
    // the same resolver; KAGEOPS_DESIGN_PROVIDER env wins, then UI state.
    const pixelModelConfig = getAgentModelConfig(agentConfig, 'pixel');
    const designRegistry = buildProviderRegistryFromEnv({
        inHouseModel: pixelModelConfig.model,
    });
    const activeDesignProvider: DesignProviderId = getActiveDesignProvider();
    console.log(`[headless] Design provider: ${activeDesignProvider}`);

    const agents = [
        new Scout(getAgentModelConfig(agentConfig, 'scout')),
        new Blueprint(getAgentModelConfig(agentConfig, 'blueprint')),
        new Forge(getAgentModelConfig(agentConfig, 'forge')),
        new Vigil(getAgentModelConfig(agentConfig, 'vigil')),
        new Aegis(getAgentModelConfig(agentConfig, 'aegis')),
        new Pixel(pixelModelConfig, {
            registry: designRegistry,
            providerId: activeDesignProvider,
        }),
        new Cipher(getAgentModelConfig(agentConfig, 'cipher')),
        new Herald(getAgentModelConfig(agentConfig, 'herald')),
    ];

    // 9. Inject infrastructure
    const { taskCheckpointRepository } = await import('../db/task-checkpoint-repo');
    for (const agent of agents) {
        agent.setCostTracker(costTracker);
        agent.setBranchManager(branchManager);
        agent.setFallbackChain(getFallbackChain(agent.name, agent.modelConfig.model));
        agent.setCodeGraphBridge(codeGraphBridge);
        agent.setGraphifyBridge(graphifyBridge);
        agent.setGitHubClient(githubClient);
        // P1-01: always wire the checkpoint repo; the per-call gate
        // `checkpointsEnabled()` (on by default, kill-switch
        // KAGEOPS_TASK_CHECKPOINTS=false) decides whether it actually
        // gets consulted, so wiring it unconditionally costs nothing
        // and avoids a "checkpoints enabled but no repo" silent failure.
        agent.setTaskCheckpointRepo(taskCheckpointRepository);
        agentRegistry.registerAgent(agent);
    }

    // 10. Connect agents to EventBus
    for (const agent of agents) {
        await agent.connect(eventBus);
    }

    // 11. Start Sensei (connects EventBus)
    await sensei.start();

    // 12. Build-summary report (F-300) — generate an HTML build report whenever
    // a project transitions to `completed`. Headless runs (benchmarks, CI,
    // automated batches) need this just as much as Electron runs do, but the
    // subscription only lives in src/main/main.ts. Wiring it here closes the
    // gap so a `headless-runner.ts --resume <id>` that finishes a project also
    // produces the report. Pure subscriber — failures log and don't affect
    // the orchestrator.
    const { subscribeBuildSummaryGenerator } = await import('../orchestrator/build-summary');
    subscribeBuildSummaryGenerator(eventBus);

    // BPF-20: start the stall watchdog headless too. It only lived in the
    // Electron bootstrap, so a headless stall (e.g. a resume that idles on an
    // unbroken dependency graph, or a provider outage) had NO auto-reclaim
    // safety net and burned the wall-clock timeout doing nothing. The reclaim
    // hook re-runs restartStalledProject (reset non-terminal tasks → pending +
    // re-dispatch) before parking. Off via KAGEOPS_AUTO_RECLAIM=0.
    //
    // BPF-23: the 5-min Electron default is a crash-detection threshold —
    // shorter than a single cloud-OSS generation call (gpt-oss:120b /
    // qwen-coder routinely exceed 5 min), so it falsely reclaimed a LIVE,
    // progressing in-flight task mid-call and restarted it in a loop. Headless
    // single-process runs already have a hard wall-clock timeout + the zombie
    // guard; the watchdog here only needs to catch a TRULY hung run, so use a
    // generous floor that comfortably exceeds realistic per-call latency.
    // KAGEOPS_STALL_TIMEOUT_MS still overrides when explicitly set.
    const HEADLESS_STALL_FLOOR_MS = 20 * 60 * 1000;
    const envStallMs = parseInt(process.env['KAGEOPS_STALL_TIMEOUT_MS'] ?? '', 10);
    const stopStallWatchdog = startStallWatchdog(eventBus, {
        reclaim: (projectId: string) => sensei.restartStalledProject(projectId),
        stallTimeoutMs: Number.isFinite(envStallMs) && envStallMs > 0
            ? envStallMs
            : HEADLESS_STALL_FLOOR_MS,
    });

    log.info({ agentCount: agents.length }, 'Headless orchestrator bootstrapped');
    return { sensei, eventBus, agentRegistry, stopStallWatchdog };
}

// ── Main Loop ────────────────────────────────────────

async function waitForCompletion(
    projectId: string,
    eventBus: EventBus,
    sensei: Sensei,
    args: RunnerArgs
): Promise<RunnerResult> {
    const startTime = Date.now();
    let lastPhase = 'discovery';
    let completed = false;
    let error: string | null = null;

    const envMaxRunUsd = parseFloat((process.env['KAGEOPS_MAX_RUN_USD'] ?? resolveDefaultMaxRunUsd()));
    // RG-2: default raised 60s → 180s so a giant cloud model's first decompose
    // call (e.g. kimi-k2.5:cloud / 1T models can exceed 60s before the first
    // task lands) isn't zombie-cancelled before it even starts. NaN/garbage env
    // falls back to the default rather than disabling the guard.
    const parsedZombie = parseInt(process.env['KAGEOPS_ZOMBIE_TIMEOUT_MS'] ?? '', 10);
    const zombieTimeoutMs = Number.isFinite(parsedZombie) && parsedZombie > 0 ? parsedZombie : 180_000;
    let killedByBudget = false;

    // Seed projects.budget_usd from the env cap so the UI has something
    // to show and edit. Only writes when the column is NULL — never
    // overwrites a cap the operator set from the Command Center.
    try {
        await query(
            `UPDATE projects SET budget_usd = $1 WHERE id = $2 AND budget_usd IS NULL`,
            [envMaxRunUsd, projectId]
        );
    } catch { /* non-fatal — DB may be read-only or slow */ }

    return new Promise<RunnerResult>((resolve) => {
        let phaseCheck: NodeJS.Timeout | null = null;
        let budgetCheck: NodeJS.Timeout | null = null;
        let zombieCheckRef: NodeJS.Timeout | null = null;
        let gateWindowWarn: NodeJS.Timeout | null = null;
        const cleanup = (): void => {
            if (phaseCheck !== null) clearInterval(phaseCheck);
            if (budgetCheck !== null) clearInterval(budgetCheck);
            if (zombieCheckRef !== null) clearTimeout(zombieCheckRef);
            if (gateWindowWarn !== null) clearTimeout(gateWindowWarn);
        };
        // Set overall timeout
        const timeout = setTimeout(() => {
            log.warn({ projectId, lastPhase }, 'Project timed out');
            cleanup();
            resolve(buildResult(projectId, lastPhase, startTime, 'Timed out', killedByBudget));
        }, args.timeoutMs);

        // F-392 part (b): GATE-WINDOW WARNING.
        //
        // 2026-05-21 GPS Delivery Tracker smoke hit the 30-min wall
        // exactly when Forge's final task finished (16.8 min for one
        // task). The build-verification + acceptance gates never ran
        // because the runner exited (exit 99) immediately on
        // task.completed — there was no budget left for the gates.
        //
        // This timer fires at `timeoutMs - KAGEOPS_GATE_WINDOW_MS`
        // (default 5 min before the wall) and emits a visible warning
        // so operators see the risk before it costs them another run.
        // It does NOT halt dispatch — phase-gates manages task flow,
        // and abrupt cancellation would orphan in-flight Forge writes.
        // The signal alone is enough to inform tuning: bump
        // KAGEOPS_HEADLESS_TIMEOUT_MS or tighten
        // KAGEOPS_MAX_TASK_DURATION_MS on the next run.
        const gateWindowMs = parseInt(
            process.env['KAGEOPS_GATE_WINDOW_MS'] ?? '300000',
            10,
        );
        const gateWindowStartMs = Math.max(0, args.timeoutMs - gateWindowMs);
        if (Number.isFinite(gateWindowMs) && gateWindowMs > 0 && gateWindowStartMs > 0) {
            gateWindowWarn = setTimeout(() => {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                const remaining = Math.round(gateWindowMs / 1000);
                log.warn(
                    { projectId, elapsedSec: elapsed, remainingSec: remaining },
                    'F-392: entering gate window — build/acceptance gates risk being cut off',
                );
                console.log(
                    `\n  [${elapsed}s] [gate-window] ${remaining}s remaining before wall-clock timeout. ` +
                    `If tasks are still in flight, the build/acceptance gates may not complete. ` +
                    `Tune KAGEOPS_HEADLESS_TIMEOUT_MS or KAGEOPS_MAX_TASK_DURATION_MS on next run.`,
                );
            }, gateWindowStartMs);
        }

        // Budget-kill: poll agent_logs every 3s. Enforce via cost AND token estimate —
        // some providers log cost as 0 before a post-hoc reconciliation, so we fall back
        // to a conservative $/token estimate against output tokens.
        //
        // Cap is re-read from projects.budget_usd each tick so the Command
        // Center can raise/lower it mid-run. When the DB column is NULL we
        // fall back to the env cap captured at start.
        console.log(`  Budget cap: $${envMaxRunUsd.toFixed(2)} (KAGEOPS_MAX_RUN_USD; mutable via projects.budget_usd)`);
        budgetCheck = setInterval(async () => {
            try {
                const row = await getOne<{ total: string | null; tout: string | null; cap: string | null }>(
                    `SELECT COALESCE(SUM(al.cost_usd), 0)::text AS total,
                            COALESCE(SUM(al.tokens_out), 0)::text AS tout,
                            (SELECT budget_usd::text FROM projects WHERE id = $1) AS cap
                       FROM agent_logs al WHERE al.project_id = $1`,
                    [projectId]
                );
                const loggedCost = row !== null && row.total !== null ? parseFloat(row.total) : 0;
                const tokensOut = row !== null && row.tout !== null ? parseInt(row.tout, 10) : 0;
                const dbCap = row !== null && row.cap !== null ? parseFloat(row.cap) : NaN;
                const maxRunUsd = Number.isFinite(dbCap) ? dbCap : envMaxRunUsd;
                // Conservative floor: $3/M output tokens (Sonnet rate) — ensures we kill
                // even if cost_usd was not recorded by the provider.
                const tokenEstCost = (tokensOut / 1_000_000) * 3.0;
                const total = Math.max(loggedCost, tokenEstCost);
                if (total >= maxRunUsd && !killedByBudget) {
                    killedByBudget = true;
                    log.error({ projectId, loggedCost, tokenEstCost, capUsd: maxRunUsd }, 'BUDGET KILL — halting run');
                    console.log(`\n  [budget-kill] $${total.toFixed(4)} >= cap $${maxRunUsd.toFixed(2)} — halting run (logged=$${loggedCost.toFixed(4)}, tokenEst=$${tokenEstCost.toFixed(4)})`);
                    try {
                        await query(
                            `UPDATE tasks SET status = 'failed', error_message = 'Budget killed'
                             WHERE project_id = $1 AND status IN ('pending', 'assigned', 'in_progress')`,
                            [projectId]
                        );
                        await query(
                            `UPDATE projects SET status = 'cancelled' WHERE id = $1`,
                            [projectId]
                        );
                    } catch { /* ignore */ }
                    clearTimeout(timeout);
                    cleanup();
                    resolve(buildResult(projectId, lastPhase, startTime, 'Budget killed', true));
                }
            } catch {
                // DB hiccup — ignore and retry next interval
            }
        }, 3_000);

        // Zombie-project guard: if no tasks exist after zombieTimeoutMs, abort.
        zombieCheckRef = setTimeout(async () => {
            try {
                const row = await getOne<{ count: string }>(
                    'SELECT COUNT(*)::text AS count FROM tasks WHERE project_id = $1',
                    [projectId]
                );
                const taskCount = row !== null ? parseInt(row.count, 10) : 0;
                if (taskCount === 0 && !killedByBudget && !completed) {
                    log.error({ projectId, elapsedMs: zombieTimeoutMs }, 'ZOMBIE PROJECT — no tasks decomposed, aborting');
                    console.log(`\n  [zombie-guard] No tasks decomposed within ${zombieTimeoutMs / 1000}s — aborting`);
                    try {
                        await query(`UPDATE projects SET status = 'cancelled' WHERE id = $1`, [projectId]);
                    } catch { /* ignore */ }
                    clearTimeout(timeout);
                    cleanup();
                    resolve(buildResult(projectId, lastPhase, startTime, 'Zombie project (no tasks)', false));
                }
            } catch { /* ignore */ }
        }, zombieTimeoutMs);

        // Subscribe to all events for progress tracking
        eventBus.subscribeAll(async (event) => {
            const eventProjectId = typeof event.data?.['projectId'] === 'string'
                ? event.data['projectId']
                : typeof event.data?.['project_id'] === 'string'
                    ? event.data['project_id']
                    : null;

            // Only track events for our project
            if (eventProjectId !== null && eventProjectId !== projectId) return;

            const ch = event.channel as string;

            if (ch === 'task.completed') {
                log.info({
                    taskId: event.data?.['taskId'],
                    agent: event.data?.['agent'],
                }, 'Task completed');
            } else if (ch === 'task.failed') {
                log.warn({
                    taskId: event.data?.['taskId'],
                    agent: event.data?.['agent'],
                    error: event.data?.['error'],
                }, 'Task failed');
            } else if (ch === 'approval.required') {
                // Distinguish phase-gate approval from failure/budget escalations.
                // phase-gates.requestApproval() sets data.currentPhase; failure
                // escalations (sensei.onTaskFailed) set data.reason instead.
                const data = (event.data ?? {}) as Record<string, unknown>;
                const isPhaseGate = typeof data['currentPhase'] === 'string'
                    && data['reason'] === undefined;
                if (args.autoApprove && isPhaseGate) {
                    log.info({ projectId }, 'Auto-approving phase gate...');
                    try {
                        await sensei.approveGate(projectId);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        log.error({ err: msg }, 'Auto-approve failed');
                    }
                } else {
                    log.info(
                        { projectId, reason: data['reason'] },
                        'Approval required (not auto-approving — not a phase gate)'
                    );
                }
            }
        });

        // Poll project phase/status every 5s for UI feedback.
        // Phase-gates set status='completed' after the last phase (launch-growth)
        // without changing the phase column, so we must check BOTH:
        //  - phase === 'completed' (legacy / explicit completion marker)
        //  - status === 'completed' (how phase-gates actually signals done)
        phaseCheck = setInterval(async () => {
            try {
                const project = await getOne<{ phase: string; status: string }>(
                    'SELECT phase, status FROM projects WHERE id = $1',
                    [projectId]
                );
                if (project !== null && project.phase !== lastPhase) {
                    lastPhase = project.phase;
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    console.log(`  [${elapsed}s] Phase: ${lastPhase}`);
                }
                const isDone =
                    project !== null &&
                    (project.phase === 'completed' || project.status === 'completed');
                if (isDone && !completed) {
                    completed = true;
                    clearTimeout(timeout);
                    cleanup();
                    resolve(buildResult(projectId, 'completed', startTime, null, killedByBudget));
                }
            } catch {
                // DB hiccup — ignore and retry next interval
            }
        }, 5000);
    });

    async function buildResult(
        pid: string,
        phase: string,
        start: number,
        err: string | null,
        budgetKilled: boolean
    ): Promise<RunnerResult> {
        let tasksCompleted = 0;
        let tasksFailed = 0;
        let repoPath: string | null = null;
        let totalCostUsd = 0;

        try {
            const stats = await getOne<{ completed: string; failed: string }>(
                `SELECT
                    COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                    COUNT(*) FILTER (WHERE status = 'failed') AS failed
                 FROM tasks WHERE project_id = $1`,
                [pid]
            );
            if (stats !== null) {
                tasksCompleted = parseInt(stats.completed, 10);
                tasksFailed = parseInt(stats.failed, 10);
            }
        } catch { /* ignore */ }

        try {
            const project = await getOne<{ repo_path: string | null }>(
                'SELECT repo_path FROM projects WHERE id = $1',
                [pid]
            );
            repoPath = project?.repo_path ?? null;
        } catch { /* ignore */ }

        try {
            const costRow = await getOne<{ total: string | null; tin: string | null; tout: string | null }>(
                `SELECT COALESCE(SUM(cost_usd), 0)::text AS total,
                        COALESCE(SUM(tokens_in), 0)::text AS tin,
                        COALESCE(SUM(tokens_out), 0)::text AS tout
                   FROM agent_logs WHERE project_id = $1`,
                [pid]
            );
            totalCostUsd = costRow !== null && costRow.total !== null ? parseFloat(costRow.total) : 0;

            // Archive run (immutable)
            const proj = await getOne<{ name: string; description: string | null; trust_level: string }>(
                'SELECT name, description, trust_level FROM projects WHERE id = $1',
                [pid]
            );
            if (proj !== null) {
                await query(
                    `INSERT INTO runs
                        (project_id, project_name, description_hash, trust_level,
                         started_at, completed_at, final_phase, final_status,
                         tasks_completed, tasks_failed, total_tokens_in, total_tokens_out,
                         total_cost_usd, killed_by_budget, error_message)
                     VALUES ($1, $2, $3, $4, to_timestamp($5/1000.0), NOW(),
                             $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
                    [
                        pid,
                        proj.name,
                        proj.description !== null ? proj.description.slice(0, 200) : null,
                        proj.trust_level,
                        start,
                        phase,
                        phase === 'completed' ? 'success' : (budgetKilled ? 'budget_killed' : 'incomplete'),
                        tasksCompleted,
                        tasksFailed,
                        parseInt(costRow?.tin ?? '0', 10),
                        parseInt(costRow?.tout ?? '0', 10),
                        totalCostUsd,
                        budgetKilled,
                        err,
                    ]
                );
            }
        } catch (archiveErr) {
            log.warn(
                { err: archiveErr instanceof Error ? archiveErr.message : String(archiveErr) },
                'Failed to archive run'
            );
        }

        return {
            success: phase === 'completed',
            projectId: pid,
            repoPath,
            phase,
            tasksCompleted,
            tasksFailed,
            durationMs: Date.now() - start,
            error: err,
            killedByBudget: budgetKilled,
            totalCostUsd,
        };
    }
}

/** Write a markdown run report to docs/runs/ for human review. */
function writeRunReport(
    result: RunnerResult,
    projectName: string,
    description: string,
): void {
    try {
        const docsDir = path.resolve(__dirname, '../../docs/runs');
        if (!fs.existsSync(docsDir)) {
            fs.mkdirSync(docsDir, { recursive: true });
        }

        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        const fileName = `${ts}_${slug}.md`;

        const status = result.success ? 'SUCCESS' : result.killedByBudget ? 'BUDGET_KILLED' : 'INCOMPLETE';
        const duration = (result.durationMs / 1000).toFixed(1);

        const lines: string[] = [
            `# Run Report: ${projectName}`,
            '',
            `**Date:** ${new Date().toISOString()}`,
            `**Status:** ${status}`,
            `**Phase Reached:** ${result.phase}`,
            `**Duration:** ${duration}s`,
            `**Cost:** $${result.totalCostUsd.toFixed(4)} USD`,
            `**Tasks:** ${result.tasksCompleted} completed, ${result.tasksFailed} failed`,
            `**Budget Killed:** ${result.killedByBudget ? 'Yes' : 'No'}`,
            result.repoPath !== null ? `**Repo:** ${result.repoPath}` : '',
            result.error !== null ? `**Error:** ${result.error}` : '',
            '',
            '## Description',
            '',
            description,
            '',
            '## Outcome',
            '',
        ];

        if (result.success) {
            lines.push(`The project completed all phases successfully.`);
            lines.push(`Total cost was $${result.totalCostUsd.toFixed(4)} USD for ${result.tasksCompleted} tasks.`);
        } else if (result.killedByBudget) {
            lines.push(`The run was terminated by the budget-kill guard.`);
            lines.push(`Spent $${result.totalCostUsd.toFixed(4)} USD before cutoff at phase "${result.phase}".`);
        } else {
            lines.push(`The run did not complete all phases. Stopped at "${result.phase}".`);
            if (result.error !== null) {
                lines.push(`Error: ${result.error}`);
            }
        }

        lines.push('');
        lines.push('## Learnings');
        lines.push('');
        if (result.tasksFailed > 0) {
            lines.push(`- ${result.tasksFailed} task(s) failed — check incidents table for root cause analysis.`);
        }
        if (result.totalCostUsd > 1.0) {
            lines.push(`- Cost exceeded $1.00 — consider using a cheaper preset or tighter token caps.`);
        }
        if (result.durationMs > 300_000) {
            lines.push(`- Run took over 5 minutes — investigate slow tasks or model latency.`);
        }
        if (result.success && result.tasksFailed === 0) {
            lines.push('- Clean run with zero failures.');
        }
        lines.push('');

        fs.writeFileSync(path.join(docsDir, fileName), lines.join('\n'), 'utf-8');
        log.info({ file: fileName }, 'Run report written to docs/runs/');
        console.log(`  Report:     docs/runs/${fileName}`);
    } catch (reportErr) {
        log.warn(
            { err: reportErr instanceof Error ? reportErr.message : String(reportErr) },
            'Failed to write run report'
        );
    }
}

// ── Programmatic API ─────────────────────────────────
//
// Exported shape for callers that want to drive the pipeline from code
// (tests, embedders) instead of the CLI. The CLI `main()` wraps this.

export interface HeadlessOptions {
    readonly name: string;
    readonly description: string;
    readonly dryRun: boolean;
    readonly budgetCapUsd?: number;
    readonly autonomousAfterDesign?: boolean;
    readonly abortSignal?: AbortSignal;
    readonly onEvent?: (event: PipelineEvent) => void;
    readonly preset?: string;
    readonly trustLevel?: 'low' | 'medium' | 'high';
    readonly timeoutMs?: number;
    readonly projectsDir?: string;
    readonly autoApprove?: boolean;
    /**
     * Quick-preset id from QUICK_PRESETS (issue #165 stage 2) — applies
     * enabledPhases + phase_task_selections derived from the preset to
     * `sensei.startProject`. Distinct from `preset`, which controls
     * agent-config (model/provider). Both can be set together.
     */
    readonly phaseSelectionsPreset?: string;
}

export interface HeadlessResult {
    readonly projectId: string;
    readonly finalPhase: string;
    readonly phasesVisited: readonly string[];
    readonly tasksCompleted: number;
    readonly tasksFailed: number;
    readonly totalCostUsd: number;
    readonly gateVerdicts: {
        readonly build?: 'pass' | 'fail' | 'skipped';
        readonly acceptance?: 'pass' | 'fail' | 'skipped';
    };
    readonly durationMs: number;
    readonly escalations: readonly string[];
}

export interface PipelineEvent {
    readonly channel: string;
    readonly projectId: string;
    readonly timestamp: string;
    readonly data?: unknown;
}

const ALL_PHASES: readonly string[] = [
    'discovery',
    'poc',
    'business-viability',
    'design-planning',
    'development',
    'launch-growth',
];

/**
 * Deterministic stand-in for a project UUID used in dry-run mode.
 * Real runs generate a UUID via Postgres `gen_random_uuid()`.
 */
function makeDryRunProjectId(name: string): string {
    // Produce a stable RFC-4122 v4-shaped hex string from the name, seeded
    // so repeated dry-runs for the same project name are reproducible.
    // UUID v4 format: 8-4-4-4-12 (32 hex digits total).
    let h = 0x811c9dc5;
    const hexOut: string[] = [];
    for (const ch of name) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
        hexOut.push(h.toString(16).padStart(8, '0'));
    }
    // Pad with deterministic filler so short names still produce 32 hex chars.
    while (hexOut.length < 4) {
        h = Math.imul(h, 0x01000193) >>> 0;
        hexOut.push(h.toString(16).padStart(8, '0'));
    }
    const blob = hexOut.join('').slice(0, 32);
    // Enforce version 4 + variant bits for a well-formed v4 UUID.
    const segments = [
        blob.slice(0, 8),
        blob.slice(8, 12),
        `4${blob.slice(13, 16)}`,
        `8${blob.slice(17, 20)}`,
        blob.slice(20, 32),
    ];
    return segments.join('-');
}

/**
 * Programmatic headless runner.
 *
 * Dry-run mode is fully offline — it does not open a DB connection, does
 * not spawn Sensei, and makes zero AI calls. It emits a synthetic event
 * stream that mirrors what a real run would produce (task.created,
 * phase.transitioned, gate verdicts) so callers can assert pipeline shape.
 */
export async function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
    const start = Date.now();
    const emit = options.onEvent ?? ((): void => undefined);

    if (options.dryRun) {
        const projectId = makeDryRunProjectId(options.name);
        const { simple } = detectSimpleApp(options.description);
        const tasksPerPhase = simple ? 1 : 2;
        let tasksCreated = 0;

        for (const phase of ALL_PHASES) {
            const phaseTimestamp = new Date().toISOString();
            for (let i = 0; i < tasksPerPhase; i++) {
                tasksCreated += 1;
                emit({
                    channel: 'task.created',
                    projectId,
                    timestamp: phaseTimestamp,
                    data: {
                        taskId: `dry-task-${phase}-${i}`,
                        phase,
                        taskType: phase === 'development' ? 'implement' : 'plan',
                    },
                });
            }
            emit({
                channel: 'phase.transitioned',
                projectId,
                timestamp: phaseTimestamp,
                data: { from: phase, to: phase },
            });
        }

        emit({
            channel: 'build.verification.passed',
            projectId,
            timestamp: new Date().toISOString(),
            data: { skipped: true, reason: 'dry-run' },
        });
        emit({
            channel: 'acceptance.passed',
            projectId,
            timestamp: new Date().toISOString(),
            data: { skipped: true, reason: 'dry-run' },
        });

        return {
            projectId,
            finalPhase: 'launch-growth',
            phasesVisited: ALL_PHASES,
            tasksCompleted: tasksCreated,
            tasksFailed: 0,
            totalCostUsd: 0,
            gateVerdicts: { build: 'skipped', acceptance: 'skipped' },
            durationMs: Date.now() - start,
            escalations: [],
        };
    }

    // Live run — delegate to the full bootstrap path. This mirrors the
    // CLI `main()` but returns a structured result instead of printing.
    const liveArgs: RunnerArgs = {
        name: options.name,
        description: options.description,
        trustLevel: options.trustLevel ?? 'high',
        timeoutMs: options.timeoutMs ?? 600_000,
        projectsDir: options.projectsDir
            ?? process.env['KAGEOPS_PROJECTS_DIR']
            ?? path.join(os.homedir(), '.kageops', 'projects'),
        autoApprove: options.autoApprove ?? true,
        dryRun: false,
        resume: null,
        phasePreset: options.phaseSelectionsPreset ?? null,
        addRequirement: null,
        closeFirst: false,
    };

    if (options.budgetCapUsd !== undefined) {
        process.env['KAGEOPS_MAX_RUN_USD'] = options.budgetCapUsd.toString();
    }
    if (options.preset !== undefined && options.preset !== '') {
        process.env['KAGEOPS_PRESET'] = options.preset;
    }

    const handles = await bootstrapHeadless(liveArgs.projectsDir);
    const escalations: string[] = [];
    const phasesVisited: string[] = [];
    let buildVerdict: 'pass' | 'fail' | 'skipped' | undefined;
    let acceptanceVerdict: 'pass' | 'fail' | 'skipped' | undefined;

    handles.eventBus.subscribeAll((event) => {
        const payload: PipelineEvent = {
            channel: event.channel,
            projectId: event.projectId ?? '',
            timestamp: event.timestamp,
            data: event.data,
        };
        emit(payload);

        if (event.channel === 'build.verification.passed') buildVerdict = 'pass';
        if (event.channel === 'build.verification.failed') buildVerdict = 'fail';
        if (event.channel === 'acceptance.passed') acceptanceVerdict = 'pass';
        if (event.channel === 'acceptance.failed') acceptanceVerdict = 'fail';

        const rec = event.data as Record<string, unknown> | undefined;
        if (event.channel === 'approval.required' && rec !== undefined && typeof rec['reason'] === 'string') {
            escalations.push(rec['reason']);
        }
        if (rec !== undefined && typeof rec['phase'] === 'string' && !phasesVisited.includes(rec['phase'])) {
            phasesVisited.push(rec['phase']);
        }
    });

    try {
        const projectId = await handles.sensei.startProject(
            liveArgs.name,
            liveArgs.description,
            buildStartOptions(liveArgs),
        );
        handles.sensei.setFocusProject(projectId);

        const runnerResult = await waitForCompletion(
            projectId,
            handles.eventBus,
            handles.sensei,
            liveArgs
        );

        return {
            projectId: runnerResult.projectId ?? projectId,
            finalPhase: runnerResult.phase,
            phasesVisited: phasesVisited.length > 0 ? phasesVisited : [runnerResult.phase],
            tasksCompleted: runnerResult.tasksCompleted,
            tasksFailed: runnerResult.tasksFailed,
            totalCostUsd: runnerResult.totalCostUsd,
            gateVerdicts: {
                build: buildVerdict,
                acceptance: acceptanceVerdict,
            },
            durationMs: runnerResult.durationMs,
            escalations,
        };
    } finally {
        try {
            handles.stopStallWatchdog();
            await handles.sensei.stop();
            await handles.agentRegistry.shutdownAll();
        } catch { /* best effort */ }
        await closePool();
    }
}

// ── B-400: RPC wrapper ───────────────────────────────
//
// `startProjectRun` is the stable main-process RPC surface that the
// Electron Command Center's split-button ("Start > Dry Run | Live Run")
// invokes via IPC. It intentionally projects the CLI's richer
// `HeadlessOptions` down to the tiny shape backlog item B-400 specifies:
// just `{ name, description, dryRun, maxUsd }`.
//
// Keep this function a *thin wrapper* over `runHeadless` — the CLI, the
// E2E smoke test, and the renderer all share the same pipeline through
// that single entry point. Adding logic here risks drift between the
// CLI and the UI. If behavioral changes are needed, they belong in
// `runHeadless`.
//
// Live runs still rely on `bootstrapHeadless` inside `runHeadless` to
// stand up their own orchestrator stack; callers that already host a
// running Sensei (e.g. Electron main process) should NOT route live
// runs through here — they should call `sensei.startProject` directly
// against their existing handles and set budget env vars themselves.
// This function IS appropriate for:
//   - CLI entry (via `main()`)
//   - Tests
//   - Dry-run previews from any host (fully offline, zero side effects)

export interface StartProjectRunOptions {
    readonly name: string;
    readonly description: string;
    readonly dryRun: boolean;
    readonly maxUsd?: number;
    readonly onEvent?: (event: PipelineEvent) => void;
}

export async function startProjectRun(
    options: StartProjectRunOptions,
): Promise<HeadlessResult> {
    return runHeadless({
        name: options.name,
        description: options.description,
        dryRun: options.dryRun,
        budgetCapUsd: options.maxUsd,
        onEvent: options.onEvent,
    });
}

// ── Entry Point ──────────────────────────────────────

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    printBanner(args);

    // F-346: surface keychain reachability as one log line at boot so
    // operators have fast feedback. If unreachable, they need to set
    // provider keys via env / .env rather than chasing HTTP 401 mid-run.
    try {
        const probe = await probeKeychainReachable();
        if (probe.reachable) {
            console.log('  Keychain:    ✓ reachable (keys from OS keychain available alongside env)');
        } else {
            console.log(`  Keychain:    ✗ unreachable — keys must come from env or .env`);
            if (probe.error !== null) {
                console.log(`     reason: ${probe.error.slice(0, 200)}`);
            }
        }
        console.log('');
    } catch {
        // never fatal — probe is diagnostic only
    }

    if (args.dryRun) {
        printDryRun(args);
        process.exitCode = 0;
        return;
    }

    let handles: Awaited<ReturnType<typeof bootstrapHeadless>> | null = null;

    try {
        // Boot
        handles = await bootstrapHeadless(args.projectsDir);

        // Create OR resume project
        let projectId: string;
        if (args.resume !== null) {
            // ── Resume path ───────────────────────────────────────
            console.log(`Resuming project ${args.resume}...`);
            const existing = await getOne<{
                id: string;
                name: string;
                phase: string;
                status: string;
                repo_path: string | null;
            }>(
                `SELECT id, name, phase, status, repo_path FROM projects WHERE id = $1`,
                [args.resume],
            );
            if (existing === null) {
                throw new Error(`--resume: project not found: ${args.resume}`);
            }
            // P1-09 smoke escape hatch: --close-first + --add-requirement
            // explicitly want a terminal project so they can closeProject +
            // reopenProject + addRequirement. Skip the terminal-status guard
            // in that combo; reopenProject handles cancelled/archived/completed.
            const isSmokeReopen = args.closeFirst && args.addRequirement !== null;
            if (!isSmokeReopen && (existing.status === 'completed' || existing.status === 'cancelled')) {
                throw new Error(
                    `--resume: project is ${existing.status} (cannot resume terminal status): ${args.resume}`
                );
            }
            if (existing.repo_path === null || !fs.existsSync(existing.repo_path)) {
                throw new Error(
                    `--resume: workspace missing on disk: ${existing.repo_path ?? '(null)'}`
                );
            }
            console.log('');
            console.log('═══════════════════════════════════════');
            console.log(`  Resuming project ${existing.name}`);
            console.log(`  Project ID:   ${existing.id}`);
            console.log(`  Current phase: ${existing.phase}`);
            console.log(`  Status:       ${existing.status}`);
            console.log(`  Repo:         ${existing.repo_path}`);
            console.log('═══════════════════════════════════════');
            console.log('');
            // P1-09 smoke harness — drives the operator's /add-requirement
            // chat command from CLI. With --close-first the project is first
            // forced terminal + reopened so iteration_index bumps to ≥ 1 and
            // the new task gets stamped task_type='revision' by
            // Sensei.stampRevisionMetadata. The terminal cycle (close +
            // reopen) handles any non-terminal AND already-terminal
            // (completed/cancelled/archived) state, so we skip the regular
            // sensei.resumeProject call (which rejects terminal states).
            if (isSmokeReopen) {
                console.log('  P1-09: --close-first → forcing project terminal');
                await handles.sensei.closeProject(existing.id);
                console.log('  P1-09: reopening project (iteration → +1)');
                await handles.sensei.reopenProject(existing.id);
            } else {
                await handles.sensei.resumeProject(existing.id);
            }
            projectId = existing.id;

            if (args.addRequirement !== null) {
                console.log(`  P1-09: addRequirement: "${args.addRequirement.slice(0, 80)}${args.addRequirement.length > 80 ? '…' : ''}"`);
                const addResult = await handles.sensei.addRequirement(existing.id, args.addRequirement);
                if (!addResult.ok) {
                    throw new Error(`--add-requirement failed: ${addResult.error}`);
                }
                console.log(`  P1-09: addRequirement accepted — ${addResult.newTaskCount} new task(s) for phase=${addResult.affectedPhase}`);
            }
        } else {
            console.log('Creating project...');
            projectId = await handles.sensei.startProject(
                args.name,
                args.description,
                buildStartOptions(args),
            );
        }

        // Restrict the dispatch sweep to this project so we never pick up
        // orphan tasks from older `active` projects left in the database.
        handles.sensei.setFocusProject(projectId);

        // Wire default GitHub owner/repo from env so Aegis can push/PR.
        const ghOwner = process.env['GITHUB_DEFAULT_OWNER'];
        const ghRepo = process.env['GITHUB_DEFAULT_REPO'];
        if (ghOwner !== undefined && ghOwner !== '' && ghRepo !== undefined && ghRepo !== '') {
            await query(
                'UPDATE projects SET github_owner = $1, github_repo = $2 WHERE id = $3',
                [ghOwner, ghRepo, projectId]
            );
            console.log(`  GitHub:     ${ghOwner}/${ghRepo}`);
        }

        console.log(`  Project ID: ${projectId}`);
        console.log('');

        // Wait for completion
        console.log('Running pipeline...');
        const result = await waitForCompletion(
            projectId,
            handles.eventBus,
            handles.sensei,
            args
        );

        // Report
        console.log('');
        console.log('═══════════════════════════════════════');
        console.log(`  Result:     ${result.success ? '✅ SUCCESS' : '❌ INCOMPLETE'}`);
        console.log(`  Phase:      ${result.phase}`);
        console.log(`  Tasks:      ${result.tasksCompleted} completed, ${result.tasksFailed} failed`);
        console.log(`  Cost:       $${result.totalCostUsd.toFixed(4)}${result.killedByBudget ? ' (BUDGET KILLED)' : ''}`);
        console.log(`  Duration:   ${(result.durationMs / 1000).toFixed(1)}s`);
        if (result.repoPath !== null) {
            console.log(`  Repo:       ${result.repoPath}`);
        }
        if (result.error !== null) {
            console.log(`  Error:      ${result.error}`);
        }
        writeRunReport(result, args.name, args.description);
        console.log('═══════════════════════════════════════');
        console.log('');

        process.exitCode = result.success ? 0 : 1;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'Headless runner failed');
        console.error(`Fatal: ${msg}`);
        process.exitCode = 2;
    } finally {
        // Graceful shutdown
        if (handles !== null) {
            log.info('Shutting down...');
            try {
                handles.stopStallWatchdog();
                await handles.sensei.stop();
                await handles.agentRegistry.shutdownAll();
            } catch { /* best effort */ }
        }
        await closePool();
    }
}

// Only invoke CLI when executed as a script, not when imported as a module.
if (require.main === module) {
    main();
}
