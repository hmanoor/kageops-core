/**
 * Deterministic per-phase fallback task templates (BPF-37) — the never-wedge
 * safety net for decomposition.
 *
 * BPF-32 re-rolls a flaky decomposition up to 3 times, and BPF-36 recovers
 * tasks from malformed/partial JSON. When BOTH still come up empty — a model
 * that never once emits anything parseable for a phase — the phase has zero
 * tasks and the pipeline wedges (no app built, the zombie guard eventually
 * cancels the whole run). Across the ClubHubOSS dogfood this was the single
 * biggest cause of dud runs.
 *
 * Rather than wedge, fall back to a minimal, deterministic, schema-valid task
 * for the phase so the pipeline always advances. The fallback is intentionally
 * SPARSE (one task, the absolute minimum the phase needs) and its quality is
 * secondary to the guarantee that the phase never stalls on a decomposition
 * dud. The development fallback is the important one: it produces a single
 * Forge/Pixel build task so an app is always attempted.
 *
 * This is a pure function — no I/O, no model calls. The caller (TaskDecomposer)
 * only invokes it after the re-roll + recovery nets are exhausted, gated on
 * KAGEOPS_DECOMPOSE_FALLBACK (default on).
 */

import type { DecomposedTask, Phase } from './task-decomposer';

export interface FallbackContext {
    readonly phase: Phase;
    readonly projectName: string;
    readonly description: string;
    /** From `detectSimpleApp` — picks the landing-page vs. app-scaffold dev task. */
    readonly simple: boolean;
}

function task(
    phase: Phase,
    partial: Omit<DecomposedTask, 'phase' | 'dependsOn'>,
): DecomposedTask {
    return { ...partial, phase, dependsOn: [] };
}

/** A short, safe slug of the brief for embedding in fallback descriptions. */
function briefExcerpt(description: string): string {
    const oneLine = description.replace(/\s+/g, ' ').trim();
    return oneLine.length > 400 ? `${oneLine.slice(0, 400)}…` : oneLine;
}

/**
 * Minimal deterministic task(s) for a phase when decomposition yields nothing.
 * Every task uses an approved (agent, taskType) pair from the decomposer's
 * catalogue so downstream routing/handlers accept it unchanged.
 */
export function phaseFallbackTasks(ctx: FallbackContext): readonly DecomposedTask[] {
    const brief = briefExcerpt(ctx.description);

    switch (ctx.phase) {
        case 'discovery':
            return [
                task('discovery', {
                    title: 'Concept brief',
                    description:
                        `Write a concise concept brief for ${ctx.projectName}, grounded strictly in ` +
                        `the user's brief: ${brief}`,
                    taskType: 'concept-brief',
                    assignedAgent: 'scout',
                    priority: 8,
                    outputPath: 'docs/discovery/01-concept-brief.md',
                }),
            ];

        case 'poc':
            return [
                task('poc', {
                    title: 'Project scaffold',
                    description:
                        `Stand up the minimal project scaffold for ${ctx.projectName} as described: ${brief}`,
                    taskType: 'setup-project',
                    assignedAgent: 'forge',
                    priority: 8,
                    outputPath: ctx.simple ? 'index.html' : null,
                }),
            ];

        case 'business-viability':
            return [
                task('business-viability', {
                    title: 'Feasibility assessment',
                    description:
                        `Assess the feasibility and viability of ${ctx.projectName}, grounded in the brief: ${brief}`,
                    taskType: 'feasibility-assessment',
                    assignedAgent: 'scout',
                    priority: 6,
                    outputPath: 'docs/business-viability/01-feasibility.md',
                }),
            ];

        case 'design-planning':
            return [
                task('design-planning', {
                    title: 'System design',
                    description:
                        `Produce the system/tech design for ${ctx.projectName} per the brief: ${brief}`,
                    taskType: 'system-design',
                    assignedAgent: 'blueprint',
                    priority: 7,
                    outputPath: 'docs/design-planning/01-system-design.md',
                }),
            ];

        case 'development':
            // The critical fallback — always attempt to BUILD something. A
            // landing/marketing single-page site goes to Pixel's ui-build
            // (index.html + styles.css via the design provider); everything
            // else to a single Forge implement task that writes the app files.
            if (ctx.simple) {
                return [
                    task('development', {
                        title: 'Build the landing page',
                        description:
                            `Build the complete landing page for ${ctx.projectName} as a single ` +
                            `index.html + styles.css, satisfying every requirement in the brief: ${brief}`,
                        taskType: 'ui-build',
                        assignedAgent: 'pixel',
                        priority: 9,
                        outputPath: 'index.html',
                    }),
                ];
            }
            return [
                task('development', {
                    title: 'Implement the application',
                    description:
                        `Implement the full application for ${ctx.projectName} described below, writing every ` +
                        `file needed (pages, components, API routes, data layer) into the existing project ` +
                        `scaffold. Satisfy every requirement in the brief: ${brief}`,
                    taskType: 'implement',
                    assignedAgent: 'forge',
                    priority: 9,
                    outputPath: null,
                }),
            ];

        case 'launch-growth':
            return [
                task('launch-growth', {
                    title: 'Release quality gate',
                    description:
                        `Run a final quality gate over ${ctx.projectName}: confirm the build is green and the ` +
                        `brief is satisfied before release. Brief: ${brief}`,
                    taskType: 'quality-gate',
                    assignedAgent: 'vigil',
                    priority: 5,
                    outputPath: 'docs/launch-growth/01-quality-gate.md',
                }),
            ];

        default:
            return [];
    }
}

/** KAGEOPS_DECOMPOSE_FALLBACK=0 opts out of the never-wedge phase fallback. */
export function decomposeFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return (env.KAGEOPS_DECOMPOSE_FALLBACK ?? '').trim() !== '0';
}
