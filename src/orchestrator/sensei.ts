/**
 * KageOps Sensei — Main Orchestrator
 *
 * The brain of KageOps. Decomposes ideas into tasks, routes them to agents,
 * manages phase gates, handles errors with tiered retry, and monitors everything.
 */

import { query, getOne, getMany } from '../db/client';
import { taskCheckpointsEnabled } from '../db/task-checkpoint-repo';
import { EventBus, EventPayload } from './event-bus';
import { TaskDecomposer, Phase, DecomposerConfig } from './task-decomposer';
import { TaskRouter } from './task-router';
import { PhaseGateManager, TrustLevel } from './phase-gates';
import { BuildVerificationGate, BuildStepName } from './build-verification-gate';
import { AcceptanceGate } from './acceptance-gate';
import { resolveRetryBudget, RETRY_ENV } from './retry-budget';
import { SpecialityMatrix } from './speciality-matrix';
import { DependencyResolver } from './dependency-resolver';
import { CommsSender } from '../comms/comms-sender';
import { WorkspaceManager } from '../workspace/workspace-manager';
import { CostTracker, BudgetExceededError } from './cost-tracker';
import { BranchManager } from '../workspace/branch-manager';
import { TaskPool } from './task-pool';
import { AgentRegistry } from '../agents/agent-registry';
import { isCredentialError } from '../agents/retry-policy';
import { isGitDisabled } from '../shared/git-config';
import { isHostingDisabled, HOSTING_DISABLED_MESSAGE } from '../shared/hosting-mode';
import { reflectOnFailure } from './reflector';
import { searchHelp, formatHelpContext } from '../learning/help-search';
import { createLogger } from '../shared/logger';
import {
    senseiChatRepository,
    projectIdFromChannelId,
    type SenseiChatRepository,
    type PersistedSenseiMessage,
} from './sensei-chat-repository';
import { type Plan, type PlanGate, openPlanGate } from '../shared/plan-gate';
import { createRefusal } from '../shared/refusal';
import { TierLimitError } from '../shared/tier-limit-error';
import { type SetupCopilotGate, noopSetupCopilotGate } from './setup-copilot-gate';

const log = createLogger('Sensei');

// ── Types ────────────────────────────────────────────

export interface ProjectStatus {
    readonly id: string;
    readonly name: string;
    readonly phase: Phase;
    readonly status: string;
    readonly trustLevel: TrustLevel;
    readonly taskCounts: {
        readonly total: number;
        readonly pending: number;
        readonly assigned: number;
        readonly completed: number;
        readonly failed: number;
    };
    /**
     * P1-05b: how many times this project has been reopened. 0 = never
     * reopened (still on the original build). 1+ = post-reopen
     * iterations. Surfaced so the project card can render a small
     * "iteration N" badge when N > 0.
     *
     * Lives at the project-status layer (not the iterations table) so
     * the project-list IPC stays a single round-trip — no JOIN onto
     * iterations for the hot path.
     */
    readonly reopenCount: number;
    /**
     * P1-05b: ISO timestamp of the most recent reopen, or `null` when
     * the project has never been reopened. Used by the iteration
     * history side-panel header + future "recently iterated" sort
     * orders.
     */
    readonly lastReopenedAt: string | null;
}

export interface ChatMessage {
    readonly role: 'user' | 'assistant';
    readonly content: string;
}

/**
 * Optional metadata captured by the New Project onboarding form.
 * Anything missing falls back to the legacy defaults (full 6-phase
 * lifecycle, low trust, no extra context).
 */
/**
 * Pillar 2.2 PR-H — surfaced by Sensei.startProject when the operator
 * tries to create a project whose name (case-insensitive) is already in
 * use AND the existing project is NOT in the F-350 zombie state
 * (status=active/paused with 0 tasks in current phase, which gets
 * silently recovered). Carries the existing project id + its status so
 * the IPC handler can offer the operator a "Open existing" CTA later.
 */
export class DuplicateProjectError extends Error {
    public readonly name = 'DuplicateProjectError';
    constructor(
        public readonly projectName: string,
        public readonly existingId: string,
        public readonly existingStatus: string,
    ) {
        super(
            `A project named "${projectName}" already exists (status: ${existingStatus}). ` +
            `Pick a unique name, or open the existing project from Mission Control.`
        );
    }
    static is(err: unknown): err is DuplicateProjectError {
        return err instanceof Error && err.name === 'DuplicateProjectError';
    }
}

export interface StartProjectOptions {
    readonly trustLevel?: TrustLevel;
    /** Ordered list of phases to run. Sensei skips any phase not in
     *  this list — useful for "I just want a landing page, skip the
     *  discovery / poc / business viability dance".              */
    readonly enabledPhases?: readonly Phase[];
    /** Free-text project type label (landing-page, internal-tool,
     *  full-saas, mobile, custom). Used as additional context for
     *  the decomposer + agent system prompts.                    */
    readonly projectType?: string;
    /** Free-text tech stack hint (e.g. "Vanilla HTML/CSS/JS",
     *  "Next.js + Tailwind", "Astro + Cloudflare Pages").       */
    readonly techStack?: string;
    /** Success criteria — what does shipping success look like.   */
    readonly goal?: string;
    /** Hard budget cap in USD. Stored on projects.budget_usd which
     *  the live cost poller and budget-kill watch.                */
    readonly budgetUsd?: number;
    /**
     * Pillar 2.2 PR-E — operator-picked bundle from the New-Project
     * modal's Project Type dropdown. Accepts the bare name
     * (`"nextjs-saas"`) or the full key (`"stack::nextjs-saas"`).
     * When set + the bundle resolves, skips Scout's keyword matcher
     * and persists this directly to projects.selected_bundle.
     * Absent / empty → matcher runs.
     */
    readonly selectedBundle?: string;
    /**
     * Operator-picked per-phase task-type allowlist (issue #165).
     * Persisted in `projects.phase_task_selections` JSONB. When set,
     * TaskDecomposer constrains the system prompt + post-parse filter
     * to ONLY emit task types in the allowlist for each listed phase.
     * Absent or `null` = legacy LLM-picks-freely behaviour.
     */
    readonly phaseTaskSelections?: Readonly<Record<string, readonly string[]>>;
}

const ALL_PHASES: readonly Phase[] = [
    'discovery',
    'poc',
    'business-viability',
    'design-planning',
    'development',
    'launch-growth',
];

/**
 * Sanitise the enabled-phases input. Falls back to the full
 * lifecycle when the caller didn't pick anything; preserves
 * canonical phase order regardless of what the UI sent in.
 */
function sanitiseEnabledPhases(
    raw: readonly Phase[] | undefined,
): readonly Phase[] {
    if (raw === undefined || raw.length === 0) return ALL_PHASES;
    const allowed = new Set<string>(ALL_PHASES);
    const set = new Set<string>(raw.filter((p) => allowed.has(p)));
    if (set.size === 0) return ALL_PHASES;
    return ALL_PHASES.filter((p) => set.has(p));
}

/**
 * Prepend a structured context block to the user's prompt so the
 * decomposer + agent system prompts read project metadata as text
 * instead of having to be wired through a separate channel.
 */
function buildEnrichedDescription(
    description: string,
    ctx: {
        readonly projectType?: string;
        readonly techStack?: string;
        readonly goal?: string;
        readonly enabledPhases: readonly Phase[];
        readonly trustLevel: TrustLevel;
        readonly budgetUsd?: number;
    },
): string {
    const lines: string[] = [];
    if (ctx.projectType !== undefined && ctx.projectType !== '') {
        lines.push(`- Project type: ${ctx.projectType}`);
    }
    if (ctx.techStack !== undefined && ctx.techStack !== '') {
        lines.push(`- Tech stack: ${ctx.techStack}`);
    }
    if (ctx.goal !== undefined && ctx.goal !== '') {
        lines.push(`- Success criteria: ${ctx.goal}`);
    }
    lines.push(`- Phases enabled: ${ctx.enabledPhases.join(', ')}`);
    lines.push(`- Trust level: ${ctx.trustLevel}`);
    if (ctx.budgetUsd !== undefined) {
        lines.push(`- Budget cap: $${ctx.budgetUsd.toFixed(2)}`);
    }
    if (lines.length === 0) return description;
    return `[Context]\n${lines.join('\n')}\n\n[Brief]\n${description}`;
}

export interface SenseiConfig {
    readonly sendPrompt: (systemPrompt: string, userPrompt: string) => Promise<string>;
    readonly sendConversation?: (
        systemPrompt: string,
        messages: readonly ChatMessage[]
    ) => Promise<string>;
    readonly projectsDir?: string;
    readonly commsSender?: CommsSender;
    readonly workspaceManager?: WorkspaceManager;
    readonly costTracker?: CostTracker;
    readonly branchManager?: BranchManager;
    readonly taskPool?: TaskPool;
    readonly agentRegistry?: AgentRegistry;
    /**
     * If set, the dispatch sweep only considers this project. Headless runs
     * use this to avoid picking up orphan tasks from older `active` projects
     * that were left in the database from prior interrupted sessions.
     */
    readonly focusProjectId?: string;
    /**
     * F-314 — synchronous accessor for the user's current plan. Sensei calls
     * this at every gate (project create, APO start, connector enable) and
     * throws `TierLimitError` when the plan is too low. Optional — when
     * omitted, Sensei behaves as if every plan unlocks every feature
     * (dev / headless-trust convention). Production wiring lives in
     * `src/main/plan-resolver.ts` — call `await resolveCurrentPlan()` at
     * boot, then pass `getCurrentPlan` here.
     */
    readonly resolvePlan?: () => Plan;
    /**
     * COMMERCIAL tier gate (kageops-core split seam). Optional — when omitted
     * the open default ({@link openPlanGate}) grants every feature, so the open
     * engine self-hosts with no tiering. The commercial layer injects
     * `tierPlanGate` (orchestrator-bootstrap) for real paid-tier enforcement.
     */
    readonly planGate?: PlanGate;
    /**
     * Commercial setup-copilot credential gate. Unset in the open build → Sensei
     * uses `noopSetupCopilotGate` (never raises). Injected at orchestrator-bootstrap.
     */
    readonly setupCopilotGate?: SetupCopilotGate;
    /**
     * Model-routing snapshot used to ground Sensei's chat replies in reality.
     * Without this, Sensei hallucinates models when asked "what are the
     * Autonauts using?" — it has no way to know the active preset because
     * the resolver lives in the main process. Implementations MUST return a
     * sync, current snapshot (orchestrator-bootstrap calls loadAgentConfig
     * + getActivePresetName on every invocation so preset switches reflect
     * immediately without an Electron restart).
     */
    readonly getAgentRouting?: () => AgentRoutingSnapshot;

    /**
     * Optional persistent chat history backend (PR B of F-302 V1). When the
     * channelId of a chat turn is `project:<uuid>`, Sensei reads + writes to
     * this repository so two operators on the same project see one shared
     * thread and history survives Electron restarts. Defaults to the Postgres
     * implementation in `sensei-chat-repository.ts`. Tests inject a fake.
     */
    readonly chatRepository?: SenseiChatRepository;
}

/**
 * Optional caller-supplied attribution for a chat turn. The renderer can
 * pass these so persisted messages and the system prompt show
 * "Alice (reviewer): start phase 3" instead of an anonymous "user".
 *
 * All fields are optional — when omitted, Sensei falls back to the legacy
 * single-tenant behaviour (in-memory history, anonymous "user" rows).
 */
export interface ChatTurnContext {
    readonly authorUserId?: string | null;
    readonly authorName?: string;
    readonly authorRole?: string | null;
}

export interface AgentRoutingSnapshot {
    /** Active preset id, e.g. "codex-cli" / "claude-cli-premium" / null for default. */
    readonly preset: string | null;
    /** Per-agent model configuration; ordered to match the chat-prompt agent list. */
    readonly agents: ReadonlyArray<{
        readonly name: string;
        readonly model: string;
        readonly provider: string;
    }>;
}

// ── Constants ────────────────────────────────────────

const MAX_TASK_RETRIES = 3;
const MAX_REVIEW_ROUNDS = 2;
const MAX_CONVERSATION_HISTORY = 40; // Keep last 40 messages (20 turns) per character

// ── F-148 V2: free-form prose detection ──────────────
//
// Catches the failure mode where the operator types prose like
// "add a contact form" without the slash command. Before this nudge,
// the message fell through to the LLM, which is supposed to point the
// operator at `/add-requirement` (CAPABILITY HONESTY RULE / #149) but
// in practice was inconsistent — sometimes Sensei narrated dispatch
// without invoking the IPC ("hallucinated dispatch" — exactly the
// #155 / v0.1.38 bug). A deterministic regex catch is cheaper, faster,
// and impossible to hallucinate around.
//
// Heuristics — ALL must hold for a positive match:
//   - Trimmed message is between 8 and 250 characters.
//   - Starts with an imperative verb from REQUIREMENT_VERBS.
//   - Is NOT a question (no leading 'why/what/how/where/is/can/...').
//   - Does NOT end with '?'.
//   - Does NOT already contain '/add-requirement' (we let the slash
//     parser handle those).
//
// Bypass: set KAGEOPS_DISABLE_F148_PROSE_NUDGE=1 (escape hatch for
// integrations that send instructions through chat — e.g. test rigs
// driving Sensei via the LLM path on purpose).

const REQUIREMENT_VERBS = [
    'add', 'implement', 'build', 'create', 'make', 'include',
    'support', 'fix', 'remove', 'update', 'change', 'replace',
    'enable', 'disable', 'rename', 'refactor', 'integrate',
    'wire', 'hook', 'plug',
] as const;

const QUESTION_LEADERS = [
    'why', 'what', 'how', 'where', 'when', 'who', 'which',
    'is', 'are', 'can', 'could', 'should', 'would', 'do', 'does', 'did',
];

/**
 * F-148 V2 — heuristic: does this chat message read like a prose
 * "please add X to my project" requirement that the operator should
 * have routed via `/add-requirement`?
 *
 * Pure function so it can be tested in isolation without a Sensei
 * instance. Returns false when the operator opted out via env.
 */
export function looksLikeRequirementProse(message: string): boolean {
    if (process.env.KAGEOPS_DISABLE_F148_PROSE_NUDGE === '1') return false;
    const trimmed = message.trim();
    if (trimmed.length < 8 || trimmed.length > 250) return false;
    if (trimmed.endsWith('?')) return false;
    // The slash parser handles these — never double-fire.
    if (/\/add[-_ ]?requirement/iu.test(trimmed)) return false;

    // Take the first whitespace-separated token, strip punctuation,
    // lowercase. Mentions like '@Herald:' are stripped by the caller.
    const firstWord = trimmed
        .replace(/^@[A-Za-z][\w-]*:\s*/, '')
        .split(/\s+/, 1)[0]
        ?.toLowerCase()
        .replace(/[^a-z]/gu, '');
    if (firstWord === undefined || firstWord.length === 0) return false;

    if (QUESTION_LEADERS.includes(firstWord)) return false;
    return (REQUIREMENT_VERBS as readonly string[]).includes(firstWord);
}

// ── Sensei ───────────────────────────────────────────

export class Sensei {
    private readonly config: SenseiConfig;
    private readonly eventBus: EventBus;
    private readonly decomposer: TaskDecomposer;
    private readonly router: TaskRouter;
    private readonly gateManager: PhaseGateManager;
    private readonly matrix: SpecialityMatrix;
    private readonly dependencyResolver: DependencyResolver;
    private readonly commsSender: CommsSender | null;
    private readonly workspaceManager: WorkspaceManager | null;
    private readonly costTracker: CostTracker | null;
    private readonly branchManager: BranchManager | null;
    private readonly taskPool: TaskPool;
    private readonly conversationHistories: Map<string, ChatMessage[]> = new Map();
    private focusProjectId: string | null;
    private running = false;
    // Commercial setup-copilot credential gate (no-op in the open build).
    private readonly setupCopilotGate: SetupCopilotGate;
    // Per-project serializer: coalesces concurrent phase-gate checks so that
    // simultaneous task.completed events can't each race-advance the phase.
    private readonly phaseGateLocks: Map<string, Promise<void>> = new Map();
    // Best-known acceptance violation count seen so far per project.
    // Used by maybeSnapshotBest() to decide whether the latest retry
    // improved on the prior best — when it did, snap the workspace
    // git tag `agent/forge/best-attempt` to HEAD. On retry-cap
    // exhaustion the caller can checkout that tag instead of
    // returning the last (potentially regressed) attempt.
    private readonly bestAcceptanceViolations: Map<string, number> = new Map();

    constructor(config: SenseiConfig, eventBus: EventBus) {
        this.config = config;
        this.eventBus = eventBus;
        this.setupCopilotGate = config.setupCopilotGate ?? noopSetupCopilotGate;
        this.matrix = new SpecialityMatrix();
        this.decomposer = new TaskDecomposer(
            {
                sendPrompt: config.sendPrompt,
                // BPF-30 — let the decomposer drop dev tasks that re-implement
                // features the project's selected bundle already ships.
                resolveShippedFeatures: (projectId) => this.resolveShippedFeaturesForProject(projectId),
            },
            eventBus
        );
        this.router = new TaskRouter(this.matrix, eventBus, config.agentRegistry);
        this.gateManager = new PhaseGateManager(
            eventBus,
            new BuildVerificationGate(eventBus),
            new AcceptanceGate(eventBus)
        );
        this.dependencyResolver = new DependencyResolver();
        this.commsSender = config.commsSender ?? null;
        this.workspaceManager = config.workspaceManager ?? null;
        this.costTracker = config.costTracker ?? null;
        this.branchManager = config.branchManager ?? null;
        this.taskPool = config.taskPool ?? new TaskPool();
        this.focusProjectId = config.focusProjectId ?? null;
    }

    /**
     * Restrict the dispatch sweep to a single project. Useful for headless runs
     * that must not touch leftover `active` projects from prior sessions.
     * Pass null to clear the focus and resume sweeping all active projects.
     */
    setFocusProject(projectId: string | null): void {
        this.focusProjectId = projectId;
    }

    /**
     * Start Sensei — subscribe to all events and begin orchestrating.
     */
    /** Periodic dispatch sweep interval handle. */
    private dispatchSweepTimer: ReturnType<typeof setInterval> | null = null;

    /** How often (ms) to sweep for stuck pending tasks. */
    private static readonly DISPATCH_SWEEP_INTERVAL_MS = 15_000;

    async start(): Promise<void> {
        if (this.running) {
            return;
        }

        await this.eventBus.connect();

        // Reset stale in-flight tasks on boot. If we're starting now, the
        // previous orchestrator process is gone — any tasks still in
        // `assigned` or `in-progress` belong to dead agents. Without
        // this, the UI's busy-agent overlay (sourced from tasks status)
        // shows phantom-active agents indefinitely after a crash, and
        // newly dispatched work waits behind tasks that will never
        // complete. Reset → 'pending' so the dispatch sweep picks them
        // up cleanly.
        await this.resetStaleTasks();

        this.eventBus.subscribeAll((event) => this.handleEvent(event));

        // Start comms sender if configured
        if (this.commsSender !== null) {
            this.commsSender.start();
        }

        this.running = true;

        // Periodic dispatch sweep — catches tasks whose events got lost
        this.dispatchSweepTimer = setInterval(() => {
            void this.sweepPendingTasks();
        }, Sensei.DISPATCH_SWEEP_INTERVAL_MS);

        log.info('Orchestrator started. Listening for events...');
    }

