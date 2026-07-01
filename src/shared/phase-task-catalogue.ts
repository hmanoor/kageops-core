/**
 * Per-phase task-type catalogue and Quick Presets (issue #165 stage 2).
 *
 * Mirrors the agent → taskTypes table baked into
 * `src/orchestrator/task-decomposer.ts buildSystemPrompt`. Kept in a
 * shared module so the renderer can build the two-level checklist UI
 * without re-deriving the taxonomy from a prompt string.
 *
 * Used by:
 *   - `src/renderer/command-center/command-center.ts` — New Project modal
 *   - `tests/shared/phase-task-catalogue.test.ts` — shape lock
 *
 * The decomposer's HARD CONSTRAINT block (#165 stage 1) is the runtime
 * authority. This module is purely a UI affordance — if a label here
 * drifts from the prompt, the decomposer's allowlist still wins at
 * decomposition time.
 *
 * Every taskType here MUST appear in the decomposer's approved list for
 * the phase's agents. Unknown types are dropped at decomposition time.
 */
import type { Phase } from '../orchestrator/task-decomposer';

export type PhaseTaskSelections = Partial<Record<Phase, readonly string[]>>;

export interface PhaseTask {
    readonly taskType: string;
    readonly agent: string;
    readonly label: string;
    readonly hint: string;
}

export interface PhaseDefinition {
    readonly phase: Phase;
    readonly label: string;
    readonly hint: string;
    readonly tasks: readonly PhaseTask[];
}

const t = (taskType: string, agent: string, label: string, hint: string): PhaseTask => ({
    taskType,
    agent,
    label,
    hint,
});

