/**
 * KageOps Base Autonauts Agent
 *
 * Abstract base class that all specialist agents extend.
 * Provides AI interaction, file system access, git integration,
 * progress reporting, and event bus subscriptions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { sendPrompt, AiResponse, AiRequestOptions } from './ai-adapter';
import type {
    TaskCheckpointRepository,
    TaskCheckpointRow,
} from '../db/task-checkpoint-repo';
import { taskCheckpointsEnabled } from '../db/task-checkpoint-repo';
import { executeFallbackChain, FallbackChainConfig } from './model-fallback';
import { resolveHaikuGuard } from './haiku-guard';
import { query } from '../db/client';
import { EventBus, EventPayload } from '../orchestrator/event-bus';
import { CostTracker, BudgetExceededError } from '../orchestrator/cost-tracker';
import { BranchManager } from '../workspace/branch-manager';
import { withRepoLock } from '../workspace/repo-lock';
import { CodeGraphBridge } from '../workspace/code-graph-bridge';
import { GraphifyBridge } from '../workspace/graphify-bridge';
import { parseFileBlocks, sanitizeAgentOutput, isLikelyArtifactContent, recoverArtifactFromNarration, sanitizePackageJson, isNoOpFileNote } from './output-parser';
import { createLogger, Logger } from '../shared/logger';
import { isGitDisabled } from '../shared/git-config';
import { buildAgentSystemPrompt } from './caveman-mode';
import {
    VerificationEvidence,
    evaluateVerification,
    evidenceFromFiles,
    evidenceFromShell,
} from './verification-gate';
import { createSessionScanner, SessionScanner, SecurityFinding } from './security-scanner';
import { compressIfLarge } from './context-compressor';
import { augmentSystemPrompt, captureCandidateSkill } from './skill-hooks';
import type { SkillRegistry } from '../skills/skill-registry';
import type { SkillStore } from '../skills/skill-store';

// ── Constants ────────────────────────────────────────

/** Commands agents are allowed to spawn. Anything else is rejected. */
const SHELL_ALLOWLIST = new Set([
    'npm', 'node', 'git', 'tsc', 'eslint', 'vitest', 'jest',
    'docker', 'terraform', 'npx', 'pnpm', 'yarn',
]);

/** Patterns that are never allowed in command arguments. */
const SHELL_BLOCKLIST = [
    /rm\s+-rf\s+\//i,
    /format\s+[a-z]:/i,
    /shutdown/i,
    /reboot/i,
    /del\s+\/[sq]/i,
    /mkfs/i,
    /dd\s+if=/i,
];

/** Map shell commands to verification evidence kinds for auto-collection. */
const COMMAND_EVIDENCE_MAP: Readonly<Record<string, import('./verification-gate').VerificationKind>> = {
    'npm':    'build_succeeded',
    'tsc':    'build_succeeded',
    'vitest': 'tests_passed',
    'jest':   'tests_passed',
    'eslint': 'linter_clean',
};

/**
 * P1-01d: byte cap on the `stdout`/`stderr` previews stored in an
 * `exec` checkpoint's `output_json`. On a resume hit the cached
 * previews are returned to the caller as `stdout`/`stderr`, so the
 * cap defines the contract: callers that parse exec output across
 * a resume see at most this many bytes. The plan canonicalised the
 * preview shape on purpose — full output is captured live in
 * `agent_logs` for the original run, and bounding the checkpoint
 * row keeps the table cheap for high-frequency operations like
 * repeated `npm test` calls inside a TDD loop.
 */
const EXEC_PREVIEW_BYTES = 4_000;

/** Approx token limit per message (GPT-4 class: 128k ctx, compact at 80% = ~102k) */
const COMPACTION_THRESHOLD_TOKENS = 102_400;
/** Rough chars-per-token for English/code. */
const CHARS_PER_TOKEN = 4;
/** How many old message pairs to summarise per compaction pass. */
const COMPACTION_BATCH = 10;
/** How many recent actions to keep for loop detection. */
const LOOP_WINDOW = 5;
/** How many identical actions before we declare a loop. */
const LOOP_THRESHOLD = 3;

// ── Types ────────────────────────────────────────────

export interface AgentModelConfig {
    readonly model: string;       // e.g., "claude/claude-sonnet-4-20250514"
    readonly temperature?: number;
    readonly maxTokens?: number;
}

export interface TaskInfo {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly description: string;
    readonly taskType: string;
    readonly phase: string;
    readonly outputPath: string | null;
    readonly repoPath: string;
    /**
     * P1-06b: present only for `task_type='revision'` tasks (stamped
     * by Sensei.stampRevisionMetadata in P1-06a). When non-null,
     * Forge's revision handler reads this as the operator's verbatim
     * change instruction.
     */
    readonly revisionInstruction?: string | null;
    /**
     * P1-06b: present only for revision tasks. Links the task back to
     * its iteration cycle so the build-summary report (F-300) +
     * history side-panel (P1-05b) can group revisions by reopen
     * cycle. Optional + nullable for backwards-compat with legacy
     * pre-027 task rows.
     */
    readonly iterationId?: string | null;
    /**
     * P1-06b: opt-in list of workspace-relative file paths the
     * revision is allowed to touch. Null on P1-06a-vintage rows
     * because the decomposer-side workspace-tree scan that populates
     * this lives in a follow-on PR (P1-07 territory). When null,
     * Forge's revision handler scans the workspace itself for known
     * artifact extensions.
     */
    readonly targetFiles?: readonly string[] | null;
}

export type AgentStatus = 'idle' | 'busy' | 'error';

export interface ShellResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
}

// ── Abstract Base Agent ──────────────────────────────

export abstract class AutonautAgent {
    readonly name: string;
    readonly role: string;
    readonly skills: readonly string[];
    /** Mutable so preset switches can update the active model at runtime without restart. */
    modelConfig: AgentModelConfig;
    readonly systemPrompt: string;

    /** When true, AI output uses normal verbose mode (e.g. Sensei chat). */
    protected isHumanFacing: boolean = false;

    protected readonly log: Logger;

    private _status: AgentStatus = 'idle';
    private _currentTask: TaskInfo | null = null;
    private _activeTasks = 0;
    private eventBus: EventBus | null = null;

    // Guards against duplicate dispatch for the same task-id (event bus replay,
    // double-subscription, re-published retry events). Keyed by task.id.
    private readonly _inFlightTaskIds = new Set<string>();

    // Track last AI response text so we can persist it after executeTask()
    private _lastAiResponseText: string | null = null;

    // Per-task askAI call counter (instrumentation for double-dispatch bugs)
    private _askAiCallCount = 0;

    // P1-01b: per-task op-index counter for task_checkpoints. Each
    // resumable op (askAI, writeFile, exec) assigns this value when it
    // records a checkpoint, then increments. Reset to 0 at task start.
    // P1-01e will later seed this from listForTask() on resume so a
    // restarted process picks up after the last completed op.
    private _currentTaskOpIndex = 0;

    // Collaborative Agent Intercept state
    private _paused = false;
    private _pauseResolver: (() => void) | null = null;
    private _interceptGuidance: string | null = null;
    private _takenOver = false;

    // B-201: verification evidence collected during task execution
    private _evidence: VerificationEvidence[] = [];

    // D3: ring buffer of recent action keys for loop detection
    private _recentActions: string[] = [];

    // D2: accumulated conversation for context compaction
    private _conversationMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // v0.6 infrastructure
    private costTracker: CostTracker | null = null;
    private branchManager: BranchManager | null = null;
    private fallbackChain: FallbackChainConfig | null = null;
    private readonly securityScanner: SessionScanner = createSessionScanner();

    // v0.8 code graph
    private codeGraphBridge: CodeGraphBridge | null = null;

    // v1.2 graphify knowledge graph
    private graphifyBridge: GraphifyBridge | null = null;

    // Phase 3 Loop A: skills library (opt-in, gated by KAGEOPS_SKILLS_HOOKS=true)
    protected skillRegistry: SkillRegistry | null = null;
    protected skillStore: SkillStore | null = null;

    // v0.9 GitHub
    private _githubClient: import('../github/github-client').GitHubClient | null = null;

    // P1-01b: task-checkpoint repository (DI; on by default, kill-switch KAGEOPS_TASK_CHECKPOINTS=false).
    private taskCheckpointRepo: TaskCheckpointRepository | null = null;

    /** Wall-clock start of the current task's executeTask() call (0 when idle). */
    private _taskStartMs = 0;

    /**
     * Hard timeout (ms) applied to each executeTask() invocation.
     *
     * Default 20 min. Operators can tighten this with `KAGEOPS_MAX_TASK_DURATION_MS`
     * (F-392 part a) so a single runaway task can't eat the whole per-run
     * budget — 2026-05-21 GPS Delivery Tracker smoke had Forge run for 16.8
     * min on one consolidation task, leaving zero budget for the
     * build/acceptance gates. Set to e.g. `600000` (10 min) on paid presets
     * where you want to fail-fast and let the fallback chain (F-367, when
     * shipped) try a stronger model rather than spin on one slow agent.
     *
     * Read once at class-load via env so test fixtures and the runner can
     * override it without resorting to subclassing.
     */
    protected readonly taskTimeoutMs = parseEnvDurationMs(
        process.env['KAGEOPS_MAX_TASK_DURATION_MS'],
        1_200_000,
    );

    /**
     * Milliseconds remaining before the current task hits its hard timeout.
     * Returns Infinity when no task is running.
     */
    protected getTaskRemainingMs(): number {
        if (this._taskStartMs === 0) return Number.POSITIVE_INFINITY;
        return this.taskTimeoutMs - (Date.now() - this._taskStartMs);
    }

    constructor(
        name: string,
        role: string,
        skills: readonly string[],
        modelConfig: AgentModelConfig,
        systemPrompt: string
    ) {
        this.name = name;
        this.role = role;
        this.skills = skills;
        this.modelConfig = modelConfig;
        this.systemPrompt = systemPrompt;
        this.log = createLogger(`Agent:${name}`);
    }

    // ── v0.6 Dependency Injection ────────────────────

    /**
     * Set the CostTracker for budget enforcement on AI calls.
     */
    setCostTracker(tracker: CostTracker): void {
        this.costTracker = tracker;
    }

    /**
     * Set the BranchManager for branch-per-task isolation.
     */
    setBranchManager(manager: BranchManager): void {
        this.branchManager = manager;
    }

    /**
     * Set the model fallback chain for resilient AI calls.
     */
    setFallbackChain(chain: FallbackChainConfig): void {
        this.fallbackChain = chain;
    }

    /**
     * Set the CodeGraphBridge for code graph context injection (v0.8).
     */
    setCodeGraphBridge(bridge: CodeGraphBridge): void {
        this.codeGraphBridge = bridge;
    }

    /**
     * Set the GraphifyBridge for knowledge graph queries (v1.2).
     */
    setGraphifyBridge(bridge: GraphifyBridge): void {
        this.graphifyBridge = bridge;
    }

    /**
     * Set the GitHubClient for agents that interact with GitHub (v0.9).
     */
    setGitHubClient(client: import('../github/github-client').GitHubClient): void {
        this._githubClient = client;
    }

    /**
     * Wire in the task-checkpoint repository (P1-01b). Bootstrap always
     * injects this; the per-call gate `checkpointsEnabled()` decides
     * whether it's consulted (on by default — see that method). The gate
     * is re-checked on every askAI, so toggling `KAGEOPS_TASK_CHECKPOINTS`
     * mid-run is safe (e.g. tests that flip it between assertions).
     */
    setTaskCheckpointRepo(repo: TaskCheckpointRepository): void {
        this.taskCheckpointRepo = repo;
    }

