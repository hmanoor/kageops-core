/**
 * P0-W5 — bundle-project phase budget (harness-coherence-fix-plan.md).
 *
 * The LinkStash integration re-run proved the *binding* constraint isn't the
 * schema-wiring mechanics — it's catastrophic over-decomposition. A DB-backed
 * bundle run produced 14-17 tasks PER planning phase and, worse, put a
 * documentation task (a 200-line Gantt-chart "implementation project plan")
 * INTO the development phase. Development timed out writing plans before it
 * ever reached the schema/API implementation, so #391/#393 never even fired.
 *
 * `applyBundlePhaseBudget` is a deterministic post-filter (same idiom as the
 * SIMPLE-APP GUARD): it hard-caps the planning phases and strips planning/doc
 * task types out of the development phase, so the run spends its budget
 * building, not planning.
 */
import { describe, it, expect } from 'vitest';
import {
    applyBundlePhaseBudget,
    BUNDLE_PLANNING_CAPS,
    DEV_FORBIDDEN_TASK_TYPES,
} from '../../src/orchestrator/bundle-phase-budget';
import type { DecomposedTask } from '../../src/orchestrator/task-decomposer';

function task(over: Partial<DecomposedTask>): DecomposedTask {
    return {
        title: 'T',
        description: '',
        taskType: 'implement',
        assignedAgent: 'forge',
        priority: 5,
        dependsOn: [],
        phase: 'development',
        outputPath: null,
        ...over,
    };
}

describe('applyBundlePhaseBudget (P0-W5)', () => {
    it('hard-caps an over-decomposed planning phase', () => {
        const many = Array.from({ length: 16 }, (_, i) => task({ title: `d${i}`, phase: 'discovery' }));
        const out = applyBundlePhaseBudget(many, 'discovery');
        expect(out.length).toBe(BUNDLE_PLANNING_CAPS['discovery']);
        expect(out.length).toBeLessThan(16);
    });

    it('caps design-planning too (the phase that spawned the Gantt plan)', () => {
        const many = Array.from({ length: 16 }, (_, i) => task({ title: `p${i}`, phase: 'design-planning' }));
        expect(applyBundlePhaseBudget(many, 'design-planning').length).toBe(BUNDLE_PLANNING_CAPS['design-planning']);
    });

    it('strips planning/doc task types out of the development phase', () => {
        const tasks = [
            task({ title: 'Write project plan', taskType: 'project-plan' }),
            task({ title: 'Market research', taskType: 'market-research' }),
            task({ title: 'Build schema', taskType: 'implement' }),
            task({ title: 'Build /api/bookmarks', taskType: 'create-api' }),
            task({ title: 'Dashboard', taskType: 'create-ui' }),
        ];
        const out = applyBundlePhaseBudget(tasks, 'development');
        const types = out.map((t) => t.taskType);
        expect(types).not.toContain('project-plan');
        expect(types).not.toContain('market-research');
        expect(types).toEqual(expect.arrayContaining(['implement', 'create-api', 'create-ui']));
        expect(out.length).toBe(3);
    });

    it('keeps legitimate non-planning dev tasks (tests, review, fixes)', () => {
        const tasks = [
            task({ taskType: 'implement' }),
            task({ taskType: 'add-tests', assignedAgent: 'vigil' }),
            task({ taskType: 'code-review', assignedAgent: 'vigil' }),
            task({ taskType: 'fix-bug' }),
        ];
        const out = applyBundlePhaseBudget(tasks, 'development');
        expect(out.length).toBe(4);
    });

    it('never wipes the development phase — if every task is forbidden, keep the original', () => {
        const tasks = [task({ taskType: 'project-plan' }), task({ taskType: 'documentation' })];
        const out = applyBundlePhaseBudget(tasks, 'development');
        expect(out.length).toBe(2); // safety: don't leave development task-less
    });

    it('does not cap the development phase by count (build tasks are not noise)', () => {
        const tasks = Array.from({ length: 10 }, (_, i) => task({ title: `impl${i}`, taskType: 'implement' }));
        expect(applyBundlePhaseBudget(tasks, 'development').length).toBe(10);
    });

    it('leaves an already-lean planning phase untouched', () => {
        const tasks = [task({ phase: 'discovery' }), task({ phase: 'discovery' })];
        expect(applyBundlePhaseBudget(tasks, 'discovery')).toEqual(tasks);
    });

    it('exposes the forbidden-in-development task types', () => {
        expect(DEV_FORBIDDEN_TASK_TYPES.has('project-plan')).toBe(true);
        expect(DEV_FORBIDDEN_TASK_TYPES.has('implement')).toBe(false);
    });
});
