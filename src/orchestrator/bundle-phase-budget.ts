/**
 * P0-W5 — bundle-project phase budget.
 *
 * See docs/plans/harness-coherence-fix-plan.md. The binding constraint on
 * Tier-3 completion is catastrophic over-decomposition: a DB-backed bundle run
 * produced 14-17 tasks per planning phase and put a documentation task (a
 * 200-line Gantt-chart "implementation project plan") INTO the development
 * phase — so development timed out planning before it ever reached the
 * schema/API implementation, and the schema-first spine (#391) + file-read
 * context (#393) never even fired.
 *
 * `applyBundlePhaseBudget` is a deterministic post-filter (same idiom as the
 * SIMPLE-APP GUARD): for a DB-backed bundle it hard-caps the planning phases
 * and strips planning/doc task types out of the development phase, so the run
 * spends its budget building, not planning. Development is intentionally NOT
 * count-capped — that's where the actual work must happen.
 */

import type { DecomposedTask } from './task-decomposer';

/**
 * Hard caps for the planning phases of a DB-backed bundle project. Development
 * is intentionally absent (uncapped). Tuned to slash the observed 14-17/phase
 * to the minimum needed to inform the build.
 */
export const BUNDLE_PLANNING_CAPS: Readonly<Record<string, number>> = {
    'discovery': 3,
    'poc': 2,
    'business-viability': 1,
    'design-planning': 3,
    'launch-growth': 2,
};

/**
 * Task types that are planning / research / design / documentation — never a
 * development-phase deliverable. A development phase must produce code; a
 * project plan or market-research doc there is pure budget drain.
 */
export const DEV_FORBIDDEN_TASK_TYPES: ReadonlySet<string> = new Set([
    // planning / research / docs
    'project-plan',
    'prd',
    'concept-brief',
    'market-research',
    'competitive-analysis',
    'feasibility-assessment',
    'risk-assessment',
    'brand-strategy',
    'content-plan',
    'seo-audit',
    'campaign',
    'release-notes',
    'documentation',
    // design / architecture belong to earlier phases — development implements them
    'architecture-design',
    'system-design',
    'tech-stack',
    'api-design',
    'database-design',
    'wireframe',
    'mockup',
    'design-system',
    'user-flow',
]);

/**
 * Apply the bundle phase budget for a single phase's decomposed tasks. Pure;
 * never mutates the input. The caller gates this on the project being a
 * DB-backed bundle (see TaskDecomposer.projectNeedsSchema).
 */
export function applyBundlePhaseBudget(
    tasks: readonly DecomposedTask[],
    phase: string,
): readonly DecomposedTask[] {
    if (tasks.length === 0) return tasks;

    if (phase === 'development') {
        const impl = tasks.filter((t) => !DEV_FORBIDDEN_TASK_TYPES.has(t.taskType));
        // Never leave development task-less — if the LLM produced ONLY planning
        // tasks, keep the original rather than wedge the phase (the schema-first
        // spine + acceptance gate are the next nets).
        return impl.length > 0 ? impl : tasks;
    }

    const cap = BUNDLE_PLANNING_CAPS[phase];
    if (cap !== undefined && tasks.length > cap) {
        return tasks.slice(0, cap);
    }
    return tasks;
}
