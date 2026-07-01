/**
 * BPF-37 — deterministic per-phase fallback templates (never-wedge net).
 */

import { describe, it, expect } from 'vitest';
import { phaseFallbackTasks, decomposeFallbackEnabled } from '../../src/orchestrator/phase-fallback-tasks';
import type { Phase } from '../../src/orchestrator/task-decomposer';

const ALL_PHASES: readonly Phase[] = [
    'discovery', 'poc', 'business-viability', 'design-planning', 'development', 'launch-growth',
];

const ctx = (phase: Phase, simple = false): Parameters<typeof phaseFallbackTasks>[0] => ({
    phase,
    projectName: 'ClubHub',
    description: 'A SaaS membership site with Clerk auth, Stripe subscriptions and a Neon Postgres database.',
    simple,
});

describe('phaseFallbackTasks', () => {
    it('returns at least one schema-valid task for every phase', () => {
        for (const phase of ALL_PHASES) {
            const tasks = phaseFallbackTasks(ctx(phase));
            expect(tasks.length).toBeGreaterThanOrEqual(1);
            for (const t of tasks) {
                expect(t.phase).toBe(phase);
                expect(t.dependsOn).toEqual([]);
                expect(t.title.length).toBeGreaterThan(0);
                expect(t.taskType.length).toBeGreaterThan(0);
                expect(t.assignedAgent.length).toBeGreaterThan(0);
                expect(typeof t.priority).toBe('number');
            }
        }
    });

    it('development (non-simple) → a single Forge implement task with no fixed outputPath', () => {
        const [t] = phaseFallbackTasks(ctx('development', false));
        expect(t.assignedAgent).toBe('forge');
        expect(t.taskType).toBe('implement');
        expect(t.outputPath).toBeNull();
    });

    it('development (simple) → a single Pixel ui-build task writing index.html', () => {
        const [t] = phaseFallbackTasks(ctx('development', true));
        expect(t.assignedAgent).toBe('pixel');
        expect(t.taskType).toBe('ui-build');
        expect(t.outputPath).toBe('index.html');
    });

    it('poc outputPath is index.html only for simple apps', () => {
        expect(phaseFallbackTasks(ctx('poc', true))[0].outputPath).toBe('index.html');
        expect(phaseFallbackTasks(ctx('poc', false))[0].outputPath).toBeNull();
    });

    it('embeds (and truncates) the brief into the task description', () => {
        const long = 'x'.repeat(900);
        const [t] = phaseFallbackTasks({ ...ctx('discovery'), description: long });
        expect(t.description).toContain('…');
        expect(t.description.length).toBeLessThan(900);
    });
});

describe('decomposeFallbackEnabled', () => {
    it('defaults on when the env var is unset or empty', () => {
        expect(decomposeFallbackEnabled({})).toBe(true);
        expect(decomposeFallbackEnabled({ KAGEOPS_DECOMPOSE_FALLBACK: '' })).toBe(true);
    });

    it('is off only for an explicit "0"', () => {
        expect(decomposeFallbackEnabled({ KAGEOPS_DECOMPOSE_FALLBACK: '0' })).toBe(false);
        expect(decomposeFallbackEnabled({ KAGEOPS_DECOMPOSE_FALLBACK: '1' })).toBe(true);
    });
});