    /**
     * Reset tasks that were in-flight when the previous orchestrator
     * process died. Returns the count of tasks reset (for telemetry).
     *
     * Scope: any task whose `status` is `assigned` or `in-progress` and
     * whose `project_id` corresponds to a project that's still `active`
     * (we don't reanimate tasks for cancelled / completed / archived
     * projects — they should stay where they are).
     *
     * Side-effects: also nulls `branch_name` so the dispatch sweep
     * doesn't try to resume on a defunct branch from the dead run.
     */
    private async resetStaleTasks(): Promise<number> {
        try {
            const result = await query<{ id: string; assigned_agent: string | null; title: string | null }>(
                `UPDATE tasks
                   SET status = 'pending',
                       branch_name = NULL,
                       started_at = NULL
                 WHERE status IN ('assigned', 'in-progress')
                   AND project_id IN (
                       SELECT id FROM projects
                        WHERE status NOT IN ('completed', 'cancelled', 'archived')
                   )
                 RETURNING id, assigned_agent, title`,
                [],
            );
            const count = result.rows.length;
            if (count > 0) {
                log.warn(
                    { count, sample: result.rows.slice(0, 5).map((r) => `${r.assigned_agent ?? '?'}: ${r.title ?? '?'}`) },
                    'Reset stale in-flight tasks from previous orchestrator run',
                );
            }
            return count;
        } catch (err) {
            // Boot must succeed even if the reset fails — log and continue.
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'Stale-task reset failed (continuing boot)',
            );
            return 0;
        }
    }

    /**
     * Stop Sensei gracefully.
     * Drains the task pool before disconnecting so in-flight dispatches finish.
     */
    async stop(): Promise<void> {
        this.running = false;

        // Clear the dispatch sweep timer
        if (this.dispatchSweepTimer !== null) {
            clearInterval(this.dispatchSweepTimer);
            this.dispatchSweepTimer = null;
        }

        // Wait for all in-flight task dispatches to complete
        await this.taskPool.drain();

        // Stop comms sender
        if (this.commsSender !== null) {
            this.commsSender.stop();
        }

        await this.eventBus.disconnect();
        log.info('Orchestrator stopped.');
    }

    /**
     * Start a new project — creates it in Postgres and kicks off the
     * first enabled phase. Optional metadata (type, stack, goal,
     * enabled_phases, budget) is captured up-front so agents don't
     * have to guess and revise. Anything not provided falls back to
     * the legacy behaviour: full 6-phase lifecycle, low trust.
     */
    async startProject(
        name: string,
        description: string,
        trustLevelOrOpts: TrustLevel | StartProjectOptions = 'low',
        // Back-compat third arg when the caller passes a trust string.
    ): Promise<string> {
        // ── F-314 tier gate — `unlimited_projects` feature ──────────────
        // Free plan: max 1 active project. Above that, throw TierLimitError
        // so the IPC layer can surface a structured "Upgrade" CTA
        // instead of a generic toast. resolvePlan is optional — when not
        // wired (dev / headless-trust mode), every plan is treated as
        // permissive. Production callers (orchestrator-bootstrap) wire it
        // to plan-resolver.getCurrentPlan().
        if (this.config.resolvePlan !== undefined) {
            const plan = this.config.resolvePlan();
            const planGate = this.config.planGate ?? openPlanGate;
            if (!planGate.canUse('unlimited_projects', plan)) {
                const activeRow = await getOne<{ count: string }>(
                    `SELECT COUNT(*)::text AS count FROM projects
                     WHERE status IN ('active', 'paused', 'awaiting-approval', 'awaiting-input')`,
                    [],
                );
                const activeCount = activeRow !== null ? parseInt(activeRow.count, 10) : 0;
                if (Number.isFinite(activeCount) && activeCount >= 1) {
                    throw new TierLimitError(
                        plan,
                        'unlimited_projects',
                        'team',
                        `Your plan is limited to 1 active project (you have ${activeCount}). ` +
                        `Upgrade to Team ($39/mo) for unlimited projects, or archive an existing project first.`,
                    );
                }
            }
        }

        const opts: StartProjectOptions = typeof trustLevelOrOpts === 'string'
            ? { trustLevel: trustLevelOrOpts }
            : trustLevelOrOpts;
        const trustLevel: TrustLevel = opts.trustLevel ?? 'low';
        const enabledPhases = sanitiseEnabledPhases(opts.enabledPhases);
        const startingPhase = enabledPhases[0];
        const projectSlug = name
            .normalize('NFKD')                                 // decompose accents (é → e + combining mark)
            .replace(/[‐-―−]/g, '-')            // Unicode dashes → ASCII hyphen (hyphen, non-breaking, figure, en, em, horizontal bar, minus)
            .replace(/[̀-ͯ]/g, '')                   // strip combining marks left over from NFKD
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')                     // any remaining non-slug char → dash
            .replace(/-+/g, '-')                               // collapse runs
            .replace(/^-|-$/g, '')                             // trim ends
            .slice(0, 80);                                     // max 80 chars

        // ── Duplicate guard ─────────────────────────────────────────────────
        // Pillar 2.2 PR-H — Surface duplicates instead of silently returning
        // the existing ID. Operator's "Create not doing anything" symptom
        // (smoke 2026-05-30, 3 attempts):
        //   - they typed an existing project's name (case-insensitive)
        //   - this guard hit, returned existing id with error=null
        //   - renderer treated it as success → hideModal + refreshAll
        //   - no INSERT (matches PGlite data-dir mtime evidence) → no new task
        //   - operator sees nothing happen because the existing project was
        //     already visible (or not visible if filtered out)
        // F-350's zombie re-decompose path STILL silently returns — that's the
        // intentional recovery path for a mid-flight create that left the
        // project at status=active/paused with 0 tasks. Everything else now
        // throws DuplicateProjectError so the renderer can show a clear error.
        const existing = await query<{ id: string; status: string }>(
            `SELECT id, status FROM projects WHERE lower(name) = lower($1) LIMIT 1`,
            [name]
        );
        if (existing.rows.length > 0) {
            const { id: existingId, status } = existing.rows[0];

            // F-350 zombie check first — recover silently if applicable.
            try {
                const phaseRow = await getOne<{ phase: string; description: string | null }>(
                    `SELECT phase, description FROM projects WHERE id = $1`,
                    [existingId],
                );
                if (phaseRow !== null) {
                    const taskCount = await getOne<{ count: string }>(
                        `SELECT COUNT(*)::text AS count FROM tasks WHERE project_id = $1 AND phase = $2`,
                        [existingId, phaseRow.phase],
                    );
                    const n = parseInt(taskCount?.count ?? '0', 10);
                    if (n === 0 && (status === 'active' || status === 'paused')) {
                        log.info(
                            { existingId, phase: phaseRow.phase },
                            'F-350: existing project has 0 tasks in current phase — re-decomposing',
                        );
                        await this.kickPhase(
                            existingId,
                            name,
                            phaseRow.description ?? description,
                            phaseRow.phase as Phase,
                        );
                        return existingId;
                    }
                }
            } catch (err) {
                log.warn(
                    { existingId, err: err instanceof Error ? err.message : String(err) },
                    'F-350 re-decompose check failed — proceeding with duplicate-error path',
                );
            }

            // Not a zombie — operator is trying to create a fresh project with
            // an in-use name. Throw a typed error so the IPC layer can surface
            // it cleanly: "A project named X already exists."
            log.info({ existingId, name, status }, 'Duplicate project name — surfacing error to operator');
            throw new DuplicateProjectError(name, existingId, status);
        }
        // ───────────────────────────────────────────────────────────────────

        // Create real workspace if manager and projectsDir are configured.
        //
        // Resolution order (highest first):
        //   1. live `KAGEOPS_PROJECTS_DIR` env var — when the user saves a new
        //      path via Configuration → KAGEOPS_PROJECTS_DIR, the IPC handler
        //      writes ~/.kageops/.env AND updates process.env in the running
        //      main process. Reading the env var live here means the new
        //      value takes effect on the NEXT created project — no app
        //      restart required. Previously this used this.config.projectsDir
        //      which was captured at orchestrator-bootstrap time, so saved
        //      values were silently ignored until restart and every new
        //      project landed in the old default directory.
        //   2. this.config.projectsDir — value passed in at bootstrap (kept
        //      as the second tier so unit tests that inject a path via
        //      SenseiConfig still work).
        //   3. ~/.kageops/projects/ fallback (cross-platform default; F-382).
        // F-382: cross-platform default. The previous Windows-only literal
        // `C:\projects\playground\kageops\projects` broke Mac installs because
        // the C: drive doesn't exist there. Now derives from $HOME.
        const envProjectsDir = process.env['KAGEOPS_PROJECTS_DIR'];
        const baseDir =
            (envProjectsDir !== undefined && envProjectsDir !== ''
                ? envProjectsDir
                : undefined) ??
            this.config.projectsDir ??
            (() => {
                const os = require('os') as typeof import('os');
                const path = require('path') as typeof import('path');
                return path.join(os.homedir(), '.kageops', 'projects');
            })();
        let repoPath = `${baseDir}/${projectSlug}`;

        if (this.workspaceManager !== null) {
            try {
                repoPath = await this.workspaceManager.createProject(
                    baseDir,
                    projectSlug,
                    name,
                    description,
                    trustLevel
                );
                log.info({ repoPath }, 'Workspace created');
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.error({ err: msg }, 'Workspace creation failed — using bare directory');
                // Ensure the directory exists even without the golden template
                const nodePath = await import('path');
                const fs = await import('fs');
                const absPath = nodePath.default.isAbsolute(repoPath)
                    ? repoPath
                    : nodePath.default.join(process.cwd(), repoPath);
                fs.mkdirSync(absPath, { recursive: true });
                repoPath = absPath;
                // F-334: a bare directory isn't a git repo — agents that
                // try to `git add -A` here will fail with "fatal: not a
                // git repository". Auto-init so the workspace is usable.
                await this.workspaceManager.ensureGitInitialized(absPath);
            }
        }

        // #165 stage 2 — sanitise operator-picked task allowlist before
        // INSERT. Drop unknown phase keys + empty arrays. An empty map
        // collapses to null so the decomposer treats it as legacy.
        const phaseTaskSelectionsJson: string | null = (() => {
            const raw = opts.phaseTaskSelections;
            if (raw === undefined || raw === null) return null;
            const allowedPhases = new Set<string>(ALL_PHASES);
            const cleaned: Record<string, string[]> = {};
            for (const [phaseKey, taskTypes] of Object.entries(raw)) {
                if (!allowedPhases.has(phaseKey)) continue;
                if (!Array.isArray(taskTypes)) continue;
                const filtered = taskTypes.filter((t): t is string => typeof t === 'string' && t.length > 0);
                if (filtered.length === 0) continue;
                cleaned[phaseKey] = filtered;
            }
            return Object.keys(cleaned).length === 0 ? null : JSON.stringify(cleaned);
        })();

        // Create project record in Postgres
        const result = await query<{ id: string }>(
            `INSERT INTO projects (
                name, description, repo_path, phase, trust_level, status,
                project_type, enabled_phases, tech_stack, goal, budget_usd,
                phase_task_selections
             )
             VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11::jsonb)
             RETURNING id`,
            [
                name,
                description,
                repoPath,
                startingPhase,
                trustLevel,
                opts.projectType ?? null,
                enabledPhases,
                opts.techStack ?? null,
                opts.goal ?? null,
                typeof opts.budgetUsd === 'number' && opts.budgetUsd > 0 ? opts.budgetUsd : null,
                phaseTaskSelectionsJson,
            ]
        );

        const projectId = result.rows[0].id;
        log.info({ projectId, name, startingPhase, enabledPhases }, 'Project created');

        // P1-05a: record iteration 0 (original build). Schema-level
        // brick for the Pillar 1.2 iteration loop. No agent-side
        // behaviour change — Sensei is the sole writer in this PR.
        // Failure is non-fatal: a missing iterations table (legacy
        // PGlite from before migration 026) must NOT block project
        // creation. The build-summary report falls back to a
        // single-cycle render when no iteration rows exist.
        try {
            const { iterationRepository } = await import('../db/iteration-repo');
            await iterationRepository.recordOriginal(projectId);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg, projectId }, 'P1-05a: failed to record iteration 0 (non-fatal)');
        }

        // P1-12: deterministic bundle pick from the operator's brief.
        // ON BY DEFAULT since Pillar 2.2 ships (flag changed from opt-in
        // to opt-out 2026-05-30 — operator can roll back by setting
        // KAGEOPS_FEATURE_BUNDLES=false). Non-fatal — a bundle
        // misconfiguration or load failure must NOT block project
        // creation.
        if (process.env['KAGEOPS_FEATURE_BUNDLES'] !== 'false') {
            try {
                await this.assignBundleForProject(projectId, name, description, opts.selectedBundle);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn({ err: msg, projectId }, 'P1-12: bundle assignment failed (non-fatal)');
            }
        }

        // Decompose the first enabled phase. The description is enriched
        // with the onboarding metadata (type / stack / goal / phase plan)
        // so agents have it as direct context — no guessing, no costly
        // mid-run revisions. Subsequent phase advances are handled by
        // PhaseGateManager which honours enabled_phases and auto-skips
        // any phase not in the list.
        const enrichedDescription = buildEnrichedDescription(description, {
            projectType: opts.projectType,
            techStack: opts.techStack,
            goal: opts.goal,
            enabledPhases,
            trustLevel,
            budgetUsd: opts.budgetUsd,
        });
        await this.kickPhase(projectId, name, enrichedDescription, startingPhase);

        return projectId;
    }

    /**
     * P1-12: deterministic bundle matcher → persists `<kind>::<name>`
     * to `projects.selected_bundle` when a stack bundle's `match`
     * block fires against (name + description). NULL on no match —
     * Forge's inline path takes over (the existing rollback knob).
     *
     * Pillar 2.2 PR-E: `operatorPick` lets the New-Project modal
     * override the heuristic. When the operator explicitly picks a
     * bundle from the dropdown ("nextjs-saas"), we persist that
     * directly without running the matcher — operator agency beats
     * keyword matching. `undefined` / empty string → fall through to
     * the heuristic (the "(auto — let Scout pick)" picker value).
     *
     * Loader runs per call. The bundle set is tiny in Pillar 1.3 +
     * 2.x (single-digit count), so the I/O cost is negligible compared
     * to the project-creation cost. A future PR can cache the registry
     * on the Sensei instance if it ever becomes hot.
     */
    private async assignBundleForProject(
        projectId: string,
        name: string,
        description: string,
        operatorPick?: string
    ): Promise<void> {
        const { loadBundles } = await import('../bundles/bundle-loader');
        const { BundleRegistry } = await import('../bundles/bundle-registry');
        const { matchBundleForBrief, buildBundleKey } = await import('../bundles/bundle-matcher');

        const loadResult = await loadBundles();
        if (loadResult.errors.length > 0) {
            log.warn(
                { errors: loadResult.errors.map((e) => `${e.directory}: ${e.reason}`) },
                'P1-12: bundle load surfaced errors'
            );
        }
        const registry = new BundleRegistry(loadResult);
        if (registry.size() === 0) {
            log.debug({ projectId }, 'P1-12: no bundles loaded — leaving selected_bundle NULL');
            return;
        }

        // Pillar 2.2 PR-E — operator override path. The renderer sends
        // the bundle name (`"nextjs-saas"`); we accept either the bare
        // name or the full key (`"stack::nextjs-saas"`). Verify it
        // resolves before persisting so a typo doesn't corrupt the column.
        if (operatorPick !== undefined && operatorPick.trim().length > 0) {
            const pick = operatorPick.trim();
            const key = pick.includes('::') ? pick : `stack::${pick}`;
            const [kindStr, bundleName] = key.split('::');
            const bundle = registry.get(kindStr as 'stack' | 'capability' | 'deployer', bundleName);
            if (bundle !== undefined) {
                await query(
                    `UPDATE projects SET selected_bundle = $1 WHERE id = $2`,
                    [key, projectId]
                );
                log.info(
                    { projectId, selectedBundle: key, source: 'operator-pick' },
                    'P1-12: bundle persisted from operator pick (skipped matcher)'
                );
                return;
            }
            log.warn(
                { projectId, operatorPick: pick },
                'P1-12: operator-picked bundle not found in registry — falling through to matcher'
            );
        }

        const hit = matchBundleForBrief({
            text: `${name}\n${description}`,
            registry,
        });
        if (hit === null) {
            log.info({ projectId }, 'P1-12: no bundle matched brief — using inline scaffold path');
            return;
        }

        const key = buildBundleKey(hit.bundle);
        await query(
            `UPDATE projects SET selected_bundle = $1 WHERE id = $2`,
            [key, projectId]
        );
        log.info(
            {
                projectId,
                selectedBundle: key,
                score: hit.score,
                matchedPhrases: hit.matchedPhrases,
                matchedTags: hit.matchedTags,
                source: 'matcher',
            },
            'P1-12: bundle matched + persisted to projects.selected_bundle'
        );
    }

    /**
     * BPF-30 — return the shipped features declared by the project's selected
     * bundle, so the decomposer can drop dev tasks that re-implement them.
     * Returns [] when the project has no bundle, the bundle isn't found, or it
     * declares none. Never throws — a resolver failure must not break decompose.
     */
    private async resolveShippedFeaturesForProject(
        projectId: string,
    ): Promise<readonly import('../bundles/types').BundleShippedFeature[]> {
        try {
            const row = await getOne<{ selected_bundle: string | null }>(
                'SELECT selected_bundle FROM projects WHERE id = $1',
                [projectId],
            );
            const key = row?.selected_bundle ?? null;
            if (key === null || key.trim().length === 0) return [];

            const { loadBundles } = await import('../bundles/bundle-loader');
            const { BundleRegistry } = await import('../bundles/bundle-registry');
            const registry = new BundleRegistry(await loadBundles());
            if (registry.size() === 0) return [];

            const full = key.includes('::') ? key : `stack::${key}`;
            const [kindStr, bundleName] = full.split('::');
            const bundle = registry.get(kindStr as 'stack' | 'capability' | 'deployer', bundleName);
            return bundle?.manifest.shipped_features ?? [];
        } catch (err) {
            log.warn(
                { projectId, err: err instanceof Error ? err.message : String(err) },
                'BPF-30: resolveShippedFeatures failed — decomposer will not filter',
            );
            return [];
        }
    }

    /**
     * BPF-24: drop a task's resumable checkpoints so its next run re-executes
     * the AI fresh instead of replaying the (failure-producing) cached output.
     * Called on failure-retry and on reviving a failed/blocked task — never on
     * a healthy crash-resume, which legitimately wants the replay. Best-effort
     * + gated on the checkpoint flag; a DB error must never block re-dispatch.
     */
    private async clearTaskCheckpoints(taskIds: readonly string[]): Promise<void> {
        if (taskIds.length === 0 || !taskCheckpointsEnabled()) return;
        try {
            await query(
                `DELETE FROM task_checkpoints WHERE task_id = ANY($1::uuid[])`,
                [taskIds],
            );
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err), count: taskIds.length },
                'clearTaskCheckpoints failed (non-fatal)',
            );
        }
    }

    /**
     * P1-01e: per-task checkpoint state summary, logged once at resume
     * time. Read-only — used to give operators visibility into what's
     * about to be replayed via cache hits vs re-executed fresh. Query
     * failure is non-fatal: a missing `task_checkpoints` table (older
     * data dir without migration 025) must not block re-dispatch.
     */
    private async logResumeCheckpointSummary(taskIds: readonly string[]): Promise<void> {
        if (taskIds.length === 0) return;
        try {
            const rows = await getMany<{
                task_id: string;
                status: string;
                count: string;
            }>(
                `SELECT task_id, status, COUNT(*)::text AS count
                   FROM task_checkpoints
                  WHERE task_id = ANY($1::uuid[])
                  GROUP BY task_id, status`,
                [taskIds],
            );

            const byTask = new Map<string, { completed: number; inFlight: number; failed: number }>();
            for (const row of rows) {
                const slot = byTask.get(row.task_id) ?? { completed: 0, inFlight: 0, failed: 0 };
                const n = parseInt(row.count, 10);
                if (row.status === 'completed') slot.completed = n;
                else if (row.status === 'in-flight') slot.inFlight = n;
                else if (row.status === 'failed') slot.failed = n;
                byTask.set(row.task_id, slot);
            }

            for (const taskId of taskIds) {
                const slot = byTask.get(taskId);
                if (slot === undefined) {
                    log.info({ taskId }, 'Resume checkpoint summary: no prior ops (fresh execution)');
                } else {
                    log.info(
                        { taskId, completedOps: slot.completed, inFlightOps: slot.inFlight, failedOps: slot.failed },
                        `Resume checkpoint summary: ${slot.completed} cached hits, ${slot.inFlight} in-flight (will overwrite), ${slot.failed} failed (will retry)`,
                    );
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg }, 'P1-01e: resume checkpoint summary query failed — continuing without summary');
        }
    }

    /**
     * P1-06a: stamp newly-decomposed `/add-requirement` tasks with the
     * revision metadata Forge will need on dispatch (P1-06b reads it):
     *
     *   - `task_type='revision'` — well-known sentinel so the future
     *     Forge revision handler can branch on it (regular tasks keep
     *     whatever the decomposer assigned).
     *   - `iteration_id` — links the task to the current iteration
     *     cycle so the build-summary + history side-panel can group it.
     *   - `revision_instruction` — the operator's verbatim text from
     *     `/add-requirement <text>`, surfaced to Forge as the "modify
     *     in place to satisfy this" instruction without re-parsing the
     *     decomposer brief.
     *
     * Also backfills the iteration row's `requirement_text` if it was
     * null (set by `reopenProject` which doesn't see the prompt — only
     * the eventual /add-requirement call does).
     *
     * Best-effort — non-fatal failure logged by the caller. P1-06a
     * leaves `target_files` null; the decomposer-side workspace-tree
     * scan that populates it is a Pillar 1.2 follow-on (with the Forge
     * revision handler in P1-06b).
     */
    private async stampRevisionMetadata(
        projectId: string,
        taskIds: readonly string[],
        requirementText: string,
    ): Promise<void> {
        if (taskIds.length === 0) return;

        const { iterationRepository } = await import('../db/iteration-repo');
        const current = await iterationRepository.getCurrent(projectId);
        const iterationId = current?.id ?? null;
        // Only treat this as a revision when the operator is iterating
        // on a reopened project (index >= 1). The very first
        // /add-requirement on iteration 0 (mid-original-build) is a
        // legitimate "add to the plan in flight" — not a revision of
        // already-shipped work.
        const isRevision = (current?.iterationIndex ?? 0) >= 1;

        if (!isRevision) {
            log.info(
                { projectId, taskCount: taskIds.length, iterationIndex: current?.iterationIndex ?? 0 },
                'P1-06a: addRequirement on iteration 0 — keeping default task_type, no revision stamp',
            );
            return;
        }

        await query(
            `UPDATE tasks
                SET task_type = 'revision',
                    iteration_id = $2,
                    revision_instruction = $3
              WHERE id = ANY($1::uuid[])`,
            [taskIds as string[], iterationId, requirementText],
        );
        log.info(
            { projectId, taskCount: taskIds.length, iterationId, iterationIndex: current?.iterationIndex },
            'P1-06a: stamped revision metadata on new tasks',
        );

        // Backfill the iteration row's requirement_text if it was null
        // (reopenProject didn't know what the operator wanted yet).
        if (current !== null && current.requirementText === null) {
            await query(
                `UPDATE iterations
                    SET requirement_text = $2
                  WHERE id = $1 AND requirement_text IS NULL`,
                [current.id, requirementText],
            );
            log.debug({ iterationId: current.id }, 'P1-06a: backfilled iteration.requirement_text');
        }
    }

    /**
     * Decompose tasks for a single phase and route them.
     *
     * Shared tail of `startProject()` and `resumeProject()` — the only
     * point where new tasks enter the pipeline for a given phase. Any
     * change to the kick-off semantics (decompose then route) belongs
     * here so both entry points stay in lock-step.
     */
    private async kickPhase(
        projectId: string,
        name: string,
        description: string,
        phase: Phase,
    ): Promise<void> {
        await this.decomposer.decompose(projectId, name, description, phase);
        await this.router.routePendingTasks(projectId);
    }

    /**
     * Resume an in-flight or paused project at its current phase.
     *
     * Two distinct callers share this entry point:
     *
     *  1. **Headless re-attach** — the runner's --resume flag invokes
     *     this against an `active` project whose orchestrator process
     *     died mid-pipeline (zombie kill, build crash, reboot). We
     *     re-dispatch the current phase's tasks without redoing
     *     Discovery / re-decomposing what's already in the DB.
     *
     *  2. **Pause/resume from the UI** — the Command Center pauses a
     *     project (status='paused') and later resumes it. We flip
     *     status back to 'active' and re-route pending work.
     *
     * Behaviour matrix:
     *  - status='paused'    → flip to 'active', publish intercept.resume
     *                         for in-flight tasks, then re-route pending.
     *  - status='active'    → re-dispatch current phase's pending tasks;
     *                         decompose fresh ones if the phase is empty.
     *  - status='completed' → throw (terminal).
     *  - status='cancelled' → throw (terminal).
     *  - missing            → throw.
     */
    async resumeProject(projectId: string): Promise<void> {
        const project = await getOne<{
            id: string;
            name: string;
            description: string | null;
            phase: Phase;
            status: string;
            trust_level: TrustLevel;
            project_type: string | null;
            enabled_phases: readonly string[] | null;
            tech_stack: string | null;
            goal: string | null;
            budget_usd: string | null;
        }>(
            `SELECT id, name, description, phase, status, trust_level,
                    project_type, enabled_phases, tech_stack, goal, budget_usd
               FROM projects WHERE id = $1`,
            [projectId],
        );

        if (project === null) {
            throw new Error(`Cannot resume — project not found: ${projectId}`);
        }
        if (project.status === 'completed') {
            throw new Error(`Cannot resume — project already complete: ${projectId}`);
        }
        if (project.status === 'cancelled') {
            throw new Error(`Cannot resume — project was cancelled: ${projectId}`);
        }

        // ── Pause/resume path (UI) ─────────────────────────────────
        if (project.status === 'paused') {
            log.info({ projectId }, 'Project: resume (paused → active)');
            const updated = await query<{ id: string }>(
                `UPDATE projects
                 SET status = 'active',
                     paused_at = NULL,
                     updated_at = NOW()
                 WHERE id = $1 AND status = 'paused'
                 RETURNING id`,
                [projectId],
            );
            if (updated.rows.length === 0) return;

            const inflight = await getMany<{ id: string; assigned_agent: string | null }>(
                `SELECT id, assigned_agent FROM tasks
                 WHERE project_id = $1 AND status IN ('assigned', 'in-progress')`,
                [projectId],
            );
            for (const row of inflight) {
                if (row.assigned_agent === null) continue;
                await this.eventBus.publish('intercept.resume', {
                    taskId: row.id,
                    agent: row.assigned_agent,
                    data: { requestedBy: 'human', scope: 'project' },
                });
            }

            await this.eventBus.publish('project.resumed', {
                projectId,
                data: { projectId },
            });

            await this.router.routePendingTasks(projectId);
            return;
        }

        // ── Headless re-attach path (active project, dead orchestrator) ──
        const phase: Phase = project.phase;

        // P1-01e: include 'in-progress' alongside 'pending' / 'assigned'.
        // A task left at `in-progress` means the prior orchestrator
        // process died while the agent was mid-executeTask — the row
        // would otherwise sit forever, blocking phase completion. With
        // checkpoints (P1-01b/c/d) the agent's deterministic re-run on
        // re-dispatch hits cached ops for completed work and only
        // re-spends on the unfinished tail.
        // BPF-22: include 'blocked'. A task hits 'blocked' when retryTask
        // exhausts its tier-3 retries — and a blocked task that GATES the
        // phase (every other task depends on it) would otherwise leave the
        // re-attach path with only-blocked rows it never revives, deadlocking
        // the whole phase on resume.
        const pendingTasks = await getMany<{
            id: string;
            assigned_agent: string | null;
            status: string;
        }>(
            `SELECT id, assigned_agent, status
               FROM tasks
              WHERE project_id = $1
                AND phase = $2
                AND status IN ('pending', 'assigned', 'in-progress', 'blocked')`,
            [projectId, phase],
        );

        if (pendingTasks.length > 0) {
            log.info(
                { projectId, phase, taskCount: pendingTasks.length },
                'Resuming project — re-dispatching existing tasks',
            );

            // P1-01e: when task checkpoints are enabled (now on by
            // default), log per-task checkpoint state so operators can see
            // what's about to be replayed via cache hits vs re-executed
            // fresh. Best-effort — a query failure must never block
            // re-dispatch.
            if (taskCheckpointsEnabled()) {
                await this.logResumeCheckpointSummary(pendingTasks.map((t) => t.id));
            }

            // BPF-24: a 'blocked' task failed out (retryTask tier-3). Drop its
            // checkpoints so the revival re-runs fresh instead of replaying the
            // cached failure output. 'assigned'/'in-progress' are crash-resume
            // cases — keep their checkpoints so completed ops replay at ~0 token.
            await this.clearTaskCheckpoints(
                pendingTasks.filter((t) => t.status === 'blocked').map((t) => t.id),
            );

            // BPF-21: reclaim THEN route — do NOT bare-re-publish task.assigned.
            // The prior code re-published task.assigned for the stuck
            // assigned/in-progress rows WITHOUT clearing their claim, leaving
            // them 'in-progress'. With a dependency graph, the gated tasks then
            // waited on dependencies that never advanced (no root dispatched),
            // so a `--resume` could idle to the wall-clock timeout doing ZERO
            // work (proven in the 2026-06-22 OSS dogfood). Mirror
            // restartStalledProject's proven reset-then-route: reset every
            // non-terminal task in the phase to a clean 'pending' (drop the
            // claim + started_at), then let routePendingTasks dispatch the
            // roots (deps = already-'completed' tasks) and cascade. Completed
            // tasks are untouched, and checkpoints (P1-01) replay their ops at
            // ~0 tokens on the re-run.
            await query(
                `UPDATE tasks
                    SET status = 'pending',
                        retry_count = 0,
                        error_message = NULL,
                        assigned_agent = NULL,
                        started_at = NULL
                  WHERE project_id = $1
                    AND phase = $2
                    AND status IN ('assigned', 'in-progress', 'blocked')`,
                [projectId, phase],
            );
            await this.router.routePendingTasks(projectId);
            return;
        }

        // No pending work for this phase — decompose fresh tasks.
        const trustLevel: TrustLevel = project.trust_level;
        const enabledPhasesRaw = project.enabled_phases ?? undefined;
        const enabledPhases = sanitiseEnabledPhases(enabledPhasesRaw as readonly Phase[] | undefined);
        const description = project.description ?? '';
        const budgetUsd = project.budget_usd !== null ? parseFloat(project.budget_usd) : undefined;
        const enrichedDescription = buildEnrichedDescription(description, {
            projectType: project.project_type ?? undefined,
            techStack: project.tech_stack ?? undefined,
            goal: project.goal ?? undefined,
            enabledPhases,
            trustLevel,
            budgetUsd: Number.isFinite(budgetUsd) ? budgetUsd : undefined,
        });

        log.info(
            { projectId, phase, taskCount: 0 },
            'Resuming project — decomposing fresh tasks for current phase',
        );
        await this.kickPhase(projectId, project.name, enrichedDescription, phase);
    }

    /**
     * Central event handler — Sensei processes all events.
     */
    async handleEvent(event: EventPayload): Promise<void> {
        if (!this.running) {
            return;
        }

        try {
            switch (event.channel) {
                case 'task.completed':
                    await this.onTaskCompleted(event);
                    break;

                case 'task.failed':
                    await this.onTaskFailed(event);
                    break;

                case 'task.blocked':
                    await this.onTaskBlocked(event);
                    break;

                case 'review.passed':
                    await this.onReviewPassed(event);
                    break;

                case 'review.rejected':
                    await this.onReviewRejected(event);
                    break;

                case 'approval.granted':
                    await this.onApprovalGranted(event);
                    break;

                case 'approval.denied':
                    await this.onApprovalDenied(event);
                    break;

                case 'intercept.acknowledged': {
                    const data = event.data as Record<string, unknown>;
                    log.info(
                        { agent: event.agent, taskId: event.taskId, action: data.action },
                        'Intercept acknowledged',
                    );
                    break;
                }

                default:
                    // Log all other events for monitoring
                    break;
            }
        } catch (err) {
            log.error({ err, channel: event.channel }, 'Error handling event');
        }
    }

    /**
     * Get status for a single project.
     */
    async getProjectStatus(projectId: string): Promise<ProjectStatus | null> {
        const project = await getOne<{
            id: string;
            name: string;
            phase: string;
            status: string;
            trust_level: string;
            // P1-05b: surfaced so the project card can render the
            // iteration N badge without a second round-trip per row.
            // `COALESCE` handles pre-026 data dirs where the column
            // doesn't exist yet (defaults to 0).
            reopen_count: number | null;
            last_reopened_at: string | null;
        }>(
            `SELECT
                id, name, phase, status, trust_level,
                COALESCE(reopen_count, 0) AS reopen_count,
                last_reopened_at
             FROM projects WHERE id = $1`,
            [projectId]
        );

        if (project === null) {
            return null;
        }

        const counts = await getOne<{
            total: string;
            pending: string;
            assigned: string;
            completed: string;
            failed: string;
        }>(
            `SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                COUNT(*) FILTER (WHERE status = 'assigned') AS assigned,
                COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                COUNT(*) FILTER (WHERE status = 'failed') AS failed
             FROM tasks WHERE project_id = $1`,
            [projectId]
        );

        return {
            id: project.id,
            name: project.name,
            phase: project.phase as Phase,
            status: project.status,
            trustLevel: project.trust_level as TrustLevel,
            taskCounts: {
                total: parseInt(counts?.total ?? '0', 10),
                pending: parseInt(counts?.pending ?? '0', 10),
                assigned: parseInt(counts?.assigned ?? '0', 10),
                completed: parseInt(counts?.completed ?? '0', 10),
                failed: parseInt(counts?.failed ?? '0', 10),
            },
            reopenCount: project.reopen_count ?? 0,
            lastReopenedAt: project.last_reopened_at,
        };
    }

    /**
     * Get all active projects status (for Command Center overview).
     *
     * Filter semantics (B-402):
     *   - No args → default "active" view: hides `completed` and `archived`.
     *   - `{ includeArchived: true }` → default view, but `archived` is NOT
     *     excluded. Used by the Archived tab (B-404) and any caller that
     *     needs archived rows without naming them explicitly.
     *   - `{ include: [...] }` → exact whitelist (takes precedence over
     *     everything else).
     *   - `{ exclude: [...] }` → explicit blacklist (overrides the default
     *     and `includeArchived`).
     */
    async getAllProjectsStatus(
        filter?: {
            readonly include?: readonly string[];
            readonly exclude?: readonly string[];
            readonly includeArchived?: boolean;
        },
    ): Promise<readonly ProjectStatus[]> {
        let rows: readonly { id: string }[];
        if (filter?.include !== undefined && filter.include.length > 0) {
            rows = await getMany<{ id: string }>(
                `SELECT id FROM projects WHERE status = ANY($1::text[]) ORDER BY created_at DESC`,
                [filter.include as string[]],
            );
        } else {
            let exclude: readonly string[];
            if (filter?.exclude !== undefined) {
                exclude = filter.exclude;
            } else if (filter?.includeArchived === true) {
                // Default minus 'archived' — surfaces archived rows for B-404.
                exclude = ['completed'];
            } else {
                exclude = ['completed', 'archived'];
            }
            rows = await getMany<{ id: string }>(
                `SELECT id FROM projects WHERE status <> ALL($1::text[]) ORDER BY created_at DESC`,
                [exclude as string[]],
            );
        }

        const statuses: ProjectStatus[] = [];
        for (const p of rows) {
            const status = await this.getProjectStatus(p.id);
            if (status !== null) {
                statuses.push(status);
            }
        }

        return statuses;
    }

    /**
     * Get pending approval queue.
     */
    async getApprovalQueue(): Promise<readonly ProjectStatus[]> {
        const projects = await getMany<{ id: string }>(
            `SELECT id FROM projects WHERE status = 'awaiting-approval' ORDER BY updated_at ASC`
        );

        const statuses: ProjectStatus[] = [];
        for (const p of projects) {
            const status = await this.getProjectStatus(p.id);
            if (status !== null) {
                statuses.push(status);
            }
        }

        return statuses;
    }

    /**
     * Approve a project's phase gate.
     */
    async approveGate(projectId: string): Promise<void> {
        // BPF-1: the development phase has an exit-gate chain (build →
        // deploy-preview → acceptance → credential copilot). Manual approval must
        // run that chain rather than jumping straight to launch-growth — in the
        // GUI flow, approving Development early advanced the phase with zero gate
        // check, so the real `vercel deploy` and the slice-4 credential ledger
        // never fired (the launch-growth "deploy" became a doc-writing task).
        // Only the development phase is gated here; all others advance as before.
        // Lightweight phase read first so non-development approvals (and the
        // project-complete path) don't pay for a full checkGate / build verify.
        const phaseRow = await getOne<{ phase: string | null }>(
            'SELECT phase FROM projects WHERE id = $1',
            [projectId]
        );
        if (phaseRow?.phase === 'development') {
            const gateStatus = await this.gateManager.checkGate(projectId);
            const projectName = await this.getProjectName(projectId);
            // BPF-2 guard, but gated on GENUINELY pending work — NOT on
            // `allTasksComplete`, which is also false when the phase has zero
            // tasks (`allPhaseTasksComplete` returns `total > 0 && total === done`).
            // Deferring on the zero-task case trapped manual approval in an
            // infinite approve→defer loop (a dev phase that decomposed to 0
            // tasks could never be advanced). Only block when tasks are actually
            // pending/in-flight; otherwise fall through to the exit gate.
            const pendingRow = await getOne<{ n: string }>(
                `SELECT COUNT(*) AS n FROM tasks
                  WHERE project_id = $1 AND phase = 'development'
                    AND status NOT IN ('completed', 'failed')`,
                [projectId]
            );
            const pendingCount = pendingRow !== null ? parseInt(pendingRow.n, 10) : 0;
            if (pendingCount > 0) {
                // Real in-flight work — don't advance past it.
                await this.sendCommsNotification(
                    projectId,
                    `Not ready to advance: ${projectName}`,
                    `Development has ${pendingCount} task${pendingCount === 1 ? '' : 's'} still running for ` +
                    `"${projectName}". The build + deploy gate runs once they finish — approval will advance after that.`
                );
                await this.emitGateDeferred(
                    projectId,
                    'pending-tasks',
                    `${pendingCount} development task${pendingCount === 1 ? ' is' : 's are'} still running — the build & deploy gate runs once they finish, then Approve advances.`,
                );
                log.info({ projectId, pendingCount }, 'approveGate deferred — development tasks still in flight');
                return;
            }
            const decision = await this.resolveDevelopmentExitGate(projectId, gateStatus);
            if (decision === 'deferred') {
                // The exit gate scheduled a deploy-preview / remediation, or
                // raised the credential ledger. Don't advance — it re-drives the
                // gate on completion; the operator approves again once it clears.
                await this.sendCommsNotification(
                    projectId,
                    `Finishing development: ${projectName}`,
                    `Running the development exit gate (build, deploy preview, acceptance, and any ` +
                    `credentials Sensei needs) before advancing. You'll be asked to approve once it passes.`
                );
                log.info(
                    { projectId },
                    'approveGate deferred — development exit gate running (deploy/remediation/credential)'
                );
                return;
            }
            // decision === 'advance' → exit gate clean, fall through to advance.
        }

        await this.advanceToNextPhase(projectId);
    }

    /**
     * Advance the project to its next enabled phase and decompose it (or mark
     * complete). Split out of `approveGate` so the autonomous path
     * (`checkPhaseGateInner`, which has already run the gate) can advance WITHOUT
     * re-running `checkGate` — re-gating there would trigger a redundant
     * BuildVerificationGate `npm build` (BPF-1 fix keeps the manual path's
     * development exit-gate check off the autonomous hot path).
     */
    private async advanceToNextPhase(projectId: string): Promise<void> {
        const nextPhase = await this.gateManager.approveGate(projectId);
        if (nextPhase !== null) {
            // Get project info for decomposition
            const project = await getOne<{ name: string; description: string }>(
                'SELECT name, description FROM projects WHERE id = $1',
                [projectId]
            );

            if (project !== null) {
                await this.decomposer.decompose(
                    projectId,
                    project.name,
                    project.description ?? '',
                    nextPhase
                );
                await this.router.routePendingTasks(projectId);
            }
        } else {
            // Project completed — all phases done
            const projectName = await this.getProjectName(projectId);
            await this.sendCommsNotification(
                projectId,
                `Project Complete: ${projectName}`,
                `All phases for project "${projectName}" are complete. ` +
                `The project has been marked as finished.`
            );
        }
    }

    /**
     * Deny a project's phase gate.
     */
    async denyGate(projectId: string, reason?: string): Promise<void> {
        await this.gateManager.denyGate(projectId, reason);
    }

    // ── Agent Intercept (v2.3) ────────────────────────

    /**
     * Pause an agent's current task. Command flows through EventBus
     * so the agent receives it regardless of process topology.
     */
    async pauseAgent(agentName: string, taskId: string): Promise<void> {
        log.info({ agentName, taskId }, 'Intercept: pause');
        await this.eventBus.publish('intercept.pause', {
            taskId,
            agent: agentName,
            data: { requestedBy: 'human' },
        });
    }

    /**
     * Resume a paused agent.
     */
    async resumeAgent(agentName: string, taskId: string): Promise<void> {
        log.info({ agentName, taskId }, 'Intercept: resume');
        await this.eventBus.publish('intercept.resume', {
            taskId,
            agent: agentName,
            data: { requestedBy: 'human' },
        });
    }

    /**
     * Inject guidance into an agent's current task context.
     * The agent will receive this at its next cooperative yield point.
     */
    async injectGuidance(
        agentName: string,
        taskId: string,
        guidance: string,
    ): Promise<void> {
        log.info({ agentName, taskId, guidanceLength: guidance.length }, 'Intercept: guidance');
        await this.eventBus.publish('intercept.guidance', {
            taskId,
            agent: agentName,
            data: { guidance, requestedBy: 'human' },
        });
    }

    /**
     * Take over a task from an agent. The agent yields, task status
     * becomes 'paused', and the human can edit files / fix issues.
     */
    async takeoverTask(agentName: string, taskId: string): Promise<void> {
        log.info({ agentName, taskId }, 'Intercept: takeover');
        await this.eventBus.publish('intercept.takeover', {
            taskId,
            agent: agentName,
            data: { requestedBy: 'human' },
        });
    }

    /**
     * Hand a task back to an agent after human edits.
     * Re-assigns the task and routes it for execution.
     */
    async handbackTask(
        taskId: string,
        agentName: string,
        guidance?: string,
    ): Promise<void> {
        log.info({ agentName, taskId }, 'Intercept: handback');

        if (guidance !== undefined && guidance !== '') {
            await query(
                `UPDATE tasks SET status = 'pending', description = description || $1 WHERE id = $2`,
                [`\n\nHUMAN GUIDANCE: ${guidance}`, taskId],
            );
        } else {
            await query(
                `UPDATE tasks SET status = 'pending' WHERE id = $1`,
                [taskId],
            );
        }

        // Look up the project to route pending tasks
        const taskRow = await getOne<{ project_id: string }>(
            'SELECT project_id FROM tasks WHERE id = $1',
            [taskId],
        );
        if (taskRow !== null) {
            await this.router.routePendingTasks(taskRow.project_id);
        }

        await this.eventBus.publish('intercept.handback', {
            taskId,
            agent: agentName,
            data: { requestedBy: 'human', hasGuidance: guidance !== undefined },
        });
    }

    /**
     * Cancel a running project. Terminal state — status='cancelled',
     * in-flight tasks marked failed, future dispatch blocked via router guard.
     */
    async cancelProject(projectId: string, reason?: string): Promise<void> {
        log.info({ projectId, reason }, 'Project: cancel');
        const updated = await query<{ id: string }>(
            `UPDATE projects
             SET status = 'cancelled',
                 cancelled_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1 AND status NOT IN ('completed', 'archived')
             RETURNING id`,
            [projectId],
        );
        if (updated.rows.length === 0) {
            log.info({ projectId }, 'cancelProject no-op (already terminal)');
            return;
        }
        await query(
            `UPDATE tasks
             SET status = 'failed',
                 error_message = COALESCE(error_message, $2)
             WHERE project_id = $1 AND status IN ('pending', 'assigned', 'in-progress')`,
            [projectId, `Cancelled: ${reason ?? 'user-requested'}`],
        );
        await this.eventBus.publish('project.cancelled', {
            projectId,
            data: { projectId, reason: reason ?? null },
        });
    }

    /**
     * F-308 + F-309 — Reopen a terminal project so the user can iterate.
     *
     * Flips status from `completed` / `cancelled` / `archived` back to `active`,
     * clears the corresponding terminal-state timestamps, and emits
     * `project.reopened`. After reopen, the user can `/retry-phase` to re-run
     * existing work, `/retry-failed` to revive failed tasks, OR ask Sensei to
     * decompose new work into the project (via the existing chat path —
     * Sensei honours active status normally).
     *
     * No-op when the project is already in a non-terminal state (active /
     * paused) — caller should use `resumeProject` for paused→active.
     */
    async reopenProject(projectId: string): Promise<void> {
        log.info({ projectId }, 'Project: reopen');

        // F-368: reopen from `completed` lands in `awaiting-input`, not
        // `active`. Rationale: a completed project has all tasks done and
        // sits at the terminal phase (`launch-growth`) — flipping straight
        // to `active` triggers a gate evaluation that surfaces an approval
        // modal which, when accepted, instantly "re-completes" the project
        // because there is no next phase. `awaiting-input` parks the project
        // in a "viewer wants to look / decide" state until either (a) new
        // work is decomposed in (F-342), which flips status back to `active`,
        // OR (b) the operator closes it back to `completed`.
        // For `cancelled` / `archived` reopens we keep the legacy `active`
        // behaviour — those reopens generally have incomplete work to resume.
        // Reopen also resets a terminal launch-growth phase back to
        // development. Without this, /add-requirement on the reopened
        // project hits the launch-growth guard and refuses — leaving
        // the operator with no way to iterate on a completed project.
        // P1-05a: include reopen_count + last_reopened_at increments on
        // the UPDATE so the projects row carries the cycle metadata for
        // fast UI queries (saves a JOIN onto iterations for the
        // project-card hot path).
        const completedUpdated = await query<{ id: string }>(
            `UPDATE projects
             SET status = 'awaiting-input',
                 phase = CASE WHEN phase = 'launch-growth' THEN 'development' ELSE phase END,
                 reopen_count = reopen_count + 1,
                 last_reopened_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1 AND status = 'completed'
             RETURNING id`,
            [projectId],
        );
        let fromStatus: string | null = completedUpdated.rows.length > 0 ? 'completed' : null;

        if (fromStatus === null) {
            // F-148 parity (2026-05-25): reopen-from-cancelled also resets
            // a terminal launch-growth phase back to development, matching
            // the completed-branch behaviour 12 lines above. Without this
            // mirror, addRequirement on a cancelled+launch-growth project
            // (typical state after a budget-killed run) hits the
            // launch-growth guard and refuses — leaving the operator with
            // no way to iterate further without a manual phase reset.
            const otherUpdated = await query<{ id: string }>(
                `UPDATE projects
                 SET status = 'active',
                     phase = CASE WHEN phase = 'launch-growth' THEN 'development' ELSE phase END,
                     cancelled_at = NULL,
                     archived_at = NULL,
                     reopen_count = reopen_count + 1,
                     last_reopened_at = NOW(),
                     updated_at = NOW()
                 WHERE id = $1 AND status IN ('cancelled', 'archived')
                 RETURNING id`,
                [projectId],
            );
            if (otherUpdated.rows.length > 0) {
                fromStatus = 'cancelled-or-archived';
            }
        }

        if (fromStatus === null) {
            log.info({ projectId }, 'reopenProject no-op (not in a terminal state)');
            return;
        }

        // P1-05a: write the iteration row (cycle N+1). `requirement_text`
        // is null on a UI-button reopen; the /add-requirement path that
        // also drives a reopen will overwrite this via a later call once
        // we route it through here (P1-06a follow-up). Non-fatal failure
        // — the projects row already carries the count, so a missing
        // iterations table only degrades the per-cycle history view.
        try {
            const { iterationRepository } = await import('../db/iteration-repo');
            await iterationRepository.recordReopen(projectId, null);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg, projectId }, 'P1-05a: failed to record reopen iteration (non-fatal)');
        }

        await this.eventBus.publish('project.reopened' as never, {
            projectId,
            data: { projectId, reopenedAt: new Date().toISOString(), fromStatus },
        });
    }

    /**
     * F-308 + F-309 — Explicitly mark a project complete without going through
     * the launch-growth phase. Useful when the user is done iterating and wants
     * to "freeze" the project so the build-summary report (F-300) reflects the
     * final state and Sensei stops trying to dispatch work on it.
     *
     * No-op when the project is already terminal.
     */
    async closeProject(projectId: string): Promise<void> {
        log.info({ projectId }, 'Project: close (manual completion)');
        const updated = await query<{ id: string }>(
            `UPDATE projects
             SET status = 'completed',
                 updated_at = NOW()
             WHERE id = $1 AND status NOT IN ('completed', 'cancelled', 'archived')
             RETURNING id`,
            [projectId],
        );
        if (updated.rows.length === 0) {
            log.info({ projectId }, 'closeProject no-op (already terminal)');
            return;
        }

        // P1-05a: close the current iteration when the project goes
        // terminal. The next reopen will open a fresh cycle. Non-fatal
        // failure — the iterations table may be absent on legacy data
        // dirs, in which case there's nothing to close.
        try {
            const { iterationRepository } = await import('../db/iteration-repo');
            await iterationRepository.closeCurrent(projectId);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg, projectId }, 'P1-05a: failed to close iteration (non-fatal)');
        }
        // Trigger the same project.completed event a normal phase-gate close
        // would, so the build-summary report (F-300) is generated for manual
        // closes too.
        const project = await getOne<{ name: string; phase: string }>(
            `SELECT name, phase FROM projects WHERE id = $1`,
            [projectId],
        );
        await this.eventBus.publish('project.completed', {
            projectId,
            data: {
                projectId,
                name: project?.name ?? null,
                finalPhase: project?.phase ?? 'unknown',
                manualClose: true,
            },
        });
    }

    /**
     * F-148 — Append a new requirement to a live project.
     *
     * Decomposes follow-up tasks for the current phase from the new
     * requirement text and routes them through the existing task router.
     * Existing tasks are not touched — this is append-only. The new
     * requirement is also appended to `projects.description` so future
     * gate evaluations and the build-summary report see the full brief.
     *
     * Refused when:
     *  - Project is terminal (`completed` / `cancelled` / `archived`) —
     *    operator should `/reopen-project` first.
     *  - Project is in `launch-growth` — there is no more development
     *    surface after launch; start a sibling or `/retry-phase`.
     *  - Trust level is `low` AND project is mid-`development` — low-
     *    autonomy projects opted into approvals, so drive-by additions
     *    must go through the approval queue instead.
     *
     * Side effects on success:
     *  - `projects.description` appended (timestamped section).
     *  - Status `awaiting-input` flipped back to `active` (F-342 path).
     *  - N new tasks created via TaskDecomposer.decompose for the current phase.
     *  - `project.requirement.added` published with `{ newTaskCount, phase, text, addedAt }`.
     */
    async addRequirement(
        projectId: string,
        text: string,
    ): Promise<{
        readonly ok: boolean;
        readonly newTaskCount: number;
        readonly affectedPhase: Phase | null;
        readonly projectName?: string;
        readonly error?: string;
    }> {
        const trimmed = text.trim();
        if (trimmed.length === 0) {
            return { ok: false, newTaskCount: 0, affectedPhase: null, error: 'Requirement text is empty.' };
        }
        if (trimmed.length > 2000) {
            return { ok: false, newTaskCount: 0, affectedPhase: null, error: 'Requirement text exceeds 2000 characters.' };
        }

        const project = await getOne<{
            id: string;
            name: string;
            description: string | null;
            phase: Phase;
            status: string;
            trust_level: TrustLevel;
        }>(
            `SELECT id, name, description, phase, status, trust_level
               FROM projects WHERE id = $1`,
            [projectId],
        );
        if (project === null) {
            return { ok: false, newTaskCount: 0, affectedPhase: null, error: `Project not found: ${projectId}` };
        }

        if (project.status === 'completed' || project.status === 'cancelled' || project.status === 'archived') {
            return {
                ok: false,
                newTaskCount: 0,
                affectedPhase: null,
                error: `Project is ${project.status}. Reopen it first (/reopen-project ${projectId}) before adding requirements.`,
            };
        }

        // Phase that subsequent decomposition + routing + event publishing
        // should target. Normally this is the project's current phase, but
        // a reopened-completed project that was sitting at launch-growth
        // auto-heals back to development for the new requirement.
        let effectivePhase: Phase = project.phase;

        if (project.phase === 'launch-growth') {
            if (project.status === 'awaiting-input') {
                await query(
                    `UPDATE projects
                        SET phase = 'development',
                            updated_at = NOW()
                      WHERE id = $1`,
                    [projectId],
                );
                effectivePhase = 'development';
                log.info(
                    { projectId },
                    'F-148: auto-reset launch-growth → development for reopened-completed iteration',
                );
            } else {
                return {
                    ok: false,
                    newTaskCount: 0,
                    affectedPhase: null,
                    error: 'Project is currently in launch-growth — wait for the launch tasks to finish, then /reopen-project to start a new iteration in development.',
                };
            }
        }

        if (project.trust_level === 'low' && effectivePhase === 'development') {
            return {
                ok: false,
                newTaskCount: 0,
                affectedPhase: null,
                error: 'Project is mid-development with trust_level=low — pause the project and use the approval queue for mid-flight changes.',
            };
        }

        log.info({ projectId, phase: effectivePhase, addedLen: trimmed.length }, 'F-148: addRequirement accepted');

        const stamp = new Date().toISOString();
        const baseDescription = project.description ?? '';
        const updatedDescription = `${baseDescription}\n\n[Added ${stamp}]\n${trimmed}`;
        await query(
            `UPDATE projects
                SET description = $2,
                    updated_at = NOW()
              WHERE id = $1`,
            [projectId, updatedDescription],
        );

        // awaiting-input is the F-368 "reopened from completed" state. New
        // work is exactly what it was waiting for — flip back to active so
        // the dispatch sweep picks the new tasks up.
        if (project.status === 'awaiting-input') {
            await query(
                `UPDATE projects
                    SET status = 'active',
                        updated_at = NOW()
                  WHERE id = $1 AND status = 'awaiting-input'`,
                [projectId],
            );
        }

        // Constrain the decomposer brief so it emits tasks ONLY for the
        // new requirement. Without this framing the LLM re-decomposes the
        // entire project and we double-up on existing work.
        const decomposerBrief = [
            `FOLLOW-UP REQUIREMENT for project "${project.name}".`,
            `The project is already in flight in the ${effectivePhase} phase — these are ADDITIONAL tasks layered on top of the existing decomposition.`,
            '',
            `New requirement: ${trimmed}`,
            '',
            'Generate 1-3 tasks that implement ONLY this new requirement. Do not re-create tasks for the original brief — assume those already exist.',
        ].join('\n');

        let taskIds: readonly string[];
        try {
            taskIds = await this.decomposer.decompose(
                projectId,
                project.name,
                decomposerBrief,
                effectivePhase,
                // Incremental injection: a 0-task result means "no new tasks for
                // this requirement" — never force the BPF-37 whole-app fallback.
                { allowFallback: false },
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ projectId, err: msg }, 'F-148: addRequirement decompose failed');
            return {
                ok: false,
                newTaskCount: 0,
                affectedPhase: effectivePhase,
                error: `Decomposition failed: ${msg}`,
            };
        }

        // P1-06a: stamp the new tasks with the revision metadata. This
        // is the persistence-layer brick; Forge's revision handler
        // (P1-06b) will read these fields to dispatch differently.
        // Non-fatal failure — the tasks themselves are valid, the
        // missing metadata only degrades the future revision path.
        try {
            await this.stampRevisionMetadata(projectId, taskIds, trimmed);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ projectId, err: msg }, 'P1-06a: stampRevisionMetadata failed (non-fatal)');
        }

        await this.router.routePendingTasks(projectId);

        await this.eventBus.publish('project.requirement.added' as never, {
            projectId,
            data: {
                projectId,
                phase: effectivePhase,
                newTaskCount: taskIds.length,
                text: trimmed,
                addedAt: stamp,
            },
        });

        return {
            ok: true,
            newTaskCount: taskIds.length,
            affectedPhase: effectivePhase,
            projectName: project.name,
        };
    }

    /**
     * Pause a project. In-flight agents receive intercept.pause and yield at
     * next askAI(). Dispatcher guard prevents new tasks from being routed.
     */
    async pauseProject(projectId: string): Promise<void> {
        log.info({ projectId }, 'Project: pause');
        const updated = await query<{ id: string }>(
            `UPDATE projects
             SET status = 'paused',
                 paused_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1 AND status = 'active'
             RETURNING id`,
            [projectId],
        );
        if (updated.rows.length === 0) {
            log.info({ projectId }, 'pauseProject no-op (not active)');
            return;
        }

        // Fan out intercept.pause to every in-flight task on this project.
        const inflight = await getMany<{ id: string; assigned_agent: string | null }>(
            `SELECT id, assigned_agent FROM tasks
             WHERE project_id = $1 AND status IN ('assigned', 'in-progress')`,
            [projectId],
        );
        for (const row of inflight) {
            if (row.assigned_agent === null) continue;
            await this.eventBus.publish('intercept.pause', {
                taskId: row.id,
                agent: row.assigned_agent,
                data: { requestedBy: 'human', scope: 'project' },
            });
        }

        await this.eventBus.publish('project.paused', {
            projectId,
            data: { projectId, inflightCount: inflight.length },
        });
    }

    /**
     * Archive a terminal project (completed or cancelled). Soft-delete:
     * workspace and tasks are preserved; the project is hidden from the
     * default Projects list. Reversible via restoreProject.
     */
    async archiveProject(projectId: string): Promise<void> {
        log.info({ projectId }, 'Project: archive');
        const updated = await query<{ id: string }>(
            `UPDATE projects
             SET status = 'archived',
                 archived_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1 AND status IN ('completed', 'cancelled')
             RETURNING id`,
            [projectId],
        );
        if (updated.rows.length === 0) {
            log.info({ projectId }, 'archiveProject no-op (not terminal)');
            return;
        }
        await this.eventBus.publish('project.archived', {
            projectId,
            data: { projectId },
        });
    }

    /**
     * Restore an archived project back to 'active' status.
     */
    async restoreProject(projectId: string): Promise<void> {
        log.info({ projectId }, 'Project: restore');
        const updated = await query<{ id: string }>(
            `UPDATE projects
             SET status = 'active',
                 archived_at = NULL,
                 updated_at = NOW()
             WHERE id = $1 AND status = 'archived'
             RETURNING id`,
            [projectId],
        );
        if (updated.rows.length === 0) {
            log.info({ projectId }, 'restoreProject no-op (not archived)');
            return;
        }
        await this.eventBus.publish('project.restored', {
            projectId,
            data: { projectId },
        });
    }

    /**
     * Reset all failed tasks on a project back to 'pending' (retry_count=0)
     * and re-drive the dispatcher. Used by the Command Center's "Retry
     * failed tasks" button after a transient failure (network outage,
     * model hiccup, etc.) so the user doesn't have to start over.
     *
     * If the project is paused/awaiting-approval, also flip it to 'active'
     * so the router will actually pick the tasks up.
     */
    async retryFailedTasks(projectId: string): Promise<{ retried: number }> {
        log.info({ projectId }, 'Project: retry failed tasks');
        // BPF-22: 'blocked' is the tier-3 escalation of a failed task —
        // "retry failed" should pick those up too, not just 'failed' rows.
        const reset = await query<{ id: string }>(
            `UPDATE tasks
             SET status = 'pending',
                 retry_count = 0,
                 error_message = NULL,
                 assigned_agent = NULL
             WHERE project_id = $1 AND status IN ('failed', 'blocked')
             RETURNING id`,
            [projectId],
        );
        const retried = reset.rows.length;
        if (retried === 0) {
            log.info({ projectId }, 'retryFailedTasks no-op (no failed tasks)');
            return { retried: 0 };
        }

        // BPF-24: these are failure-retries — drop the cached outputs that
        // produced the failure so the re-attempt runs the AI fresh.
        await this.clearTaskCheckpoints(reset.rows.map((r) => r.id));

        // If the project got parked in paused/awaiting-approval because of
        // the failures, wake it back up so the router will dispatch.
        await query(
            `UPDATE projects
             SET status = 'active',
                 paused_at = NULL,
                 updated_at = NOW()
             WHERE id = $1 AND status IN ('paused', 'awaiting-approval')`,
            [projectId],
        );

        await this.router.routePendingTasks(projectId);
        return { retried };
    }

    /**
     * Restart a stalled project — recovers from Electron crashes, network
     * outages, or any scenario where tasks ended up in `assigned`/
     * `in-progress` status with no live agent process driving them.
     *
     * Pause/Resume only fan out cooperative `intercept.*` events, which
     * are no-ops once the original agent process is gone. retryFailedTasks
     * handles `failed` rows but ignores stalled in-flight ones. This
     * method bridges that gap: it resets every non-terminal task to
     * `pending`, wakes the project to `active`, and asks the router to
     * dispatch fresh.
     *
     * Safe to call repeatedly — if nothing is stalled, returns
     * `{ requeued: 0 }` and the project status is left alone.
     */
    async restartStalledProject(projectId: string): Promise<{ requeued: number }> {
        log.info({ projectId }, 'Project: restart stalled');

        // BPF-22: include 'blocked' — a gating task that exhausted its
        // retries (retryTask tier-3) must be revivable on reclaim, otherwise
        // its dependents deadlock and the watchdog can never un-stick them.
        const reset = await query<{ id: string }>(
            `UPDATE tasks
             SET status = 'pending',
                 retry_count = 0,
                 error_message = NULL,
                 assigned_agent = NULL,
                 started_at = NULL
             WHERE project_id = $1 AND status IN ('assigned', 'in-progress', 'blocked')
             RETURNING id`,
            [projectId],
        );
        const requeued = reset.rows.length;

        // Wake the project regardless — a fully-pending project that was
        // parked in awaiting-approval or paused still needs the router to
        // pick up where it left off.
        await query(
            `UPDATE projects
             SET status = 'active',
                 paused_at = NULL,
                 updated_at = NOW()
             WHERE id = $1 AND status IN ('paused', 'awaiting-approval', 'active')`,
            [projectId],
        );

        await this.eventBus.publish('project.resumed', {
            projectId,
            data: { projectId, reason: 'restart-stalled', requeued },
        });

        await this.router.routePendingTasks(projectId);
        return { requeued };
    }

    /**
     * Hard-delete a project from any status. Removes DB rows (CASCADE
     * to tasks, agent_logs, runs) and the workspace directory.
     *
     * Caller-side safety: the renderer surfaces a two-step confirm
     * (Delete? → Final check?) before calling this, so the previous
     * status=archived guard was just UX friction. We still mark any
     * in-flight tasks as failed before deleting so the orchestrator
     * doesn't try to dispatch work against a now-vanished project_id.
     */
    async hardDeleteProject(projectId: string): Promise<void> {
        log.warn({ projectId }, 'Project: hard delete');
        const row = await getOne<{ repo_path: string | null; status: string }>(
            'SELECT repo_path, status FROM projects WHERE id = $1',
            [projectId],
        );
        if (row === null) return;

        // Stop in-flight work cleanly before tearing down. Any task in
        // pending/assigned/in-progress gets marked failed; the router
        // guard then refuses to re-dispatch them. Skip if already
        // terminal (cancelled/completed/archived) to avoid noisy logs.
        const inFlightStatuses = ['active', 'paused', 'awaiting-approval', 'awaiting-input'];
        if (inFlightStatuses.includes(row.status)) {
            try {
                await query(
                    `UPDATE tasks
                     SET status = 'failed',
                         error_message = COALESCE(error_message, 'Project deleted')
                     WHERE project_id = $1
                       AND status IN ('pending', 'assigned', 'in-progress')`,
                    [projectId],
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn({ err: msg, projectId }, 'Failed to fail in-flight tasks before delete (continuing)');
            }
        }

        await query('DELETE FROM projects WHERE id = $1', [projectId]);

        if (this.workspaceManager !== null && row.repo_path !== null) {
            try {
                const path = await import('path');
                const parent = path.default.dirname(row.repo_path);
                const slug = path.default.basename(row.repo_path);
                await this.workspaceManager.deleteProject(parent, slug);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.error({ err: msg, repo_path: row.repo_path }, 'Workspace delete failed');
            }
        }

        await this.eventBus.publish('project.deleted', {
            data: { projectId },
        });
    }

    /**
     * Render the active agent-routing snapshot as a fixed-width table that
     * Sensei reads from when asked "what model are you using?".
     *
     * When `getAgentRouting` isn't wired (older deployments / tests), returns
     * a placeholder so the system prompt makes sense — Sensei is then
     * instructed to defer to Settings → Model Routing.
     */
    private buildModelRoutingBlock(): string {
        if (this.config.getAgentRouting === undefined) {
            return 'Active agent routing: (not available — getAgentRouting not wired)';
        }
        try {
            const snapshot = this.config.getAgentRouting();
            const presetLabel = snapshot.preset === null || snapshot.preset === ''
                ? 'default (custom)'
                : snapshot.preset;
            const rows = snapshot.agents.map((a) => {
                const display = a.model === '' ? '(unset)' : a.model;
                return `  ${a.name.padEnd(10)} ${display.padEnd(38)} provider=${a.provider}`;
            });
            return [
                `Active preset: ${presetLabel}`,
                'Per-agent model routing:',
                ...rows,
            ].join('\n');
        } catch {
            return 'Active agent routing: (failed to read — defer to Settings → Model Routing)';
        }
    }

    /**
     * Render the live project list as an authoritative ground-truth block.
     *
     * Closes the F-323 hallucination gap: Sensei previously received a loose
     * bulleted list under `CURRENT STATE` that was easy for the LLM to
     * paraphrase, ignore, or supplement with imagined projects. The fenced
     * truth-block format mirrors the model-routing block and is paired with
     * a refusal rule in the system prompt so Sensei must answer FROM this
     * data — fabricating a project ID like `proj_001` for a name not in
     * this list, or inventing task counts for one that is, is now an
     * explicit prompt violation.
     *
     * Format choices:
     * - Full UUIDs in the output (real IDs are UUIDs; LLMs that fake them
     *   produce `proj_001` or `prj-1` — operators can spot the lie immediately).
     * - Per-project task breakdown (completed/total + pending/failed) so
     *   "what's left" / "did anything fail" answers come from data.
     * - Empty-state is explicit ("No projects exist") rather than absent so
     *   Sensei can't infer "presumably there are some".
     */
    /**
     * F-343: Detect a confirm-token in the operator's current chat message
     * and dispatch a real project from the most recent substantive prior
     * user turn.
     *
     * Returns the reply string when a dispatch was performed (caller
     * short-circuits the LLM call), or null when no dispatch was triggered
     * (caller continues to the normal LLM path).
     *
     * Detection rules:
     * - Current message must be SHORT (<=40 chars after trim) AND match a
     *   confirm-token regex. Long messages can't be a pure confirmation
     *   (operator probably described a new idea instead).
     * - Prior turn must be a user message of >=30 chars that is NOT itself
     *   a confirm token (we don't dispatch from a chain of "go go go").
     * - Failures during startProject are caught and surfaced to the
     *   operator as a friendly reply rather than throwing.
     */
    private async tryChatDispatch(
        currentMessage: string,
        history: readonly ChatMessage[],
    ): Promise<string | null> {
        const trimmed = currentMessage.trim();
        if (trimmed.length === 0 || trimmed.length > 40) return null;
        const normalized = trimmed.toLowerCase().replace(/[.!?]+$/u, '');
        const CONFIRM_TOKENS = new Set([
            'start', 'go', 'go ahead', 'do it', 'do it now', 'proceed', 'begin',
            'launch', 'kick off', 'ship it', 'build it', 'make it',
            'let\'s go', 'lets go', 'let\'s do it', 'lets do it',
            'yes start', 'yes go', 'yes proceed', 'yes do it',
        ]);
        if (!CONFIRM_TOKENS.has(normalized)) return null;

        // Walk history backwards (excluding the current message we just
        // pushed) for the latest substantive user turn.
        let brief: string | null = null;
        for (let i = history.length - 2; i >= 0; i--) {
            const turn = history[i];
            if (turn.role !== 'user') continue;
            const candidate = turn.content.trim();
            if (candidate.length < 30) continue;
            const candidateNorm = candidate.toLowerCase().replace(/[.!?]+$/u, '');
            if (CONFIRM_TOKENS.has(candidateNorm)) continue;
            brief = candidate;
            break;
        }
        if (brief === null) {
            return 'I have no idea to dispatch yet. Describe the project you want to build, then reply `start`.';
        }

        const name = this.deriveProjectName(brief);
        try {
            const projectId = await this.startProject(name, brief, 'low');
            log.info({ projectId, name }, 'F-343: chat dispatch created project');
            return `The path is set. I have dispatched **${name}** — Scout will assess scope next.\n\n· id: \`${projectId}\``;
        } catch (err) {
            // TierLimitError carries an upgrade-friendly message — surface as-is.
            const isTierLimit = err instanceof TierLimitError;
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg, isTierLimit }, 'F-343: chat dispatch startProject failed');
            return isTierLimit
                ? msg
                : `I could not dispatch: ${msg}. Open New Project (top-right) to try a different path.`;
        }
    }

    /**
     * F-148 (#148): handle the `/add-requirement <text>` slash command in
     * project-scoped chat. Returns the assistant-facing reply when the
     * message matched the command, or `null` so the caller falls through
     * to the normal LLM path.
     *
     * Why a slash command rather than LLM intent detection: this lets
     * `addRequirement()` run deterministically — the test surface is
     * "does Sensei call addRequirement when the operator types the
     * command", not "does the LLM infer intent correctly". Free-form
     * "add a landing page" still routes to the LLM, which now has the
     * updated CAPABILITY HONESTY RULE pointing the operator at the
     * command instead of inventing a technical refusal.
     */
    private async tryAddRequirementCommand(
        projectId: string | null,
        message: string,
    ): Promise<string | null> {
        // Strip an optional leading `@AgentName: ` mention. The Autonauts
        // detail panel prepends `@Herald: ` (etc.) to every chat message
        // before sending — without this strip the slash regex misses, and
        // Sensei falls through to the LLM which then hallucinates dispatch
        // (caught in production 2026-05-20 with the Plant Maintenance Book
        // / PDF requirement — issue #158).
        const trimmed = message.trim().replace(/^@[A-Za-z][\w-]*:\s*/, '');
        // Recognise the slash command with optional --project <id> flag.
        // Accepted forms (case-insensitive):
        //   /add-requirement <text>
        //   /add-requirement --project <uuid> <text>
        //   /add_requirement <text>          (underscore variant)
        //   /add requirement <text>          (space variant)
        //   @AgentName: /add-requirement <text>   (Autonauts agent chat)
        const match = /^\/add[-_ ]?requirement(?:\s+--project\s+(\S+))?\s+(.+)$/iu.exec(trimmed);
        if (match === null) {
            // Bare `/add-requirement` with no body still counts — give usage.
            if (/^\/add[-_ ]?requirement\s*$/iu.test(trimmed)) {
                return 'Usage: `/add-requirement <text>` — e.g. `/add-requirement add a contact form to the landing page`. Use `/add-requirement --project <id> <text>` when more than one project is active.';
            }
            return null;
        }
        const explicitProjectId = match[1] ?? null;
        const text = match[2]?.trim() ?? '';
        if (text.length === 0) {
            return 'Usage: `/add-requirement <text>` — e.g. `/add-requirement add a contact form to the landing page`.';
        }

        // F-148 v2 (#155): resolve the target project. Project-scoped chat
        // wins if set; otherwise an explicit --project flag; otherwise the
        // operator's focus project; otherwise the single active project.
        // Multiple active with no flag → explicit refusal with the list.
        let targetProjectId: string;
        if (explicitProjectId !== null) {
            targetProjectId = explicitProjectId;
        } else if (projectId !== null) {
            targetProjectId = projectId;
        } else {
            const resolved = await this.resolveActiveProject();
            if (!resolved.ok) return resolved.error;
            targetProjectId = resolved.projectId;
        }

        const result = await this.addRequirement(targetProjectId, text);
        if (!result.ok) {
            return `I could not add that requirement: ${result.error ?? 'unknown error'}`;
        }
        const phaseTxt = result.affectedPhase ?? 'current phase';
        const projectLabel = result.projectName !== undefined
            ? `**${result.projectName}**`
            : `project \`${targetProjectId}\``;
        return `Added the requirement to ${projectLabel} (${phaseTxt} phase) — ${result.newTaskCount} new task${result.newTaskCount === 1 ? '' : 's'} routed.`;
    }

    /**
     * F-148 V2 — prose-style requirement nudge.
     *
     * When the operator types prose like "add a contact form to the
     * landing page" without the slash command, we previously relied
     * on the LLM honesty rule to point them at `/add-requirement`.
     * That worked SOMETIMES — when it didn't, Sensei hallucinated
     * dispatch (#155) or invented technical refusals (#149).
     *
     * This method short-circuits prose requirements with a
     * deterministic, machine-grade nudge — same destination as the
     * LLM honesty rule (point at the slash command), zero LLM cost,
     * zero hallucination surface.
     *
     * Returns the nudge string when it fired, or `null` to fall
     * through to the LLM. Falls through (returns null) when:
     *   - The message doesn't look like a requirement (see
     *     {@link looksLikeRequirementProse}).
     *   - No project is in scope: neither a project-scoped chat,
     *     nor a focus project, nor any active project in the DB.
     *     (No active project → the operator probably meant to
     *     pitch a NEW project — let the LLM / F-343 dispatch path
     *     handle that.)
     */
    private async tryProseRequirementNudge(
        projectId: string | null,
        message: string,
    ): Promise<string | null> {
        if (!looksLikeRequirementProse(message)) return null;

        // Strip optional `@AgentName:` mention (Autonauts detail panel
        // prepends this for every chat message) before quoting it back
        // to the operator — the bare text reads cleaner in the nudge.
        const cleaned = message.trim().replace(/^@[A-Za-z][\w-]*:\s*/, '');

        // Find a target project — same precedence as tryAddRequirement-
        // Command. If none, return null so the LLM path runs (operator
        // is probably describing a NEW project, not amending one).
        let targetProjectId: string | null = projectId;
        if (targetProjectId === null) {
            try {
                const resolved = await this.resolveActiveProject();
                if (resolved.ok) targetProjectId = resolved.projectId;
            } catch (err) {
                // resolveActiveProject hits the DB — if it explodes we
                // would rather fall through than swallow the operator's
                // message. The LLM path has its own error handling.
                log.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    'F-148 V2 prose nudge: resolveActiveProject failed — falling through to LLM',
                );
                return null;
            }
        }
        if (targetProjectId === null) return null;

        // Quote the operator's message back so they can confirm we're
        // capturing the right text before they re-type it as a command.
        // Truncate to 200 chars in the quoted echo to keep the reply
        // tight if they pasted a wall of text that still met the
        // 250-char ceiling.
        const echo = cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
        log.info(
            { projectId: targetProjectId, len: cleaned.length },
            'F-148 V2: emitted prose-requirement nudge',
        );
        return [
            'That reads like a follow-up requirement. To capture it deterministically rather than letting the chat path interpret it, re-send as the slash command:',
            '',
            '```',
            `/add-requirement ${echo}`,
            '```',
            '',
            'I will only dispatch new tasks when you use the slash form — see [Add a Requirement](docs/help/add-requirement.md) for the full flow.',
        ].join('\n');
    }

    /**
     * F-148 v2 (#155): resolve which project a global-chat `/add-requirement`
     * targets when the operator didn't pass `--project`. Precedence:
     *
     *   1. `focusProjectId` — set by headless runs and `--resume` flows.
     *   2. Exactly one project in `status='active'` → use it (the common case).
     *   3. Zero active projects → explicit refusal ("start one first").
     *   4. Multiple active projects → refuse with the list and require the
     *      operator to re-run with `--project <id>`. We never guess in this
     *      case — guessing is exactly the failure mode #149 banned.
     */
    private async resolveActiveProject(): Promise<
        | { readonly ok: true; readonly projectId: string }
        | { readonly ok: false; readonly error: string }
    > {
        if (this.focusProjectId !== null) {
            return { ok: true, projectId: this.focusProjectId };
        }
        const rows = await getMany<{ id: string; name: string }>(
            `SELECT id, name FROM projects
              WHERE status = 'active'
              ORDER BY updated_at DESC
              LIMIT 5`,
            [],
        );
        if (rows.length === 0) {
            return {
                ok: false,
                error: 'No active projects. Start one from Mission Control first, then re-run `/add-requirement <text>`.',
            };
        }
        if (rows.length === 1) {
            return { ok: true, projectId: rows[0]!.id };
        }
        const list = rows.map((r) => `  - **${r.name}** — \`${r.id}\``).join('\n');
        return {
            ok: false,
            error: `I have ${rows.length} active projects — which one is the requirement for?\n\n${list}\n\nRe-run as: \`/add-requirement --project <id> <text>\``,
        };
    }

    /**
     * Derive a short, capitalised project name from a free-form brief.
     * Strips leading filler ("I want to build a ...", "Make me a ..."),
     * takes the first 5 words, capitalises each. Falls back to a generic
     * "Untitled Project (<date>)" when nothing usable remains.
     */
    private deriveProjectName(brief: string): string {
        const FILLERS = [
            /^(i want to|i would like to|please|can you|could you)\s+/iu,
            /^(build|make|create|design|develop)\s+(me\s+)?(a|an|the)\s+/iu,
            /^(build|make|create|design|develop)\s+/iu,
            /^(a|an|the)\s+/iu,
        ];
        let stripped = brief.trim();
        for (const re of FILLERS) {
            stripped = stripped.replace(re, '');
        }
        const words = stripped
            .split(/\s+/u)
            .map((w) => w.replace(/[^A-Za-z0-9-]/gu, ''))
            .filter((w) => w.length > 0)
            .slice(0, 5);
        if (words.length === 0) {
            const stamp = new Date().toISOString().slice(0, 10);
            return `Untitled Project ${stamp}`;
        }
        return words
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');
    }

    /**
     * F-336: Query in-flight work grouped by agent across all projects.
     *
     * The chat-grounding gap was: `buildProjectStateBlock` only injects
     * aggregate per-project task counts, so when the operator asks
     * "is Pixel working on anything?" Sensei has no per-agent data to
     * read from and confabulates ("no" while the Agent Activity panel
     * shows Pixel mid-task).
     *
     * Returns one row per (agent, task) pair currently in
     * `assigned` or `in-progress` status. Empty array means every
     * agent is idle right now — Sensei should reply "all agents are
     * currently idle".
     */
    private async getActiveWorkByAgent(): Promise<readonly {
        readonly agent: string;
        readonly taskId: string;
        readonly taskTitle: string;
        readonly projectId: string;
        readonly projectName: string;
        readonly status: string;
        readonly phase: string;
        readonly startedAt: Date | null;
    }[]> {
        try {
            return await getMany<{
                agent: string;
                taskId: string;
                taskTitle: string;
                projectId: string;
                projectName: string;
                status: string;
                phase: string;
                startedAt: Date | null;
            }>(
                `SELECT
                     t.assigned_agent AS agent,
                     t.id             AS "taskId",
                     t.title          AS "taskTitle",
                     t.project_id     AS "projectId",
                     p.name           AS "projectName",
                     t.status         AS status,
                     t.phase          AS phase,
                     t.started_at     AS "startedAt"
                 FROM tasks t
                 JOIN projects p ON p.id = t.project_id
                 WHERE t.assigned_agent IS NOT NULL
                   AND t.status IN ('assigned', 'in-progress')
                 ORDER BY t.assigned_agent, t.started_at NULLS LAST`,
                [],
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg }, 'F-336: getActiveWorkByAgent failed — Sensei will answer without per-agent grounding');
            return [];
        }
    }

    /**
     * F-336: Render `getActiveWorkByAgent()` rows as a fenced truth block.
     *
     * Format choices:
     * - Group by agent so "what is Pixel doing?" can be answered by
     *   scanning to the `pixel:` heading.
     * - Empty state is explicit ("All agents idle — no in-flight tasks")
     *   so Sensei cannot infer "presumably someone is working".
     * - Includes task title + project + phase + duration so Sensei can
     *   answer "what is Forge working on?" / "how long has it been
     *   running?" without an extra DB roundtrip.
     */
    private buildActiveWorkBlock(rows: readonly {
        readonly agent: string;
        readonly taskId: string;
        readonly taskTitle: string;
        readonly projectId: string;
        readonly projectName: string;
        readonly status: string;
        readonly phase: string;
        readonly startedAt: Date | null;
    }[]): string {
        if (rows.length === 0) {
            return 'All agents idle — no in-flight tasks.';
        }
        const byAgent = new Map<string, typeof rows[number][]>();
        for (const r of rows) {
            const existing = byAgent.get(r.agent) ?? [];
            existing.push(r);
            byAgent.set(r.agent, existing);
        }
        const lines: string[] = [];
        const sortedAgents = Array.from(byAgent.keys()).sort();
        for (const agent of sortedAgents) {
            const agentRows = byAgent.get(agent)!;
            lines.push(`  ${agent}:`);
            for (const r of agentRows) {
                const dur = r.startedAt === null
                    ? 'not yet started'
                    : `running ${Math.max(0, Math.round((Date.now() - new Date(r.startedAt).getTime()) / 1000))}s`;
                lines.push(`    - [${r.status}] ${r.taskTitle} — project=${r.projectName} phase=${r.phase} (${dur})`);
            }
        }
        return lines.join('\n');
    }

    private buildProjectStateBlock(projects: readonly ProjectStatus[]): string {
        if (projects.length === 0) {
            return 'No projects exist in the database. Any project name the operator mentions is one you do NOT have — offer to create it.';
        }
        const rows = projects.map((p) => {
            const c = p.taskCounts;
            const breakdown = `tasks=${c.completed}/${c.total} completed`
                + (c.pending > 0 ? ` (${c.pending} pending` : '')
                + (c.assigned > 0 ? `${c.pending > 0 ? ', ' : ' ('}${c.assigned} in-progress` : '')
                + (c.failed > 0 ? `${c.pending > 0 || c.assigned > 0 ? ', ' : ' ('}${c.failed} failed` : '')
                + (c.pending > 0 || c.assigned > 0 || c.failed > 0 ? ')' : '');
            return [
                `  ${p.id}  ${p.name}`,
                `    phase=${p.phase}  status=${p.status}  ${breakdown}`,
            ].join('\n');
        });
        return rows.join('\n');
    }

    /**
     * Persist + load chat history for project-scoped channels (PR B of F-302).
     *
     * For project channels (`project:<uuid>`), conversation history lives in
     * the `sensei_messages` Postgres table — survives restarts, and any team
     * member viewing the project sees the full attributed thread. For legacy
     * channels (`'default'` / `'command-center'` / etc.), history stays in
     * the in-memory map and persists only for the life of the process.
     *
     * The trade-off is intentional: the legacy channels are used by the
     * setup wizard / help dialogs / pre-project chat where persistence
     * doesn't matter and the DB write would be pure overhead.
     */
    private get chatRepo(): SenseiChatRepository {
        return this.config.chatRepository ?? senseiChatRepository;
    }

    /** Convert a persisted DB row to the in-memory `ChatMessage` shape used by the existing prompt assembly. */
    private toChatMessage(row: PersistedSenseiMessage): ChatMessage {
        return { role: row.role, content: row.content };
    }

    /**
     * Hydrate the in-memory history Map from the database the first time we
     * see a project channel. Subsequent calls reuse the cached array, which
     * is mutated in lock-step with the DB writes below. Failures fall back
     * to an empty history so the chat surface degrades to fresh-thread
     * behaviour rather than throwing.
     */
    private async ensureHistoryLoaded(channelId: string): Promise<ChatMessage[]> {
        if (this.conversationHistories.has(channelId)) {
            return this.conversationHistories.get(channelId)!;
        }
        const projectId = projectIdFromChannelId(channelId);
        if (projectId === null) {
            const empty: ChatMessage[] = [];
            this.conversationHistories.set(channelId, empty);
            return empty;
        }
        // Fail-soft: a transient DB error during hydration must not block
        // the chat turn. Degrade to an empty in-memory thread; the
        // operator's new message + Sensei's reply still go through.
        let persisted: readonly PersistedSenseiMessage[] = [];
        try {
            persisted = await this.chatRepo.listForProject(projectId);
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err), projectId },
                'Sensei chat hydration failed — starting with empty history',
            );
        }
        const trimmed = persisted.length > MAX_CONVERSATION_HISTORY
            ? persisted.slice(-MAX_CONVERSATION_HISTORY)
            : persisted;
        const loaded: ChatMessage[] = trimmed.map((r) => this.toChatMessage(r));
        this.conversationHistories.set(channelId, loaded);
        return loaded;
    }

    /**
     * Handle a free-form user message from the Command Center chat.
     * Maintains conversation history per channel for multi-turn context.
     * For project-scoped channels, persists to `sensei_messages`.
     * Returns Sensei's AI-generated response.
     */
    async handleUserMessage(
        message: string,
        channelId: string = 'default',
        context: ChatTurnContext = {},
    ): Promise<string> {
        try {
            const projectId = projectIdFromChannelId(channelId);
            const history = await this.ensureHistoryLoaded(channelId);

            // Persist user message before sending to LLM. Failures don't
            // block the chat turn — the error logs and the in-memory history
            // continues; the message is just missing from the DB.
            if (projectId !== null) {
                await this.chatRepo.append({
                    projectId,
                    role: 'user',
                    authorUserId: context.authorUserId ?? null,
                    authorName: context.authorName ?? 'Operator',
                    authorRole: context.authorRole ?? null,
                    content: message,
                }).catch((err: unknown) => {
                    log.warn(
                        { err: err instanceof Error ? err.message : String(err), projectId },
                        'Sensei chat persist (user) failed — continuing without persistence',
                    );
                });
            }

            // Add user message to history
            history.push({ role: 'user', content: message });

            // Trim history if it exceeds the limit (keep most recent messages)
            if (history.length > MAX_CONVERSATION_HISTORY) {
                const excess = history.length - MAX_CONVERSATION_HISTORY;
                history.splice(0, excess);
            }

            // F-343: chat dispatch flow.
            // When operator types a confirm token ("start" / "go" / "do it" /
            // "proceed" / etc.) in the global chat AND a substantive prior
            // user message exists in history, create the project from that
            // prior message instead of routing to the LLM. This closes the
            // dead-end where Sensei refused to dispatch and the operator
            // had nowhere to take "start" because no command handler existed.
            // Project-scoped channels (where projectId !== null) skip this —
            // their project already exists; dispatch goes through normal IPC.
            if (projectId === null) {
                const dispatchResult = await this.tryChatDispatch(message, history);
                if (dispatchResult !== null) {
                    history.push({ role: 'assistant', content: dispatchResult });
                    return dispatchResult;
                }
            }

            // F-148 v2 (#155): /add-requirement <text> dispatch.
            // Fires in EVERY chat (global + project-scoped). When called
            // from global chat the resolver picks the focus project or the
            // single active one; multiple-active forces an explicit
            // --project flag. The LLM never sees a /add-requirement
            // message — short-circuiting here prevents the v0.1.38
            // hallucination where Sensei narrated dispatch without
            // actually invoking the IPC. See #155.
            const addResult = await this.tryAddRequirementCommand(projectId, message);
            if (addResult !== null) {
                history.push({ role: 'assistant', content: addResult });
                if (projectId !== null) {
                    await this.chatRepo.append({
                        projectId,
                        role: 'assistant',
                        authorUserId: null,
                        authorName: 'Sensei',
                        authorRole: null,
                        content: addResult,
                    }).catch((err: unknown) => {
                        log.warn(
                            { err: err instanceof Error ? err.message : String(err), projectId },
                            'Sensei chat persist (assistant) failed — continuing without persistence',
                        );
                    });
                }
                return addResult;
            }

            // F-148 V2: free-form prose nudge. If the operator wrote
            // something that looks like a feature request without the
            // slash command, AND there's an active project to attach
            // it to, surface a deterministic suggestion instead of
            // letting the LLM hallucinate dispatch. See looksLike-
            // RequirementProse() docblock above for full rules.
            const nudgeResult = await this.tryProseRequirementNudge(projectId, message);
            if (nudgeResult !== null) {
                history.push({ role: 'assistant', content: nudgeResult });
                if (projectId !== null) {
                    await this.chatRepo.append({
                        projectId,
                        role: 'assistant',
                        authorUserId: null,
                        authorName: 'Sensei',
                        authorRole: null,
                        content: nudgeResult,
                    }).catch((err: unknown) => {
                        log.warn(
                            { err: err instanceof Error ? err.message : String(err), projectId },
                            'Sensei chat persist (assistant) failed — continuing without persistence',
                        );
                    });
                }
                return nudgeResult;
            }

            // Build dynamic context. Surface ALL projects (active, completed,
            // archived) so Sensei can answer history questions truthfully —
            // the prior chat path filtered out completed/archived rows and
            // then Sensei would invent answers when asked about them.
            const projects = await this.getAllProjectsStatus({ exclude: [] });
            const projectStateBlock = this.buildProjectStateBlock(projects);

            // F-336: per-agent in-flight task block, so "is Pixel working
            // on anything?" is answered from data, not from the LLM's prior.
            const activeWork = await this.getActiveWorkByAgent();
            const activeWorkBlock = this.buildActiveWorkBlock(activeWork);

            // Help RAG — surface relevant docs/help/*.md chunks to Sensei.
            // Best-effort: if the index isn't ready or search fails we still
            // answer, just without doc context.
            let helpContext: string | null = null;
            try {
                const hits = await searchHelp(message, { limit: 3 });
                helpContext = formatHelpContext(hits);
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log.warn({ err: errMsg }, 'Help RAG lookup failed — answering without help context');
            }

            const systemPrompt = [
                'You are Sensei — the master orchestrator of KageOps.',
                '',
                'PERSONALITY:',
                '- You are the wise, composed master ninja who oversees everything from the shadows.',
                '- You speak with quiet authority — measured, precise, and unhurried.',
                '- You use brief martial arts / ninja metaphors naturally ("the path is clear", "patience reveals the opening", "strike now").',
                '- You never ramble. Every word carries weight. You are the opposite of chatty.',
                '- You see the big picture — strategy, timing, resource allocation, risk.',
                '- You are deeply respected by the Autonauts. When you speak, they listen.',
                '- You refer to agents by name as your students: "I have sent Scout ahead", "Forge is sharpening the blade".',
                '- You address the human operator with quiet respect — they are the client, the mission-giver.',
                '',
                'YOUR TEAM (the Autonauts):',
                '- Scout: strategist & researcher — first to assess any new mission',
                '- Blueprint: architect — designs systems and structures',
                '- Pixel: designer — UI/UX and visual identity',
                '- Forge: engineer — writes the code, builds the product',
                '- Cipher: data specialist — databases, APIs, integrations',
                '- Aegis: platform engineer — infrastructure, CI/CD, deployments',
                '- Vigil: quality guardian — testing, code review, security',
                '- Herald: marketer — docs, launch strategy, user communication',
                '',
                'RULES:',
                '- Be concise. 2-4 sentences typical. No long tables or lists unless asked.',
                '- When the operator says "start", "proceed", "go ahead", or "do it" — act immediately.',
                '- When you have enough info to start a project, do so without asking more questions.',
                '- Keep responses under 150 words unless detail is requested.',
                '- Remember the full conversation — never re-ask what was already answered.',
                '- If a project was discussed and approved, reference it by name.',
                '- End actionable responses with a brief status: what is happening next.',
                '- If RELEVANT HELP DOCS appear below, treat them as authoritative for "how do I…" / settings questions and cite the doc path (docs/help/<slug>.md) so the operator can find more.',
                '',
                'PLATFORM-FEATURE HONESTY RULE:',
                '- If the operator asks about a KageOps-specific acronym, feature, or concept (e.g. "what does APO do", "what is the Quickflow", "explain Speciality Matrix") and you do NOT see an answer in the RELEVANT HELP DOCS block below, you do NOT know. Do NOT guess from the name. Do NOT expand acronyms creatively. Reply with one short sentence: "I don\'t have that in my help index — try the `/help` command in the Mission Control shell, or browse the in-app docs at Settings → Help." Then stop.',
                '- Specifically: APO is "Automatic Prompt Optimization" (the nightly prompt-tuning scheduler). It is NOT "Autonomous Project Orchestration" or anything else. If APO is asked and the docs aren\'t below, say you don\'t have it indexed — never invent an expansion.',
                '',
                'CAPABILITY HONESTY RULE (HARD CONSTRAINT):',
                '- You have a small, fixed set of tools: read the truth blocks below, answer questions, dispatch a NEW project when the operator confirms, and append a new requirement via the `/add-requirement <text>` slash command (works in both global and project-scoped chat per #155).',
                '- You CANNOT: edit existing tasks, reassign tasks between Autonauts, pause or resume phases from chat, change budgets, change models, modify the .env, repair the database, restart services, or run arbitrary shell commands. None of these have IPCs wired to you.',
                '- For new requirements on an active project: tell the operator to type `/add-requirement <text>` — that command short-circuits to a real DB write + task decomposition. Do NOT claim you added a requirement on free-form prose (e.g. "add a landing page"); reply: \'Type `/add-requirement add a landing page` and I will dispatch the work.\'',
                '',
                'SLASH-COMMAND HONESTY RULE (HARD CONSTRAINT, added #155):',
                '- If the operator\'s message starts with `/add-requirement`, the chat-dispatch handler runs BEFORE this prompt is built. If that handler succeeds, you never see the message — you see ONLY the next operator turn. If the message DID reach you (you can read it), it means dispatch failed and you MUST say so plainly.',
                '- NEVER narrate hypothetical agent action when you see a `/`-prefixed command. NEVER write phrases like "Requirement recorded", "Blueprint will revise…", "Pixel will begin…", or "Forge will integrate…" in response to a slash command. Those phrases describe action the dispatch handler would have taken but did not.',
                '- Correct response when `/add-requirement` reaches you: "The dispatch handler did not pick that up. Most likely the message was malformed — retype `/add-requirement <text>` on a single line, all on one line, no extra `--project` flag unless multiple projects are active." Then stop.',
                '- If the operator asks you to do anything else from the cannot-list, reply plainly: "I don\'t have a tool for that in the current build — the closest thing is <X> in the <panel name>." Then stop. Example: "fix the database" → \'I can\'t repair the DB from chat. If the app is running and surfacing project state below, the DB is healthy.\'',
                '- NEVER invent a technical excuse (database corruption, lock conflicts, permission errors, sandboxing, "the app holds a write lock") for a missing capability. Inventing a destructive recovery procedure (e.g. "rename your pgdata directory") is the worst possible answer — it can erase the operator\'s real state. A blunt "I don\'t have a tool for that" is always correct; a fabricated technical refusal is never correct.',
                '',
                'COMPLETED / TERMINAL PROJECTS — HONESTY RULE:',
                '- A project listed with `status=completed`, `status=cancelled`, or `status=archived` is TERMINAL. No agent dispatch is possible while it stays in that state.',
                '- If the operator asks you to do work on a terminal-status project (build, fix, deploy, add a feature), DO NOT claim you have dispatched it. That is a lie.',
                '- Instead reply with one short sentence acknowledging the state, then offer the operator one of: (a) `/reopen-project <projectId>` to flip it back to active so you CAN dispatch, (b) `/retry-phase <projectId> <phase>` to re-run an existing phase, or (c) starting a new project with the requested change as its description.',
                '- Never silently fabricate dispatch confirmations. Truth is more important than appearing helpful.',
                '',
                'PROJECT STATE — TRUTH BLOCK (HALLUCINATION RULE):',
                '- The block below is the COMPLETE list of every project the database knows about right now. It is your only source of truth for project names, IDs, phases, statuses, and task counts.',
                '- If the operator names a project that is NOT in this block, you do NOT have it. Do not invent an ID (real IDs are UUIDs like `7c4f...`, never `proj_001`). Do not invent task counts. Reply: "I have no project by that name. Did you mean <closest match from the block, if any>, or would you like to create a new one?"',
                '- If the operator asks about a project that IS in this block (status, progress, what tasks are pending, what failed), read your answer FROM the row. Do not paraphrase counts ("about half done") — quote the exact fraction.',
                '- A free-form chat prompt by itself does NOT create a project. You cannot say "Project X is now active, Scout is assessing scope" unless X already appears in the block. If the operator describes an idea, reply: "I will not start work until you confirm. Open New Project (top-right) or reply `start` and I will create it."',
                '- Never invent activity ("Scout is investigating", "Forge is sharpening the blade") for a project that has no row in the block. The Autonauts dispatch through the task router, not through your narration.',
                '',
                'MODEL ROUTING — TRUTH BLOCK:',
                '- The block below lists the EXACT model each Autonaut is configured to call right now. If the operator asks "what model are you using?" or "what models are the Autonauts running?", read your answer FROM THIS BLOCK. Do not infer, do not generalise, do not say "Sonnet 4.6 by default" or any default — read the table.',
                '- If the block is missing (older deployments), say "I cannot read the active model routing — open Settings → Model Routing to see what each agent is using."',
                '',
                'ACTIVE WORK — TRUTH BLOCK:',
                '- The block below is the COMPLETE list of every task currently in flight (status=assigned or in-progress), grouped by Autonaut. It is your only source of truth for what each agent is doing right now.',
                '- If the operator asks "is <agent> working on anything?" / "what is <agent> doing?" / "is anything running?", read your answer FROM THIS BLOCK. If an agent name does NOT appear in the block, that agent is IDLE — never invent activity ("Scout is investigating") for an agent absent from the block.',
                '- If the block reads "All agents idle", state that plainly. Do not soften it ("they may be working on something") — silence in the block means silence on the task router.',
                '',
                '=== PROJECT STATE — TRUTH BLOCK ===',
                projectStateBlock,
                '=== END PROJECT STATE ===',
                '',
                '=== ACTIVE WORK — TRUTH BLOCK ===',
                activeWorkBlock,
                '=== END ACTIVE WORK ===',
                '',
                '=== MODEL ROUTING — TRUTH BLOCK ===',
                this.buildModelRoutingBlock(),
                '=== END MODEL ROUTING ===',
                ...(helpContext === null ? [] : ['', helpContext]),
            ].join('\n');

            let reply: string;

            // Use multi-turn conversation API if available, otherwise fall back to single-turn
            if (this.config.sendConversation !== undefined) {
                reply = await this.config.sendConversation(systemPrompt, history);
            } else {
                // Fallback: pack conversation into a single prompt
                const conversationText = history.map((m) =>
                    `${m.role === 'user' ? 'Human' : 'Sensei'}: ${m.content}`
                ).join('\n\n');
                reply = await this.config.sendPrompt(systemPrompt, conversationText);
            }

            // Add assistant reply to history
            history.push({ role: 'assistant', content: reply });

            // Persist assistant reply (project channels only). Same fail-soft
            // semantics as the user-message persist above.
            if (projectId !== null) {
                await this.chatRepo.append({
                    projectId,
                    role: 'assistant',
                    authorUserId: null,
                    authorName: 'Sensei',
                    authorRole: null,
                    content: reply,
                }).catch((err: unknown) => {
                    log.warn(
                        { err: err instanceof Error ? err.message : String(err), projectId },
                        'Sensei chat persist (assistant) failed — continuing without persistence',
                    );
                });
            }

            // Trim again after adding reply
            if (history.length > MAX_CONVERSATION_HISTORY) {
                const excess = history.length - MAX_CONVERSATION_HISTORY;
                history.splice(0, excess);
            }

            return reply;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? err.stack ?? '' : '';
            log.error({ err: msg }, 'handleUserMessage error');

            // F-350: Sensei chat failures are surfaced as a single line in the
            // chat panel ("Sorry, I encountered an error: ..."), which is great
            // for normal UX but useless for diagnosis — there's no way to tell
            // which provider/endpoint/key was used. Persist a per-call dump
            // when the error involves an HTTP status so the user can paste it
            // back to me. Best-effort; never throws.
            void persistSenseiErrorDump(msg, stack).catch(() => undefined);

            return `Sorry, I encountered an error: ${msg}`;
        }
    }

    /**
     * Clear conversation history for a specific character or all characters.
     *
     * For project-scoped channels (`project:<uuid>`), this also deletes the
     * persisted rows from `sensei_messages` so a "Clear chat" action in the
     * UI doesn't surprise the operator with the history reappearing on next
     * project open. Best-effort — DB failure logs but does not throw.
     */
    clearConversationHistory(characterId?: string): void {
        if (characterId !== undefined) {
            this.conversationHistories.delete(characterId);
            const projectId = projectIdFromChannelId(characterId);
            if (projectId !== null) {
                void this.chatRepo.deleteForProject(projectId);
            }
        } else {
            this.conversationHistories.clear();
            // Don't bulk-delete sensei_messages here — caller intent is
            // "drop in-memory caches", not "wipe every project's DB
            // history". Project-scoped clears go through the targeted
            // path above.
        }
    }

    // ── Event Handlers ───────────────────────────────

    private async onTaskCompleted(event: EventPayload): Promise<void> {
        const { projectId, taskId, agent } = event;
        if (projectId === undefined) return;

        // Update speciality matrix with success
        const task = await getOne<{ task_type: string; quality_score: number | null; phase: string }>(
            'SELECT task_type, quality_score, phase FROM tasks WHERE id = $1',
            [taskId ?? '']
        );

        if (task !== null && agent !== undefined) {
            await this.matrix.recordTaskOutcome(
                agent,
                task.task_type,
                true,
                task.quality_score ?? undefined
            );
        }

        // Check if the completed task should trigger a Vigil review
        if (task !== null && taskId !== undefined && this.isReviewableTask(task.task_type, task.phase)) {
            const reviewCreated = await this.createReviewTask(projectId, taskId, task.task_type);
            if (reviewCreated) {
                // Review task created — don't check phase gate yet.
                // Phase gate will be checked when the review task completes.
                return;
            }
        }

        // Non-reviewed tasks: merge branch immediately so artifacts land on main.
        // Reviewed tasks merge in onReviewPassed after Vigil approves.
        if (taskId !== undefined && this.branchManager !== null) {
            await this.mergeTaskBranch(taskId);
        }

        // Dispatch any tasks that were waiting on this one
        await this.dispatchReadyTasks(projectId);

        // Check if phase is complete
        await this.checkPhaseGate(projectId);
    }

    /**
     * Dispatch all pending tasks whose dependencies are now satisfied.
     * Each task acquires a pool slot before routing and releases it on completion/failure.
     */
    private async dispatchReadyTasks(projectId: string): Promise<void> {
        const { readyIds } = await this.dependencyResolver.getReadyTasks(projectId);

        for (const taskId of readyIds) {
            await this.taskPool.acquire();

            // Fire-and-forget: dispatch runs concurrently, pool slot released when done
            this.router.routeTask(taskId)
                .catch((err) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    log.error({ err: msg, taskId }, 'Failed to dispatch ready task');
                })
                .finally(() => {
                    this.taskPool.release();
                });
        }
    }

    /**
     * Periodic sweep: find ALL active projects with pending tasks and dispatch
     * any whose dependencies are now satisfied. This catches tasks missed due to
     * lost events, race conditions, or EventBus glitches.
     */
    private async sweepPendingTasks(): Promise<void> {
        if (!this.running) return;

        try {
            // When focused (e.g. headless run), only sweep that project so we
            // never pick up orphan tasks from older active projects.
            if (this.focusProjectId !== null) {
                await this.dispatchReadyTasks(this.focusProjectId);
                return;
            }

            const { rows: activeProjects } = await query<{ id: string }>(
                `SELECT id FROM projects WHERE status = 'active'`
            );

            for (const project of activeProjects) {
                await this.dispatchReadyTasks(project.id);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg }, 'Dispatch sweep failed');
        }
    }

    /**
     * Check phase gate and handle transitions. Serialized per project to
     * prevent concurrent task.completed handlers from each racing to
     * advance the phase (the atomic UPDATE alone is not enough — two
     * callers reading the phase at different times can still each
     * advance it, one step apart).
     */
    private async checkPhaseGate(projectId: string): Promise<void> {
        const prev = this.phaseGateLocks.get(projectId) ?? Promise.resolve();
        const next = prev.then(() => this.checkPhaseGateInner(projectId));
        // Always clear after completion; swallow errors here so the chain
        // doesn't permanently poison future checks for this project.
        this.phaseGateLocks.set(
            projectId,
            next.catch(() => undefined)
        );
        await next;
    }

    private async checkPhaseGateInner(projectId: string): Promise<void> {
        const gateStatus = await this.gateManager.checkGate(projectId);

        // F-368: project is in awaiting-input (reopened, no new work). Gate
        // evaluation is a no-op until a follow-up brief decomposes new tasks.
        // Without this guard, the gate logic below would surface an approval
        // modal whose only outcome is to instantly re-complete the project.
        if (gateStatus.alreadyComplete === true) {
            log.info(
                { projectId, currentPhase: gateStatus.currentPhase },
                'Phase gate no-op: project is awaiting-input',
            );
            return;
        }

        if (gateStatus.allTasksComplete) {
            if (gateStatus.canAutoAdvance) {
                // Auto-advance. The gate has already run here, so advance
                // directly rather than via approveGate() (which would re-run
                // checkGate → a redundant build verification).
                await this.advanceToNextPhase(projectId);
                return;
            }

            // Run the development exit-gate chain (build → deploy-preview →
            // acceptance → credential copilot). When it took an action that must
            // complete first, it returns 'deferred' and we stop here — the
            // scheduled work re-drives the gate on its next completion. BPF-1:
            // this same chain is now also invoked by manual approveGate() so the
            // GUI flow can't bypass deploy/credential by approving early.
            const decision = await this.resolveDevelopmentExitGate(projectId, gateStatus);
            if (decision === 'deferred') return;

            if (gateStatus.requiresApproval) {
                // Exit gate is clean — request human approval to advance.
                await this.gateManager.requestApproval(projectId);

                // Notify via comms channels
                const projectName = await this.getProjectName(projectId);
                await this.sendCommsNotification(
                    projectId,
                    `Approval Required: ${projectName}`,
                    `Phase "${gateStatus.currentPhase}" is complete for project "${projectName}". ` +
                    `Human approval is required to proceed to the next phase.`
                );
            }
        }
    }

    /**
     * BPF-1: the development exit-gate decision, shared by the autonomous gate
     * (`checkPhaseGateInner`) and manual approval (`approveGate`). A build
     * failure, a pending deploy-preview, an acceptance failure, or a missing app
     * credential each trigger the appropriate remediation/scheduling and return
     * `'deferred'` — the scheduled work re-drives the gate when it completes.
     * Returns `'advance'` when the exit is clean (build passed, preview shipped
     * for build-tests-preview bundles, acceptance passed).
     *
     * For non-development phases the gate status carries no build/acceptance
     * result (those gates only run for `development && allTasksComplete`), so
     * every branch is skipped and this returns `'advance'` — preserving prior
     * advance-on-approval behaviour for discovery/poc/etc.
     */
    /**
     * BPF-6 — tell the Command Center WHY a development-gate approval deferred.
     * Every defer point publishes this so clicking "Approve" never silently does
     * nothing: the renderer shows the human-readable `message` as a toast.
     * Fail-safe — a publish error never blocks the gate logic.
     */
    private async emitGateDeferred(
        projectId: string,
        kind: 'pending-tasks' | 'build-failing' | 'deploy-pending' | 'acceptance-failing' | 'credential-needed',
        message: string,
    ): Promise<void> {
        try {
            await this.eventBus.publish('gate.deferred', {
                projectId,
                agent: 'sensei',
                data: { kind, message },
            });
        } catch (err) {
            log.warn(
                { projectId, err: err instanceof Error ? err.message : String(err) },
                'gate.deferred emit failed',
            );
        }
    }

    private async resolveDevelopmentExitGate(
        projectId: string,
        gateStatus: Awaited<ReturnType<PhaseGateManager['checkGate']>>
    ): Promise<'advance' | 'deferred'> {
        if (gateStatus.buildVerificationPassed === false) {
            // MCC-8 Slice 4: surface any MISSING app credential the failure might
            // need (e.g. the app can't build without DATABASE_URL).
            const credentialRaised = await this.setupCopilotGate.maybeRaise(projectId);
            // BPF-15: ALWAYS route the build failure through the build-fix Forge
            // task too — an unrelated credential gap must NOT mask a genuine code
            // build error. Previously the copilot short-circuited here, so a
            // failure like a TypeScript error never reached Forge until the
            // operator happened to provide an (unrelated) credential. The task has
            // its own in-flight guard + retry budget, so this is safe to always
            // call. P2-03 (D-08, D-09).
            await this.createBuildRemediationTask(projectId, gateStatus);
            await this.emitGateDeferred(
                projectId,
                credentialRaised ? 'credential-needed' : 'build-failing',
                credentialRaised
                    ? 'A credential is needed AND Forge is fixing the build — open the Credentials panel, then Approve again.'
                    : 'The build is failing — Forge is working on a fix. Approve again once the build passes.',
            );
            return 'deferred';
        }

        if (
            gateStatus.bundleAcceptanceKind === 'build-tests-preview' &&
            gateStatus.buildVerificationPassed === true &&
            (gateStatus.previewUrl === undefined || gateStatus.previewUrl.length === 0)
        ) {
            // BPF-7: "run locally / no hosting" — the operator just wants a
            // working app on their machine. Skip the cloud deploy-preview
            // requirement entirely; a green build + tests is enough to finish
            // development. The app still builds/runs and the scaffold ships a
            // SETUP.md explaining how to start it locally. Without this, a
            // missing Vercel token/deploy blocks the phase forever.
            if (isHostingDisabled()) {
                await this.sendCommsNotification(
                    projectId,
                    `Finishing development (run-locally): ${await this.getProjectName(projectId)}`,
                    HOSTING_DISABLED_MESSAGE,
                );
                log.info({ projectId }, 'BPF-7: hosting disabled — skipping deploy-preview, advancing on build+tests');
                return 'advance';
            }
            // P2-05: bundle declares the v2 acceptance gate but no preview URL is
            // set yet. Schedule a deploy-preview task so Aegis ships the workspace
            // to Vercel; the next gate check sees the populated URL and runs v2.
            await this.scheduleDeployPreviewTask(projectId, gateStatus);
            await this.emitGateDeferred(
                projectId,
                'deploy-pending',
                'Build passed — Aegis is shipping a deploy preview. Approve again once the preview URL is live.',
            );
            return 'deferred';
        }

        if (gateStatus.acceptancePassed === false && gateStatus.acceptanceViolations !== undefined) {
            // MCC-8 Slice 4: a missing app credential can fail acceptance too
            // (e.g. the app can't render without its DB/auth keys). Prompt for it
            // before remediating with Forge.
            if (await this.setupCopilotGate.maybeRaise(projectId)) {
                await this.emitGateDeferred(
                    projectId,
                    'credential-needed',
                    'A credential is needed before acceptance can pass — open the Credentials panel to provide it, then Approve again.',
                );
                return 'deferred';
            }
            // Acceptance gate failed — create a remediation task for Forge.
            await this.createAcceptanceRemediationTask(projectId, gateStatus);
            await this.emitGateDeferred(
                projectId,
                'acceptance-failing',
                'Acceptance checks are failing — Forge is working on a fix. Approve again once they pass.',
            );
            return 'deferred';
        }

        return 'advance';
    }

    /**
     * P2-03 (D-09): default retry budget for the build-fix dispatch loop.
     * Override per run via KAGEOPS_MAX_BUILD_RETRIES (clamped [0,10]; 0 =
     * escalate to a human on the first failure). See retry-budget.ts.
     */
    private static readonly DEFAULT_BUILD_RETRIES = 2;

    /** P2-05: default retry budget for the deploy-preview scheduling loop. Override via KAGEOPS_MAX_DEPLOY_PREVIEW_RETRIES. */
    private static readonly DEFAULT_DEPLOY_PREVIEW_RETRIES = 2;

    /** Default retry budget for the acceptance-fix loop. Override via KAGEOPS_MAX_ACCEPTANCE_RETRIES. */
    private static readonly DEFAULT_ACCEPTANCE_RETRIES = 2;
    /** Tag name applied to the best-known artifact during the acceptance loop. */
    private static readonly BEST_ATTEMPT_TAG = 'agent/forge/best-attempt';

    /**
     * If the current violation count is the lowest we've seen for this
     * project, tag the workspace HEAD as `agent/forge/best-attempt`.
     * Force-updated so the tag walks forward only on improvement.
     *
     * Returns the previous best (or +Infinity if none) so callers can
     * log the delta. Failure to tag is non-fatal — the best-attempt
     * is a recovery aid, not a correctness boundary.
     */
    private async maybeSnapshotBest(
        projectId: string,
        currentViolations: number,
    ): Promise<number> {
        const previousBest = this.bestAcceptanceViolations.get(projectId) ?? Number.POSITIVE_INFINITY;
        if (currentViolations >= previousBest) return previousBest;

        // First improvement is always tagged. Subsequent improvements
        // overwrite. The repo lock inside BranchManager.runGit serializes
        // against any concurrent checkout from a per-task branch.
        if (this.branchManager !== null) {
            const repoPath = await this.getProjectRepoPath(projectId);
            if (repoPath !== null) {
                try {
                    await this.branchManager.createTag(repoPath, Sensei.BEST_ATTEMPT_TAG);
                    log.info(
                        { projectId, previousBest, currentViolations, tag: Sensei.BEST_ATTEMPT_TAG },
                        'Snapshotted best-known acceptance state',
                    );
                } catch (err) {
                    log.warn(
                        { projectId, err: err instanceof Error ? err.message : String(err) },
                        'Failed to tag best-attempt — continuing without snapshot',
                    );
                }
            }
        }
        this.bestAcceptanceViolations.set(projectId, currentViolations);
        return previousBest;
    }

    /**
     * Restore HEAD to the best-attempt tag if one exists. Used on
     * retry-cap exhaustion so the operator inherits the least-broken
     * artifact instead of the last attempt's regression.
     *
     * Returns true if the restore succeeded, false otherwise.
     */
    private async restoreBestAttempt(projectId: string): Promise<boolean> {
        if (this.branchManager === null) return false;
        const repoPath = await this.getProjectRepoPath(projectId);
        if (repoPath === null) return false;

        try {
            const exists = await this.branchManager.tagExists(repoPath, Sensei.BEST_ATTEMPT_TAG);
            if (!exists) return false;
            await this.branchManager.checkoutTag(repoPath, Sensei.BEST_ATTEMPT_TAG);
            log.info(
                { projectId, tag: Sensei.BEST_ATTEMPT_TAG },
                'Restored workspace to best-known acceptance state',
            );
            return true;
        } catch (err) {
            log.warn(
                { projectId, err: err instanceof Error ? err.message : String(err) },
                'Failed to restore best-attempt — leaving HEAD as-is',
            );
            return false;
        }
    }

    private async getProjectRepoPath(projectId: string): Promise<string | null> {
        const row = await getOne<{ repo_path: string | null }>(
            'SELECT repo_path FROM projects WHERE id = $1',
            [projectId],
        );
        return row?.repo_path ?? null;
    }

    /**
     * P2-03 (D-08, D-09): turn a BuildVerificationGate failure into a
     * `build-fix` Forge task with diff context + the build error log.
     * Mirrors createAcceptanceRemediationTask: in-flight guard, retry-cap
     * guard, exhaustion → human approval. Counts terminal-state tasks
     * (completed | failed) toward MAX_BUILD_RETRIES.
     *
     * Inputs come from gateStatus.buildFailedStep + gateStatus.buildFailedStderr,
     * populated by PhaseGateManager.checkGate when build verification fails.
     * If either is missing (defensive — shouldn't happen given the dispatch
     * site only calls this on buildVerificationPassed === false), fall back
     * to requestApproval rather than emitting a malformed task.
     */
    private async createBuildRemediationTask(
        projectId: string,
        gateStatus: Awaited<ReturnType<PhaseGateManager['checkGate']>>
    ): Promise<void> {
        const failedStep = gateStatus.buildFailedStep;
        const stderr = gateStatus.buildFailedStderr ?? '';

        if (failedStep === undefined) {
            log.warn(
                { projectId },
                'P2-03: build failure dispatch called without failedStep — falling back to approval'
            );
            await this.gateManager.requestApproval(
                projectId,
                'build verification failed (details unavailable)'
            );
            return;
        }

        // In-flight guard: don't create a second build-fix while one is
        // still pending/assigned. Prevents duplicate dispatches when the
        // gate is polled concurrently.
        const inFlight = await getOne<{ in_flight: string }>(
            `SELECT COUNT(*) AS in_flight FROM tasks
             WHERE project_id = $1 AND task_type = 'build-fix'
               AND status IN ('pending', 'assigned')`,
            [projectId]
        );
        if (parseInt(inFlight?.in_flight ?? '0', 10) > 0) {
            log.debug({ projectId }, 'P2-03: build-fix already in flight — skipping');
            return;
        }

        // Retry-cap guard: terminal-state count toward MAX_BUILD_RETRIES.
        const finished = await getOne<{ finished_count: string }>(
            `SELECT COUNT(*) AS finished_count FROM tasks
             WHERE project_id = $1 AND task_type = 'build-fix'
               AND status IN ('completed', 'failed')`,
            [projectId]
        );
        const finishedCount = parseInt(finished?.finished_count ?? '0', 10);
        const maxBuildRetries = resolveRetryBudget(RETRY_ENV.build, Sensei.DEFAULT_BUILD_RETRIES);
        if (finishedCount >= maxBuildRetries) {
            log.warn(
                { projectId, finishedCount, maxBuildRetries, failedStep },
                'P2-03: build-fix retry limit reached — requesting human approval'
            );
            await this.gateManager.requestApproval(
                projectId,
                `build verification still failing at step "${failedStep}" after ${finishedCount} fix attempts`
            );
            const projectName = await this.getProjectName(projectId);
            await this.sendCommsNotification(
                projectId,
                `Build Failed: ${projectName}`,
                `Build verification still failing at step "${failedStep}" for project "${projectName}" ` +
                `after ${finishedCount} fix attempts. Manual intervention required.`
            );
            return;
        }

        const description =
            `${describeFailedStep(failedStep)} during build verification. ` +
            `Read the workspace as authoritative — the scaffold is committed and the previous tasks ` +
            `produced the current files. Edit in place to fix the build error below; do NOT rewrite ` +
            `unrelated files. After your fix, the gate will re-run \`npm install\` + \`npm run build\` + ` +
            `\`npm test\` and re-dispatch this task with a fresh log if any step still fails ` +
            `(retry ${finishedCount + 1}/${maxBuildRetries}).\n\n` +
            `Failed step: ${failedStep}\n` +
            `Stderr (truncated to 4000 chars):\n\`\`\`\n${stderr || '(no stderr captured)'}\n\`\`\`\n\n` +
            `When you re-emit files, return their FULL contents — partial diffs will not be applied.`;

        const result = await query<{ id: string }>(
            `INSERT INTO tasks (project_id, title, description, task_type, phase, assigned_agent, status)
             VALUES ($1, $2, $3, 'build-fix', 'development', 'forge', 'pending')
             RETURNING id`,
            [
                projectId,
                `Fix build failure at step "${failedStep}"`,
                description,
            ]
        );

        const taskId = result.rows[0].id;
        log.info(
            { projectId, taskId, failedStep, attempt: finishedCount + 1 },
            'P2-03: created build remediation task'
        );

        await this.router.routeTask(taskId);

        await this.eventBus.publish('task.created', {
            projectId,
            taskId,
            agent: 'sensei',
            data: { title: 'Fix build failure', failedStep, attempt: finishedCount + 1 },
        });
    }

    /**
     * P2-05: schedule an Aegis deploy-preview task when the bundle declares
     * the build-tests-preview acceptance kind, the build verifier has passed,
     * and no preview_url is set yet. Aegis (see specialists/aegis.ts) handles
     * the actual deployment + persists projects.preview_url on success.
     *
     * In-flight guard prevents duplicate dispatches. Retry budget enforces
     * MAX_DEPLOY_PREVIEW_RETRIES — on exhaustion, escalate to human approval
     * (e.g. Vercel token misconfigured, project disabled at Vercel, etc.).
     */
    private async scheduleDeployPreviewTask(
        projectId: string,
        gateStatus: Awaited<ReturnType<PhaseGateManager['checkGate']>>
    ): Promise<void> {
        // In-flight guard
        const inFlight = await getOne<{ in_flight: string }>(
            `SELECT COUNT(*) AS in_flight FROM tasks
             WHERE project_id = $1 AND task_type = 'deploy-preview'
               AND status IN ('pending', 'assigned')`,
            [projectId]
        );
        if (parseInt(inFlight?.in_flight ?? '0', 10) > 0) {
            log.debug({ projectId }, 'P2-05: deploy-preview already in flight — skipping');
            return;
        }

        // Retry-cap guard
        const finished = await getOne<{ finished_count: string }>(
            `SELECT COUNT(*) AS finished_count FROM tasks
             WHERE project_id = $1 AND task_type = 'deploy-preview'
               AND status IN ('completed', 'failed')`,
            [projectId]
        );
        const finishedCount = parseInt(finished?.finished_count ?? '0', 10);
        const maxDeployRetries = resolveRetryBudget(RETRY_ENV.deployPreview, Sensei.DEFAULT_DEPLOY_PREVIEW_RETRIES);
        if (finishedCount >= maxDeployRetries) {
            log.warn(
                { projectId, finishedCount, maxDeployRetries },
                'P2-05: deploy-preview retry limit reached — requesting human approval'
            );
            await this.gateManager.requestApproval(
                projectId,
                `deploy-preview failed after ${finishedCount} attempts — Vercel token, ` +
                `project access, or scaffold dependencies likely need manual attention`
            );
            return;
        }

        const description =
            `Deploy the project workspace to Vercel as a preview build (--prebuilt --yes). ` +
            `The current bundle declares acceptance.kind = 'build-tests-preview', so the ` +
            `AcceptanceGate v2 needs the preview URL to run its HTTP 200 checks. On success, ` +
            `Aegis persists the URL to projects.preview_url and the next gate check runs the ` +
            `v2 acceptance flow.\n\n` +
            `Retry ${finishedCount + 1}/${maxDeployRetries}.`;

        const result = await query<{ id: string }>(
            `INSERT INTO tasks (project_id, title, description, task_type, phase, assigned_agent, status)
             VALUES ($1, $2, $3, 'deploy-preview', 'development', 'aegis', 'pending')
             RETURNING id`,
            [
                projectId,
                'Deploy preview to Vercel',
                description,
            ]
        );

        const taskId = result.rows[0].id;
        log.info(
            { projectId, taskId, attempt: finishedCount + 1 },
            'P2-05: scheduled deploy-preview task'
        );

        await this.router.routeTask(taskId);

        await this.eventBus.publish('task.created', {
            projectId,
            taskId,
            agent: 'sensei',
            data: {
                title: 'Deploy preview to Vercel',
                attempt: finishedCount + 1,
                gateKind: gateStatus.bundleAcceptanceKind,
            },
        });
    }

    private async createAcceptanceRemediationTask(
        projectId: string,
        gateStatus: Awaited<ReturnType<PhaseGateManager['checkGate']>>
    ): Promise<void> {
        const allViolations = gateStatus.acceptanceViolations ?? [];

        // Two-tier rules: only MUST violations block the gate / trigger
        // remediation. SHOULD violations are advisory — the gate logs
        // them and advances. Forge should only ever be asked to fix
        // MUST violations; throwing SHOULD-only fixes at it tends to
        // cause regression on the parts that already pass.
        const violations = allViolations.filter((v) => v.severity !== 'should');
        const shouldOnlyCount = allViolations.length - violations.length;

        if (violations.length === 0) {
            // Acceptance passed in MUST terms. The phase will advance on
            // the next gate check; this remediation creator is a no-op.
            // (We don't expect to land here often — the gate itself sets
            // passed=true when MUST violations are zero — but if we're
            // called via a stale gateStatus we should return cleanly.)
            log.info(
                { projectId, shouldOnlyCount },
                'No MUST violations — skipping remediation task creation'
            );
            return;
        }

        // Snapshot-on-improvement: if this evaluation has fewer (MUST)
        // violations than any prior attempt for this project, tag the
        // workspace HEAD as `agent/forge/best-attempt`. The retry loop
        // is allowed to regress (Forge sometimes makes things worse
        // trying to fix the last 5%), so we keep a recoverable pointer
        // to the best version.
        //
        // Skip the snapshot if the artifact is structurally absent —
        // a missing-artifact violation means the page itself doesn't
        // exist on disk. Tagging that state as "best" then restoring
        // to it after retries fail leaves the operator with an empty
        // scaffold (see kageops-landing-premium-v7 post-mortem).
        const hasMissingArtifact = violations.some((v) => v.check === 'missing-artifact');
        if (!hasMissingArtifact) {
            await this.maybeSnapshotBest(projectId, violations.length);
        } else {
            log.info(
                { projectId, currentViolations: violations.length },
                'Skipping snapshot — artifact is missing, not a recoverable state'
            );
        }

        // In-flight guard: never create a remediation task while another one
        // is still pending/assigned — prevents duplicate dispatches on
        // concurrent gate checks.
        const inFlight = await getOne<{ in_flight: string }>(
            `SELECT COUNT(*) AS in_flight FROM tasks
             WHERE project_id = $1 AND task_type = 'acceptance-fix'
               AND status IN ('pending', 'assigned')`,
            [projectId]
        );
        if (parseInt(inFlight?.in_flight ?? '0', 10) > 0) {
            log.debug({ projectId }, 'Acceptance remediation already in flight — skipping');
            return;
        }

        // Retry-cap guard: count tasks that reached a terminal state to bound
        // the retry budget. After MAX_ACCEPTANCE_RETRIES completions/failures,
        // escalate to human approval.
        const finished = await getOne<{ finished_count: string }>(
            `SELECT COUNT(*) AS finished_count FROM tasks
             WHERE project_id = $1 AND task_type = 'acceptance-fix'
               AND status IN ('completed', 'failed')`,
            [projectId]
        );
        const finishedCount = parseInt(finished?.finished_count ?? '0', 10);
        const maxAcceptanceRetries = resolveRetryBudget(RETRY_ENV.acceptance, Sensei.DEFAULT_ACCEPTANCE_RETRIES);
        if (finishedCount >= maxAcceptanceRetries) {
            // Before escalating, restore the best-known artifact. The current
            // HEAD may be a regression — the operator should inherit the
            // least-broken version we ever produced, not the last attempt.
            const restored = await this.restoreBestAttempt(projectId);
            const bestCount = this.bestAcceptanceViolations.get(projectId);
            log.warn(
                { projectId, finishedCount, maxAcceptanceRetries, restored, bestViolations: bestCount },
                'Acceptance remediation limit reached — requesting human approval'
            );
            // Refusal is a first-class terminal outcome, not a prose string.
            // The violation objects survive intact so the UI can offer the
            // right verbs and the next planner turn reads structure rather
            // than re-parsing English. See src/shared/refusal.ts.
            const refusal = createRefusal({
                reason: 'acceptance-violations',
                projectId,
                phase: 'development',
                attemptsMade: finishedCount,
                details: violations.map((v) => ({
                    check: v.check,
                    expected: v.expected,
                    message: v.message,
                    severity: v.severity,
                })),
                ...(restored && bestCount !== undefined
                    ? { bestAttempt: { violations: bestCount, restored } }
                    : {}),
            });
            await this.gateManager.requestApproval(projectId, refusal.summary, refusal);
            return;
        }

        const violationSummary = violations
            .map((v) => `- ${v.check}: expected "${v.expected}" — ${v.message}`)
            .join('\n');

        // Build violation-specific guidance so the retry prompt tells
        // Forge exactly how to address each failure kind, not just
        // "fix the IDs". Without this, Forge tends to re-emit the same
        // broken output (especially missing-asset where it keeps the
        // <link> tag without ever creating the file).
        const guidance = buildViolationGuidance(violations);

        // Wave 5 Day 1: include the existing styles.css class names in
        // the remediation prompt. v5 produced a working pipeline but
        // the acceptance-fix retry rewrote index.html with different
        // class names (.sigil-card) than the existing CSS (.agent-card).
        // Visual layout collapsed to default block flow even though
        // every required ID was present.
        const cssContext = await this.gatherCssContext(projectId);

        const result = await query<{ id: string }>(
            `INSERT INTO tasks (project_id, title, description, task_type, phase, assigned_agent, status)
             VALUES ($1, $2, $3, 'acceptance-fix', 'development', 'forge', 'pending')
             RETURNING id`,
            [
                projectId,
                'Fix acceptance violations in index.html',
                `The acceptance gate found spec-fidelity violations in the produced artifact.\n\n` +
                `Violations:\n${violationSummary}\n\n` +
                `${guidance}\n\n` +
                `${cssContext}` +
                `When you re-emit files, return their FULL contents — partial diffs will not be applied. ` +
                `Every <link href> and <script src> in your HTML must point to a file you actually emit ` +
                `or that already exists in the project. Do NOT rename element IDs — use the exact IDs ` +
                `listed above as "expected". If you change ANY HTML class names, you MUST also re-emit ` +
                `styles.css with matching rules in the same response — don't break the existing layout.`,
            ]
        );

        const taskId = result.rows[0].id;
        log.info({ projectId, taskId, violationCount: violations.length }, 'Created acceptance remediation task');

        await this.router.routeTask(taskId);

        await this.eventBus.publish('task.created', {
            projectId,
            taskId,
            agent: 'sensei',
            data: { title: 'Fix acceptance violations', violationCount: violations.length },
        });
    }

    /**
     * Wave 5 Day 1: build a context block from the existing styles.css so
     * the acceptance-fix retry can keep HTML class names consistent with
     * the layout rules already on disk. Returns an empty string if
     * styles.css doesn't exist or is unreadable.
     */
    private async gatherCssContext(projectId: string): Promise<string> {
        try {
            const project = await getOne<{ repo_path: string | null }>(
                'SELECT repo_path FROM projects WHERE id = $1',
                [projectId],
            );
            if (project?.repo_path === null || project?.repo_path === undefined) return '';

            const fs = await import('fs');
            const path = await import('path');
            const cssPath = path.default.join(project.repo_path, 'styles.css');
            if (!fs.default.existsSync(cssPath)) return '';

            const css = fs.default.readFileSync(cssPath, 'utf-8');
            // Extract class selector tokens (simple regex — good enough
            // for the prompt, falls back to "no classes" if file is huge).
            const classMatches = css.match(/\.([a-zA-Z][a-zA-Z0-9_-]+)/g) ?? [];
            const uniqueClasses = [...new Set(classMatches.map((s) => s.slice(1)))].sort();
            if (uniqueClasses.length === 0) return '';

            // Cap the list so very large stylesheets don't blow up the prompt.
            const previewClasses = uniqueClasses.slice(0, 60);
            const moreNote = uniqueClasses.length > previewClasses.length
                ? ` (+${uniqueClasses.length - previewClasses.length} more)`
                : '';

            return (
                `EXISTING styles.css class names (your HTML MUST use these — or re-emit styles.css):\n` +
                previewClasses.map((c) => `  .${c}`).join('\n') +
                `${moreNote}\n\n`
            );
        } catch {
            return '';
        }
    }

    /**
     * Determine if a completed task should trigger a Vigil review.
     */
    private isReviewableTask(taskType: string, phase: string): boolean {
        const reviewableTypes = new Set([
            'implement', 'refactor', 'fix-bug', 'create-api', 'create-ui',
            'database-migration', 'api-design', 'database-design', 'architecture',
        ]);
        const reviewablePhases = new Set(['poc', 'development']);

        return reviewableTypes.has(taskType) && reviewablePhases.has(phase);
    }

    /**
     * Create a code-review task for Vigil after a reviewable task completes.
     * Returns true if a review task was created, false if skipped (e.g., max reviews reached).
     */
    private async createReviewTask(
        projectId: string,
        originalTaskId: string,
        originalTaskType: string
    ): Promise<boolean> {
        // Check how many review tasks already exist for this original task
        const existing = await getOne<{ review_count: string }>(
            `SELECT COUNT(*) AS review_count FROM tasks
             WHERE project_id = $1 AND task_type = 'code-review'
             AND description LIKE $2`,
            [projectId, `%[review-of:${originalTaskId}]%`]
        );

        const reviewCount = parseInt(existing?.review_count ?? '0', 10);
        if (reviewCount >= MAX_REVIEW_ROUNDS) {
            log.info({ taskId: originalTaskId, reviewCount }, 'Skipping review — already reviewed maximum times');
            return false;
        }

        // Create review task
        const result = await query<{ id: string }>(
            `INSERT INTO tasks (project_id, title, description, task_type, phase, assigned_agent, status, output_path)
             VALUES ($1, $2, $3, 'code-review', 'development', 'vigil', 'pending', $4)
             RETURNING id`,
            [
                projectId,
                `Code review: ${originalTaskType} task`,
                `Review the output of ${originalTaskType} task. [review-of:${originalTaskId}]`,
                `docs/reviews/review-${originalTaskId}.md`,
            ]
        );

        const reviewTaskId = result.rows[0].id;
        log.info({ reviewTaskId, originalTaskId }, 'Created review task');

        // Route review task immediately
        await this.router.routeTask(reviewTaskId);

        // Publish review.requested event
        await this.eventBus.publish('review.requested', {
            projectId,
            taskId: reviewTaskId,
            agent: 'sensei',
            data: { originalTaskId, originalTaskType },
        });

        return true;
    }

    private async onTaskFailed(event: EventPayload): Promise<void> {
        const { projectId, taskId, agent } = event;
        if (taskId === undefined) return;

        const data = event.data as Record<string, unknown>;
        const errorMessage = typeof data.errorMessage === 'string' ? data.errorMessage : 'Unknown error';
        const isBudgetExceeded = data.isBudgetExceeded === true;

        // Update speciality matrix with failure
        const task = await getOne<{ task_type: string; retry_count: number }>(
            'SELECT task_type, retry_count FROM tasks WHERE id = $1',
            [taskId]
        );

        if (task !== null && agent !== undefined) {
            await this.matrix.recordTaskOutcome(agent, task.task_type, false);
        }

        // Post-task reflector — write an incident row (fire-and-forget)
        if (agent !== undefined) {
            const taskRow = await getOne<{ title: string; task_type: string | null }>(
                'SELECT title, task_type FROM tasks WHERE id = $1',
                [taskId]
            );
            void reflectOnFailure({
                projectId: projectId ?? null,
                taskId,
                agent,
                taskType: taskRow?.task_type ?? null,
                taskTitle: taskRow?.title ?? '(unknown)',
                errorMessage,
            }).catch((err) => {
                log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Reflector failed');
            });
        }

        // BudgetExceededError — skip retry, escalate immediately (v0.6)
        if (isBudgetExceeded) {
            log.warn({ taskId }, 'Task failed due to budget exceeded. Escalating to human');
            await this.parkProjectForApproval(projectId);
            await this.eventBus.publish('approval.required', {
                projectId: projectId ?? undefined,
                taskId,
                agent: 'sensei',
                data: {
                    reason: 'Budget exceeded — cannot retry',
                    errorMessage,
                },
            });

            const projectName = projectId !== undefined
                ? await this.getProjectName(projectId)
                : 'Unknown project';
            await this.sendCommsNotification(
                projectId ?? null,
                `Budget Exceeded: ${projectName}`,
                `Task ${taskId} cannot proceed — project budget is exceeded. ` +
                `Error: ${errorMessage}. Increase the budget or complete the project manually.`
            );
            return;
        }

        // ④ Pause-don't-fail on a credential/auth error. Retrying a 401 /
        // missing-or-invalid key just burns the retry budget — the key
        // won't appear by re-running. Pause the project and surface the
        // SPECIFIC missing credential via the setup copilot instead. With
        // output checkpoints on (③), the resume after the operator adds
        // the key replays completed work at ~0 tokens. We do NOT consume
        // retries here; the task stays 'failed' and a resume / retry
        // re-dispatches it once the credential is in place.
        if (isCredentialError(errorMessage)) {
            log.warn(
                { taskId, projectId },
                'Task failed on a credential/auth error — pausing for setup (no retry burn)',
            );
            await this.parkProjectForApproval(projectId);

            let surfaced = false;
            if (projectId !== undefined) {
                try {
                    surfaced = await this.setupCopilotGate.maybeRaise(projectId);
                } catch (err) {
                    log.warn(
                        { err: err instanceof Error ? err.message : String(err), projectId },
                        'setup copilot raise failed during credential pause',
                    );
                }
            }
            if (!surfaced) {
                // Fallback so the operator still sees WHY it paused even if
                // the copilot couldn't pin the exact credential.
                await this.eventBus.publish('approval.required', {
                    projectId: projectId ?? undefined,
                    taskId,
                    agent: 'sensei',
                    data: {
                        reason: 'Paused — a provider/app credential is missing or invalid. ' +
                            'Add the key, then resume (completed work is cached, no tokens re-spent).',
                        errorMessage,
                    },
                });
            }

            const projectName = projectId !== undefined
                ? await this.getProjectName(projectId)
                : 'Unknown project';
            await this.sendCommsNotification(
                projectId ?? null,
                `Credential needed: ${projectName}`,
                `Task ${taskId} is paused — a credential is missing or invalid (${errorMessage}). ` +
                `Add it, then resume; completed work is cached and won't be re-run.`,
            );
            return;
        }

        // Tiered retry strategy
        if (task !== null && task.retry_count < MAX_TASK_RETRIES) {
            await this.retryTask(taskId, task.retry_count);
        } else {
            // Escalate to human
            log.warn({ taskId }, 'Task exhausted all retries. Escalating to human');
            await this.parkProjectForApproval(projectId);
            await this.eventBus.publish('approval.required', {
                projectId: projectId ?? undefined,
                taskId,
                agent: 'sensei',
                data: {
                    reason: 'Task failed after maximum retries',
                    errorMessage,
                },
            });

            // Urgent comms notification for exhausted retries
            const projectName = projectId !== undefined
                ? await this.getProjectName(projectId)
                : 'Unknown project';
            await this.sendCommsNotification(
                projectId ?? null,
                `Task Failed: ${projectName}`,
                `Task ${taskId} has failed after ${MAX_TASK_RETRIES} retries. ` +
                `Error: ${String(errorMessage)}. Human intervention required.`
            );
        }
    }

    /**
     * Park a project in `'awaiting-approval'` so the UI stops showing it as
     * an actively-running project when the orchestrator is blocked on human
     * input. Only transitions from 'active' — already-terminal states
     * (completed, cancelled, archived) are left untouched.
     *
     * retryFailedTasks and approveGate flip it back to 'active' on resolve.
     */
    private async parkProjectForApproval(projectId: string | undefined): Promise<void> {
        if (projectId === undefined) return;
        try {
            await query(
                `UPDATE projects
                 SET status = 'awaiting-approval',
                     updated_at = NOW()
                 WHERE id = $1 AND status = 'active'`,
                [projectId],
            );
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err), projectId },
                'parkProjectForApproval failed',
            );
        }
    }

    private async onTaskBlocked(event: EventPayload): Promise<void> {
        const { projectId, taskId } = event;
        if (taskId === undefined) return;

        const task = await getOne<{ depends_on: readonly string[] | null }>(
            'SELECT depends_on FROM tasks WHERE id = $1',
            [taskId]
        );

        const deps = task?.depends_on ?? [];
        log.info(
            { taskId, dependencies: deps },
            'Task is blocked. Will auto-dispatch when dependencies complete'
        );
    }

    private async onApprovalGranted(event: EventPayload): Promise<void> {
        // Already handled by approveGate — this is for monitoring
        log.info({ projectId: event.projectId }, 'Approval granted');
    }

    private async onApprovalDenied(event: EventPayload): Promise<void> {
        log.info(
            { projectId: event.projectId, reason: (event.data as Record<string, unknown>).reason },
            'Approval denied'
        );
    }

    // ── Review Handlers ──────────────────────────────

    private async onReviewPassed(event: EventPayload): Promise<void> {
        const { projectId, taskId } = event;
        const data = event.data as Record<string, unknown>;
        const qualityScore = typeof data.qualityScore === 'number' ? data.qualityScore : null;

        log.info({ taskId, qualityScore: qualityScore ?? 'unknown' }, 'Review passed');

        // Find the original task from the review task
        let originalTaskId: string | null = null;
        if (taskId !== undefined) {
            const description = await getOne<{ description: string }>(
                'SELECT description FROM tasks WHERE id = $1',
                [taskId]
            );
            const originalTaskIdMatch = description?.description?.match(/\[review-of:([^\]]+)\]/);
            if (originalTaskIdMatch !== null && originalTaskIdMatch !== undefined) {
                originalTaskId = originalTaskIdMatch[1];

                // Update quality score on the original task
                if (qualityScore !== null) {
                    await query(
                        'UPDATE tasks SET quality_score = $1 WHERE id = $2',
                        [qualityScore, originalTaskId]
                    );
                }
            }
        }

        // Merge the task branch into main (v0.6)
        if (this.branchManager !== null && originalTaskId !== null) {
            await this.mergeTaskBranch(originalTaskId);
        }

        // Check phase gate now that review is done
        if (projectId !== undefined) {
            await this.checkPhaseGate(projectId);
        }
    }

    private async onReviewRejected(event: EventPayload): Promise<void> {
        const { projectId, taskId } = event;
        const data = event.data as Record<string, unknown>;
        const summary = typeof data.summary === 'string' ? data.summary : 'Quality issues found';

        log.info({ taskId, summary }, 'Review rejected');

        // Find the original task and re-assign it with feedback
        if (taskId === undefined) return;

        const reviewTask = await getOne<{ description: string }>(
            'SELECT description FROM tasks WHERE id = $1',
            [taskId]
        );

        if (reviewTask === null) return;

        const originalTaskIdMatch = reviewTask.description.match(/\[review-of:([^\]]+)\]/);
        if (originalTaskIdMatch === null) return;

        const originalTaskId = originalTaskIdMatch[1];

        // Atomic retry-count cap: increment only if under the cap. Same
        // read-then-write race we fixed for phase-gates — concurrent reviews
        // can each read retry_count=N, both pass the cap check, then each
        // `retry_count + 1` blows past the cap. Doing it in one UPDATE with
        // a WHERE clause is the fix.
        const bump = await query<{ retry_count: number }>(
            `UPDATE tasks SET status = 'pending',
             description = description || $1,
             retry_count = retry_count + 1
             WHERE id = $2 AND retry_count < $3
             RETURNING retry_count`,
            [`\n\nREVIEW FEEDBACK: ${summary}`, originalTaskId, MAX_TASK_RETRIES]
        );

        if (bump.rowCount === 0) {
            log.warn(
                { taskId: originalTaskId, maxRetries: MAX_TASK_RETRIES },
                'Review-rejection retry cap hit — marking task failed instead of re-routing'
            );
            await query(
                `UPDATE tasks SET status = 'failed', error_message = $1
                 WHERE id = $2 AND status != 'failed'`,
                [`Exhausted ${MAX_TASK_RETRIES} review rounds. Last feedback: ${summary.slice(0, 200)}`, originalTaskId]
            );
            return;
        }

        // Branch is preserved (not merged) — agent will continue on it for the retry
        log.info(
            { taskId: originalTaskId, retryCount: bump.rows[0]?.retry_count ?? null },
            'Branch preserved for rejected task, re-routing'
        );

        // Re-route the original task
        await this.router.routeTask(originalTaskId);

        log.info({ taskId: originalTaskId }, 'Re-assigned task with review feedback');
    }

    // ── Branch Management ─────────────────────────────

    /**
     * Merge a completed task's branch into main after review passes.
     * Logs conflict and preserves branch on failure.
     * No-op when KAGEOPS_DISABLE_GIT is set.
     */
    private async mergeTaskBranch(taskId: string): Promise<void> {
        if (this.branchManager === null) return;
        if (isGitDisabled()) {
            log.debug({ taskId }, 'Git disabled — skipping branch merge');
            return;
        }

        const task = await getOne<{ branch_name: string | null; title: string; project_id: string }>(
            'SELECT branch_name, title, project_id FROM tasks WHERE id = $1',
            [taskId]
        );

        if (task === null || task.branch_name === null) {
            log.info({ taskId }, 'No branch to merge for task');
            return;
        }

        // Get the project repo path
        const project = await getOne<{ repo_path: string }>(
            'SELECT repo_path FROM projects WHERE id = $1',
            [task.project_id]
        );

        if (project === null || project.repo_path === '') {
            log.warn({ projectId: task.project_id }, 'No repo path for project, skipping merge');
            return;
        }

        try {
            const result = await this.branchManager.mergeBranch(
                project.repo_path,
                task.branch_name,
                `Merge: ${task.title} (reviewed)`
            );

            if (result.success) {
                log.info(
                    { branch: task.branch_name, mergeCommit: result.mergeCommit?.slice(0, 8) ?? 'n/a' },
                    'Merged branch into main'
                );

                // Clean up merged branch
                try {
                    await this.branchManager.deleteBranch(project.repo_path, task.branch_name);
                } catch (cleanupErr) {
                    const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
                    log.warn({ err: cleanupMsg, branch: task.branch_name }, 'Branch cleanup failed');
                }
            } else if (result.conflicted) {
                log.warn(
                    { branch: task.branch_name },
                    'Merge conflict on branch. Branch preserved for manual resolution'
                );

                await this.sendCommsNotification(
                    task.project_id,
                    `Merge Conflict: ${task.title}`,
                    `Branch "${task.branch_name}" has merge conflicts with main. ` +
                    `Manual resolution required.`
                );
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err: msg, branch: task.branch_name }, 'Failed to merge branch');
        }
    }

    // ── Communications ────────────────────────────────

    /**
     * Send a notification to all configured comms channels.
     * Fails silently — comms should never break orchestration.
     */
    private async sendCommsNotification(
        projectId: string | null,
        subject: string,
        body: string
    ): Promise<void> {
        if (this.commsSender === null) return;

        try {
            const channels = this.commsSender.getChannels();
            for (const channel of channels) {
                await this.commsSender.enqueue({
                    projectId: projectId ?? undefined,
                    channel,
                    subject,
                    body,
                });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err: msg }, 'Failed to enqueue comms notification');
        }
    }

    /**
     * Get project name by ID. Returns fallback if not found.
     */
    private async getProjectName(projectId: string): Promise<string> {
        try {
            const project = await getOne<{ name: string }>(
                'SELECT name FROM projects WHERE id = $1',
                [projectId]
            );
            return project?.name ?? projectId;
        } catch {
            return projectId;
        }
    }

    // ── Retry Logic ──────────────────────────────────

    private async retryTask(taskId: string, currentRetryCount: number): Promise<void> {
        // Atomic bump: only one concurrent failure can advance the retry count
        // for a given task. Guards against the read-then-write race that let
        // retry_count blow past MAX_TASK_RETRIES (observed: 5, cap 3).
        const bump = await query<{ retry_count: number }>(
            `UPDATE tasks SET status = 'pending', retry_count = retry_count + 1
             WHERE id = $1 AND retry_count = $2 AND retry_count < $3
             RETURNING retry_count`,
            [taskId, currentRetryCount, MAX_TASK_RETRIES]
        );

        if (bump.rowCount === 0) {
            log.info(
                { taskId, expectedRetryCount: currentRetryCount, maxRetries: MAX_TASK_RETRIES },
                'retryTask no-op: retry_count changed or cap reached by another caller'
            );
            return;
        }

        // BPF-24: a retry must re-run the AI fresh, NOT replay the failed
        // attempt's cached outputs. With checkpoints on (③), the task's
        // 'completed' askAI ops are cached; without clearing them the retry
        // replays the exact response that just failed (e.g. narration that the
        // writeFile artifact-guard rejects) → instant identical failure on
        // every tier → tier-3 → blocked, forever. Clear them so the retry
        // genuinely re-attempts. (Crash-resume of a healthy in-progress task
        // still replays — that path doesn't go through retryTask.)
        await this.clearTaskCheckpoints([taskId]);

        const retryCount = bump.rows[0]?.retry_count ?? currentRetryCount + 1;

        if (retryCount === 1) {
            // Tier 1: Retry with same agent
            log.info({ taskId }, 'Retry tier 1: Re-assigning task to same agent');
            await this.router.routeTask(taskId);

        } else if (retryCount === 2) {
            // Tier 2: Try a different agent (next best from matrix)
            log.info({ taskId }, 'Retry tier 2: Trying different agent for task');
            const task = await getOne<{ task_type: string; assigned_agent: string }>(
                'SELECT task_type, assigned_agent FROM tasks WHERE id = $1',
                [taskId]
            );

            if (task !== null) {
                const topAgents = await this.matrix.getTopAgents(task.task_type, 3);
                const altAgent = topAgents.find((a) => a.agent !== task.assigned_agent);

                if (altAgent !== undefined) {
                    await query(
                        `UPDATE tasks SET assigned_agent = $1 WHERE id = $2`,
                        [altAgent.agent, taskId]
                    );
                }
                await this.router.routeTask(taskId);
            }

        } else {
            // Tier 3: the model couldn't finish this task in three attempts
            // (same agent, then the next-best agent). Mark it blocked AND
            // actually escalate to a human.
            //
            // BPF-28: marking 'blocked' alone was a SILENT dead-end. A blocked
            // task never re-routes, so it never fails again — which means
            // onTaskFailed's retry-exhaustion park branch is unreachable from
            // here. Worse, 'blocked' is non-terminal for phase completion, so
            // the phase can never finish and the orchestrator sits idle forever
            // (the stall-watchdog only reclaims IN-PROGRESS stalls, and nothing
            // is in progress). Escalate like the build-fix / retry-exhaustion
            // paths so the operator gets a clean approval.required instead of a
            // 20-minute-plus wedge.
            log.warn({ taskId }, 'Retry tier 3: task blocked after all retries — escalating to human (BPF-28)');
            await query(
                `UPDATE tasks SET status = 'blocked' WHERE id = $1`,
                [taskId]
            );
            await this.escalateBlockedTask(taskId);
        }
    }

    /**
     * BPF-28 — a tier-3 blocked task halts phase completion, so it must surface
     * to a human instead of silently wedging the project. Mirrors the build-fix
     * / retry-exhaustion escalation: park the project + emit `approval.required`
     * + notify. Only the FIRST block parks-and-notifies; later blocks on an
     * already-parked project fold into the same approval (no notification spam).
     */
    private async escalateBlockedTask(taskId: string): Promise<void> {
        const task = await getOne<{ project_id: string; title: string }>(
            'SELECT project_id, title FROM tasks WHERE id = $1',
            [taskId]
        );
        if (task === null) return;
        const projectId = task.project_id;

        const proj = await getOne<{ status: string }>(
            'SELECT status FROM projects WHERE id = $1',
            [projectId]
        );
        if (proj?.status !== 'active') {
            log.info(
                { taskId, projectId, status: proj?.status ?? 'unknown' },
                'BPF-28: task blocked but project not active — folding into existing approval',
            );
            return;
        }

        const reason =
            `Task "${task.title}" is blocked after ${MAX_TASK_RETRIES} attempts ` +
            `(same agent, then an alternate). It needs a human — fix or clarify it, ` +
            `then resume (completed work is cached, no tokens re-spent).`;

        await this.parkProjectForApproval(projectId);
        await this.eventBus.publish('approval.required', {
            projectId,
            taskId,
            agent: 'sensei',
            data: { reason },
        });

        const projectName = await this.getProjectName(projectId);
        await this.sendCommsNotification(
            projectId,
            `Task Blocked: ${projectName}`,
            `Task "${task.title}" is blocked after ${MAX_TASK_RETRIES} attempts. ` +
            `Human intervention required — resume after resolving it.`,
        );
    }
}

