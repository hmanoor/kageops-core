/**
 * Tests for risk-scorer.ts — B-206
 */

import { describe, it, expect } from 'vitest';
import {
    scoreFileRisk,
    prioritizeByRisk,
    buildRiskAwareReviewPrompt,
    formatRiskReport,
    type ChangedFunctionParam,
    type BlastRadiusParam,
    type TestGapParam,
    type RiskScoredFile,
} from '../../src/agents/risk-scorer';

// ── Helpers ───────────────────────────────────────────

function makeFunctions(scores: number[], testGap = false): ChangedFunctionParam[] {
    return scores.map((riskScore, i) => ({ name: `fn${i}`, riskScore, testGap }));
}

function makeBlast(filePath: string, calledBy: string[]): BlastRadiusParam {
    return { filePath, calledBy };
}

function makeTestGap(filePath: string, hasCoverage: boolean): TestGapParam {
    return { filePath, hasCoverage };
}

// ── scoreFileRisk ─────────────────────────────────────

describe('scoreFileRisk', () => {
    it('returns base risk as average of changed function scores', () => {
        const result = scoreFileRisk(
            'src/foo.ts',
            makeFunctions([4, 6]),
            [],
            []
        );
        // avg = 5, no bonuses
        expect(result.riskScore).toBe(5);
        expect(result.filePath).toBe('src/foo.ts');
    });

    it('adds +2 when a changed function has testGap === true', () => {
        const fns: ChangedFunctionParam[] = [
            { name: 'fn0', riskScore: 3, testGap: true },
        ];
        const result = scoreFileRisk('src/foo.ts', fns, [], []);
        expect(result.riskScore).toBe(5); // 3 + 2
        expect(result.hasTestGap).toBe(true);
    });

    it('adds +2 when testGaps list marks the file as uncovered', () => {
        const fns: ChangedFunctionParam[] = [
            { name: 'fn0', riskScore: 2, testGap: false },
        ];
        const gaps: TestGapParam[] = [makeTestGap('src/foo.ts', false)];
        const result = scoreFileRisk('src/foo.ts', fns, [], gaps);
        expect(result.riskScore).toBe(4); // 2 + 2
        expect(result.hasTestGap).toBe(true);
    });

    it('adds blast-radius bonus capped at +3', () => {
        const fns: ChangedFunctionParam[] = [
            { name: 'fn0', riskScore: 4, testGap: false },
        ];
        // 8 callers → 8 * 0.5 = 4, capped to 3
        const blast: BlastRadiusParam[] = [
            makeBlast('src/foo.ts', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
        ];
        const result = scoreFileRisk('src/foo.ts', fns, blast, []);
        expect(result.riskScore).toBe(7); // 4 + 3 (capped)
        expect(result.blastRadius).toBe(8);
    });

    it('blast-radius bonus is NOT capped when callers < 6', () => {
        const fns: ChangedFunctionParam[] = [
            { name: 'fn0', riskScore: 4, testGap: false },
        ];
        const blast: BlastRadiusParam[] = [makeBlast('src/foo.ts', ['a', 'b'])];
        const result = scoreFileRisk('src/foo.ts', fns, blast, []);
        expect(result.riskScore).toBe(5); // 4 + (2 * 0.5)
    });

    it('clamps score to maximum of 10', () => {
        const fns: ChangedFunctionParam[] = [
            { name: 'fn0', riskScore: 9, testGap: true },
        ];
        const blast: BlastRadiusParam[] = [
            makeBlast('src/foo.ts', ['a', 'b', 'c', 'd', 'e', 'f', 'g']),
        ];
        const result = scoreFileRisk('src/foo.ts', fns, blast, []);
        expect(result.riskScore).toBe(10); // 9 + 2 + 3 = 14 → clamped to 10
    });

    it('clamps score to minimum of 0', () => {
        // No functions — base is 0, no bonuses
        const result = scoreFileRisk('src/foo.ts', [], [], []);
        expect(result.riskScore).toBe(0);
    });

    it('builds descriptive reasons array', () => {
        const fns: ChangedFunctionParam[] = [
            { name: 'fn0', riskScore: 5, testGap: true },
        ];
        const blast: BlastRadiusParam[] = [makeBlast('src/foo.ts', ['x'])];
        const result = scoreFileRisk('src/foo.ts', fns, blast, []);
        expect(result.reasons.some((r) => r.includes('changed function'))).toBe(true);
        expect(result.reasons.some((r) => r.includes('test gap'))).toBe(true);
        expect(result.reasons.some((r) => r.includes('blast radius'))).toBe(true);
    });
});

// ── prioritizeByRisk ──────────────────────────────────

describe('prioritizeByRisk', () => {
    function makeScored(filePath: string, riskScore: number): RiskScoredFile {
        return { filePath, riskScore, reasons: [], hasTestGap: false, blastRadius: 0 };
    }

    it('sorts files by riskScore descending', () => {
        const files = [
            makeScored('low.ts', 2),
            makeScored('high.ts', 8),
            makeScored('med.ts', 5),
        ];
        const result = prioritizeByRisk(files);
        expect(result.files[0].filePath).toBe('high.ts');
        expect(result.files[1].filePath).toBe('med.ts');
        expect(result.files[2].filePath).toBe('low.ts');
    });

    it('buckets files correctly: high >= 7, medium 4-6, low <= 3', () => {
        const files = [
            makeScored('a.ts', 9),  // high
            makeScored('b.ts', 7),  // high
            makeScored('c.ts', 6),  // medium
            makeScored('d.ts', 4),  // medium
            makeScored('e.ts', 3),  // low
            makeScored('f.ts', 0),  // low
        ];
        const result = prioritizeByRisk(files);
        expect(result.highRiskFiles).toEqual(['a.ts', 'b.ts']);
        expect(result.mediumRiskFiles).toEqual(['c.ts', 'd.ts']);
        expect(result.lowRiskFiles).toEqual(['e.ts', 'f.ts']);
    });

    it('handles empty input gracefully', () => {
        const result = prioritizeByRisk([]);
        expect(result.files).toHaveLength(0);
        expect(result.highRiskFiles).toHaveLength(0);
        expect(result.mediumRiskFiles).toHaveLength(0);
        expect(result.lowRiskFiles).toHaveLength(0);
        expect(result.overallRisk).toBe(0);
        expect(result.summary).toContain('No files');
    });

    it('sets overallRisk to the highest score', () => {
        const files = [
            makeScored('x.ts', 3),
            makeScored('y.ts', 9),
            makeScored('z.ts', 6),
        ];
        const result = prioritizeByRisk(files);
        expect(result.overallRisk).toBe(9);
    });
});

// ── buildRiskAwareReviewPrompt ────────────────────────

describe('buildRiskAwareReviewPrompt', () => {
    function makeScored(filePath: string, riskScore: number, hasTestGap = false): RiskScoredFile {
        return { filePath, riskScore, reasons: [], hasTestGap, blastRadius: 0 };
    }

    it('mentions high-risk files in PRIORITY section', () => {
        const files = [makeScored('danger.ts', 9), makeScored('safe.ts', 2)];
        const prioritized = prioritizeByRisk(files);
        const prompt = buildRiskAwareReviewPrompt(prioritized, 'My Task');
        expect(prompt).toContain('PRIORITY: Review these high-risk files first');
        expect(prompt).toContain('danger.ts');
    });

    it('includes test gap warnings when files have gaps', () => {
        const files = [
            makeScored('gapped.ts', 8, true),
            makeScored('fine.ts', 2, false),
        ];
        const prioritized = prioritizeByRisk(files);
        const prompt = buildRiskAwareReviewPrompt(prioritized, 'Gap Task');
        expect(prompt).toContain('Test Gap Warning');
        expect(prompt).toContain('gapped.ts');
    });

    it('includes the task title in the prompt', () => {
        const prioritized = prioritizeByRisk([makeScored('x.ts', 5)]);
        const prompt = buildRiskAwareReviewPrompt(prioritized, 'Special Task Title');
        expect(prompt).toContain('Special Task Title');
    });
});

// ── formatRiskReport ──────────────────────────────────

describe('formatRiskReport', () => {
    it('produces a markdown table with expected columns', () => {
        const files: RiskScoredFile[] = [
            { filePath: 'src/a.ts', riskScore: 7.5, reasons: ['avg risk 7.5'], hasTestGap: true, blastRadius: 3 },
            { filePath: 'src/b.ts', riskScore: 2, reasons: [], hasTestGap: false, blastRadius: 0 },
        ];
        const prioritized = prioritizeByRisk(files);
        const report = formatRiskReport(prioritized);

        expect(report).toContain('| File |');
        expect(report).toContain('| Score |');
        expect(report).toContain('| Reasons |');
        expect(report).toContain('| Test Gap |');
        expect(report).toContain('| Blast Radius |');
        expect(report).toContain('src/a.ts');
        expect(report).toContain('YES'); // test gap
        expect(report).toContain('src/b.ts');
    });
});