    /**
     * Whether P1-01 output-checkpoint caching runs (askAI / writeFile /
     * exec). This is the engine behind output-cached resume — a resumed
     * task replays its completed ops from cache (askAI returns at
     * `costUsd:0`), so a resume costs ~0 tokens for work already done.
     *
     * Durable-recovery (#1 priority): ON by default. The operator's
     * "restart re-burns all the tokens" complaint was exactly this cache
     * sitting behind an off-by-default flag. Two safety nets make
     * default-on safe: (1) every checkpoint DB call already degrades to
     * live execution on error (never crashes), and (2) the askai/exec
     * cache hits now verify the prompt/command still matches before
     * serving (see `checkpointAskAiMatches` / `tryExecCacheHit`), so a
     * divergent replay re-executes live rather than returning stale data.
     *
     * Kill-switch: `KAGEOPS_TASK_CHECKPOINTS=false` (or `0`/`off`/`no`).
     * Delegates to the shared `taskCheckpointsEnabled()` so this and the
     * orchestrator's resume-summary logging never drift apart.
     */
    private checkpointsEnabled(): boolean {
        return taskCheckpointsEnabled();
    }

    /**
     * Wire in the skills library (Phase 3, Loop A). Opt-in at runtime:
     * bootstrap only calls this when `KAGEOPS_SKILLS_HOOKS=true`, so
     * default behaviour is unchanged.
     */
    setSkillInfra(registry: SkillRegistry, store: SkillStore): void {
        this.skillRegistry = registry;
        this.skillStore = store;
    }

    /** Whether the Phase-3 skill hooks should run for this askAI call. */
    private skillHooksEnabled(): boolean {
        return process.env['KAGEOPS_SKILLS_HOOKS'] === 'true';
    }

    /**
     * If a registry is wired in and the feature flag is on, search the skill
     * library with `userPrompt` and return a system prompt augmented with
     * the top matches. Otherwise return `baseSystemPrompt` unchanged.
     */
    private async maybeAugmentWithSkills(
        baseSystemPrompt: string,
        userPrompt: string
    ): Promise<string> {
        if (!this.skillHooksEnabled()) return baseSystemPrompt;
        if (this.skillRegistry === null) return baseSystemPrompt;

        try {
            const { prompt, hits } = await augmentSystemPrompt(
                baseSystemPrompt,
                userPrompt,
                this.skillRegistry
            );
            if (hits.length > 0) {
                this.log.info(
                    { count: hits.length, skills: hits.map((h) => h.skill.name) },
                    `skill-augmented with ${hits.length} skills`
                );
            }
            return prompt;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.debug({ err: msg }, 'skill augmentation failed — passthrough');
            return baseSystemPrompt;
        }
    }

    /**
     * Non-blocking skill capture. Kicks off `captureCandidateSkill` in a
     * detached async so AI callers don't wait for (or observe) DB writes.
     */
    private maybeCaptureSkill(responseText: string): void {
        if (!this.skillHooksEnabled()) return;
        if (this.skillStore === null) return;
        const task = this._currentTask;
        if (task === null) return;

        const store = this.skillStore;
        void (async (): Promise<void> => {
            try {
                await captureCandidateSkill(
                    responseText,
                    {
                        id: task.id,
                        title: task.title,
                        description: task.description,
                        taskType: task.taskType,
                    },
                    store
                );
            } catch (err) {
                // captureCandidateSkill already swallows internally; belt-and-braces.
                const msg = err instanceof Error ? err.message : String(err);
                this.log.debug({ err: msg, taskId: task.id }, 'skill capture threw (swallowed)');
            }
        })();
    }

    /**
     * Access the GitHubClient (protected — for subclass use only).
     */
    protected get githubClient(): import('../github/github-client').GitHubClient | null {
        return this._githubClient;
    }

    /**
     * Get current agent status.
     */
    get status(): AgentStatus {
        return this._status;
    }

    /**
     * Get currently executing task info, or null.
     */
    get currentTask(): TaskInfo | null {
        return this._currentTask;
    }

    /**
     * Set this agent's current-task context for out-of-band execution paths
     * (Pillar 2.4 Cloud Burst) that invoke `executeTask()` directly, bypassing
     * `onTaskAssigned()`. Without it, `askAI()`'s `agent_logs` insert records
     * null project_id/task_id — breaking per-task cost reconciliation and the
     * in-container budget guard. Mirrors the per-task state reset
     * `onTaskAssigned` performs. Pair with `endExternalTask()` in a finally.
     */
    beginExternalTask(task: TaskInfo): void {
        this._currentTask = task;
        this._lastAiResponseText = null;
        this._evidence = [];
        this._askAiCallCount = 0;
        this._currentTaskOpIndex = 0;
        this.resetInterceptState();
        this.resetLoopDetection();
        this.resetConversation();
    }

    /** Clear the external-task context set by {@link beginExternalTask}. */
    endExternalTask(): void {
        this._currentTask = null;
    }

    /**
     * Number of tasks currently being executed by this agent.
     */
    get activeTasks(): number {
        return this._activeTasks;
    }

    /**
     * Whether this agent can accept another task.
     * @param maxConcurrent Max tasks this agent may run in parallel (default 1).
     */
    isAvailable(maxConcurrent = 1): boolean {
        return this._activeTasks < maxConcurrent;
    }

    /**
     * Whether this agent is currently paused by an intercept.
     */
    get paused(): boolean { return this._paused; }

    /**
     * Whether a human has taken over this agent's current task.
     */
    get takenOver(): boolean { return this._takenOver; }

    /**
     * Connect to the event bus and subscribe to assigned tasks.
     */
    async connect(eventBus: EventBus): Promise<void> {
        if (this.eventBus !== null) {
            this.log.warn('connect() called twice on same agent — ignoring duplicate subscription');
            return;
        }
        this.eventBus = eventBus;

        await eventBus.subscribe('task.assigned', async (event) => {
            if (event.agent === this.name) {
                await this.onTaskAssigned(event);
            }
        });

        // Collaborative Agent Intercept subscriptions
        await eventBus.subscribe('intercept.pause', (event) => {
            if (event.agent === this.name) {
                this.log.info({ taskId: event.taskId }, 'Intercept: pause received');
                this.pause();
            }
        });

        await eventBus.subscribe('intercept.resume', (event) => {
            if (event.agent === this.name) {
                this.log.info({ taskId: event.taskId }, 'Intercept: resume received');
                this.resume();
            }
        });

        await eventBus.subscribe('intercept.guidance', (event) => {
            if (event.agent === this.name) {
                const guidance = typeof event.data.guidance === 'string'
                    ? event.data.guidance
                    : '';
                this.log.info({ taskId: event.taskId, guidanceLen: guidance.length }, 'Intercept: guidance received');
                this.injectGuidance(guidance);
            }
        });

        await eventBus.subscribe('intercept.takeover', (event) => {
            if (event.agent === this.name) {
                this.log.info({ taskId: event.taskId }, 'Intercept: takeover received');
                this.takeover();
            }
        });

        this.log.info('Agent connected and listening for tasks.');
    }

