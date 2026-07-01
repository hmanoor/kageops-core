/**
 * KageOps Task Decomposer
 *
 * Takes a project description and current phase, uses AI to decompose
 * the work into structured tasks with dependencies and agent assignments.
 */

import { query, getMany, getOne } from '../db/client';
import { EventBus, EventPayload } from './event-bus';
import { createLogger } from '../shared/logger';
import { detectSimpleApp } from '../shared/simple-app-detector';
import { filterShippedFeatureTasks } from './shipped-feature-filter';
import { recoverTaskArray, decompositionParseFailed } from './decompose-json';
import { phaseFallbackTasks, decomposeFallbackEnabled } from './phase-fallback-tasks';

// Deterministic SIMPLE-APP GUARD caps — enforced after parse even if the LLM
// ignores the prompt rule. Matches the values documented in the prompt.
const SIMPLE_APP_PHASE_CAPS: Record<string, number> = {
    'discovery': 2,
    'poc': 1,
    'business-viability': 1,
    'design-planning': 1,
    'development': 1,
    'launch-growth': 1,
};

const log = createLogger('TaskDecomposer');

// BPF-32 — how many reinforced re-rolls to attempt when decomposition returns
// 0 parseable tasks. Each is an independent dice throw against a flaky OSS
// model; 3 makes a persistent dud rare. Override with KAGEOPS_DECOMPOSE_RETRIES
// (clamped 1..6); default 3.
function resolveDecomposeRetries(env: NodeJS.ProcessEnv = process.env): number {
    const raw = parseInt((env.KAGEOPS_DECOMPOSE_RETRIES ?? '').trim(), 10);
    if (Number.isFinite(raw) && raw >= 1) return Math.min(raw, 6);
    return 3;
}

// ── Types ────────────────────────────────────────────

export interface DecomposedTask {
    readonly title: string;
    readonly description: string;
    readonly taskType: string;
    readonly assignedAgent: string;
    readonly priority: number;
    readonly dependsOn: readonly string[];
    readonly phase: string;
    readonly outputPath: string | null;
}

export interface DecomposerConfig {
    readonly sendPrompt: (systemPrompt: string, userPrompt: string) => Promise<string>;
    /**
     * BPF-30 — resolve the features the project's selected bundle already ships,
     * so the decomposer can drop development tasks that re-implement them.
     * Optional: when unset (or it returns []), no filtering happens. Injected by
     * Sensei, which knows the project's bundle.
     */
    readonly resolveShippedFeatures?: (
        projectId: string,
    ) => Promise<readonly import('../bundles/types').BundleShippedFeature[]>;
}

// ── Phase definitions ────────────────────────────────

const PHASES = [
    'discovery',
    'poc',
    'business-viability',
    'design-planning',
    'development',
    'launch-growth',
] as const;

export type Phase = typeof PHASES[number];

/**
 * Operator-picked per-phase task-type allowlist (issue #165).
 *
 * Shape:
 *   {
 *     "discovery":       ["concept-brief", "feasibility-assessment"],
 *     "poc":             ["setup-project"],
 *     "design-planning": ["wireframe", "design-system"]
 *   }
 *
 * A phase absent from the map (or `null` overall) = LLM picks freely
 * from the phase's full agent catalogue (today's behaviour).
 *
 * Persisted in `projects.phase_task_selections` JSONB.
 */
export type PhaseTaskSelections = Partial<Record<Phase, readonly string[]>>;

const PHASE_AGENTS: Record<Phase, readonly string[]> = {
    'discovery': ['scout', 'blueprint'],
    'poc': ['forge', 'blueprint', 'cipher'],
    'business-viability': ['scout', 'herald'],
    'design-planning': ['scout', 'pixel', 'blueprint'],
    'development': ['forge', 'cipher', 'aegis', 'vigil', 'pixel'],
    'launch-growth': ['aegis', 'vigil', 'herald', 'scout'],
};

// ── Task Decomposer ──────────────────────────────────

export class TaskDecomposer {
    private readonly config: DecomposerConfig;
    private readonly eventBus: EventBus;

    constructor(config: DecomposerConfig, eventBus: EventBus) {
        this.config = config;
        this.eventBus = eventBus;
    }

