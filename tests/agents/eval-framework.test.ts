import { describe, it, expect } from 'vitest';
import {
  ALL_ARMS,
  createEvalCase,
  createRunResult,
  compareArms,
  runEvalSuite,
  formatEvalReport,
  type EvalArm,
  type EvalRunResult,
} from '../../src/agents/eval-framework';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  caseId: string,
  arm: EvalArm,
  qualityScore: number,
  tokenCount: number = 100,
): EvalRunResult {
  return createRunResult(caseId, arm, `output-${arm}`, tokenCount, 500, qualityScore, [
    true,
    true,
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createEvalCase', () => {
  it('creates case with all fields', () => {
    const c = createEvalCase('c1', 'Test case', 'Do the thing', ['outputs X', 'is concise']);
    expect(c.id).toBe('c1');
    expect(c.description).toBe('Test case');
    expect(c.input).toBe('Do the thing');
    expect(c.expectedBehaviors).toEqual(['outputs X', 'is concise']);
  });
});

describe('createRunResult', () => {
  it('creates result with all fields', () => {
    const r = createRunResult('c1', 'baseline', 'hello', 200, 1500, 7, [true, false]);
    expect(r.caseId).toBe('c1');
    expect(r.arm).toBe('baseline');
    expect(r.output).toBe('hello');
    expect(r.tokenCount).toBe(200);
    expect(r.durationMs).toBe(1500);
    expect(r.qualityScore).toBe(7);
    expect(r.behaviorsPassed).toEqual([true, false]);
  });
});

describe('compareArms', () => {
  it('calculates token savings correctly', () => {
    const baseline = makeResult('c1', 'baseline', 7, 200);
    const terse = makeResult('c1', 'terse-control', 7, 140); // 30% savings
    const enhanced = makeResult('c1', 'enhanced', 9, 140);
    const cmp = compareArms(baseline, terse, enhanced);
    expect(cmp.tokenSavingsVsBaseline).toBeCloseTo(30, 5);
  });

  it('returns enhanced-wins when quality delta vs terse > 1', () => {
    const baseline = makeResult('c1', 'baseline', 6, 200);
    const terse = makeResult('c1', 'terse-control', 6, 150); // 25% savings
    const enhanced = makeResult('c1', 'enhanced', 8, 150); // +2 vs terse
    const cmp = compareArms(baseline, terse, enhanced);
    expect(cmp.verdict).toBe('enhanced-wins');
    expect(cmp.qualityDeltaVsTerse).toBe(2);
  });

  it('returns terse-sufficient when terse saves >20% tokens with equal quality', () => {
    const baseline = makeResult('c1', 'baseline', 7, 200);
    const terse = makeResult('c1', 'terse-control', 7, 150); // 25% savings
    const enhanced = makeResult('c1', 'enhanced', 8, 150); // +1 vs terse — not > 1
    const cmp = compareArms(baseline, terse, enhanced);
    expect(cmp.verdict).toBe('terse-sufficient');
  });

  it('returns baseline-wins when both enhanced and terse score lower than baseline', () => {
    const baseline = makeResult('c1', 'baseline', 9, 200);
    const terse = makeResult('c1', 'terse-control', 6, 150);
    const enhanced = makeResult('c1', 'enhanced', 7, 150); // still below baseline
    const cmp = compareArms(baseline, terse, enhanced);
    expect(cmp.verdict).toBe('baseline-wins');
    expect(cmp.qualityDeltaVsBaseline).toBeLessThan(0);
  });

  it('returns inconclusive for marginal differences', () => {
    const baseline = makeResult('c1', 'baseline', 7, 200);
    const terse = makeResult('c1', 'terse-control', 7, 190); // only ~5% savings
    const enhanced = makeResult('c1', 'enhanced', 8, 190); // +1 vs terse — not > 1
    const cmp = compareArms(baseline, terse, enhanced);
    expect(cmp.verdict).toBe('inconclusive');
  });
});

describe('runEvalSuite', () => {
  function buildComparisons() {
    const c1 = compareArms(
      makeResult('c1', 'baseline', 6, 200),
      makeResult('c1', 'terse-control', 6, 150),
      makeResult('c1', 'enhanced', 9, 150),
    );
    const c2 = compareArms(
      makeResult('c2', 'baseline', 8, 200),
      makeResult('c2', 'terse-control', 8, 150),
      makeResult('c2', 'enhanced', 8, 150),
    );
    return [c1, c2];
  }

  it('calculates averages correctly', () => {
    const [c1, c2] = buildComparisons();
    const suite = runEvalSuite([c1, c2]);
    // token savings: both 25% → avg 25
    expect(suite.avgTokenSavings).toBeCloseTo(25, 5);
    // quality delta vs baseline: c1 = +3, c2 = 0 → avg 1.5
    expect(suite.avgQualityDelta).toBeCloseTo(1.5, 5);
  });

  it('calculates win rate correctly', () => {
    const [c1, c2] = buildComparisons();
    const suite = runEvalSuite([c1, c2]);
    // c1: enhanced-wins (delta vs terse = 3 > 1)
    // c2: terse-sufficient (delta vs terse = 0, savings = 25%)
    expect(suite.enhancedWinRate).toBeCloseTo(0.5, 5);
  });

  it('returns zero stats for empty comparisons', () => {
    const suite = runEvalSuite([]);
    expect(suite.avgTokenSavings).toBe(0);
    expect(suite.avgQualityDelta).toBe(0);
    expect(suite.enhancedWinRate).toBe(0);
  });
});

describe('formatEvalReport', () => {
  function buildSuite() {
    const cmp = compareArms(
      makeResult('case-1', 'baseline', 6, 200),
      makeResult('case-1', 'terse-control', 6, 150),
      makeResult('case-1', 'enhanced', 9, 150),
    );
    return runEvalSuite([cmp]);
  }

  it('includes summary table', () => {
    const report = formatEvalReport(buildSuite());
    expect(report).toContain('## Summary');
    expect(report).toContain('| Case |');
    expect(report).toContain('case-1');
    expect(report).toContain('Baseline Score');
  });

  it('includes overall statistics', () => {
    const report = formatEvalReport(buildSuite());
    expect(report).toContain('## Overall Statistics');
    expect(report).toContain('Cases evaluated');
    expect(report).toContain('Enhanced win rate');
    expect(report).toContain('Avg token savings');
    expect(report).toContain('Avg quality delta');
  });
});

describe('ALL_ARMS', () => {
  it('has all 3 arms', () => {
    expect(ALL_ARMS).toHaveLength(3);
    expect(ALL_ARMS).toContain('baseline');
    expect(ALL_ARMS).toContain('terse-control');
    expect(ALL_ARMS).toContain('enhanced');
  });
});
