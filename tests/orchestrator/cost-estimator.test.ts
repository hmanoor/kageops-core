/**
 * Cost Estimator unit tests
 *
 * Confidence tiers, no-data fallback, preset filtering, disclaimer copy,
 * budget-cap rendering. The estimator is informational — these tests
 * pin its observable contract so the Scout brief stays honest.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => {
    const getManyFn = vi.fn<(_sql: string, _params?: unknown[]) => Promise<unknown[]>>(
        async () => [],
    );
    return { getMany: getManyFn };
});

vi.mock('../../src/db/client', () => ({
    getMany: mockDb.getMany,
}));

import { estimateProjectCost } from '../../src/orchestrator/cost-estimator';

describe('estimateProjectCost', () => {
    beforeEach(() => {
        mockDb.getMany.mockReset();
    });

    it('returns no-data confidence + theoretical range on first run (empty DB)', async () => {
        mockDb.getMany.mockResolvedValue([]);

        const est = await estimateProjectCost({ preset: 'openrouter_budget' });

        expect(est.sampleSize).toBe(0);
        expect(est.confidence).toBe('no-data');
        expect(est.presetMatched).toBe(false);
        expect(est.estimatedUsd).toBeGreaterThan(0);
        expect(est.disclaimer).toContain('first run');
        expect(est.markdown).toContain('## Cost Estimate');
        expect(est.markdown).toContain('No historical data');
    });

    it('falls back to default range when preset is unknown and DB is empty', async () => {
        mockDb.getMany.mockResolvedValue([]);

        const est = await estimateProjectCost({ preset: 'invented-preset' });

        expect(est.confidence).toBe('no-data');
        expect(est.estimatedUsd).toBeGreaterThan(0);
    });

    it('returns $0 typical for subscription/local presets with no history', async () => {
        mockDb.getMany.mockResolvedValue([]);

        const est = await estimateProjectCost({ preset: 'ollama' });

        expect(est.estimatedUsd).toBe(0);
        expect(est.p10Usd).toBe(0);
        expect(est.p90Usd).toBe(0);
    });

    it('reports low confidence with 1-4 historical samples', async () => {
        // Two preset-matched runs
        mockDb.getMany.mockResolvedValueOnce([
            { total: '0.20' },
            { total: '0.30' },
        ]);

        const est = await estimateProjectCost({ preset: 'openrouter_budget' });

        expect(est.sampleSize).toBe(2);
        expect(est.confidence).toBe('low');
        expect(est.presetMatched).toBe(true);
        expect(est.disclaimer).toContain('only 2 prior completed runs');
        expect(est.disclaimer).toContain('improve once you have at least 5');
    });

    it('reports medium confidence at 5-19 samples', async () => {
        const samples = Array.from({ length: 7 }, (_, i) => ({ total: String((i + 1) * 0.10) }));
        mockDb.getMany.mockResolvedValueOnce(samples);

        const est = await estimateProjectCost({ preset: 'openrouter_budget' });

        expect(est.sampleSize).toBe(7);
        expect(est.confidence).toBe('medium');
        expect(est.disclaimer).toContain('moderate');
    });

    it('reports high confidence at 20+ samples', async () => {
        const samples = Array.from({ length: 25 }, () => ({ total: '0.50' }));
        mockDb.getMany.mockResolvedValueOnce(samples);

        const est = await estimateProjectCost({ preset: 'openrouter_budget' });

        expect(est.sampleSize).toBe(25);
        expect(est.confidence).toBe('high');
        expect(est.disclaimer).toContain('high confidence');
    });

    it('falls back to global pool when no preset-matched samples exist', async () => {
        mockDb.getMany
            .mockResolvedValueOnce([])                                  // preset query: empty
            .mockResolvedValueOnce([{ total: '0.40' }, { total: '0.50' }, { total: '0.60' }]); // global query

        const est = await estimateProjectCost({ preset: 'a-rare-preset' });

        expect(est.sampleSize).toBe(3);
        expect(est.presetMatched).toBe(false);
        expect(est.disclaimer).toContain('No prior runs used');
        expect(est.disclaimer).toContain('global average');
    });

    it('renders the budget cap into the disclaimer when provided', async () => {
        mockDb.getMany.mockResolvedValue([]);

        const est = await estimateProjectCost({ preset: 'openrouter_budget', budgetCapUsd: 0.5 });

        expect(est.disclaimer).toContain('$0.50');
        expect(est.disclaimer).toContain('Hard kill');
        expect(est.markdown).toContain('Budget cap');
    });

    it('warns when no budget cap is set', async () => {
        mockDb.getMany.mockResolvedValue([]);

        const est = await estimateProjectCost({ preset: 'openrouter_budget' });

        expect(est.disclaimer).toContain('No budget cap set');
        expect(est.markdown).toContain('(none)');
    });

    it('auto-fetches budget when projectId is provided and budgetCapUsd is null', async () => {
        mockDb.getMany
            .mockResolvedValueOnce([{ budget_usd: '1.50' }])  // budget lookup
            .mockResolvedValueOnce([]);                        // history query

        const est = await estimateProjectCost({ projectId: 'proj-uuid' });

        expect(est.disclaimer).toContain('$1.50');
    });

    it('produces valid p10/p50/p90 ordering on real data', async () => {
        const samples = [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00].map(
            (v) => ({ total: String(v) }),
        );
        mockDb.getMany.mockResolvedValueOnce(samples);

        const est = await estimateProjectCost({ preset: 'openrouter_budget' });

        expect(est.p10Usd).toBeLessThanOrEqual(est.estimatedUsd);
        expect(est.estimatedUsd).toBeLessThanOrEqual(est.p90Usd);
    });

    it('always includes the "estimate only — not a quote" disclaimer header', async () => {
        mockDb.getMany.mockResolvedValue([]);
        const noData = await estimateProjectCost({});
        expect(noData.disclaimer).toContain('Estimate only — not a quote');

        mockDb.getMany.mockResolvedValueOnce([{ total: '0.5' }]);
        const lowData = await estimateProjectCost({});
        expect(lowData.disclaimer).toContain('Estimate only — not a quote');
    });

    it('gracefully degrades to no-data when DB query throws', async () => {
        mockDb.getMany.mockRejectedValue(new Error('connection refused'));

        const est = await estimateProjectCost({ preset: 'openrouter_budget' });

        expect(est.confidence).toBe('no-data');
        expect(est.sampleSize).toBe(0);
    });
});