    /**
     * Decompose a project description into tasks for a given phase.
     * Returns the created task IDs.
     *
     * `options.allowFallback` (default true) controls the BPF-37 never-wedge
     * phase fallback. It belongs on FRESH phase kick-offs (kickPhase /
     * advanceToNextPhase) where a 0-task decomposition wedges the run. It must
     * be OFF for incremental injection (addRequirement), where a 0-task result
     * legitimately means "no new tasks for this requirement" and a generic
     * whole-app build task would be wrong.
     */
    async decompose(
        projectId: string,
        projectName: string,
        description: string,
        phase: Phase,
        options: { readonly allowFallback?: boolean } = {},
    ): Promise<readonly string[]> {
        log.info({ projectId, phase, descriptionLen: description.length }, 'decompose() invoked');
        const availableAgents = PHASE_AGENTS[phase];

        // #165 — operator-picked allowed task types for this phase. NULL or
        // unset for the phase means "LLM picks freely" (today's behaviour).
        const allowedTaskTypes = await this.getAllowedTaskTypes(projectId, phase);
        if (allowedTaskTypes !== null) {
            log.info(
                { projectId, phase, allowedCount: allowedTaskTypes.length },
                'decompose: phase_task_selections active — constraining decomposer',
            );
        }

        const systemPrompt = this.buildSystemPrompt(phase, availableAgents, allowedTaskTypes);
        let userPrompt = this.buildUserPrompt(projectName, description, phase);

        // Include prior phase outputs so the decomposer knows what was decided/designed
        const priorContext = await this.getPriorPhaseContext(projectId);
        if (priorContext.length > 0) {
            userPrompt += `\n\nPRIOR PHASE OUTPUTS (use these to inform task breakdown):\n${priorContext}`;
        }

        let response: string;
        try {
            response = await this.config.sendPrompt(systemPrompt, userPrompt);
        } catch (err) {
            log.error(
                { projectId, phase, err: err instanceof Error ? err.message : String(err) },
                'decompose sendPrompt threw'
            );
            throw err;
        }
        let tasks = this.parseTaskResponse(response, phase);
        log.info({ projectId, phase, parsedCount: tasks.length }, 'decompose parsed LLM response');

        // BPF-10 / BPF-32: weak (OSS/budget) models sometimes return malformed
        // JSON or wrap tasks in prose, yielding 0 parsed tasks — a silently
        // task-less phase (no app built, phase wedges). Retry with explicit
        // "valid JSON only" reinforcement. Each re-roll is an INDEPENDENT dice
        // throw, so BPF-32 loops up to DECOMPOSE_REINFORCE_ATTEMPTS times (was a
        // single try) — the ClubHubOSS dogfood showed ~half of fresh OSS runs
        // dudded development/poc decomposition on one bad roll, and a re-roll
        // usually parses clean. Override with KAGEOPS_DECOMPOSE_RETRIES.
        if (tasks.length === 0 && decompositionParseFailed(response)) {
            const maxAttempts = resolveDecomposeRetries();
            const reinforced =
                userPrompt +
                '\n\nIMPORTANT: your previous response could not be parsed into tasks. ' +
                'Output ONLY a valid JSON array of task objects and nothing else — ' +
                'no prose, no explanation, no markdown code fences, no trailing commas; ' +
                'every property double-quoted and comma-separated.';
            for (let attempt = 1; attempt <= maxAttempts && tasks.length === 0; attempt++) {
                log.warn(
                    { projectId, phase, attempt, maxAttempts },
                    'decompose: response did not parse to tasks — retrying with JSON reinforcement (BPF-10/32)',
                );
                try {
                    const retryResponse = await this.config.sendPrompt(systemPrompt, reinforced);
                    const retryTasks = this.parseTaskResponse(retryResponse, phase);
                    if (retryTasks.length > 0) {
                        tasks = retryTasks;
                        log.info(
                            { projectId, phase, attempt, parsedCount: tasks.length },
                            'decompose: recovered tasks on JSON-reinforced retry (BPF-10/32)',
                        );
                    }
                } catch (err) {
                    log.warn(
                        { projectId, phase, attempt, err: err instanceof Error ? err.message : String(err) },
                        'decompose: reinforced retry threw — will re-roll if attempts remain',
                    );
                }
            }
        }

        // #165 — defence in depth: if the operator picked an allowlist,
        // drop any task whose taskType is not on it. The LLM has the
        // HARD CONSTRAINT in the system prompt, but a deterministic
        // post-filter means a non-compliant model can never bypass it.
        if (allowedTaskTypes !== null && allowedTaskTypes.length > 0) {
            const allowSet = new Set(allowedTaskTypes);
            const before = tasks.length;
            tasks = tasks.filter((t) => allowSet.has(t.taskType));
            if (tasks.length !== before) {
                log.info(
                    { projectId, phase, beforeCount: before, afterCount: tasks.length, allowed: allowedTaskTypes },
                    '#165: post-parse filtered tasks not on operator allowlist',
                );
            }
        }

        // BPF-30 — drop development tasks that re-implement features the
        // selected bundle already ships (planner-noise root). A weak model
        // rebuilds shipped infra (checkout route, webhook, Clerk auth, db
        // client) as broken duplicates that fail the build; the scaffold's
        // versions are correct, so the task is pure noise. Conservative +
        // never wipes a whole phase (see filterShippedFeatureTasks).
        if (phase === 'development' && this.config.resolveShippedFeatures !== undefined) {
            try {
                const features = await this.config.resolveShippedFeatures(projectId);
                if (features.length > 0) {
                    const result = filterShippedFeatureTasks(tasks, features);
                    if (result.dropped.length > 0) {
                        tasks = result.kept as DecomposedTask[];
                        for (const d of result.dropped) {
                            log.info(
                                { projectId, phase, droppedTitle: d.task.title, feature: d.feature, phrase: d.phrase },
                                'BPF-30: dropped task re-implementing a shipped scaffold feature',
                            );
                        }
                    }
                }
            } catch (err) {
                log.warn(
                    { projectId, phase, err: err instanceof Error ? err.message : String(err) },
                    'BPF-30: shipped-feature filter threw — keeping tasks unfiltered',
                );
            }
        }

        // Deterministic SIMPLE-APP GUARD: hard-truncate task lists for trivial
        // apps even if the decomposer LLM padded past the prompt cap.
        const simple = detectSimpleApp(description);
        if (simple.simple) {
            const cap = SIMPLE_APP_PHASE_CAPS[phase] ?? tasks.length;
            if (tasks.length > cap) {
                log.info(
                    { phase, kind: simple.kind, beforeCount: tasks.length, cap },
                    'SIMPLE-APP GUARD: truncating task list to phase cap'
                );
                tasks = tasks.slice(0, cap);
            }
        }

        // BPF-37 — never-wedge phase fallback. If decomposition (including the
        // BPF-32 reinforced re-rolls and BPF-36 recovery/salvage) still yielded
        // 0 tasks, drop in a minimal deterministic task so the phase advances
        // instead of wedging the whole run. Gated to genuine duds: a true parse
        // failure, OR an empty development phase with no operator allowlist
        // (development MUST attempt to build something). A deliberate empty `[]`
        // on a doc phase is respected. Opt out with KAGEOPS_DECOMPOSE_FALLBACK=0.
        if (tasks.length === 0 && (options.allowFallback ?? true) && decomposeFallbackEnabled()) {
            const parseFailed = decompositionParseFailed(response);
            const devMustBuild = phase === 'development' && allowedTaskTypes === null;
            if (parseFailed || devMustBuild) {
                const fallback = phaseFallbackTasks({
                    phase,
                    projectName,
                    description,
                    simple: simple.simple,
                });
                if (fallback.length > 0) {
                    tasks = [...fallback];
                    log.warn(
                        { projectId, phase, parseFailed, devMustBuild, fallbackCount: tasks.length },
                        'BPF-37: decomposition produced 0 tasks after retries/recovery — using deterministic phase fallback',
                    );
                }
            }
        }

        if (tasks.length === 0) {
            log.warn({ phase }, 'AI returned no tasks for phase');
            return [];
        }

        // Store tasks in Postgres and publish events
        const taskIds = await this.storeTasks(projectId, tasks);
        log.info({ projectId, phase, taskCount: taskIds.length }, 'decompose stored tasks, publishing events');

        // Publish task.created events
        for (let i = 0; i < taskIds.length; i++) {
            try {
                await this.eventBus.publish('task.created', {
                    projectId,
                    taskId: taskIds[i],
                    agent: 'sensei',
                    data: {
                        title: tasks[i].title,
                        assignedAgent: tasks[i].assignedAgent,
                        phase,
                        priority: tasks[i].priority,
                    },
                });
            } catch (pubErr) {
                log.error(
                    { projectId, phase, taskId: taskIds[i], err: pubErr instanceof Error ? pubErr.message : String(pubErr) },
                    'decompose publish task.created threw — continuing'
                );
            }
        }

        log.info({ taskCount: taskIds.length, phase }, 'Created tasks for phase');
        return taskIds;
    }