export const PHASE_CATALOGUE: readonly PhaseDefinition[] = [
    {
        phase: 'discovery',
        label: 'Discovery',
        hint: 'Research, scope, framing.',
        tasks: [
            t('concept-brief', 'scout', 'Concept brief', 'One-page summary of what we\'re building and why.'),
            t('feasibility-assessment', 'scout', 'Feasibility assessment', 'Can this be built within scope? Highlights showstoppers.'),
            t('prd', 'scout', 'PRD', 'Product requirements doc with explicit acceptance criteria.'),
            t('project-plan', 'scout', 'Project plan', 'Timeline + milestones. Skip for one-shot builds.'),
            t('risk-assessment', 'scout', 'Risk register', 'Top risks + mitigation. Useful for client work.'),
            t('market-research', 'scout', 'Market research', 'Who else is in this space? Skip for solo POCs.'),
            t('competitive-analysis', 'scout', 'Competitive analysis', 'Feature-by-feature comparison vs incumbents.'),
            t('tech-stack', 'blueprint', 'Tech stack pick', 'Lock the stack early — language, framework, DB.'),
            t('architecture-design', 'blueprint', 'Architecture sketch', 'High-level system shape — modules, data flow.'),
            t('system-design', 'blueprint', 'System design', 'Detailed component + integration diagram.'),
        ],
    },
    {
        phase: 'poc',
        label: 'POC',
        hint: 'Runnable prototype to de-risk the core assumption.',
        tasks: [
            t('tech-stack', 'blueprint', 'Stack pick', 'Lock the stack for the prototype.'),
            t('architecture-design', 'blueprint', 'Architecture sketch', 'Just enough structure for the POC.'),
            t('api-design', 'blueprint', 'API contracts', 'Endpoint shapes the POC will exercise.'),
            t('database-design', 'blueprint', 'Schema sketch', 'Tables/collections needed for the POC.'),
            t('setup-project', 'forge', 'Scaffold prototype', 'Minimal repo skeleton — package.json, base files.'),
            t('implement', 'forge', 'Implement core path', 'The one thing the POC needs to prove.'),
            t('create-ui', 'forge', 'Working UI', 'A clickable interface so the POC is visibly runnable, not just files.'),
            t('create-api', 'forge', 'Working API', 'Live endpoint(s) the POC actually calls.'),
            t('add-tests', 'forge', 'Smoke test', 'Boots the prototype and verifies the core path runs end-to-end.'),
            t('data-schema', 'cipher', 'Data schema', 'Just enough schema to make the POC work.'),
            t('database-query', 'cipher', 'Sample queries', 'Hand-written queries the POC uses.'),
            t('data-pipeline', 'cipher', 'Mini pipeline', 'Throw-away ETL for POC data — keep tiny.'),
        ],
    },
    {
        phase: 'business-viability',
        label: 'Business Viability',
        hint: 'Costs, market fit, go-to-market.',
        tasks: [
            t('market-research', 'scout', 'Market research', 'TAM/SAM/SOM, buyer personas.'),
            t('competitive-analysis', 'scout', 'Competitive analysis', 'Feature matrix vs incumbents.'),
            t('prd', 'scout', 'PRD refinement', 'Sharpen the requirements doc with viability findings.'),
            t('project-plan', 'scout', 'Project plan', 'Phased delivery + milestones with budget.'),
            t('risk-assessment', 'scout', 'Risk register', 'Commercial + technical risks with mitigations.'),
            t('brand-strategy', 'herald', 'Brand strategy', 'Voice, positioning, naming.'),
            t('content-plan', 'herald', 'Content plan', 'Launch + ongoing content cadence.'),
            t('seo-audit', 'herald', 'SEO audit', 'Keyword + on-page audit for the marketing site.'),
            t('campaign', 'herald', 'Campaign outline', 'Launch campaign across the relevant channels.'),
            t('landing-page', 'herald', 'Landing-page plan', 'Marketing site outline (scope, sections, CTAs).'),
        ],
    },
    {
        phase: 'design-planning',
        label: 'Design & Planning',
        hint: 'Architecture lockdown + UX.',
        tasks: [
            t('wireframe', 'pixel', 'Wireframes', 'Low-fi layout for each screen.'),
            t('mockup', 'pixel', 'Hi-fi mockups', 'Visual design with type/colour/spacing locked.'),
            t('design-system', 'pixel', 'Design system', 'Tokens + reusable components.'),
            t('user-flow', 'pixel', 'User flow', 'Click-path through the product.'),
            t('responsive-design', 'pixel', 'Responsive breakdown', 'Mobile / tablet / desktop variants.'),
            t('ui-review', 'pixel', 'UI review', 'Critique pass on the design before build.'),
            t('ui-build', 'pixel', 'Pixel UI build', 'Pixel produces styled HTML/CSS — landing-page path.'),
            t('architecture-design', 'blueprint', 'Architecture', 'Module boundaries, deployment topology.'),
            t('api-design', 'blueprint', 'API design', 'Endpoint contracts.'),
            t('database-design', 'blueprint', 'Database design', 'Schema + indexes.'),
            t('system-design', 'blueprint', 'System design', 'Integration + sequence diagrams.'),
            t('tech-stack', 'blueprint', 'Tech stack lockdown', 'Final stack pick with rationale.'),
            t('prd', 'scout', 'PRD lockdown', 'Final PRD with acceptance criteria.'),
            t('project-plan', 'scout', 'Project plan', 'Sprint plan / delivery milestones.'),
        ],
    },
    {
        phase: 'development',
        label: 'Development',
        hint: 'Build.',
        tasks: [
            t('setup-project', 'forge', 'Project scaffold', 'package.json, tsconfig, base files.'),
            t('implement', 'forge', 'Implement', 'Feature implementation tasks.'),
            t('create-api', 'forge', 'Build API', 'Endpoint implementations.'),
            t('create-ui', 'forge', 'Build UI', 'React/HTML implementation of designs.'),
            t('refactor', 'forge', 'Refactor', 'Restructure existing code without changing behaviour.'),
            t('fix-bug', 'forge', 'Fix bug', 'Targeted fix.'),
            t('add-tests', 'forge', 'Add tests', 'Forge-authored unit/integration tests.'),
            t('ui-build', 'pixel', 'Pixel ui-build (landing pages)', 'Pixel produces index.html + styles.css through the design provider.'),
            t('ui-review', 'pixel', 'UI review', 'Pixel reviews the live UI against the mockups.'),
            t('responsive-design', 'pixel', 'Responsive polish', 'Tighten mobile/tablet/desktop variants.'),
            t('database-query', 'cipher', 'Database queries', 'Hand-written SQL / ORM calls.'),
            t('data-pipeline', 'cipher', 'Data pipeline', 'ETL / ingestion.'),
            t('etl', 'cipher', 'ETL job', 'Scheduled extract / transform / load.'),
            t('analytics', 'cipher', 'Analytics', 'Event tracking / metrics surfaces.'),
            t('ml-model', 'cipher', 'ML model', 'Train or wire in a model.'),
            t('data-schema', 'cipher', 'Data schema', 'Detailed schema with indexes + constraints.'),
            t('docker-setup', 'aegis', 'Docker setup', 'Dockerfile + compose.'),
            t('terraform', 'aegis', 'Terraform / IaC', 'Infra-as-code for dev/staging.'),
            t('ci-cd', 'aegis', 'CI/CD pipeline', 'GitHub Actions / similar for dev branches.'),
            t('write-tests', 'vigil', 'Vigil test pass', 'Independent test review + additions.'),
            t('code-review', 'vigil', 'Code review', 'Vigil reads the diff.'),
            t('security-review', 'vigil', 'Security review', 'Spot common vulnerabilities before launch.'),
            t('documentation', 'vigil', 'Documentation', 'README + inline docs.'),
            t('quality-gate', 'vigil', 'Quality gate', 'Run the gate before promoting to launch.'),
        ],
    },
    {
        phase: 'launch-growth',
        label: 'Launch & Growth',
        hint: 'Ship + iterate.',
        tasks: [
            t('ci-cd', 'aegis', 'CI/CD pipeline', 'GitHub Actions / similar for prod.'),
            t('deployment', 'aegis', 'Deploy', 'Push to hosting.'),
            t('docker-setup', 'aegis', 'Docker setup', 'Production Dockerfile + compose.'),
            t('terraform', 'aegis', 'Terraform / IaC', 'Prod infrastructure as code.'),
            t('monitoring', 'aegis', 'Monitoring', 'Logs + alerts wired up.'),
            t('security-hardening', 'aegis', 'Security hardening', 'Secrets review, headers, CSP.'),
            t('quality-gate', 'vigil', 'Quality gate', 'Final acceptance pass before announce.'),
            t('security-review', 'vigil', 'Security review', 'Pen-test pass before public launch.'),
            t('documentation', 'vigil', 'Launch docs', 'User-facing docs + changelog.'),
            t('release-notes', 'herald', 'Release notes', 'Changelog + announcement copy.'),
            t('campaign', 'herald', 'Launch campaign', 'Cross-channel announcement.'),
            t('landing-page', 'herald', 'Marketing landing page', 'Standalone marketing site.'),
            t('content-plan', 'herald', 'Post-launch content', 'Ongoing content cadence after the launch.'),
            t('seo-audit', 'herald', 'SEO audit', 'On-page audit before announce.'),
            t('brand-strategy', 'herald', 'Brand polish', 'Final voice + positioning pass.'),
            t('project-plan', 'scout', 'Growth plan', 'Post-launch roadmap.'),
            t('risk-assessment', 'scout', 'Launch risks', 'What could go wrong on day one.'),
        ],
    },
] as const;

