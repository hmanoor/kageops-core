import { describe, it, expect } from 'vitest';
import {
  computePercentile,
  computePercentiles,
  buildAgentProfile,
  buildAllAgentProfiles,
  buildLatencyTrend,
  identifySlowestOperations,
  formatLatencyReport,
  isLatencyRegression,
  type LatencySample,
} from '../../src/shared/latency-stats';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSample(
  overrides: Partial<LatencySample> & { durationMs: number },
): LatencySample {
  return {
    agent: 'Forge',
    operationName: 'build',
    timestamp: 1000,
    runType: 'standard',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computePercentile
// ---------------------------------------------------------------------------

describe('computePercentile', () => {
  it('returns median for P50 on an odd-length array', () => {
    const sorted = [1, 2, 3, 4, 5];
    expect(computePercentile(sorted, 50)).toBe(3);
  });

  it('handles a single element', () => {
    expect(computePercentile([42], 50)).toBe(42);
    expect(computePercentile([42], 99)).toBe(42);
  });

  it('interpolates between values', () => {
    // [10, 20]: index = 0.5*1 = 0.5 → 10*0.5 + 20*0.5 = 15
    const result = computePercentile([10, 20], 50);
    expect(result).toBeCloseTo(15, 5);
  });

  it('returns 0 for an empty array', () => {
    expect(computePercentile([], 50)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computePercentiles
// ---------------------------------------------------------------------------

describe('computePercentiles', () => {
  it('returns all stats correctly for a known array', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = computePercentiles(values);

    expect(result.count).toBe(10);
    expect(result.min).toBe(1);
    expect(result.max).toBe(10);
    expect(result.mean).toBeCloseTo(5.5, 5);
    expect(result.p50).toBeCloseTo(5.5, 1);
  });

  it('calculates stdDev correctly', () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] — classic example, population stdDev = 2
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const result = computePercentiles(values);
    expect(result.stdDev).toBeCloseTo(2, 5);
  });

  it('handles an empty array and returns zeros', () => {
    const result = computePercentiles([]);
    expect(result.count).toBe(0);
    expect(result.p50).toBe(0);
    expect(result.p99).toBe(0);
    expect(result.mean).toBe(0);
    expect(result.stdDev).toBe(0);
  });

  it('returns p99 >= p95 >= p90 >= p75 >= p50 for any array', () => {
    const values = [100, 200, 50, 400, 10, 300, 150, 250, 350, 80];
    const r = computePercentiles(values);
    expect(r.p99).toBeGreaterThanOrEqual(r.p95);
    expect(r.p95).toBeGreaterThanOrEqual(r.p90);
    expect(r.p90).toBeGreaterThanOrEqual(r.p75);
    expect(r.p75).toBeGreaterThanOrEqual(r.p50);
  });
});

// ---------------------------------------------------------------------------
// buildAgentProfile
// ---------------------------------------------------------------------------

describe('buildAgentProfile', () => {
  const samples: readonly LatencySample[] = [
    makeSample({ agent: 'Forge', durationMs: 100, runType: 'standard', operationName: 'build' }),
    makeSample({ agent: 'Forge', durationMs: 200, runType: 'standard', operationName: 'build' }),
    makeSample({ agent: 'Forge', durationMs: 300, runType: 'fast', operationName: 'lint' }),
    makeSample({ agent: 'Scout', durationMs: 50, runType: 'standard', operationName: 'scan' }),
  ];

  it('groups by runType correctly', () => {
    const profile = buildAgentProfile('Forge', samples);
    expect(Object.keys(profile.byRunType)).toContain('standard');
    expect(Object.keys(profile.byRunType)).toContain('fast');
    expect(profile.byRunType['standard'].count).toBe(2);
    expect(profile.byRunType['fast'].count).toBe(1);
  });

  it('groups by operation correctly', () => {
    const profile = buildAgentProfile('Forge', samples);
    expect(Object.keys(profile.byOperation)).toContain('build');
    expect(Object.keys(profile.byOperation)).toContain('lint');
    expect(profile.byOperation['build'].count).toBe(2);
    expect(profile.byOperation['lint'].count).toBe(1);
  });

  it('excludes other agents from the profile', () => {
    const profile = buildAgentProfile('Forge', samples);
    expect(profile.sampleCount).toBe(3);
    expect(profile.overall.count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// buildAllAgentProfiles
// ---------------------------------------------------------------------------

describe('buildAllAgentProfiles', () => {
  it('creates one profile per distinct agent', () => {
    const samples: readonly LatencySample[] = [
      makeSample({ agent: 'Forge', durationMs: 100 }),
      makeSample({ agent: 'Scout', durationMs: 200 }),
      makeSample({ agent: 'Vigil', durationMs: 150 }),
      makeSample({ agent: 'Forge', durationMs: 120 }),
    ];

    const profiles = buildAllAgentProfiles(samples);
    const agents = profiles.map((p) => p.agent).sort();
    expect(agents).toEqual(['Forge', 'Scout', 'Vigil']);
  });
});

// ---------------------------------------------------------------------------
// buildLatencyTrend
// ---------------------------------------------------------------------------

describe('buildLatencyTrend', () => {
  const base = 1_000_000;
  const windowMs = 60_000; // 1 minute

  const samples: readonly LatencySample[] = [
    makeSample({ agent: 'Forge', durationMs: 100, timestamp: base }),
    makeSample({ agent: 'Forge', durationMs: 200, timestamp: base + 10_000 }),
    makeSample({ agent: 'Forge', durationMs: 300, timestamp: base + 70_000 }),
    makeSample({ agent: 'Forge', durationMs: 400, timestamp: base + 130_000 }),
  ];

  it('creates the correct number of buckets', () => {
    const trend = buildLatencyTrend('Forge', samples, windowMs);
    // Spans ~130 000 ms with 60 000 ms windows → 3 buckets
    expect(trend.buckets.length).toBe(3);
  });

  it('computes P50 and P99 per bucket', () => {
    const trend = buildLatencyTrend('Forge', samples, windowMs);
    // First bucket: [100, 200] → p50 = 150
    expect(trend.buckets[0].p50).toBeCloseTo(150, 1);
    expect(trend.buckets[0].count).toBe(2);
    // Second bucket: [300]
    expect(trend.buckets[1].p50).toBe(300);
    expect(trend.buckets[1].p99).toBe(300);
  });

  it('returns empty buckets for an agent with no samples', () => {
    const trend = buildLatencyTrend('Ghost', samples, windowMs);
    expect(trend.buckets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// identifySlowestOperations
// ---------------------------------------------------------------------------

describe('identifySlowestOperations', () => {
  const samples: readonly LatencySample[] = [
    makeSample({ agent: 'Forge', durationMs: 100, operationName: 'build' }),
    makeSample({ agent: 'Forge', durationMs: 500, operationName: 'deploy' }),
    makeSample({ agent: 'Scout', durationMs: 300, operationName: 'scan' }),
    makeSample({ agent: 'Vigil', durationMs: 800, operationName: 'audit' }),
  ];

  const profiles = buildAllAgentProfiles(samples);

  it('returns the top N slowest operations', () => {
    const top2 = identifySlowestOperations(profiles, 2);
    expect(top2).toHaveLength(2);
  });

  it('sorts by P99 descending', () => {
    const top3 = identifySlowestOperations(profiles, 3);
    for (let i = 1; i < top3.length; i++) {
      expect(top3[i - 1].p99).toBeGreaterThanOrEqual(top3[i].p99);
    }
    expect(top3[0].operation).toBe('audit');
  });
});

// ---------------------------------------------------------------------------
// formatLatencyReport
// ---------------------------------------------------------------------------

describe('formatLatencyReport', () => {
  it('includes all agents as rows', () => {
    const samples: readonly LatencySample[] = [
      makeSample({ agent: 'Forge', durationMs: 100 }),
      makeSample({ agent: 'Scout', durationMs: 200 }),
    ];
    const profiles = buildAllAgentProfiles(samples);
    const report = formatLatencyReport(profiles);

    expect(report).toContain('Forge');
    expect(report).toContain('Scout');
    expect(report).toContain('P50');
    expect(report).toContain('P99');
  });
});

// ---------------------------------------------------------------------------
// isLatencyRegression
// ---------------------------------------------------------------------------

describe('isLatencyRegression', () => {
  const baseline = computePercentiles([100, 100, 100, 100, 100]);

  it('detects a regression above threshold', () => {
    // P99 of current ~200 vs baseline ~100 → 100% increase, threshold 20%
    const current = computePercentiles([200, 200, 200, 200, 200]);
    expect(isLatencyRegression(current, baseline, 20)).toBe(true);
  });

  it('returns false when increase is below threshold', () => {
    // P99 of current ~105 vs baseline ~100 → 5% increase, threshold 20%
    const current = computePercentiles([105, 105, 105, 105, 105]);
    expect(isLatencyRegression(current, baseline, 20)).toBe(false);
  });

  it('returns false when baseline P99 is zero to avoid divide-by-zero', () => {
    const zeroBbaseline = computePercentiles([]);
    const current = computePercentiles([100]);
    expect(isLatencyRegression(current, zeroBbaseline, 10)).toBe(false);
  });
});