/**
 * Human-readable lead-in for a build-fix prompt, accurate per step kind. The
 * static-check / e2e steps (PR-2) aren't `npm run <step>` invocations, so a
 * literal "npm run static-check failed" would mislead Forge.
 */
function describeFailedStep(step: BuildStepName): string {
    switch (step) {
        case 'install':
            return '`npm install` failed';
        case 'build':
            return '`npm run build` failed';
        case 'test':
            return '`npm test` failed';
        case 'e2e':
            return 'The Playwright e2e suite failed';
        case 'static-check':
            return 'Deploy-readiness static checks failed (module-load-time SDK init and/or migration validation). ' +
                'Fix the deploy-readiness issue(s) detailed below — defer any module-scope `new Stripe(...)` / DB ' +
                'client behind a `getStripe()` / `getDb()` factory, and make every migration apply cleanly to a ' +
                'fresh database';
    }
}

// ── Acceptance-fix violation guidance ────────────────
//
// Map each AcceptanceViolation kind to a concrete instruction for
// Forge. Without this, the retry prompt only said "fix the IDs",
// which left Forge re-emitting the same broken output for any
// non-id violation (notably missing-asset).

function buildViolationGuidance(violations: readonly AcceptanceViolationLike[]): string {
    const kinds = new Set(violations.map((v) => v.check));
    const lines: string[] = ['Specific fix instructions per violation kind:'];

    if (kinds.has('missing-asset')) {
        lines.push(
            '- missing-asset: The HTML references a file that does not exist on disk. ' +
            'Emit that file with FULL substantial content following the DESIGN SYSTEM ' +
            '(no Bootstrap/Tailwind, use the provided design tokens). ' +
            'Do not just remove the <link>/<script> tag — actually create the file. ' +
            'The file MUST be at the project ROOT (e.g. `styles.css`, NOT `landing/styles.css`).'
        );
    }
    if (kinds.has('markdown-fenced-asset')) {
        lines.push(
            '- markdown-fenced-asset: A linked CSS/JS file contains markdown code fences ' +
            '(```css or ```). Re-emit the file as raw content — never include code fences ' +
            'inside the file body.'
        );
    }
    if (kinds.has('unbalanced-css-braces')) {
        lines.push(
            '- unbalanced-css-braces: The CSS file was truncated mid-rule. Re-emit the ' +
            'FULL file with every `{` matched by a `}`. Do not assume the previous version ' +
            'is correct — output the complete stylesheet.'
        );
    }
    if (kinds.has('missing-id')) {
        // Wave 4 Day 2: list the exact missing IDs so the model has no
        // ambiguity about which to add. Previously the generic "with the
        // exact id listed" guidance was being interpreted loosely and
        // Forge kept emitting #features/#pricing/#faq instead.
        // F-365: also include a tiny HTML example so the model can pattern-
        // match against an exact target instead of inferring shape from
        // the bullet phrasing alone. Earlier retries kept landing on
        // `<section id="X-section">` instead of `<section id="X">`.
        const missingIds = violations
            .filter((v) => v.check === 'missing-id')
            .map((v) => {
                const m = v.expected.match(/id="([^"]+)"/);
                return m !== null ? m[1] : v.expected;
            });
        const example = missingIds.length > 0
            ? `<section id="${missingIds[0]}">…content…</section>`
            : `<section id="X">…</section>`;
        lines.push(
            `- missing-id: The artifact is missing required <section id="..."> elements. ` +
            `Add a top-level <section id="..."> for EACH of these EXACT ids, in this order: ` +
            `${missingIds.map((id) => `\`${id}\``).join(', ')}. ` +
            `EXAMPLE of the exact shape required: \`${example}\`. ` +
            `Do NOT use other names. Do NOT skip any. Do NOT substitute synonyms ` +
            `(e.g. "features" is NOT "agents", "pricing" is NOT "guardrails"). ` +
            `Do NOT add suffixes like "-section" or "-grid" to the id — emit the bare id. ` +
            `Re-read the project description to confirm the content of each section.`,
        );
    }
    if (kinds.has('missing-tag')) {
        lines.push('- missing-tag: An expected tag is absent. Add it to the document.');
    }
    if (kinds.has('missing-class')) {
        lines.push('- missing-class: An expected class is absent. Add the class to a relevant element.');
    }
    if (kinds.has('missing-text')) {
        lines.push('- missing-text: Required text content is absent. Add it within the relevant section.');
    }
    if (kinds.has('missing-artifact')) {
        lines.push(
            '- missing-artifact: index.html was not produced (or was produced in the wrong location). ' +
            'Emit a complete index.html at the PROJECT ROOT (not `landing/index.html`) ' +
            'that satisfies every spec rule.'
        );
    }
    if (kinds.has('orphan-css-classes')) {
        // The violation message itself lists the orphan class names —
        // Forge needs the names AND the order: re-emit styles.css with
        // a CSS rule per orphan class, using the locked design tokens.
        // Don't change the HTML; the markup is already correct, the
        // stylesheet just needs to catch up.
        lines.push(
            '- orphan-css-classes: Many HTML class names have no matching CSS rule, so the ' +
            'page renders unstyled. Re-emit `styles.css` with a CSS rule for EVERY orphan ' +
            'class listed in the violation message above (use `.<class>{...}` selectors). ' +
            'Use the locked design tokens (var(--accent), var(--surface), var(--border), ' +
            '--space-*, --text-*, --radius-*) — do NOT introduce new colors or fonts. ' +
            'Do NOT remove the orphan classes from the HTML — keep the markup, fix the CSS. ' +
            'Do NOT truncate the file: every `{` must have a matching `}`.'
        );
    }
    if (kinds.has('runtime-error') || kinds.has('console-error') || kinds.has('unhandled-rejection')) {
        lines.push(
            '- runtime-error / console-error / unhandled-rejection: The page threw at load. ' +
            'Always null-guard DOM lookups: ' +
            '`document.querySelector(\'.x\')?.addEventListener(...)`. ' +
            'Wrap risky blocks in try/catch. Verify every selector you use actually exists in the HTML.'
        );
    }
    if (kinds.has('orphaned-half-feature')) {
        lines.push(
            '- orphaned-half-feature: A flow is wired on only one end (e.g. a Stripe webhook ' +
            'RECEIVES `checkout.session.completed` but nothing CREATES a checkout session). ' +
            'Wire the missing half so the flow can complete end-to-end: add the initiator that ' +
            'calls `stripe.checkout.sessions.create(...)` (a Server Action / route the UI can hit) ' +
            'AND keep the existing receiver. Read the violation message for the exact missing half.'
        );
    }
    if (kinds.has('missing-required-initiator')) {
        lines.push(
            '- missing-required-initiator: The brief requires the app to take payment but no ' +
            'payment initiator exists. Add a checkout path that calls ' +
            '`stripe.checkout.sessions.create({ mode: \'subscription\', ... })` from a Server Action ' +
            '(read `STRIPE_PRICE_ID` from env — never hardcode a price), redirect the user to the ' +
            'returned `url`, and ensure the webhook handler activates the membership on ' +
            '`checkout.session.completed`. The payment slice is already scaffolded under ' +
            '`lib/payments/` — wire the UI to it rather than authoring a new money path.'
        );
    }
    if (kinds.has('webhook-no-signature-verify')) {
        lines.push(
            '- webhook-no-signature-verify: The Stripe webhook acts on events without verifying ' +
            'the signature — a spoofable POST could unlock the app for free. In the webhook route, ' +
            'read the `stripe-signature` header and the RAW request body, then call ' +
            '`getStripe().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET)` ' +
            'inside a try/catch and only handle the returned event. Never `JSON.parse` the body directly.'
        );
    }
    if (kinds.has('hardcoded-price')) {
        lines.push(
            '- hardcoded-price: A literal Stripe `price_…` id is committed in source. Remove it and ' +
            'read the price from `process.env.STRIPE_PRICE_ID` when building the checkout session ' +
            '(as `lib/payments/checkout.ts` does). Hardcoded ids break across environments and leak.'
        );
    }
    if (kinds.has('activation-not-keyed-to-user')) {
        lines.push(
            '- activation-not-keyed-to-user: The `checkout.session.completed` handler does not read ' +
            '`metadata`/`client_reference_id`, so it cannot grant access to the user who paid. When ' +
            'creating the session set `metadata: { clerkId }` and `client_reference_id: clerkId`; in ' +
            'the handler read `session.metadata?.clerkId ?? session.client_reference_id` and activate ' +
            'THAT membership row.'
        );
    }
    if (
        kinds.has('lorem-ipsum') ||
        kinds.has('placeholder-contact') ||
        kinds.has('unfilled-placeholder') ||
        kinds.has('unreplaced-template')
    ) {
        lines.push(
            '- fabrication (lorem-ipsum / placeholder-contact / unfilled-placeholder / ' +
            'unreplaced-template): the shipped UI contains placeholder or fabricated values ' +
            '(lorem ipsum, a fake email/phone/address, an unfilled `[TODO: …]`, or an unreplaced ' +
            '`{{title}}`). Replace each with the REAL value from the project brief. If a needed ' +
            'fact is genuinely absent from the brief, do NOT invent one — leave a single, clearly ' +
            'human-facing gap note and flag it, per the grounding directive. The violation message ' +
            'names the file + exact snippet to fix.'
        );
    }

    return lines.join('\n');
}