    /**
     * Get the next phase after the current one, or null if at the end.
     */
    getNextPhase(currentPhase: Phase): Phase | null {
        const idx = PHASES.indexOf(currentPhase);
        if (idx < 0 || idx >= PHASES.length - 1) {
            return null;
        }
        return PHASES[idx + 1];
    }

    /**
     * Get all valid phases.
     */
    getPhases(): readonly Phase[] {
        return PHASES;
    }

    // ── Private ──────────────────────────────────────

    private buildSystemPrompt(
        phase: Phase,
        agents: readonly string[],
        allowedTaskTypes: readonly string[] | null,
    ): string {
        // When the operator picked specific task types for this phase
        // (issue #165), inject a HARD CONSTRAINT block. The LLM is told
        // to emit ONLY these task types — anything else, even if the
        // brief seems to imply it, is forbidden. The decomposer cap and
        // SIMPLE-APP GUARD still apply on top.
        const allowedBlock = allowedTaskTypes !== null && allowedTaskTypes.length > 0
            ? `\n\nALLOWED TASK TYPES FOR THIS PHASE (HARD CONSTRAINT — operator picked these):\n${allowedTaskTypes.map((t) => `- ${t}`).join('\n')}\nEmit ONLY these task types. Do not emit any other type even if the brief seems to imply one. This overrides the per-agent catalogue below.`
            : '';

        return `You are Sensei, the KageOps orchestrator. You decompose project ideas into actionable tasks.${allowedBlock}

RULES:
- Output ONLY a valid JSON array of task objects. No markdown, no commentary, no code fences.
- Each task must use EXACTLY one taskType from the approved list below for its agent.
- Available agents for this phase: ${agents.join(', ')}
- Current phase: ${phase}
- Tasks must be specific, actionable, and completable by one agent.
- Include 3-8 tasks per phase. Start simple — don't over-decompose.
- Order by dependency — tasks with dependsOn must come after the tasks they depend on.
- The outputPath must be a relative file path (e.g. "docs/discovery/01-concept-brief.md").

AGENT CAPABILITIES AND APPROVED TASK TYPES:
scout:
  taskTypes: concept-brief, market-research, feasibility-assessment, competitive-analysis, prd, project-plan, risk-assessment
  roles: strategy, research, PRDs, market analysis, feasibility

blueprint:
  taskTypes: architecture-design, api-design, database-design, tech-stack, system-design
  roles: architecture, system design, API design, database design, tech stack selection

pixel:
  taskTypes: wireframe, mockup, design-system, user-flow, ui-review, responsive-design, ui-build
  roles: UI/UX design, wireframes, mockups, design systems, end-to-end UI build (pixel:ui-build produces index.html + styles.css via a design provider — use it for landing pages and visually-heavy single-page sites)

forge:
  taskTypes: implement, refactor, fix-bug, create-api, create-ui, add-tests, setup-project
  roles: coding, implementation, debugging, testing, git

cipher:
  taskTypes: data-pipeline, etl, analytics, ml-model, database-query, data-schema
  roles: data pipelines, ETL, ML, analytics, database queries

aegis:
  taskTypes: docker-setup, terraform, ci-cd, deployment, monitoring, security-hardening
  roles: DevOps, Docker, Terraform, CI/CD, deployment, monitoring

vigil:
  taskTypes: code-review, security-review, write-tests, documentation, quality-gate
  roles: code review, security review, testing, documentation, quality gates

herald:
  taskTypes: brand-strategy, content-plan, seo-audit, campaign, landing-page, release-notes
  roles: marketing, branding, content, SEO, campaigns

PHASE-TO-AGENT MAPPING (use ONLY available agents for this phase):
- discovery: scout, blueprint
- poc: forge, blueprint, cipher
- business-viability: scout, herald
- design-planning: scout, pixel, blueprint
- development: forge, cipher, aegis, vigil, pixel
- launch-growth: aegis, vigil, herald, scout

ARTIFACT RESTRAINT POLICY (F-362):
- The user's brief is the contract. Do NOT spawn ancillary artifacts the
  brief didn't ask for. Specifically forbidden unless the description
  explicitly requests them:
    * COMPETITIVE_ANALYSIS.md / competitive-analysis tasks
    * MARKET_RESEARCH.md / market-research tasks
    * SEO_AUDIT.md / seo-audit tasks
    * DESIGN_SYSTEM.md as a separate doc (the design system lives in
      styles.css for static-HTML projects)
    * Brand-strategy / campaign / release-notes tasks
- When the brief reads as "build me <X>", produce ONLY the build tasks
  needed for X. Marketing/research tasks are scope creep. The build-
  summary report (F-300) auto-generated by KageOps is the only auxiliary
  artifact that's always produced.
- If the user explicitly wants market research ("include a competitive
  analysis", "audit the SEO"), then the relevant tasks are in scope.`;
    }

