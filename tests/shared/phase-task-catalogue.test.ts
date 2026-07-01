/**
 * #165 stage 2 — phase-task catalogue + quick-presets + payload derivation.
 */

import { describe, it, expect } from 'vitest';
import {
    PHASE_CATALOGUE,
    QUICK_PRESETS,
    derivePhaseTaskSelectionsPayload,
    getPhaseDefinition,
    getPreset,
    taskTypesForPhase,
} from '../../src/shared/phase-task-catalogue';
import type { Phase } from '../../src/orchestrator/task-decomposer';

const PHASE_ORDER: readonly Phase[] = [
    'discovery',
    'poc',
    'business-viability',
    'design-planning',
    'development',
    'launch-growth',
];

describe('phase-task catalogue', () => {
    it('covers all six phases in canonical order', () => {
        expect(PHASE_CATALOGUE.map((d) => d.phase)).toEqual(PHASE_ORDER);
    });

    it('every phase has at least one task and unique task types within a phase', () => {
        for (const def of PHASE_CATALOGUE) {
            expect(def.tasks.length).toBeGreaterThan(0);
            const seen = new Set<string>();
            for (const t of def.tasks) {
                expect(seen.has(t.taskType), `duplicate ${t.taskType} in ${def.phase}`).toBe(false);
                seen.add(t.taskType);
            }
        }
    });

    it('getPhaseDefinition returns the same object as the catalogue entry', () => {
        const def = getPhaseDefinition('design-planning');
        expect(def.phase).toBe('design-planning');
        expect(def.tasks.length).toBeGreaterThan(0);
    });

    it('taskTypesForPhase returns task types in display order', () => {
        const list = taskTypesForPhase('discovery');
        expect(list[0]).toBe('concept-brief');
        expect(list).toContain('feasibility-assessment');
    });
});

describe('quick presets', () => {
    const ids = ['poc', 'landing-page', 'full-product', 'iteration'];

    it('exposes exactly the four operator-facing presets', () => {
        expect(QUICK_PRESETS.map((p) => p.id)).toEqual(ids);
    });

    it('full-product preset has no selection constraints', () => {
        const fp = getPreset('full-product');
        expect(fp).toBeDefined();
        expect(fp?.selections).toBeUndefined();
        expect(fp?.phases.length).toBe(PHASE_ORDER.length);
    });

    it('POC preset constrains to a tight task list and skips business + launch', () => {
        const poc = getPreset('poc');
        expect(poc).toBeDefined();
        expect(poc?.phases).not.toContain('business-viability');
        expect(poc?.phases).not.toContain('launch-growth');
        expect(poc?.selections?.discovery).toContain('concept-brief');
        expect(poc?.selections?.discovery).toContain('feasibility-assessment');
        expect(poc?.selections?.discovery).not.toContain('market-research');
    });

    it('landing-page preset uses Pixel ui-build for development', () => {
        const lp = getPreset('landing-page');
        expect(lp?.selections?.development).toEqual(['ui-build']);
    });

    it('iteration preset includes only development + launch phases', () => {
        const it_ = getPreset('iteration');
        expect(it_?.phases).toEqual(['development', 'launch-growth']);
    });

    it('every task type referenced by a preset exists in the catalogue', () => {
        for (const preset of QUICK_PRESETS) {
            if (preset.selections === undefined) continue;
            for (const [phaseKey, taskTypes] of Object.entries(preset.selections)) {
                const def = getPhaseDefinition(phaseKey as Phase);
                const available = new Set(def.tasks.map((task) => task.taskType));
                for (const tt of taskTypes ?? []) {
                    expect(
                        available.has(tt),
                        `${preset.id}.${phaseKey} references unknown task type "${tt}"`,
                    ).toBe(true);
                }
            }
        }
    });
});

describe('derivePhaseTaskSelectionsPayload', () => {
    it('returns null when every task type is ticked for every enabled phase (legacy)', () => {
        const enabled: readonly Phase[] = ['discovery', 'development'];
        const allTicked: Record<string, readonly string[]> = {};
        for (const phase of enabled) {
            allTicked[phase] = taskTypesForPhase(phase);
        }
        expect(derivePhaseTaskSelectionsPayload(enabled, allTicked)).toBeNull();
    });

    it('returns null when phases are enabled but no checkboxes are ticked', () => {
        // Defensive: empty arrays should never reach the DB because they
        // would block decomposition. derive() strips them and the result
        // becomes the empty map → null.
        const out = derivePhaseTaskSelectionsPayload(['discovery'], { discovery: [] });
        expect(out).toBeNull();
    });

    it('omits disabled phases entirely', () => {
        const out = derivePhaseTaskSelectionsPayload(['discovery'], {
            discovery: ['concept-brief'],
            development: ['implement'],
        });
        expect(out).not.toBeNull();
        expect(out?.discovery).toEqual(['concept-brief']);
        expect(out).not.toHaveProperty('development');
    });

    it('drops unknown task types per phase', () => {
        const out = derivePhaseTaskSelectionsPayload(['discovery'], {
            discovery: ['concept-brief', 'not-a-real-type'],
        });
        expect(out?.discovery).toEqual(['concept-brief']);
    });

    it('preserves order of task-type entries the renderer supplied', () => {
        const out = derivePhaseTaskSelectionsPayload(['discovery'], {
            discovery: ['feasibility-assessment', 'concept-brief'],
        });
        expect(out?.discovery).toEqual(['feasibility-assessment', 'concept-brief']);
    });

    it('omits phases where all tasks are still ticked (per-phase no-constraint short-circuit)', () => {
        const all = taskTypesForPhase('discovery');
        const out = derivePhaseTaskSelectionsPayload(['discovery', 'development'], {
            discovery: all,                            // fully ticked → omit
            development: ['implement'],                // constrained
        });
        expect(out).not.toBeNull();
        expect(out).not.toHaveProperty('discovery');
        expect(out?.development).toEqual(['implement']);
    });
});
