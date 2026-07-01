/**
 * Cost intelligence panel — Run Budgets section (B-449).
 *
 * Uses a tiny fake container that records innerHTML so we can assert
 * the rendered contract without a jsdom dependency (vitest defaults to
 * the node env here). The wiring layer (click → setProjectBudget) is
 * intentionally not exercised — it requires real DOM event dispatch —
 * but the render contract is what other Command Center tests need to
 * trust.
 */

import { describe, it, expect } from 'vitest';
import {
    renderCostIntelligencePanel,
    type OperationalCostSummary,
    type RunBudgetEntry,
} from '../../src/renderer/command-center/cost-intelligence-panel';

class FakeContainer {
    innerHTML = '';
    // The real panel also calls querySelectorAll after setting innerHTML
    // to attach listeners. Return empty — no controls are exercised.
    querySelectorAll(): readonly unknown[] {
        return [];
    }
}

function emptySummary(): OperationalCostSummary {
    return {
        totalToday: 0,
        totalThisWeek: 0,
        totalThisMonth: 0,
        byAgent: [],
        byProvider: [],
        byProject: [],
        lastSyncAt: null,
    };
}

describe('renderCostIntelligencePanel — Run Budgets', () => {
    it('omits the RUN BUDGETS section when there are no active runs', () => {
        const c = new FakeContainer();
        renderCostIntelligencePanel(c as unknown as HTMLElement, emptySummary(), []);
        expect(c.innerHTML).not.toContain('RUN BUDGETS');
    });

    it('renders one row per active budget with spend / cap', () => {
        const c = new FakeContainer();
        const budgets: RunBudgetEntry[] = [
            {
                projectId: 'p1',
                projectName: 'Landing Page',
                status: 'active',
                capUsd: 0.50,
                spentUsd: 0.12,
                tokensOut: 1000,
            },
        ];
        renderCostIntelligencePanel(c as unknown as HTMLElement, emptySummary(), budgets);
        expect(c.innerHTML).toContain('RUN BUDGETS');
        expect(c.innerHTML).toContain('Landing Page');
        expect(c.innerHTML).toContain('$0.50');
        expect(c.innerHTML).toContain('data-project-id="p1"');
    });

    it('colors the bar green under 60%, amber 60-85%, red over 85%', () => {
        // under 60% → ok
        {
            const c = new FakeContainer();
            renderCostIntelligencePanel(c as unknown as HTMLElement, emptySummary(), [
                { projectId: 'p', projectName: 'x', status: 'active', capUsd: 1, spentUsd: 0.3, tokensOut: 0 },
            ]);
            expect(c.innerHTML).toContain('ci-bar-ok');
        }
        // 60-85% → warn
        {
            const c = new FakeContainer();
            renderCostIntelligencePanel(c as unknown as HTMLElement, emptySummary(), [
                { projectId: 'p', projectName: 'x', status: 'active', capUsd: 1, spentUsd: 0.7, tokensOut: 0 },
            ]);
            expect(c.innerHTML).toContain('ci-bar-warn');
        }
        // over 85% → crit
        {
            const c = new FakeContainer();
            renderCostIntelligencePanel(c as unknown as HTMLElement, emptySummary(), [
                { projectId: 'p', projectName: 'x', status: 'active', capUsd: 1, spentUsd: 0.95, tokensOut: 0 },
            ]);
            expect(c.innerHTML).toContain('ci-bar-crit');
        }
    });

    it('renders a dash for cap when DB value is null (env fallback active)', () => {
        const c = new FakeContainer();
        renderCostIntelligencePanel(c as unknown as HTMLElement, emptySummary(), [
            { projectId: 'p', projectName: 'x', status: 'active', capUsd: null, spentUsd: 0.05, tokensOut: 0 },
        ]);
        // spend / —
        expect(c.innerHTML).toMatch(/\$0\.\d+ \/ —/);
    });

    it('shows paused badge when project status is paused', () => {
        const c = new FakeContainer();
        renderCostIntelligencePanel(c as unknown as HTMLElement, emptySummary(), [
            { projectId: 'p', projectName: 'x', status: 'paused', capUsd: 1, spentUsd: 0.1, tokensOut: 0 },
        ]);
        expect(c.innerHTML).toContain('ci-badge-paused');
    });
});