    private buildUserPrompt(name: string, description: string, phase: Phase): string {
        const basePrompt = `Project: ${name}
Description: ${description}
Phase: ${phase}

Decompose into 3-8 tasks for the ${phase} phase.
Use ONLY approved taskTypes for each agent. Use unique, sequential outputPath values.
Output ONLY a JSON array — no explanation.

Required JSON shape per task:
{
  "title": "Short task title",
  "description": "What this task must produce",
  "taskType": "<exact type from approved list>",
  "assignedAgent": "<agent name>",
  "priority": <0-9>,
  "dependsOn": ["title of dependency task", ...],
  "outputPath": "docs/${phase}/NN-slug.md"
}`;

        const simpleAppRule = `
**SIMPLE-APP GUARD (applies to ALL phases)**
If the project description clearly describes a simple single-page app — counter, todo, calculator, clock, timer, landing page, static dashboard mock, single-file utility — produce the ABSOLUTE MINIMUM tasks for this phase. Hard caps per phase:
- discovery:         MAX 2 tasks (scout:market-research + blueprint:system-design) — no deeper analysis
- poc:               MAX 1 task (forge:setup-project, outputPath "index.html")
- business-viability: MAX 1 task (scout:competitive-analysis) or skip entirely if trivial
- design-planning:   MAX 1 task (blueprint:tech-stack) or skip entirely
- development:       MAX 1 task. For *landing pages / marketing sites / visually-heavy single-page sites*, this task MUST be pixel:ui-build with outputPath "index.html" — Pixel's ui-build handler produces index.html + styles.css through the configured design provider. For all other simple apps (counter, todo, calculator, clock, timer, utility), use forge:setup-project with outputPath "index.html" bundling HTML+CSS+JS inline.
- launch-growth:     MAX 1 task (aegis:deployment or vigil:quality-gate)
Do NOT pick Svelte, React, Vite, or any build tool for simple apps. Do NOT produce write-tests/add-tests/refactor/persistence/export-import tasks for simple apps.
`;

        // For development phase, add guidance for file-level task granularity
        if (phase === 'development') {
            return basePrompt + simpleAppRule + `

DEVELOPMENT PHASE RULES:
- Forge tasks MUST use outputPath like "src/filename.ts" not "docs/development/..."
- For non-trivial apps only: first task is "setup-project" to create package.json, tsconfig.json, and project scaffold, then break implementation into one task per module/feature.
- Each implement task description must specify the exact files to create
- Include at least one vigil task for "write-tests" at the end ONLY for non-trivial apps
- Include one aegis task for "ci-cd" or "docker-setup" ONLY for non-trivial apps
- Tasks should build on each other via dependsOn
- Aim for the MINIMUM number of tasks that satisfies the description. A counter app = 1 task. A todo app = 1-2 tasks. Do not pad.`;
        }

        if (phase === 'poc' || phase === 'discovery' || phase === 'business-viability' || phase === 'design-planning') {
            return basePrompt + simpleAppRule;
        }

        return basePrompt;
    }