const PHASE_LOOKUP: Record<Phase, PhaseDefinition> = (() => {
    const out: Partial<Record<Phase, PhaseDefinition>> = {};
    for (const def of PHASE_CATALOGUE) out[def.phase] = def;
    return out as Record<Phase, PhaseDefinition>;
})();

export function getPhaseDefinition(phase: Phase): PhaseDefinition {
    return PHASE_LOOKUP[phase];
}

/** All task types available for a phase, in display order. */
export function taskTypesForPhase(phase: Phase): readonly string[] {
    return getPhaseDefinition(phase).tasks.map((task) => task.taskType);
}

// ── Quick presets ─────────────────────────────────────

export interface QuickPreset {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly phases: readonly Phase[];
    /**
     * Selections to apply when this preset is picked. `undefined` = "no
     * constraint" (all task types ticked, payload serialises to null
     * which means today's legacy decomposer behaviour).
     */
    readonly selections: PhaseTaskSelections | undefined;
}

export const QUICK_PRESETS: readonly QuickPreset[] = [
    {
        id: 'poc',
        label: 'POC',
        description: 'Runnable prototype — scaffold, core path, working UI, smoke test.',
        phases: ['discovery', 'poc'],
        selections: {
            'discovery': ['concept-brief', 'feasibility-assessment', 'tech-stack'],
            'poc': [
                'tech-stack',
                'setup-project',
                'implement',
                'create-ui',
                'add-tests',
            ],
        },
    },
    {
        id: 'landing-page',
        label: 'Landing page',
        description: 'Visually-heavy single-page site — concept, full design, Pixel ui-build.',
        phases: ['discovery', 'design-planning', 'development'],
        selections: {
            'discovery': ['concept-brief'],
            'design-planning': [
                'wireframe',
                'mockup',
                'design-system',
                'user-flow',
                'responsive-design',
                'ui-build',
            ],
            'development': ['ui-build'],
        },
    },
    {
        id: 'full-product',
        label: 'Full product',
        description: 'Everything — all phases, all task types. Today\'s default behaviour.',
        phases: ['discovery', 'poc', 'business-viability', 'design-planning', 'development', 'launch-growth'],
        selections: undefined,
    },
    {
        id: 'iteration',
        label: 'Iteration',
        description: 'Changes to an existing project — just dev + launch.',
        phases: ['development', 'launch-growth'],
        selections: {
            'development': ['implement', 'refactor', 'fix-bug', 'add-tests', 'code-review'],
            'launch-growth': ['ci-cd', 'deployment', 'quality-gate', 'release-notes'],
        },
    },
] as const;

