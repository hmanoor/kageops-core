import { describe, it, expect } from 'vitest';
import {
  evaluateRule,
  evaluateGate,
  createQualityGate,
  DEFAULT_QUALITY_GATES,
  formatGateReport,
  calculateTrend,
  addDataPoint,
  buildQualityTrend,
  formatTrendReport,
  detectQualityRegression,
  type QualityGateRule,
  type QualityDataPoint,
  type QualityTrend,
} from '../../src/eval/quality-gates.js';

// Helper to build a data point
function makePoint(
  avgScore: number,
  i: number,
  agent = 'forge',
  projectId = 'proj-1'
): QualityDataPoint {
  return {
    timestamp: new Date(2026, 0, i + 1).toISOString(),
    runId: `run-${i}`,
    agent,
    projectId,
    avgScore,
    passRate: 0.8,
    sampleCount: 10,
    totalCost: 5,
  };
}

const METRICS_PASSING = {
  avgScore: 7,
  passRate: 0.8,
  errorRate: 0.05,
  totalCost: 30,
  maxDuration: 60,
};

const METRICS_FAILING_SCORE = { ...METRICS_PASSING, avgScore: 4 };
const METRICS_FAILING_PASS_RATE = { ...METRICS_PASSING, passRate: 0.5 };
const METRICS_HIGH_COST = { ...METRICS_PASSING, totalCost: 100 };

describe('evaluateRule', () => {
  it('gte passes when actual >= threshold', () => {
    const rule: QualityGateRule = { name: 'r', metric: 'avg-score', threshold: 6, operator: 'gte', blocking: true };
    expect(evaluateRule(rule, 6)).toBe(true);
    expect(evaluateRule(rule, 8)).toBe(true);
  });

  it('gte fails when actual < threshold', () => {
    const rule: QualityGateRule = { name: 'r', metric: 'avg-score', threshold: 6, operator: 'gte', blocking: true };
    expect(evaluateRule(rule, 5.9)).toBe(false);
  });

  it('lte passes when actual <= threshold', () => {
    const rule: QualityGateRule = { name: 'r', metric: 'error-rate', threshold: 0.1, operator: 'lte', blocking: true };
    expect(evaluateRule(rule, 0.1)).toBe(true);
    expect(evaluateRule(rule, 0.05)).toBe(true);
  });
});

describe('evaluateGate', () => {
  it('passes when all blocking rules pass', () => {
    const result = evaluateGate(DEFAULT_QUALITY_GATES, METRICS_PASSING);
    expect(result.passed).toBe(true);
    expect(result.blockedBy).toHaveLength(0);
  });

  it('fails when any blocking rule fails (low avg-score)', () => {
    const result = evaluateGate(DEFAULT_QUALITY_GATES, METRICS_FAILING_SCORE);
    expect(result.passed).toBe(false);
  });

  it('fails when any blocking rule fails (low pass-rate)', () => {
    const result = evaluateGate(DEFAULT_QUALITY_GATES, METRICS_FAILING_PASS_RATE);
    expect(result.passed).toBe(false);
  });

  it('allows non-blocking rule failures', () => {
    const result = evaluateGate(DEFAULT_QUALITY_GATES, METRICS_HIGH_COST);
    // max-cost is non-blocking, so gate should still pass
    expect(result.passed).toBe(true);
    const costRule = result.rules.find((r) => r.rule.name === 'max-cost');
    expect(costRule?.passed).toBe(false);
  });

  it('lists blockedBy names for failing blocking rules', () => {
    const result = evaluateGate(DEFAULT_QUALITY_GATES, METRICS_FAILING_SCORE);
    expect(result.blockedBy).toContain('avg-score');
  });
});

describe('DEFAULT_QUALITY_GATES', () => {
  it('has 4 rules', () => {
    expect(DEFAULT_QUALITY_GATES).toHaveLength(4);
  });
});

describe('formatGateReport', () => {
  it('includes checkmarks for passing rules', () => {
    const result = evaluateGate(DEFAULT_QUALITY_GATES, METRICS_PASSING);
    const report = formatGateReport(result);
    expect(report).toContain('✅');
  });

  it('includes cross for failing rules', () => {
    const result = evaluateGate(DEFAULT_QUALITY_GATES, METRICS_FAILING_SCORE);
    const report = formatGateReport(result);
    expect(report).toContain('❌');
  });
});