    private parseTaskResponse(response: string, phase: Phase): readonly DecomposedTask[] {
        // BPF-36: robust recovery supersedes the greedy `/\[[\s\S]*\]/` + single
        // trailing-comma repair. `recoverTaskArray` scans for the best balanced
        // top-level array (defeats stray-bracket prose) and, failing that,
        // salvages individual task objects (one malformed object no longer
        // zeroes the whole phase). Still conservative — it never guesses at
        // string content; BPF-32 re-roll + BPF-37 fallback are the next nets.
        const parsed = recoverTaskArray(response);
        if (parsed === null) {
            log.error({ phase }, 'parseTaskResponse: no recoverable task array in AI response (BPF-36)');
            return [];
        }

        try {
            return parsed
                .filter((item): item is Record<string, unknown> =>
                    typeof item === 'object' && item !== null
                )
                .map((item) => ({
                    title: String(item.title ?? 'Untitled Task'),
                    description: String(item.description ?? ''),
                    taskType: String(item.taskType ?? 'general'),
                    assignedAgent: String(item.assignedAgent ?? 'scout'),
                    priority: typeof item.priority === 'number' ? item.priority : 5,
                    dependsOn: Array.isArray(item.dependsOn)
                        ? item.dependsOn.map(String)
                        : [],
                    phase,
                    outputPath: typeof item.outputPath === 'string' ? item.outputPath : null,
                }));
        } catch (err) {
            log.error({ err }, 'Failed to parse AI response');
            return [];
        }
    }