export function getPreset(id: string): QuickPreset | undefined {
    return QUICK_PRESETS.find((p) => p.id === id);
}

// ── Payload derivation ────────────────────────────────

/**
 * Collapse the operator's checkbox state into the JSONB payload that
 * goes to `projects.phase_task_selections`.
 *
 * Rules:
 *   - Phases not in `enabledPhases` are omitted entirely (the column
 *     is per-phase, and the existing `enabled_phases` column already
 *     controls which phases run).
 *   - If a phase has EVERY task type ticked, the phase is omitted from
 *     the map — that's "no constraint" for that phase. Matches the
 *     legacy LLM-picks-freely behaviour for the unchanged phases.
 *   - If the resulting map is empty, returns `null` — the decomposer
 *     treats null as "no constraint anywhere".
 *
 * Defence in depth: this never sends a phase key with an empty array.
 * An empty array would mean "no task types are valid for this phase",
 * which would block decomposition entirely. We strip those.
 */
export function derivePhaseTaskSelectionsPayload(
    enabledPhases: readonly Phase[],
    selectionsByPhase: Readonly<Record<string, readonly string[]>>,
): PhaseTaskSelections | null {
    const out: Partial<Record<Phase, readonly string[]>> = {};
    for (const phase of enabledPhases) {
        const def = PHASE_LOOKUP[phase];
        if (def === undefined) continue;
        const available = def.tasks.map((task) => task.taskType);
        const picked = (selectionsByPhase[phase] ?? []).filter((tt) =>
            available.includes(tt),
        );
        if (picked.length === 0) continue;
        if (picked.length === available.length) continue; // all-on = no constraint
        out[phase] = picked;
    }
    if (Object.keys(out).length === 0) return null;
    return out;
}