interface AcceptanceViolationLike {
    readonly check: string;
    readonly expected: string;
    readonly message: string;
}

/**
 * F-350: write per-call Sensei error context to `<userData>/sensei-error.txt`
 * so the user can paste it back and tell us which provider/endpoint/key
 * the running app actually used. Includes resolved Sensei spec, the
 * source the API key came from (env vs registry vs keychain) and the
 * raw error message + stack. Never includes the full key — only first
 * 6 + last 4 characters.
 */
async function persistSenseiErrorDump(msg: string, stack: string): Promise<void> {
    try {
        const electron = await import('electron');
        const fsMod = await import('node:fs');
        const pathMod = await import('node:path');
        const { loadAgentConfig, getAgentModelConfig } = await import('../agents/agent-config');
        const { parseModelString } = await import('../agents/ai-adapter/model-parser');

        const userData = electron.app.getPath('userData');
        const target = pathMod.join(userData, 'sensei-error.txt');

        let provider = 'unknown';
        let model = 'unknown';
        let cfgPathHint = 'unknown';
        try {
            const cfg = loadAgentConfig();
            const sensei = getAgentModelConfig(cfg, 'sensei');
            model = sensei.model;
            provider = parseModelString(sensei.model).provider;
            cfgPathHint = `${process.env['KAGEOPS_DATA_DIR'] ?? '~/.kageops'}/agent-config[.preset].json`;
        } catch { /* ignore */ }

        // Resolve key + source the same way ai-adapter does so we know
        // which slot Sensei is actually pulling from.
        let keySource = 'none';
        let keyPreview = '(no key)';
        try {
            const envNameByProvider: Record<string, readonly string[]> = {
                claude: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
                'claude-cli': ['ANTHROPIC_API_KEY'],
                openai: ['OPENAI_API_KEY'],
                'codex-cli': ['OPENAI_API_KEY'],
                openrouter: ['OPENROUTER_API_KEY'],
                gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
                ollama: ['OLLAMA_API_KEY'],
            };
            const envNames = envNameByProvider[provider] ?? [];
            const envKey = envNames.map((n) => process.env[n]).find((v) => v !== undefined && v !== '');
            if (envKey !== undefined) {
                keySource = `env (${envNames.find((n) => process.env[n] === envKey)})`;
                keyPreview = `${envKey.slice(0, 6)}...${envKey.slice(-4)} (${envKey.length} chars)`;
            } else {
                const { getApiKey } = await import('../main/secret-store');
                const k = await getApiKey(provider as never).catch(() => null);
                if (k !== null && k !== '') {
                    keySource = 'keychain';
                    keyPreview = `${k.slice(0, 6)}...${k.slice(-4)} (${k.length} chars)`;
                }
            }
        } catch { /* ignore */ }

        const body = [
            `KageOps Sensei chat error — ${new Date().toISOString()}`,
            '',
            `Error message: ${msg}`,
            '',
            `Resolved Sensei spec:`,
            `  model       = ${model}`,
            `  provider    = ${provider}`,
            `  cfg source  = ${cfgPathHint}`,
            `  KAGEOPS_PRESET env = ${process.env['KAGEOPS_PRESET'] ?? '(unset)'}`,
            '',
            `Key resolution:`,
            `  source = ${keySource}`,
            `  key    = ${keyPreview}`,
            '',
            'Stack:',
            stack || '(no stack)',
            '',
            `Process: node ${process.versions.node} · electron ${process.versions.electron ?? 'n/a'}`,
            `cwd: ${process.cwd()}`,
            `KAGEOPS_DATA_DIR: ${process.env['KAGEOPS_DATA_DIR'] ?? '(unset — defaults to ~/.kageops)'}`,
            `LITELLM_PROXY_URL: ${process.env['LITELLM_PROXY_URL'] ?? '(unset)'}`,
            `OLLAMA_HOST: ${process.env['OLLAMA_HOST'] ?? '(unset)'}`,
            '',
        ].join('\n');
        fsMod.writeFileSync(target, body, 'utf8');
    } catch {
        // Best effort
    }
}