    private async storeTasks(
        projectId: string,
        tasks: readonly DecomposedTask[]
    ): Promise<readonly string[]> {
        const taskIds: string[] = [];
        const titleToId = new Map<string, string>();

        for (const task of tasks) {
            // Resolve dependency titles to IDs
            const dependsOnIds: string[] = [];
            for (const depTitle of task.dependsOn) {
                const depId = titleToId.get(depTitle);
                if (depId !== undefined) {
                    dependsOnIds.push(depId);
                }
            }

            const result = await query<{ id: string }>(
                `INSERT INTO tasks (project_id, title, description, task_type, phase, assigned_agent, priority, depends_on, output_path)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING id`,
                [
                    projectId,
                    task.title,
                    task.description,
                    task.taskType,
                    task.phase,
                    task.assignedAgent,
                    task.priority,
                    dependsOnIds.length > 0 ? `{${dependsOnIds.join(',')}}` : '{}',
                    task.outputPath,
                ]
            );

            const id = result.rows[0].id;
            taskIds.push(id);
            titleToId.set(task.title, id);
        }

        return taskIds;
    }

    /**
     * Fetch the operator-picked allowed task types for a given phase
     * (issue #165). Returns `null` when no selections are persisted for
     * the phase — that's the legacy "LLM picks freely" path.
     *
     * Returns an empty list if the operator explicitly set the phase to
     * `[]` (i.e. wants the phase included but with no auto-decomposed
     * tasks). Callers should treat that as "no LLM tasks for this phase"
     * — but today the decomposer LLM is still invoked; the constraint
     * just yields an empty parse. Future iteration may short-circuit.
     */
    private async getAllowedTaskTypes(
        projectId: string,
        phase: Phase,
    ): Promise<readonly string[] | null> {
        try {
            const row = await getOne<{ phase_task_selections: unknown }>(
                'SELECT phase_task_selections FROM projects WHERE id = $1',
                [projectId],
            );
            if (row === null || row.phase_task_selections === null || row.phase_task_selections === undefined) {
                return null;
            }
            const selections = row.phase_task_selections;
            if (typeof selections !== 'object' || Array.isArray(selections)) {
                return null;
            }
            const forPhase = (selections as Record<string, unknown>)[phase];
            if (!Array.isArray(forPhase)) {
                return null;
            }
            // Coerce to strings + dedupe to be defensive against bad input.
            const cleaned = Array.from(new Set(forPhase.map(String).filter((s) => s.length > 0)));
            return cleaned;
        } catch (err) {
            log.warn(
                { projectId, phase, err: err instanceof Error ? err.message : String(err) },
                'getAllowedTaskTypes failed — falling back to free-pick decomposer',
            );
            return null;
        }
    }

    /**
     * Gather completed task outputs from prior phases to give the decomposer
     * context about what was decided/designed. This ensures the development
     * phase decomposition aligns with the architecture and PRD.
     */
    private async getPriorPhaseContext(projectId: string): Promise<string> {
        try {
            const priorTasks = await getMany<{
                title: string;
                assigned_agent: string;
                phase: string;
                response_text: string | null;
            }>(
                `SELECT title, assigned_agent, phase, response_text
                 FROM tasks
                 WHERE project_id = $1
                   AND status = 'completed'
                   AND response_text IS NOT NULL
                 ORDER BY completed_at ASC
                 LIMIT 8`,
                [projectId]
            );

            if (priorTasks.length === 0) return '';

            return priorTasks.map((t) => {
                const text = (t.response_text ?? '').length > 2000
                    ? (t.response_text ?? '').slice(0, 2000) + '\n[... truncated]'
                    : (t.response_text ?? '');
                return `--- ${t.assigned_agent} (${t.phase}): ${t.title} ---\n${text}`;
            }).join('\n\n');
        } catch {
            return '';
        }
    }
}