describe('calculateTrend', () => {
  it('returns improving for positive slope', () => {
    const points = [1, 2, 3, 4, 5].map((s, i) => makePoint(s * 2, i));
    const { trend, slope } = calculateTrend(points);
    expect(trend).toBe('improving');
    expect(slope).toBeGreaterThan(0.1);
  });

  it('returns declining for negative slope', () => {
    const points = [10, 8, 6, 4, 2].map((s, i) => makePoint(s, i));
    const { trend, slope } = calculateTrend(points);
    expect(trend).toBe('declining');
    expect(slope).toBeLessThan(-0.1);
  });

  it('returns stable for flat data', () => {
    const points = [5, 5, 5, 5, 5].map((s, i) => makePoint(s, i));
    const { trend } = calculateTrend(points);
    expect(trend).toBe('stable');
  });

  it('returns insufficient-data for < 3 points', () => {
    expect(calculateTrend([]).trend).toBe('insufficient-data');
    expect(calculateTrend([makePoint(5, 0)]).trend).toBe('insufficient-data');
    expect(calculateTrend([makePoint(5, 0), makePoint(6, 1)]).trend).toBe('insufficient-data');
  });
});

describe('addDataPoint', () => {
  it('appends immutably (original trend unchanged)', () => {
    const original: QualityTrend = buildQualityTrend('forge', 'proj-1', [
      makePoint(5, 0), makePoint(6, 1), makePoint(7, 2),
    ]);
    const newPoint = makePoint(8, 3);
    const updated = addDataPoint(original, newPoint);

    expect(original.dataPoints).toHaveLength(3);
    expect(updated.dataPoints).toHaveLength(4);
    expect(updated.dataPoints[3]).toBe(newPoint);
  });

  it('recalculates trend after adding a point', () => {
    const original: QualityTrend = buildQualityTrend('forge', 'proj-1', [
      makePoint(5, 0), makePoint(5, 1), makePoint(5, 2),
    ]);
    expect(original.trend).toBe('stable');

    const updated = addDataPoint(addDataPoint(original, makePoint(7, 3)), makePoint(9, 4));
    expect(updated.trend).toBe('improving');
  });
});

describe('buildQualityTrend', () => {
  it('creates a trend with correct agent and projectId', () => {
    const points = [makePoint(7, 0), makePoint(8, 1), makePoint(9, 2)];
    const trend = buildQualityTrend('aegis', 'proj-42', points);
    expect(trend.agent).toBe('aegis');
    expect(trend.projectId).toBe('proj-42');
    expect(trend.trend).toBe('improving');
  });
});

describe('formatTrendReport', () => {
  it('includes trend arrows in the report', () => {
    const trends: QualityTrend[] = [
      buildQualityTrend('forge', 'proj-1', [makePoint(5, 0), makePoint(6, 1), makePoint(7, 2)]),
      buildQualityTrend('scout', 'proj-2', [makePoint(9, 0), makePoint(7, 1), makePoint(5, 2)]),
      buildQualityTrend('vigil', 'proj-3', [makePoint(5, 0), makePoint(5, 1), makePoint(5, 2)]),
    ];
    const report = formatTrendReport(trends);
    expect(report).toContain('📈');
    expect(report).toContain('📉');
    expect(report).toContain('➡️');
  });
});

describe('detectQualityRegression', () => {
  it('detects decline in lookback window', () => {
    const points = [
      makePoint(8, 0), makePoint(8, 1), makePoint(8, 2),
      makePoint(6, 3), makePoint(4, 4), makePoint(2, 5),
    ];
    const trend = buildQualityTrend('forge', 'proj-1', points);
    expect(detectQualityRegression(trend, 3)).toBe(true);
  });

  it('returns false when lookback window is improving', () => {
    const points = [
      makePoint(2, 0), makePoint(2, 1), makePoint(2, 2),
      makePoint(5, 3), makePoint(7, 4), makePoint(9, 5),
    ];
    const trend = buildQualityTrend('forge', 'proj-1', points);
    expect(detectQualityRegression(trend, 3)).toBe(false);
  });

  it('returns false when lookback has < 3 points', () => {
    const points = [makePoint(9, 0), makePoint(5, 1)];
    const trend = buildQualityTrend('forge', 'proj-1', points);
    expect(detectQualityRegression(trend, 2)).toBe(false);
  });
});