    /**
     * Handle an assigned task — execute it and report results.
     */
    async onTaskAssigned(event: EventPayload): Promise<void> {
        const taskId = event.taskId;
        if (taskId === undefined) return;

        // Defence-in-depth against duplicate dispatch: same task-id routed twice
        // (event bus replay, double-subscription, retry re-publish). Without
        // this guard, two concurrent runs race on git branch creation and
        // double-spend budget. See V11 post-mortem.
        if (this._inFlightTaskIds.has(taskId)) {
            this.log.warn({ taskId }, 'Duplicate dispatch ignored — task already running');
            return;
        }
        this._inFlightTaskIds.add(taskId);

        let branchName: string | null = null;

        this._activeTasks += 1;

        try {
            this._status = 'busy';

            // Load full task info
            const taskInfo = await this.loadTaskInfo(taskId);
            if (taskInfo === null) {
                throw new Error(`Task not found: ${taskId}`);
            }

            this._currentTask = taskInfo;
            this.log.info({ taskTitle: taskInfo.title }, 'Starting task');

            // Create isolated branch before executing (v0.6)
            if (this.branchManager !== null && taskInfo.repoPath !== '') {
                try {
                    branchName = await this.branchManager.createTaskBranch(
                        taskInfo.repoPath,
                        taskId,
                        this.name
                    );

                    // Store branch name on the task record
                    await query(
                        `UPDATE tasks SET branch_name = $1 WHERE id = $2`,
                        [branchName, taskId]
                    );

                    this.log.info({ branchName }, 'Working on branch');
                } catch (branchErr) {
                    const msg = branchErr instanceof Error ? branchErr.message : String(branchErr);
                    this.log.warn({ err: msg }, 'Branch creation failed, continuing on current branch');
                }
            }

            // Reset per-task state
            this._lastAiResponseText = null;
            this._evidence = [];
            this._askAiCallCount = 0;
            // P1-01b: fresh-run counter starts at 0. P1-01e will replace
            // this with a listForTask() seed so resume picks up after the
            // last completed op.
            this._currentTaskOpIndex = 0;
            this.resetInterceptState();
            this.resetLoopDetection();
            this.resetConversation();

            // Execute the task (specialist implementation) with 20-minute timeout
            const TASK_TIMEOUT_MS = this.taskTimeoutMs;
            const start = Date.now();
            this._taskStartMs = start;
            try {
                await Promise.race([
                    this.executeTask(taskInfo),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error(
                            `Task timed out after ${TASK_TIMEOUT_MS / 60_000} minutes: ${taskInfo.title}`
                        )), TASK_TIMEOUT_MS)
                    ),
                ]);
            } finally {
                this._taskStartMs = 0;
            }
            const durationMs = Date.now() - start;

            // D4 safety net: if specialist didn't write output files but we have
            // an AI response and an output path, write it now
            if (this._lastAiResponseText !== null && taskInfo.outputPath !== null) {
                try {
                    await this.writeOutputFiles(taskInfo, this._lastAiResponseText);
                } catch (writeErr) {
                    const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
                    this.log.warn({ err: msg }, 'Safety net writeOutputFiles failed');
                }
            }

            // B3: Persist last AI response text to tasks table
            if (this._lastAiResponseText !== null) {
                await query(
                    `UPDATE tasks SET response_text = $1 WHERE id = $2`,
                    [this._lastAiResponseText, taskId]
                );
            }

            // B-201: Evaluate verification evidence before marking complete
            const verification = evaluateVerification(taskInfo.taskType, this._evidence);
            if (!verification.verified) {
                this.log.warn(
                    { missing: verification.missingChecks, taskType: taskInfo.taskType },
                    'Task completed without full verification'
                );
            }

            // Mark task as completed
            await query(
                `UPDATE tasks SET status = 'completed', completed_at = NOW() WHERE id = $1`,
                [taskId]
            );

            // Publish completion event with verification result
            if (this.eventBus !== null) {
                await this.eventBus.publish('task.completed', {
                    projectId: taskInfo.projectId,
                    taskId,
                    agent: this.name,
                    data: {
                        title: taskInfo.title,
                        durationMs,
                        branchName,
                        verification: {
                            verified: verification.verified,
                            summary: verification.summary,
                            missingChecks: verification.missingChecks,
                        },
                    },
                });
            }

            this.log.info({ taskTitle: taskInfo.title, durationMs }, 'Completed task');

        } catch (err) {
            // Intercept: if a human took over, don't treat the interruption as failure
            if (this._takenOver) {
                this.log.info({ taskId }, 'Task interrupted by human takeover');
                await query(
                    `UPDATE tasks SET status = 'paused' WHERE id = $1`,
                    [taskId]
                );
                if (this.eventBus !== null) {
                    await this.eventBus.publish('intercept.acknowledged' as never, {
                        projectId: event.projectId,
                        taskId,
                        agent: this.name,
                        data: { action: 'takeover-complete' },
                    });
                }
                return;
            }

            const errorMessage = err instanceof Error ? err.message : String(err);
            const isBudgetError = err instanceof BudgetExceededError;
            this.log.error({ err: errorMessage, isBudgetError }, 'Task failed');

            this._status = 'error';

            // Mark task as failed
            await query(
                `UPDATE tasks SET status = 'failed', error_message = $1 WHERE id = $2`,
                [errorMessage, taskId]
            );

            // Publish failure event with budget context
            if (this.eventBus !== null) {
                await this.eventBus.publish('task.failed', {
                    projectId: event.projectId,
                    taskId,
                    agent: this.name,
                    data: {
                        errorMessage,
                        isBudgetExceeded: isBudgetError,
                        branchName,
                    },
                });
            }

        } finally {
            this._activeTasks -= 1;
            this._status = 'idle';
            this._currentTask = null;
            this._inFlightTaskIds.delete(taskId);
        }
    }

    /**
     * Abstract: Each specialist agent implements this.
     */
    abstract executeTask(task: TaskInfo): Promise<void>;

    // ── AI Interaction ───────────────────────────────

    /**
     * Send a prompt to the configured AI model.
     *
     * Wraps the actual provider call with the P1-01b checkpoint flow:
     *   - Cooperative pause check (always; even cached returns honour
     *     a pending pause / human guidance).
     *   - Cache hit: a prior run already executed this op-index for
     *     this task — return the persisted response. Cost is reported
     *     as 0 (it was paid for in the prior run) but the cached
     *     totals are emitted on the stream channel + an `ai-cache-hit`
     *     agent_log row, so accounting + UI can show the saving.
     *   - Cache miss: record an `in-flight` checkpoint, execute the
     *     core call (existing budget enforcement / haiku guard /
     *     fallback chain / cost tracking), then mark the row
     *     `completed` (with the response) or `failed` (with the error).
     *
     * The checkpoint flow is ON by default (kill-switch
     * `KAGEOPS_TASK_CHECKPOINTS=false`). When disabled the behaviour is
     * identical to the pre-P1-01b path.
     */
    protected async askAI(
        prompt: string,
        context?: string,
        options?: AiRequestOptions
    ): Promise<AiResponse> {
        // Cooperative pause yield point — every AI call is preceded by
        // a pause check. Runs before the cache check so a human who
        // paused the agent gets a chance to inspect before a cached
        // response sails through.
        if (this._currentTask !== null) {
            const injectedGuidance = await this.checkPause(this._currentTask);
            if (injectedGuidance !== null) {
                prompt = `[HUMAN GUIDANCE]: ${injectedGuidance}\n\n${prompt}`;
            }
        }

        // P1-01b: try the cache first.
        if (this.checkpointsEnabled() && this.taskCheckpointRepo !== null && this._currentTask !== null) {
            const opIndex = this._currentTaskOpIndex;
            let existing: TaskCheckpointRow | null = null;
            try {
                existing = await this.taskCheckpointRepo.findByOp(this._currentTask.id, opIndex);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.warn({ err: msg, opIndex }, 'checkpoint: findByOp failed — continuing without cache');
            }
            if (
                existing !== null && existing.status === 'completed' && existing.opType === 'askai'
                && this.checkpointAskAiMatches(existing, prompt, context)
            ) {
                this._currentTaskOpIndex += 1;
                return await this.serveCheckpointCacheHit(existing);
            }
            // Cache miss / re-execute path: keep the existing row id (if
            // any) to mark on complete/fail, then run the core call. A
            // completed-but-prompt-mismatched row falls through here too
            // (the re-run diverged from the cached path) — we re-execute
            // live and overwrite, never serving a stale answer.
            this._currentTaskOpIndex += 1;
            return await this.runAskAiWithCheckpoint(prompt, context, options, opIndex, existing);
        }

        // Checkpoints disabled or unwired — execute exactly as before.
        return await this.executeAskAiCore(prompt, context, options);
    }

    /**
     * Return a cached AiResponse for a completed askai checkpoint.
     * Reports `costUsd: 0` on the returned response (the cost was
     * already paid in the prior run) but the original cost is still
     * surfaced on the `agent.stream` event + an `ai-cache-hit`
     * agent_log row so reporting can show how much was saved.
     */
    private async serveCheckpointCacheHit(row: TaskCheckpointRow): Promise<AiResponse> {
        const output = (row.outputJson as AskAiCheckpointOutput | null) ?? {
            text: '', tokensIn: 0, tokensOut: 0, costUsd: 0, model: this.modelConfig.model, durationMs: 0,
        };
        this._lastAiResponseText = output.text;

        await this.logAction('ai-cache-hit', {
            model: output.model,
            tokensIn: output.tokensIn,
            tokensOut: output.tokensOut,
            costUsd: 0,
            durationMs: 0,
            cachedFromCheckpointId: row.id,
            opIndex: row.opIndex,
            originalCostUsd: output.costUsd,
        });

        if (this.eventBus !== null && this._currentTask !== null) {
            await this.eventBus.publish('agent.stream' as never, {
                projectId: this._currentTask.projectId,
                taskId: this._currentTask.id,
                agent: this.name,
                data: {
                    type: 'ai-cache-hit',
                    opIndex: row.opIndex,
                    model: output.model,
                    tokensIn: output.tokensIn,
                    tokensOut: output.tokensOut,
                    originalCostUsd: output.costUsd,
                },
            });
        }

        this.log.info(
            { taskId: this._currentTask?.id, opIndex: row.opIndex, model: output.model, savedCostUsd: output.costUsd },
            'checkpoint cache hit (askai) — skipped real call',
        );

        return {
            text: output.text,
            tokensIn: output.tokensIn,
            tokensOut: output.tokensOut,
            costUsd: 0,
            model: output.model,
            durationMs: 0,
        };
    }

    /**
     * Resume-safety guard: only serve a cached askai response when the
     * re-run's prompt actually matches the one that produced it. The
     * checkpoint key is `(taskId, opIndex)`, so if a re-run takes a
     * different path (an extra/fewer earlier op), op-index N can line up
     * with a *different* call — without this check we'd hand back a
     * stale answer. We compare the stored `promptHash` (recorded by
     * `runAskAiWithCheckpoint`) against the current call's hash.
     *
     * Legacy rows with no stored hash return `true` (preserve the
     * pre-guard behaviour) — real rows always carry a hash, so the
     * only practical effect is making divergent replays correct.
     */
    private checkpointAskAiMatches(
        row: TaskCheckpointRow,
        prompt: string,
        context: string | undefined,
    ): boolean {
        const payload = row.payloadJson as { promptHash?: unknown } | null;
        const stored = payload !== null && typeof payload.promptHash === 'string'
            ? payload.promptHash
            : null;
        if (stored === null) return true;
        const current = hashPrompt(this.systemPrompt, context, prompt, this.modelConfig.model);
        if (stored === current) return true;
        this.log.info(
            { taskId: row.taskId, opIndex: row.opIndex },
            'checkpoint: askai promptHash mismatch on resume — re-executing live (not serving stale cache)',
        );
        return false;
    }

    /**
     * Cache-miss / re-execute branch. Records a fresh `in-flight`
     * checkpoint (or reuses an existing in-flight / failed row at this
     * op-index), runs the core call, then transitions the row to
     * completed/failed. Checkpoint persistence failures are swallowed
     * with a warning — they must never break a successful AI call.
     */
    private async runAskAiWithCheckpoint(
        prompt: string,
        context: string | undefined,
        options: AiRequestOptions | undefined,
        opIndex: number,
        existingRow: TaskCheckpointRow | null,
    ): Promise<AiResponse> {
        const repo = this.taskCheckpointRepo;
        const task = this._currentTask;
        if (repo === null || task === null) {
            // Defensive — caller already checked, but narrow for the
            // type system. Fall back to the no-checkpoint path.
            return await this.executeAskAiCore(prompt, context, options);
        }

        let checkpointId: string | null = existingRow?.id ?? null;
        if (existingRow === null) {
            try {
                const promptHash = hashPrompt(this.systemPrompt, context, prompt, this.modelConfig.model);
                const row = await repo.recordStart({
                    taskId: task.id,
                    opIndex,
                    opType: 'askai',
                    payloadJson: {
                        promptHash,
                        model: this.modelConfig.model,
                        contextLen: (context?.length ?? 0) + prompt.length,
                    },
                });
                checkpointId = row.id;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.warn({ err: msg, opIndex }, 'checkpoint: recordStart failed — running without checkpoint');
                checkpointId = null;
            }
        } else {
            this.log.info(
                { opIndex, priorStatus: existingRow.status, checkpointId: existingRow.id },
                'checkpoint: re-executing prior in-flight/failed op',
            );
        }

        try {
            const response = await this.executeAskAiCore(prompt, context, options);
            if (checkpointId !== null) {
                try {
                    const output: AskAiCheckpointOutput = {
                        text: response.text,
                        tokensIn: response.tokensIn,
                        tokensOut: response.tokensOut,
                        costUsd: response.costUsd,
                        model: response.model,
                        durationMs: response.durationMs,
                    };
                    await repo.markCompleted(checkpointId, output);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.log.warn({ err: msg, opIndex, checkpointId }, 'checkpoint: markCompleted failed (non-fatal)');
                }
            }
            return response;
        } catch (err) {
            if (checkpointId !== null) {
                try {
                    await repo.markFailed(checkpointId, err instanceof Error ? err.message : String(err));
                } catch (markErr) {
                    const msg = markErr instanceof Error ? markErr.message : String(markErr);
                    this.log.warn({ err: msg, opIndex, checkpointId }, 'checkpoint: markFailed failed');
                }
            }
            throw err;
        }
    }

    /**
     * The real askAI body — sends to the provider, tracks cost,
     * publishes the stream event, etc. Extracted so the checkpoint
     * wrapper can call it once per cache miss without duplicating the
     * provider logic. Same observable behaviour as the pre-P1-01b
     * inline implementation.
     */
    private async executeAskAiCore(
        prompt: string,
        context?: string,
        options?: AiRequestOptions,
    ): Promise<AiResponse> {
        const projectId = this._currentTask?.projectId;
        const taskId = this._currentTask?.id;

        // Enforce budget before making AI call (v0.6)
        if (this.costTracker !== null && projectId !== undefined) {
            await this.costTracker.enforceBudget(projectId);
        }

        // Per-task AI-call cap — prevents runaway TDD/review loops from
        // burning 40+ calls on one task. Configurable via env.
        this._askAiCallCount += 1;
        const maxCalls = parseInt(process.env['KAGEOPS_MAX_AI_CALLS_PER_TASK'] ?? '8', 10);
        if (this._askAiCallCount > maxCalls) {
            this.log.error(
                { taskId, callNumber: this._askAiCallCount, maxCalls },
                `ASKAI-CAP: task exceeded ${maxCalls} AI calls — aborting`
            );
            throw new Error(
                `askAI per-task cap exceeded: ${this._askAiCallCount} > ${maxCalls}. ` +
                `Set KAGEOPS_MAX_AI_CALLS_PER_TASK to raise the limit.`
            );
        }
        if (this._askAiCallCount >= 2 && taskId !== undefined) {
            const stack = new Error('askAI-trace').stack?.split('\n').slice(2, 8).join('\n') ?? '(no stack)';
            this.log.warn(
                { taskId, callNumber: this._askAiCallCount, stack },
                `REPEAT-CALL: askAI invoked ${this._askAiCallCount}x for same task`
            );
        }

        const rawPrompt = context !== undefined
            ? `${context}\n\n${prompt}`
            : prompt;
        const fullPrompt = compressIfLarge(rawPrompt, 500);

        // Guard: Haiku gives poor results on very large prompts while still
        // burning tokens. Rather than hard-fail the task (which spammed runs
        // when a heavy agent like Vigil was routed to Haiku with no fallback),
        // escalate the call to a capable model — the configured non-Haiku
        // fallback, else a same-provider Sonnet. KAGEOPS_HAIKU_GUARD=block
        // restores the old hard-fail.
        const estTokens = Math.ceil(fullPrompt.length / 4);
        const fallbackModelIds = this.fallbackChain?.models.map((m) => m.model) ?? [];
        const haikuGuard = resolveHaikuGuard(this.modelConfig.model, fallbackModelIds, estTokens);
        let escalatedModel: string | null = null;
        if (haikuGuard.action === 'block') {
            this.log.warn(
                { model: this.modelConfig.model, estTokens, taskId },
                'HAIKU-GUARD: blocking prompt > limit on Haiku (block mode or no escalation target)'
            );
            throw new Error(haikuGuard.reason);
        }
        if (haikuGuard.action === 'escalate') {
            escalatedModel = haikuGuard.model ?? null;
            this.log.warn(
                { from: this.modelConfig.model, to: escalatedModel, estTokens, taskId },
                'HAIKU-GUARD: escalating heavy prompt to a capable model'
            );
        }

        // Build a terminal context so the Claude-CLI provider streams its
        // stdout into the Agent Terminal panel (subprocess.output channel).
        // The provider uses it only when the request resolves to claude-cli;
        // other providers ignore it.
        const terminalContext = this.eventBus !== null && projectId !== undefined
            ? {
                projectId,
                ...(taskId !== undefined ? { taskId } : {}),
                agent: this.name,
                publish: async (event: { readonly projectId?: string; readonly taskId?: string; readonly agent?: string; readonly data: Record<string, unknown> }): Promise<void> => {
                    if (this.eventBus === null) return;
                    await this.eventBus.publish('subprocess.output' as never, {
                        projectId: event.projectId ?? projectId,
                        ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
                        agent: event.agent ?? this.name,
                        data: event.data,
                    });
                },
            }
            : undefined;

        // Default cwd for subprocess providers (claude-cli) to the project's
        // workspace. Without this, the CLI runs in KageOps's own repo and
        // cross-contaminates: it reads KageOps's CLAUDE.md and writes output
        // files into the KageOps source tree.
        const taskCwd = this._currentTask?.repoPath;

        const requestOptions = {
            temperature: this.modelConfig.temperature ?? 0.7,
            maxTokens: this.modelConfig.maxTokens ?? 4096,
            ...(terminalContext !== undefined ? { terminal: terminalContext } : {}),
            ...(taskCwd !== undefined && taskCwd !== '' ? { cwd: taskCwd } : {}),
            ...options,
        };

        let response: AiResponse;

        // Resolve the effective system prompt, optionally augmented with skills
        // from the library. Feature-flagged: opt-in via KAGEOPS_SKILLS_HOOKS=true.
        const baseSystemPrompt = buildAgentSystemPrompt(this.systemPrompt, this.isHumanFacing);
        const effectiveSystemPrompt = await this.maybeAugmentWithSkills(baseSystemPrompt, fullPrompt);

        // Use fallback chain if configured (v0.6)
        if (escalatedModel !== null) {
            // HAIKU-GUARD escalation: the primary is a Haiku model that can't
            // handle this prompt — send directly to the capable model, bypassing
            // the (Haiku) chain so we don't bounce back to a model we just ruled out.
            response = await sendPrompt(
                escalatedModel,
                effectiveSystemPrompt,
                fullPrompt,
                requestOptions
            );
        } else if (this.fallbackChain !== null) {
            const result = await executeFallbackChain(
                this.fallbackChain,
                (model: string) => sendPrompt(
                    model,
                    effectiveSystemPrompt,
                    fullPrompt,
                    requestOptions
                )
            );
            response = result.response;
        } else {
            response = await sendPrompt(
                this.modelConfig.model,
                effectiveSystemPrompt,
                fullPrompt,
                requestOptions
            );
        }

        // Fire-and-forget capture — only runs when hooks are enabled AND a
        // skill store was wired in. Never blocks askAI().
        this.maybeCaptureSkill(response.text);

        // Record cost after successful AI call (v0.6)
        if (this.costTracker !== null && projectId !== undefined && response.costUsd > 0) {
            await this.costTracker.recordCost(projectId, response.costUsd);
        }

        // Track last response text for post-task persistence (D4 safety net)
        this._lastAiResponseText = response.text;

        // Log AI usage
        await this.logAction('ai-request', {
            model: response.model,
            tokensIn: response.tokensIn,
            tokensOut: response.tokensOut,
            costUsd: response.costUsd,
            durationMs: response.durationMs,
        });

        // Emit agent.stream event for real-time intercept observability.
        // Send the FULL prompt + response so the Live Intercept panel can
        // show the actual content, not a 500-char preview. The renderer
        // is responsible for any clamping/scrolling on its end.
        // Keep `promptSnippet` / `responseSnippet` keys for back-compat
        // with the existing Activity Bridge wire format; they now carry
        // the unclipped text.
        if (this.eventBus !== null && this._currentTask !== null) {
            await this.eventBus.publish('agent.stream' as never, {
                projectId: this._currentTask.projectId,
                taskId: this._currentTask.id,
                agent: this.name,
                data: {
                    type: 'ai-exchange',
                    prompt: fullPrompt,
                    response: response.text,
                    promptSnippet: fullPrompt,
                    responseSnippet: response.text,
                    model: response.model,
                    tokensIn: response.tokensIn,
                    tokensOut: response.tokensOut,
                    costUsd: response.costUsd,
                },
            });
        }

        return response;
    }

    // ── Progress Reporting ───────────────────────────

    // ── v0.11 Phase 2: Web Research ───────────────────

    /**
     * Scrape a URL and optionally extract structured data against a JSON schema.
     * First iteration scope: `query` must be a URL. SearXNG/Tavily search
     * integration is deferred — passing a free-text query will throw.
     *
     * @param query     The URL to scrape. Must be http(s) and public.
     * @param opts      Optional scrape hints + extraction schema.
     */
    async webResearch(
        query: string,
        opts?: {
            readonly schema?: import('../web/extractor').JsonSchema;
            readonly scrape?: import('../web/scraper').ScrapeOptions;
            readonly maxInputChars?: number;
        },
    ): Promise<import('../web/scraper').ScrapeResult | import('../web/extractor').ExtractResult> {
        if (!isProbablyUrl(query)) {
            throw new Error(
                '[AutonautAgent.webResearch] first iteration accepts URLs only — ' +
                'search engine integration is deferred. Got: ' + query,
            );
        }
        const { scrape } = await import('../web/scraper');
        if (opts?.schema === undefined) {
            return scrape(query, opts?.scrape ?? {});
        }
        const { extract } = await import('../web/extractor');
        return extract(query, opts.schema, {
            scrape: opts.scrape,
            agent: this.name,
            maxInputChars: opts.maxInputChars,
        });
    }

    /**
     * Report progress on the current task.
     */
    protected async reportProgress(task: TaskInfo, message: string): Promise<void> {
        if (this.eventBus !== null) {
            await this.eventBus.publish('task.progress', {
                projectId: task.projectId,
                taskId: task.id,
                agent: this.name,
                data: { message },
            });
        }
    }

    // ── B-201: Verification Evidence ──────────────────

    /**
     * Collect verification evidence during task execution.
     * Agents call this to prove work was done.
     */
    protected collectEvidence(evidence: VerificationEvidence): void {
        this._evidence = [...this._evidence, evidence];
    }

    // ── Event Publishing ──────────────────────────────

    /**
     * Publish a domain-specific event via the EventBus.
     * Agents can emit events (e.g., review.passed, build.started)
     * that Sensei and other components react to.
     */
    protected async publishEvent(
        channel: string,
        data: Record<string, unknown>
    ): Promise<void> {
        if (this.eventBus !== null && this._currentTask !== null) {
            await this.eventBus.publish(channel as never, {
                projectId: this._currentTask.projectId,
                taskId: this._currentTask.id,
                agent: this.name,
                data,
            });
        }
    }

    // ── Output File Writing ────────────────────────────

    /**
     * Parse AI output for file blocks and write them to the project repo.
     * Falls back to writing the entire output to task.outputPath if no
     * file blocks are found.
     *
     * Returns the list of file paths written.
     */
    protected async writeOutputFiles(task: TaskInfo, aiOutput: string): Promise<readonly string[]> {
        const blocks = parseFileBlocks(aiOutput);
        const written: string[] = [];
        const rejected: { path: string; preview: string }[] = [];

        for (const block of blocks) {
            // F-390: per-block content-shape guard. Forge's IMPROVE-phase
            // consolidated task was caught (2026-05-21 GPS Delivery Tracker
            // smoke) writing 1-3 line file-description prose into `.ts`/
            // `.tsx` files. Reject any block whose content doesn't look
            // like the kind of artifact its extension implies — log a
            // warning with a preview, skip the write. If every block in
            // this AI output ends up rejected, throw below so the task
            // fails loud (retry/escalate path) instead of silently
            // shipping zero files.
            if (!isLikelyArtifactContent(block.content, block.filePath)) {
                // BPF-4: recover a real artifact hidden behind a narration
                // preamble before treating the block as unrecoverable prose.
                const recovered = recoverArtifactFromNarration(block.content, block.filePath);
                if (recovered === null) {
                    // BPF-38: a "no-op note" ("file already exists" / "no
                    // changes") is the model declining to rewrite — NOT a stub
                    // regression. Skip the write so the existing file is
                    // preserved, and do NOT count it as a rejection (so a task
                    // whose only action is "this file is already fine" succeeds
                    // instead of false-failing F-390 + clobbering the artifact).
                    if (isNoOpFileNote(block.content)) {
                        this.log.info(
                            { taskId: task.id, agent: this.name, filePath: block.filePath },
                            'BPF-38: model returned a no-op note — preserving existing file, skipping write',
                        );
                        continue;
                    }
                    const preview = block.content.replace(/\s+/g, ' ').slice(0, 160);
                    rejected.push({ path: block.filePath, preview });
                    this.log.warn(
                        { taskId: task.id, agent: this.name, filePath: block.filePath, contentLength: block.content.length, preview },
                        'F-390: rejected file block — content does not look like an artifact for its extension (likely stub prose)',
                    );
                    continue;
                }
                this.log.info(
                    { taskId: task.id, agent: this.name, filePath: block.filePath, strippedChars: block.content.length - recovered.length },
                    'BPF-4: stripped narration preamble — recovered file block',
                );
                await this.writeFile(task.repoPath, block.filePath, recovered);
                written.push(block.filePath);
                await this.reportProgress(task, `Wrote: ${block.filePath}`);
                continue;
            }
            await this.writeFile(task.repoPath, block.filePath, block.content);
            written.push(block.filePath);
            await this.reportProgress(task, `Wrote: ${block.filePath}`);
        }

        // F-390: if Forge produced blocks but EVERY one was prose, that's a
        // regression we must surface. The task fails — Sensei's retry path
        // takes it from there (escalate to a stronger model or human).
        if (written.length === 0 && rejected.length > 0) {
            const detail = rejected
                .map((r) => `  - ${r.path}: "${r.preview}${r.preview.length >= 160 ? '…' : ''}"`)
                .join('\n');
            throw new Error(
                `F-390: all ${rejected.length} file block(s) produced by ${this.name} for task "${task.title}" ` +
                `look like prose/descriptions, not real source. No files written. Rejected blocks:\n${detail}\n` +
                `If this is a real artifact in an unusual shape, broaden isLikelyArtifactContent in src/agents/output-parser.ts.`
            );
        }

        // Fallback: write entire output to the task's designated output path —
        // BUT only when the response actually looks like file content. Wave 4
        // Day 2 fix: agents (especially Pixel and Forge) routinely return
        // chat-style summaries ("--- DESIGN BRIEF ---", "POC landing exists.
        // Reviewed HTML, CSS, JS...") that this fallback was blindly writing
        // as the artifact, stomping real files left by previous tasks.
        if (written.length === 0 && task.outputPath !== null) {
            if (isLikelyArtifactContent(aiOutput, task.outputPath)) {
                await this.writeFile(task.repoPath, task.outputPath, aiOutput);
                written.push(task.outputPath);
            } else {
                this.log.warn(
                    { taskId: task.id, agent: this.name, outputPath: task.outputPath, preview: aiOutput.slice(0, 120) },
                    'Skipped writing fallback: response looks like chat text, not file content',
                );
            }
        }

        // B-201: Auto-collect files_written evidence
        // F-391: pass `repoPath` so evidenceFromFiles reads each file
        // back and shape-checks the content. Defense-in-depth with
        // F-390 — even if a stub slipped past writeOutputFiles, the
        // verifier won't claim "Verified: 4/2 checks passed" against
        // 1-line prose files.
        if (written.length > 0) {
            this.collectEvidence(evidenceFromFiles(written, { repoPath: task.repoPath }));
        }

        return written;
    }

    // ── D1: Shell Execution ───────────────────────────

    /**
     * Execute a shell command inside the project repo directory.
     *
     * - Only commands on SHELL_ALLOWLIST are permitted.
     * - Arguments are checked against SHELL_BLOCKLIST patterns.
     * - Timeout: 5 minutes.
     * - All executions are logged to agent_logs.
     *
     * @throws Error if the command is not on the allowlist, args are blocked,
     *   or the process exits non-zero.
     */
    protected async executeCommand(
        task: TaskInfo,
        command: string,
        args: string[] = []
    ): Promise<ShellResult> {
        // Allowlist + blocklist checks always run, even on a resume —
        // they're pure validation and we never want a future change to
        // the allowlist to be bypassed by a stale checkpoint.
        const cmd = command.trim().toLowerCase();
        if (!SHELL_ALLOWLIST.has(cmd)) {
            throw new Error(
                `Shell command '${command}' is not on the allowlist. ` +
                `Allowed: ${[...SHELL_ALLOWLIST].join(', ')}`
            );
        }

        const argString = args.join(' ');
        for (const pattern of SHELL_BLOCKLIST) {
            if (pattern.test(argString)) {
                throw new Error(`Shell args blocked by safety pattern ${pattern}: ${argString}`);
            }
        }

        this.log.info({ command, args, repoPath: task.repoPath }, 'Executing shell command');
        await this.reportProgress(task, `Running: ${command} ${argString}`);

        // Live transparency: shell-exec-start fires regardless of
        // cache hit so the operator still sees the command appear in
        // the feed. The follow-up shell-exec-end either reports the
        // real exit (miss) or the cached exit (hit).
        const startedAt = Date.now();
        void this.publishEvent('agent.stream', {
            type: 'shell-exec-start',
            command,
            args: argString,
            cwd: task.repoPath,
        });

        // P1-01d: checkpoint pre-flight. Cache hit ⇒ replay cached
        // result + observability + (possibly) throw, without spawning
        // the process. Cache miss ⇒ fall through to the real spawn,
        // then record completion via the existing flow + markCompleted.
        let checkpointId: string | null = null;
        if (this.checkpointsEnabled() && this.taskCheckpointRepo !== null && this._currentTask !== null) {
            const opIndex = this._currentTaskOpIndex;
            const decision = await this.tryExecCacheHit(
                this._currentTask.id, opIndex, cmd, command, argString, task.repoPath, args,
            );
            if (decision.kind === 'hit') {
                this._currentTaskOpIndex += 1;
                return this.serveExecCacheHit(decision.row, command, argString, cmd);
            }
            checkpointId = decision.checkpointId;
            this._currentTaskOpIndex += 1;
        }

        const onChunk = (kind: 'stdout' | 'stderr', chunk: string): void => {
            // Fire-and-forget — pg_notify truncates oversized payloads,
            // and full output is still captured in agent_logs by logAction.
            void this.publishEvent('subprocess.output', {
                command,
                kind,
                chunk: chunk.slice(0, 4000),
            });
        };

        let result: ShellResult;
        try {
            result = await this.spawnWithTimeout(command, args, task.repoPath, 300_000, onChunk);
        } catch (err) {
            void this.publishEvent('agent.stream', {
                type: 'shell-exec-end',
                command,
                args: argString,
                exitCode: -1,
                durationMs: Date.now() - startedAt,
                error: err instanceof Error ? err.message : String(err),
            });
            if (checkpointId !== null && this.taskCheckpointRepo !== null) {
                try {
                    await this.taskCheckpointRepo.markFailed(checkpointId, err instanceof Error ? err.message : String(err));
                } catch (markErr) {
                    const msg = markErr instanceof Error ? markErr.message : String(markErr);
                    this.log.warn({ err: msg, checkpointId }, 'checkpoint: markFailed (exec) failed');
                }
            }
            throw err;
        }

        const durationMs = Date.now() - startedAt;
        void this.publishEvent('agent.stream', {
            type: 'shell-exec-end',
            command,
            args: argString,
            exitCode: result.exitCode,
            durationMs,
        });

        await this.logAction('shell-exec', {
            command,
            args: argString,
            exitCode: result.exitCode,
            stdout: result.stdout.slice(0, 500),
            stderr: result.stderr.slice(0, 500),
        });

        // B-201: Auto-collect verification evidence for known commands.
        const evidenceKind = COMMAND_EVIDENCE_MAP[cmd];
        if (evidenceKind !== undefined) {
            this.collectEvidence(
                evidenceFromShell(evidenceKind, `${command} ${argString}`, result.stdout, result.stderr, result.exitCode)
            );
        }

        // markCompleted runs BEFORE the non-zero-exit throw so a future
        // resume can replay the failure deterministically (rather than
        // re-spawning a known-bad command).
        if (checkpointId !== null && this.taskCheckpointRepo !== null) {
            try {
                await this.taskCheckpointRepo.markCompleted(checkpointId, {
                    exitCode: result.exitCode,
                    stdoutPreview: result.stdout.slice(0, EXEC_PREVIEW_BYTES),
                    stderrPreview: result.stderr.slice(0, EXEC_PREVIEW_BYTES),
                    durationMs,
                });
            } catch (markErr) {
                const msg = markErr instanceof Error ? markErr.message : String(markErr);
                this.log.warn({ err: msg, checkpointId, command }, 'checkpoint: markCompleted (exec) failed (non-fatal)');
            }
        }

        if (result.exitCode !== 0) {
            throw new Error(
                `Command '${command} ${argString}' exited ${result.exitCode}:\n${result.stderr || result.stdout}`
            );
        }

        return result;
    }

    /**
     * P1-01d helper. Decide whether the pending exec is a cache hit
     * (replay cached result, no spawn) or a miss (proceed to real
     * spawn + record). Returns the row id to mark on success / failure
     * when it's a miss + the recordStart succeeded; null otherwise.
     */
    private async tryExecCacheHit(
        taskId: string,
        opIndex: number,
        cmd: string,
        command: string,
        argString: string,
        cwd: string,
        args: readonly string[],
    ): Promise<{ kind: 'hit'; row: TaskCheckpointRow } | { kind: 'miss'; checkpointId: string | null }> {
        const repo = this.taskCheckpointRepo;
        if (repo === null) return { kind: 'miss', checkpointId: null };

        let existing: TaskCheckpointRow | null = null;
        try {
            existing = await repo.findByOp(taskId, opIndex);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn({ err: msg, opIndex, command }, 'checkpoint: findByOp (exec) failed — continuing without cache');
        }

        if (existing !== null && existing.status === 'completed' && existing.opType === 'exec') {
            // Resume-safety guard (mirror of checkpointAskAiMatches): only
            // replay the cached exit/stdout when this op-index re-ran the
            // SAME full command (`cmd` alone is just the allowlist base,
            // e.g. "npm" — identical for "npm test" vs "npm run build", so
            // we compare command + args). A divergent re-run could land a
            // different command at the same op-index; replaying the old
            // result would be wrong. On mismatch, overwrite via the row id.
            const payload = existing.payloadJson as { command?: unknown; args?: unknown } | null;
            const storedKey = execInvocationKey(payload?.command, payload?.args);
            const currentKey = execInvocationKey(command, args);
            if (storedKey === null || storedKey === currentKey) {
                return { kind: 'hit', row: existing };
            }
            this.log.info(
                { taskId, opIndex },
                'checkpoint: exec command mismatch on resume — re-executing live (not serving stale cache)',
            );
            return { kind: 'miss', checkpointId: existing.id };
        }

        if (existing !== null) {
            // in-flight / failed / wrong op_type ⇒ overwrite via id.
            return { kind: 'miss', checkpointId: existing.id };
        }

        try {
            const row = await repo.recordStart({
                taskId,
                opIndex,
                opType: 'exec',
                payloadJson: { command, args: [...args], cwd, cmd },
            });
            return { kind: 'miss', checkpointId: row.id };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn({ err: msg, opIndex, command }, 'checkpoint: recordStart (exec) failed — running without checkpoint');
            return { kind: 'miss', checkpointId: null };
        }
    }

    /**
     * P1-01d helper. Reconstruct a ShellResult + replay observability
     * (stream event + log row + evidence collection) from a cached
     * exec checkpoint. Throws when the cached exit code was non-zero
     * so the calling code path matches the original semantics
     * exactly. Cached stdout/stderr are previews (capped at
     * `EXEC_PREVIEW_BYTES`) — callers parsing full output across a
     * resume should be aware of the cap; the plan canonicalised
     * previews on purpose to keep checkpoint rows bounded.
     */
    private serveExecCacheHit(
        row: TaskCheckpointRow,
        command: string,
        argString: string,
        cmd: string,
    ): ShellResult {
        const output = (row.outputJson as ExecCheckpointOutput | null) ?? {
            exitCode: 0, stdoutPreview: '', stderrPreview: '', durationMs: 0,
        };
        const result: ShellResult = {
            stdout: output.stdoutPreview,
            stderr: output.stderrPreview,
            exitCode: output.exitCode,
        };

        void this.publishEvent('agent.stream', {
            type: 'shell-exec-end',
            command,
            args: argString,
            exitCode: result.exitCode,
            durationMs: 0,
            cached: true,
            cachedFromCheckpointId: row.id,
        });

        // Same log row shape as the live path so downstream tooling
        // (cost reporting, run reports) sees identical rows on a
        // resumed run. `cached: true` flag marks it for filtering.
        void this.logAction('shell-exec-cache-hit', {
            command,
            args: argString,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            cachedFromCheckpointId: row.id,
            opIndex: row.opIndex,
            originalDurationMs: output.durationMs,
        });

        const evidenceKind = COMMAND_EVIDENCE_MAP[cmd];
        if (evidenceKind !== undefined) {
            this.collectEvidence(
                evidenceFromShell(evidenceKind, `${command} ${argString}`, result.stdout, result.stderr, result.exitCode)
            );
        }

        this.log.info(
            { taskId: this._currentTask?.id, opIndex: row.opIndex, command, exitCode: result.exitCode },
            'checkpoint cache hit (exec) — skipped real spawn',
        );

        if (result.exitCode !== 0) {
            throw new Error(
                `Command '${command} ${argString}' exited ${result.exitCode}:\n${result.stderr || result.stdout}`
            );
        }

        return result;
    }

    protected spawnWithTimeout(
        command: string,
        args: string[],
        cwd: string,
        timeoutMs: number,
        onChunk?: (kind: 'stdout' | 'stderr', chunk: string) => void,
    ): Promise<ShellResult> {
        return new Promise((resolve, reject) => {
            // Strip dangerous env vars before spawning
            const safeEnv = { ...process.env };
            delete safeEnv['LD_PRELOAD'];
            delete safeEnv['LD_LIBRARY_PATH'];
            delete safeEnv['DYLD_INSERT_LIBRARIES'];

            // On Windows, npm/npx are .cmd shims — spawn() with shell:false
            // can't resolve them. Use shell:true on Windows only.
            const isWindows = process.platform === 'win32';
            const proc = spawn(command, args, {
                cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: safeEnv,
                shell: isWindows,
                windowsHide: true,
            });

            let stdout = '';
            let stderr = '';
            let timedOut = false;

            const timer = setTimeout(() => {
                timedOut = true;
                proc.kill('SIGTERM');
            }, timeoutMs);

            proc.stdout.on('data', (d: Buffer) => {
                const text = d.toString();
                stdout += text;
                if (onChunk !== undefined) {
                    try { onChunk('stdout', text); } catch { /* never let listener errors kill the process */ }
                }
            });
            proc.stderr.on('data', (d: Buffer) => {
                const text = d.toString();
                stderr += text;
                if (onChunk !== undefined) {
                    try { onChunk('stderr', text); } catch { /* never let listener errors kill the process */ }
                }
            });

            proc.on('close', (code) => {
                clearTimeout(timer);
                if (timedOut) {
                    reject(new Error(`Command '${command}' timed out after ${timeoutMs / 1000}s`));
                } else {
                    resolve({ stdout, stderr, exitCode: code ?? 1 });
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    // ── D3: Loop Detection ────────────────────────────

    /**
     * Record an action key and check if the agent is stuck in a loop.
     * Call this inside executeTask() with a string that uniquely identifies
     * the action being taken (e.g., `askAI:${prompt.slice(0,80)}`).
     *
     * @returns true if a loop is detected (caller should break/escalate).
     */
    protected detectLoop(actionKey: string): boolean {
        this._recentActions.push(actionKey);
        if (this._recentActions.length > LOOP_WINDOW) {
            this._recentActions.shift();
        }

        if (this._recentActions.length < LOOP_THRESHOLD) return false;

        // Count occurrences of the most-recent action in the window
        const last = this._recentActions[this._recentActions.length - 1];
        const count = this._recentActions.filter((a) => a === last).length;
        const looping = count >= LOOP_THRESHOLD;

        if (looping) {
            this.log.warn({ actionKey, count, window: this._recentActions }, 'Loop detected');
        }

        return looping;
    }

    /** Reset the loop detection buffer — call at the start of each task. */
    protected resetLoopDetection(): void {
        this._recentActions = [];
    }

    // ── D2: Context Compaction ────────────────────────

    /**
     * Add a message to the tracked conversation for this task.
     * Automatically compacts when accumulated token estimate exceeds threshold.
     *
     * Returns the (possibly compacted) message list to pass to the next AI call.
     */
    protected async trackConversation(
        role: 'user' | 'assistant',
        content: string
    ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
        this._conversationMessages = [...this._conversationMessages, { role, content }];

        const totalChars = this._conversationMessages.reduce((sum, m) => sum + m.content.length, 0);
        const estimatedTokens = Math.floor(totalChars / CHARS_PER_TOKEN);

        if (estimatedTokens > COMPACTION_THRESHOLD_TOKENS) {
            await this.compactConversation();
        }

        return this._conversationMessages;
    }

    /** Reset the conversation buffer — call at the start of each task. */
    protected resetConversation(): void {
        this._conversationMessages = [];
    }

    private async compactConversation(): Promise<void> {
        if (this._conversationMessages.length <= COMPACTION_BATCH) return;

        // Take the oldest batch (skip index 0 if it's a system/context message)
        const toSummarise = this._conversationMessages.slice(0, COMPACTION_BATCH);
        const remainder = this._conversationMessages.slice(COMPACTION_BATCH);

        const summaryPrompt = [
            'Summarise the following conversation exchanges concisely. ',
            'Preserve all decisions made, files mentioned, and key facts. ',
            'Output only the summary, no preamble.\n\n',
            toSummarise.map((m) => `[${m.role}]: ${m.content}`).join('\n'),
        ].join('');

        try {
            const response = await this.askAI(summaryPrompt);
            const summaryMessage = {
                role: 'user' as const,
                content: `[Compacted context]\n${compressIfLarge(response.text, 200)}`,
            };
            this._conversationMessages = [summaryMessage, ...remainder];
            this.log.info(
                { compactedCount: toSummarise.length, remainingCount: remainder.length },
                'Context compacted'
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn({ err: msg }, 'Context compaction failed — keeping full history');
        }
    }

    // ── File System Access (scoped to project repo) ──

    /**
     * Read a file from the project repo.
     */
    protected readFile(repoPath: string, filePath: string): string {
        const fullPath = path.resolve(repoPath, filePath);
        this.validatePath(repoPath, fullPath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        // Live transparency for the intercept feed. Fire-and-forget;
        // if eventBus is null the publishEvent guard returns early.
        void this.publishEvent('agent.stream', {
            type: 'file-read',
            path: filePath,
            bytes: Buffer.byteLength(content, 'utf-8'),
        });
        return content;
    }

    /**
     * Write a file to the project repo.
     *
     * Every agent file-write funnels through `sanitizeAgentOutput`,
     * which layers fence stripping, BOM removal, zero-width-char
     * scrubbing, and (for code files) smart-quote + NBSP normalization.
     * Every transform is idempotent, so callers that already cleaned
     * content pay only a cheap second pass.
     *
     * P1-01c: when checkpoints are enabled (on by default) and a
     * checkpoint repo is wired, the write goes through the
     * `task_checkpoints` table. On a resume hit (status='completed', op_type='write',
     * on-disk sha256 matches cached) the actual write is skipped —
     * the prior run's bytes-on-disk verifies survived. On a sha256
     * mismatch (file wiped or corrupted) the cache is treated as a
     * miss and the write proceeds, overwriting the existing row's
     * status. Outside the checkpoint flow the behaviour is identical
     * to the pre-P1-01c path.
     */
    protected async writeFile(repoPath: string, filePath: string, content: string): Promise<void> {
        const fullPath = path.resolve(repoPath, filePath);
        this.validatePath(repoPath, fullPath);

        let cleaned = sanitizeAgentOutput(content, filePath);

        // 2026-06 narration-leak guard. Every agent write funnels through
        // here, but historically only the block-parse call sites
        // (writeOutputFiles, forge.ts) shape-checked the content. Any
        // path calling writeFile directly wrote unguarded — that's how a
        // 374-line leaked monologue landed in layout.tsx and 500'd every
        // route. Enforce the shape oracle at the single choke point so no
        // write escapes it. Idempotent with the upstream checks: those
        // already skip rejected blocks, so this only fires for the
        // direct-write paths (a no-op double-check otherwise).
        if (!isLikelyArtifactContent(cleaned, filePath)) {
            // BPF-4: non-premium models (Haiku, qwen-coder, kimi) prepend a
            // narration preamble ("I'll implement…", "Let me…", a fenced block)
            // before the real file body. Recover the artifact rather than
            // failing the whole task — only when a valid body actually follows.
            const recovered = recoverArtifactFromNarration(cleaned, filePath);
            if (recovered !== null) {
                this.log.info(
                    { agent: this.name, filePath, strippedChars: cleaned.length - recovered.length },
                    `[${this.name}] BPF-4: stripped narration preamble — recovered artifact for ${filePath}`,
                );
                cleaned = recovered;
            } else {
                const firstLine = cleaned.replace(/^[﻿\s]+/, '').split(/\r?\n/, 1)[0].slice(0, 160);
                this.log.warn(
                    { agent: this.name, filePath, firstLine, contentLength: cleaned.length },
                    `[${this.name}] rejected non-artifact content for ${filePath} — looks like chat/reasoning narration, not source`,
                );
                throw new Error(
                    `[${this.name}] refused to write non-artifact content to ${filePath}: ` +
                    `the content reads as chat/reasoning narration, not a valid artifact for its type. ` +
                    `First line: "${firstLine}". ` +
                    `If this is a real artifact in an unusual shape, broaden isLikelyArtifactContent in src/agents/output-parser.ts.`,
                );
            }
        }

        // BPF-9: keep a generated package.json installable. Weak models add
        // TypeScript path aliases (`@/components`) or otherwise-illegal names to
        // dependencies, which fail `npm install` (EINVALIDPACKAGENAME) and block
        // the whole build gate. Strip invalid dep names on write (no-op for any
        // other file or an already-clean manifest).
        if (path.basename(filePath).toLowerCase() === 'package.json') {
            cleaned = sanitizePackageJson(cleaned);
        }

        const sha256 = sha256OfContent(cleaned);
        const bytes = Buffer.byteLength(cleaned, 'utf-8');

        // P1-01c checkpoint pre-flight. Cache hit ⇒ skip the write
        // entirely; cache miss / row mismatch ⇒ proceed to the actual
        // write, with `checkpointId` carrying the row id to mark on
        // completion (reusing the existing row id on overwrite avoids
        // the unique-key collision).
        let checkpointId: string | null = null;
        if (this.checkpointsEnabled() && this.taskCheckpointRepo !== null && this._currentTask !== null) {
            const opIndex = this._currentTaskOpIndex;
            const decision = await this.tryWriteFileCacheHit(
                this._currentTask.id, opIndex, filePath, fullPath, sha256, bytes,
            );
            if (decision.kind === 'hit') {
                this._currentTaskOpIndex += 1;
                return;
            }
            checkpointId = decision.checkpointId;
            this._currentTaskOpIndex += 1;
        }

        // Actual write (security scan + mkdir + writeFileSync + stream event).
        const findingsCount = this.writeFileToDiskSync(fullPath, filePath, cleaned);

        if (checkpointId !== null && this.taskCheckpointRepo !== null) {
            try {
                await this.taskCheckpointRepo.markCompleted(checkpointId, {
                    bytesWritten: bytes,
                    sha256,
                    securityFindings: findingsCount,
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.warn(
                    { err: msg, checkpointId, filePath },
                    'checkpoint: markCompleted (write) failed (non-fatal)',
                );
            }
        }
    }

    /**
     * P1-01c helper. Decide whether the pending write is a cache hit
     * (skip the actual write) or a miss (proceed and record). Returns
     * the row id the caller should `markCompleted()` on success when
     * the result is a miss + repo write succeeded; null when the
     * checkpoint write itself failed (we still do the disk write, we
     * just don't track it).
     */
    private async tryWriteFileCacheHit(
        taskId: string,
        opIndex: number,
        filePath: string,
        fullPath: string,
        sha256: string,
        bytes: number,
    ): Promise<{ kind: 'hit' } | { kind: 'miss'; checkpointId: string | null }> {
        const repo = this.taskCheckpointRepo;
        if (repo === null) return { kind: 'miss', checkpointId: null };

        let existing: TaskCheckpointRow | null = null;
        try {
            existing = await repo.findByOp(taskId, opIndex);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn({ err: msg, opIndex, filePath }, 'checkpoint: findByOp (write) failed — continuing without cache');
        }

        if (existing !== null && existing.status === 'completed' && existing.opType === 'write') {
            const cachedSha = (existing.outputJson as { sha256?: string } | null)?.sha256;
            const onDiskSha = readOnDiskSha256(fullPath);
            if (cachedSha !== undefined && onDiskSha !== null && cachedSha === onDiskSha) {
                await this.emitWriteCacheHit(existing, filePath, bytes);
                return { kind: 'hit' };
            }
            this.log.info(
                { opIndex, filePath, cachedSha, onDiskSha },
                'checkpoint: write op completed in prior run but on-disk content differs — re-writing',
            );
            return { kind: 'miss', checkpointId: existing.id };
        }

        if (existing !== null) {
            // in-flight / failed / wrong op_type ⇒ overwrite via id.
            return { kind: 'miss', checkpointId: existing.id };
        }

        // No row — record a fresh in-flight checkpoint.
        try {
            const row = await repo.recordStart({
                taskId,
                opIndex,
                opType: 'write',
                payloadJson: {
                    filePath,
                    bytes,
                    sha256,
                },
            });
            return { kind: 'miss', checkpointId: row.id };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn({ err: msg, opIndex, filePath }, 'checkpoint: recordStart (write) failed — writing without checkpoint');
            return { kind: 'miss', checkpointId: null };
        }
    }

    /**
     * P1-01c helper. Emit the `file-write-cache-hit` observability
     * surface (stream event + agent_log row) when a prior run's
     * bytes-on-disk are still there. Mirrors the askAI cache-hit
     * shape so the operator UI can render both in the same timeline.
     */
    private async emitWriteCacheHit(row: TaskCheckpointRow, filePath: string, bytes: number): Promise<void> {
        await this.logAction('file-write-cache-hit', {
            costUsd: 0,
            durationMs: 0,
            cachedFromCheckpointId: row.id,
            opIndex: row.opIndex,
            filePath,
            bytes,
        });
        if (this.eventBus !== null && this._currentTask !== null) {
            await this.eventBus.publish('agent.stream' as never, {
                projectId: this._currentTask.projectId,
                taskId: this._currentTask.id,
                agent: this.name,
                data: {
                    type: 'file-write-cache-hit',
                    opIndex: row.opIndex,
                    path: filePath,
                    bytes,
                },
            });
        }
        this.log.info(
            { taskId: this._currentTask?.id, opIndex: row.opIndex, filePath, bytes },
            'checkpoint cache hit (write) — skipped real write',
        );
    }

    /**
     * Synchronous FS portion of writeFile. Extracted in P1-01c so the
     * checkpoint wrapper can call it once per miss without duplicating
     * the security-scan / mkdir / stream-event logic. Returns the
     * number of security findings so the checkpoint output_json can
     * carry it for diagnostic completeness.
     */
    private writeFileToDiskSync(fullPath: string, filePath: string, cleaned: string): number {
        const findings = this.securityScanner.scan(cleaned, filePath);
        for (const f of findings) {
            this.log.warn(
                { pattern: f.pattern, file: f.file, line: f.line, severity: f.severity },
                `Security: ${f.pattern} — ${f.remediation}`
            );
        }

        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(fullPath, cleaned, 'utf-8');

        void this.publishEvent('agent.stream', {
            type: 'file-write',
            path: filePath,
            bytes: Buffer.byteLength(cleaned, 'utf-8'),
            securityFindings: findings.length,
        });

        return findings.length;
    }

    /** Return accumulated security findings for this session. */
    protected getSecurityFindings(): readonly SecurityFinding[] {
        // Delegate to a full scan isn't needed — the session scanner tracks warned patterns.
        // This is a convenience accessor; callers can use the scanner directly if needed.
        return [];
    }

    /**
     * List files matching a glob pattern in the project repo.
     */
    protected listFiles(repoPath: string, pattern: string): string[] {
        // Simple recursive listing — for more complex globs, use a glob library
        const results: string[] = [];
        const fullRepoPath = path.resolve(repoPath);

        function walk(dir: string): void {
            if (!fs.existsSync(dir)) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== 'node_modules' && entry.name !== '.git') {
                        walk(entryPath);
                    }
                } else if (entry.name.match(pattern)) {
                    results.push(path.relative(fullRepoPath, entryPath));
                }
            }
        }

        walk(fullRepoPath);
        return results;
    }

    // ── Git Integration ──────────────────────────────

    /**
     * Create a git commit in the project repo.
     * No-op when KAGEOPS_DISABLE_GIT is set.
     */
    protected async gitCommit(repoPath: string, message: string): Promise<void> {
        if (isGitDisabled()) {
            this.log.debug({ message }, 'Git disabled — skipping commit');
            return;
        }
        await this.ensureRepoInitialized(repoPath);
        await this.runGit(repoPath, ['add', '-A']);
        await this.runGit(repoPath, ['commit', '-m', message]);
    }

    /**
     * Create a new branch in the project repo.
     * No-op when KAGEOPS_DISABLE_GIT is set.
     */
    protected async gitCreateBranch(repoPath: string, branchName: string): Promise<void> {
        if (isGitDisabled()) {
            this.log.debug({ branchName }, 'Git disabled — skipping branch create');
            return;
        }
        await this.ensureRepoInitialized(repoPath);
        await this.runGit(repoPath, ['checkout', '-b', branchName]);
    }

    /**
     * F-334: defensive auto-init for legacy / fallback workspaces that
     * lack a `.git/` directory. Without this, agents that arrive in a
     * non-repo workspace fail with `fatal: not a git repository` on the
     * first `git add -A`, surfacing as a cryptic task failure. Idempotent
     * — skipped when `.git/` already exists.
     */
    private async ensureRepoInitialized(repoPath: string): Promise<void> {
        try {
            const fs = await import('fs');
            const path = await import('path');
            const gitDir = path.join(repoPath, '.git');
            if (fs.existsSync(gitDir)) return;
            await this.runGit(repoPath, ['init']);
            await this.runGit(repoPath, ['commit', '--allow-empty', '-m', 'Initial commit (auto-init)']);
            this.log.info({ repoPath }, 'F-334: auto-initialized git repo');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn({ err: msg, repoPath }, 'F-334: git auto-init failed (continuing)');
        }
    }

    /**
     * Push to remote.
     * No-op when KAGEOPS_DISABLE_GIT is set.
     */
    protected async gitPush(repoPath: string): Promise<void> {
        if (isGitDisabled()) {
            this.log.debug({ repoPath }, 'Git disabled — skipping push');
            return;
        }
        await this.runGit(repoPath, ['push']);
    }

    // ── v0.8 Code Graph Helpers ──────────────────────

    /**
     * Fetch review context (blast radius + test gaps) for changed files.
     * Returns a markdown-formatted string, or null if unavailable.
     */
    protected async getCodeGraphReviewContext(
        repoPath: string,
        changedFiles: readonly string[]
    ): Promise<string | null> {
        if (this.codeGraphBridge === null) return null;
        const result = await this.codeGraphBridge.getReviewContext(repoPath, changedFiles);
        if (result === null) return null;

        const lines: string[] = [
            '## Code Graph: Review Context',
            `Risk Score: ${result.riskScore}`,
            result.summary,
        ];

        if (result.blastRadius.length > 0) {
            lines.push('\n### Blast Radius');
            for (const entry of result.blastRadius) {
                lines.push(`- **${entry.filePath}** — called by: ${entry.calledBy.join(', ') || 'none'}`);
            }
        }

        if (result.testGaps.length > 0) {
            lines.push('\n### Test Gaps');
            for (const gap of result.testGaps) {
                const status = gap.hasCoverage ? 'covered' : 'UNCOVERED';
                lines.push(`- **${gap.symbol}** (${gap.filePath}): ${status}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Fetch impact radius for a symbol (callers/callees up to N hops).
     * Returns a markdown-formatted string, or null if unavailable.
     */
    protected async getCodeGraphImpactRadius(
        repoPath: string,
        symbolName: string,
        depth = 2
    ): Promise<string | null> {
        if (this.codeGraphBridge === null) return null;
        const result = await this.codeGraphBridge.getImpactRadius(repoPath, symbolName, depth);
        if (result === null) return null;

        const lines: string[] = [
            `## Code Graph: Impact Radius — \`${symbolName}\``,
            result.summary,
        ];

        for (const entry of result.entries) {
            lines.push(`\n### ${entry.symbol} (${entry.filePath}, depth ${entry.depth})`);
            if (entry.callers.length > 0) lines.push(`Callers: ${entry.callers.join(', ')}`);
            if (entry.callees.length > 0) lines.push(`Callees: ${entry.callees.join(', ')}`);
        }

        return lines.join('\n');
    }

    /**
     * Fetch architecture overview (community clusters + coupling score).
     * Returns a markdown-formatted string, or null if unavailable.
     */
    protected async getCodeGraphArchitecture(repoPath: string): Promise<string | null> {
        if (this.codeGraphBridge === null) return null;
        const result = await this.codeGraphBridge.getArchitectureOverview(repoPath);
        if (result === null) return null;

        const lines: string[] = [
            '## Code Graph: Architecture Overview',
            `Coupling Score: ${result.couplingScore}`,
            result.summary,
            '\n### Module Communities',
        ];

        for (const community of result.communities) {
            lines.push(`- **${community.name}** (cohesion ${community.cohesion}): ${community.files.join(', ')}`);
        }

        return lines.join('\n');
    }

    /**
     * Fetch minimal context needed for a task (token-efficient).
     * Returns a markdown-formatted string, or null if unavailable.
     */
    protected async getCodeGraphMinimalContext(
        repoPath: string,
        taskDescription: string
    ): Promise<string | null> {
        if (this.codeGraphBridge === null) return null;
        const result = await this.codeGraphBridge.getMinimalContext(repoPath, taskDescription);
        if (result === null) return null;

        return [
            `## Code Graph: Minimal Context (~${result.tokenEstimate} tokens)`,
            result.context,
        ].join('\n');
    }

    // ── Graphify Knowledge Graph Helpers (v1.2) ────

    /**
     * Get the graphify report for a repo (god nodes, community structure).
     * Returns the GRAPH_REPORT.md contents, or null if not built yet.
     */
    protected getGraphifyReport(repoPath: string): string | null {
        if (this.graphifyBridge === null) return null;
        return this.graphifyBridge.getReport(repoPath);
    }

    /**
     * Query the graphify knowledge graph with a question.
     * Returns relevant nodes and edges within a token budget.
     */
    protected queryGraphify(repoPath: string, question: string, tokenBudget = 2000): string | null {
        if (this.graphifyBridge === null) return null;
        const result = this.graphifyBridge.queryGraph(repoPath, question, tokenBudget);
        if (result.nodes.length === 0) return null;

        const lines = [
            `## Graphify: ${result.summary}`,
            '',
            '### Key Nodes',
            ...result.nodes.slice(0, 20).map((n) =>
                `- **${n.label}** (${n.file_type ?? 'unknown'}) — ${n.source_file ?? ''}`
            ),
        ];

        if (result.edges.length > 0) {
            lines.push('', '### Relationships');
            const edgeSample = result.edges.slice(0, 15);
            for (const e of edgeSample) {
                lines.push(`- ${e.source} → ${e.target} (${e.relation ?? 'related'}, ${e.confidence ?? 'EXTRACTED'})`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Get god nodes (most connected entities) from the graphify graph.
     */
    protected getGraphifyGodNodes(repoPath: string, topN = 10): string | null {
        if (this.graphifyBridge === null) return null;
        const godNodes = this.graphifyBridge.getGodNodes(repoPath, topN);
        if (godNodes.length === 0) return null;

        const lines = [
            `## Graphify: Top ${godNodes.length} God Nodes`,
            '',
            ...godNodes.map((n, i) =>
                `${i + 1}. **${n.label}** — degree ${n.degree}, community ${n.community ?? '?'}${n.sourceFile !== undefined ? ` (${n.sourceFile})` : ''}`
            ),
        ];
        return lines.join('\n');
    }

    /**
     * Find shortest path between two concepts in the knowledge graph.
     */
    protected findGraphifyPath(repoPath: string, source: string, target: string): string | null {
        if (this.graphifyBridge === null) return null;
        const result = this.graphifyBridge.shortestPath(repoPath, source, target);
        if (result === null) return null;

        return [
            `## Graphify: Path from "${source}" to "${target}" (${result.hops} hops)`,
            '',
            result.path.join(' → '),
        ].join('\n');
    }

    // ── Collaborative Agent Intercept ─────────────────

    /**
     * Cooperative yield point. Call this before any significant work step.
     * If the agent is paused, blocks until resume or takeover.
     * Returns injected guidance text if available, null otherwise.
     */
    async checkPause(task: TaskInfo): Promise<string | null> {
        if (!this._paused) {
            const guidance = this._interceptGuidance;
            this._interceptGuidance = null;
            return guidance;
        }

        this.log.info({ taskId: task.id }, 'Agent paused — waiting for resume or takeover');

        await new Promise<void>((resolve) => {
            this._pauseResolver = resolve;
        });

        // After unblock, check for takeover
        if (this._takenOver) {
            throw new Error('Task interrupted: human takeover');
        }

        const guidance = this._interceptGuidance;
        this._interceptGuidance = null;
        return guidance;
    }

    /**
     * Pause this agent. The next checkPause() call will block.
     */
    pause(): void {
        this._paused = true;
    }

    /**
     * Resume this agent. Unblocks any pending checkPause() call.
     */
    resume(): void {
        this._paused = false;
        if (this._pauseResolver !== null) {
            this._pauseResolver();
            this._pauseResolver = null;
        }
    }

    /**
     * Inject human guidance. Auto-resumes if the agent is paused.
     */
    injectGuidance(guidance: string): void {
        this._interceptGuidance = guidance;
        if (this._paused) {
            this.resume();
        }
    }

    /**
     * Signal that a human is taking over this task.
     * Unblocks the agent so it can exit cleanly.
     */
    takeover(): void {
        this._takenOver = true;
        this._paused = false;
        if (this._pauseResolver !== null) {
            this._pauseResolver();
            this._pauseResolver = null;
        }
    }

    /**
     * Reset all intercept state — called at the start of each task.
     */
    private resetInterceptState(): void {
        this._paused = false;
        this._pauseResolver = null;
        this._interceptGuidance = null;
        this._takenOver = false;
    }

    // ── Private Helpers ──────────────────────────────

    private async loadTaskInfo(taskId: string): Promise<TaskInfo | null> {
        // P1-06b: revision_instruction / iteration_id / target_files are
        // surfaced via COALESCE-equivalent SELECT — defaulting to null
        // on pre-027 data dirs (the columns simply don't exist yet,
        // which raises in the SELECT — handled by the catch below).
        const task = await query<{
            id: string;
            project_id: string;
            title: string;
            description: string;
            task_type: string;
            phase: string;
            output_path: string | null;
            revision_instruction: string | null;
            iteration_id: string | null;
            target_files: unknown;
        }>(
            `SELECT t.id, t.project_id, t.title, t.description, t.task_type, t.phase, t.output_path,
                    t.revision_instruction, t.iteration_id, t.target_files
             FROM tasks t WHERE t.id = $1`,
            [taskId]
        ).catch(async () => {
            // Legacy pre-027 schema doesn't have the new columns; retry
            // with the smaller SELECT so older data dirs keep loading.
            const fallback = await query<{
                id: string;
                project_id: string;
                title: string;
                description: string;
                task_type: string;
                phase: string;
                output_path: string | null;
            }>(
                `SELECT t.id, t.project_id, t.title, t.description, t.task_type, t.phase, t.output_path
                 FROM tasks t WHERE t.id = $1`,
                [taskId]
            );
            return {
                rows: fallback.rows.map((r) => ({
                    ...r,
                    revision_instruction: null as string | null,
                    iteration_id: null as string | null,
                    target_files: null as unknown,
                })),
                rowCount: fallback.rowCount,
            };
        });

        if (task.rows.length === 0) return null;

        const row = task.rows[0];

        // Get project repo path
        const project = await query<{ repo_path: string }>(
            'SELECT repo_path FROM projects WHERE id = $1',
            [row.project_id]
        );

        const repoPath = project.rows.length > 0 ? project.rows[0].repo_path : '';

        // Append any human comments so the agent sees team guidance on retry
        let description = row.description ?? '';
        try {
            const comments = await query<{
                author_name: string; author_type: string; body: string; created_at: string;
            }>(
                `SELECT author_name, author_type, body, created_at
                 FROM task_comments
                 WHERE task_id = $1 AND author_type = 'human'
                 ORDER BY created_at ASC`,
                [row.id]
            );
            if (comments.rows.length > 0) {
                const block = comments.rows
                    .map(c => `[${c.author_name}]: ${c.body}`)
                    .join('\n');
                description = `${description}\n\n--- Human guidance ---\n${block}`;
            }
        } catch {
            // non-fatal — comments table may not exist yet during migration
        }

        // P1-06b: normalise target_files (stored as jsonb on the row).
        // Falls back to null when the column is absent (pre-027 dirs)
        // or when the JSON wasn't a string array.
        let targetFiles: readonly string[] | null = null;
        const rawTargets = (row as { target_files?: unknown }).target_files;
        if (Array.isArray(rawTargets)) {
            const cleaned = rawTargets.filter((s): s is string => typeof s === 'string' && s.length > 0);
            if (cleaned.length > 0) targetFiles = cleaned;
        }

        return {
            id: row.id,
            projectId: row.project_id,
            title: row.title,
            description,
            taskType: row.task_type ?? 'general',
            phase: row.phase,
            outputPath: row.output_path,
            repoPath,
            revisionInstruction: (row as { revision_instruction?: string | null }).revision_instruction ?? null,
            iterationId: (row as { iteration_id?: string | null }).iteration_id ?? null,
            targetFiles,
        };
    }

    /**
     * Log a cost row for work performed by an external service (e.g. a
     * DesignProvider). Goes through the same `agent_logs` path as normal
     * AI spend so budget-kill counts it without caring about the source.
     *
     * Protected so subclasses that delegate to providers (currently
     * Pixel.ui-build) can route cost through this choke point instead of
     * each specialist shipping its own INSERT.
     */
    protected async logExternalCost(opts: {
        readonly provider: string;
        readonly costUsd: number;
        readonly tokensIn?: number;
        readonly tokensOut?: number;
        readonly durationMs?: number;
        readonly action?: string;
    }): Promise<void> {
        await this.logAction(opts.action ?? 'external-provider', {
            model: opts.provider,
            tokensIn: opts.tokensIn ?? 0,
            tokensOut: opts.tokensOut ?? 0,
            costUsd: opts.costUsd,
            durationMs: opts.durationMs ?? 0,
            external: true,
        });
    }

    private async logAction(action: string, metadata: Record<string, unknown>): Promise<void> {
        try {
            await query(
                `INSERT INTO agent_logs (project_id, task_id, agent, action, model_used, tokens_in, tokens_out, cost_usd, duration_ms, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                    this._currentTask?.projectId ?? null,
                    this._currentTask?.id ?? null,
                    this.name,
                    action,
                    metadata.model ?? null,
                    metadata.tokensIn ?? 0,
                    metadata.tokensOut ?? 0,
                    metadata.costUsd ?? 0,
                    metadata.durationMs ?? 0,
                    JSON.stringify(metadata),
                ]
            );
        } catch {
            // Don't let logging failures break task execution
        }
    }

    private validatePath(repoPath: string, fullPath: string): void {
        const resolvedRepo = path.resolve(repoPath);
        const resolvedFull = path.resolve(fullPath);
        if (!resolvedFull.startsWith(resolvedRepo)) {
            throw new Error(`Path traversal detected: ${fullPath} is outside repo ${repoPath}`);
        }
    }

    private runGit(repoPath: string, args: string[]): Promise<string> {
        return withRepoLock(repoPath, () => this.runGitUnlocked(repoPath, args));
    }

    private runGitUnlocked(repoPath: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawn('git', args, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
                }
            });

            proc.on('error', reject);
        });
    }
}

// ── Module-level helpers ────────────────────────────

/**
 * Canonical key for an exec invocation (command + args), used by the
 * exec-checkpoint resume guard to detect a divergent re-run. Returns
 * `null` when the command isn't a usable string (legacy / malformed
 * payload) so the caller preserves the pre-guard "serve" behaviour.
 * NUL-joined so no arg boundary can be forged by embedding the
 * separator.
 */
export function execInvocationKey(command: unknown, args: unknown): string | null {
    if (typeof command !== 'string') return null;
    const argList = Array.isArray(args) ? args.map((a) => String(a)) : [];
    return [command, ...argList].join(' ');
}

/**
 * P1-01b: cached output payload persisted to `task_checkpoints.output_json`
 * for `op_type='askai'` rows. Mirrors the relevant `AiResponse` fields so
 * the resume path can return a structurally identical response without
 * a second provider call.
 *
 * `costUsd` here is the cost the ORIGINAL call paid — it is preserved
 * so reporting / UI can show "this run saved $0.13 via cache hits".
 * The response actually returned to the caller on a hit reports
 * `costUsd: 0` because the resumed process pays nothing.
 */
export interface AskAiCheckpointOutput {
    readonly text: string;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly costUsd: number;
    readonly model: string;
    readonly durationMs: number;
}

/**
 * Deterministic sha256 of the full prompt context — system prompt +
 * optional caller-supplied context + user prompt + active model. Used
 * by P1-01b in `task_checkpoints.payload_json.promptHash` so a future
 * resume path can detect when the same op-index is being re-attempted
 * with a different prompt (e.g. caller swapped the system prompt) and
 * surface that as a diagnostic rather than silently serving a stale
 * cache. v1 trusts position over content for the cache decision; the
 * hash is recorded for inspection only.
 */
export function hashPrompt(
    systemPrompt: string,
    context: string | undefined,
    prompt: string,
    model: string,
): string {
    return crypto
        .createHash('sha256')
        .update(systemPrompt, 'utf8')
        .update('', 'utf8')
        .update(context ?? '', 'utf8')
        .update('', 'utf8')
        .update(prompt, 'utf8')
        .update('', 'utf8')
        .update(model, 'utf8')
        .digest('hex');
}

/**
 * P1-01d: cached output payload persisted to
 * `task_checkpoints.output_json` for `op_type='exec'` rows. Mirrors
 * the fields a downstream consumer needs to replay the same
 * `ShellResult` (and observability events) without re-spawning. The
 * `stdoutPreview` / `stderrPreview` fields are capped at
 * {@link EXEC_PREVIEW_BYTES} bytes — by design; full output is in
 * `agent_logs` for the live run.
 */
export interface ExecCheckpointOutput {
    readonly exitCode: number;
    readonly stdoutPreview: string;
    readonly stderrPreview: string;
    readonly durationMs: number;
}

/**
 * P1-01c: sha256 hex of a UTF-8 string. Used as the cache key for
 * `writeFile` checkpoints (`payload_json.sha256` + `output_json.sha256`).
 * On resume the on-disk file is re-hashed and compared to the cached
 * value to decide whether the prior write survived.
 */
export function sha256OfContent(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * P1-01c: read a file from disk and return its sha256 hex digest,
 * or `null` when the file is missing or the read fails. Used by the
 * write-checkpoint resume path to verify that bytes the prior run
 * committed are still on disk.
 *
 * Read failures (permission, race, ENOTDIR) are treated the same as
 * "missing" — the cache decision falls back to "miss" and the agent
 * re-writes. We never want a flaky FS read to be the difference
 * between a recoverable resume and a stale-file regression.
 */
export function readOnDiskSha256(fullPath: string): string | null {
    try {
        const buf = fs.readFileSync(fullPath);
        return crypto.createHash('sha256').update(buf).digest('hex');
    } catch {
        return null;
    }
}

/**
 * F-392 helper. Parse an env-string into a positive integer of
 * milliseconds with strict guard rails — used for `taskTimeoutMs` so
 * a malformed `KAGEOPS_MAX_TASK_DURATION_MS` doesn't silently break
 * the per-task timeout.
 *
 * Returns `fallback` when:
 *   - the env var is undefined / empty
 *   - parsing fails
 *   - parsed value is < 1000ms (1 second floor — anything less is
 *     guaranteed to thrash before the task even starts an AI call)
 *
 * Strict-mode behaviour matters because we want a misconfiguration
 * to be louder in CI but silent in production — see the warn log in
 * the bad-input path.
 */
export function parseEnvDurationMs(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw === '') return fallback;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1000) {
        // eslint-disable-next-line no-console
        console.warn(
            `[autonaut-agent] Ignoring KAGEOPS_MAX_TASK_DURATION_MS=${raw} ` +
            `(must be a positive integer >= 1000) — using fallback ${fallback}ms`,
        );
        return fallback;
    }
    return parsed;
}

/**
 * Heuristic: does this AI response look like raw artifact content
 * (HTML, CSS, JS, JSON, markdown) for the given target path, rather
 * than a chat-style summary that was meant for the conversation?
 *
 * Used by the writeOutputFiles fallback to avoid blindly writing
 * "All files have been created" or "--- DESIGN BRIEF ---" as the
 * artifact. False negatives (real content skipped) get caught by
 * AcceptanceGate; false positives (chat written) cascade.
 */
// `looksLikeArtifactContent` moved to src/agents/output-parser.ts as
// the exported `isLikelyArtifactContent` so writeOutputFiles (above)
// and BuildVerificationGate (F-391) share the same shape oracle.

function isProbablyUrl(candidate: string): boolean {
    if (candidate.length === 0) return false;
    try {
        const parsed = new URL(candidate);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}
