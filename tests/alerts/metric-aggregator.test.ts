import { describe, it, expect } from 'vitest';
import {
  createWindow,
  STANDARD_WINDOWS,
  aggregateMetrics,
  aggregateMultipleMetrics,
  filterPointsInWindow,
  computePercentile,
  assessProviderHealth,
  updateProviderHealth,
  detectHealthTrend,
  createDefaultHealthConfig,
  formatHealthDashboard,
  formatAggregationReport,
  type MetricDataPoint,
  type ProviderHealthSnapshot,
  type ProviderHealthHistory,
  type HealthConfig,
} from '../../src/alerts/metric-aggregator';

const NOW = '2026-04-11T12:00:00.000Z';
const NOW_MS = new Date(NOW).getTime();

function makePoint(metric: string, value: number, minutesAgo: number): MetricDataPoint {
  return {
    metric,
    value,
    timestamp: new Date(NOW_MS - minutesAgo * 60_000).toISOString(),
  };
}

function makeSnapshot(overrides: Partial<ProviderHealthSnapshot> = {}): ProviderHealthSnapshot {
  return {
    provider: 'claude',
    status: 'healthy',
    latencyMs: 200,
    errorRate: 0.01,
    uptimePercent: 99.9,
    lastChecked: NOW,
    consecutiveFailures: 0,
    lastError: null,
    ...overrides,
  };
}

const defaultConfig: HealthConfig = createDefaultHealthConfig();

// ── STANDARD_WINDOWS ───────────────────────────────────────────────

describe('STANDARD_WINDOWS', () => {
  it('has 5 entries', () => {
    expect(STANDARD_WINDOWS).toHaveLength(5);
  });

  it('includes 1min, 5min, 15min, 1hr, 24hr', () => {
    const labels = STANDARD_WINDOWS.map((w) => w.label);
    expect(labels).toEqual(['1min', '5min', '15min', '1hr', '24hr']);
  });
});

// ── createWindow ───────────────────────────────────────────────────

describe('createWindow', () => {
  it('creates a window with given duration and label', () => {
    const w = createWindow(60000, '1min');
    expect(w).toEqual({ durationMs: 60000, label: '1min' });
  });
});

// ── filterPointsInWindow ───────────────────────────────────────────

describe('filterPointsInWindow', () => {
  const points: readonly MetricDataPoint[] = [
    makePoint('cpu', 50, 2),   // 2 min ago
    makePoint('cpu', 60, 6),   // 6 min ago
    makePoint('cpu', 70, 20),  // 20 min ago
  ];

  it('filters points within 5min window', () => {
    const result = filterPointsInWindow(points, createWindow(300_000, '5min'), NOW);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(50);
  });

  it('filters points within 15min window', () => {
    const result = filterPointsInWindow(points, createWindow(900_000, '15min'), NOW);
    expect(result).toHaveLength(2);
  });

  it('returns empty for very short window with no points', () => {
    const result = filterPointsInWindow(points, createWindow(1000, '1s'), NOW);
    expect(result).toHaveLength(0);
  });
});

// ── computePercentile ──────────────────────────────────────────────

describe('computePercentile', () => {
  it.each([
    { values: [10], percentile: 50, expected: 10, desc: 'single value' },
    { values: [1, 2, 3], percentile: 50, expected: 2, desc: 'odd count p50' },
    { values: [1, 2, 3, 4], percentile: 50, expected: 2.5, desc: 'even count p50' },
    { values: [1, 2, 3, 4, 5], percentile: 99, expected: 4.96, desc: 'p99 of 5 values' },
    { values: [], percentile: 50, expected: 0, desc: 'empty array' },
    { values: [10, 20], percentile: 0, expected: 10, desc: 'p0' },
    { values: [10, 20], percentile: 100, expected: 20, desc: 'p100' },
  ])('$desc → $expected', ({ values, percentile, expected }) => {
    expect(computePercentile(values, percentile)).toBeCloseTo(expected, 2);
  });
});

// ── aggregateMetrics ───────────────────────────────────────────────

describe('aggregateMetrics', () => {
  const points: readonly MetricDataPoint[] = [
    makePoint('latency', 100, 1),
    makePoint('latency', 200, 2),
    makePoint('latency', 300, 3),
    makePoint('latency', 400, 4),
  ];
  const window5min = createWindow(300_000, '5min');

  it('computes correct min/max/avg/sum/count', () => {
    const result = aggregateMetrics(points, window5min, NOW);
    expect(result).not.toBeNull();
    expect(result!.min).toBe(100);
    expect(result!.max).toBe(400);
    expect(result!.avg).toBe(250);
    expect(result!.sum).toBe(1000);
    expect(result!.count).toBe(4);
  });

  it('computes p50 and p99', () => {
    const result = aggregateMetrics(points, window5min, NOW);
    expect(result!.p50).toBeCloseTo(250, 0);
    expect(result!.p99).toBeGreaterThan(390);
  });

  it('returns null for empty window', () => {
    const result = aggregateMetrics(points, createWindow(1000, '1s'), NOW);
    expect(result).toBeNull();
  });

  it('sets metric name and window on result', () => {
    const result = aggregateMetrics(points, window5min, NOW);
    expect(result!.metric).toBe('latency');
    expect(result!.window).toBe(window5min);
  });

  it('sets startTime and endTime', () => {
    const result = aggregateMetrics(points, window5min, NOW);
    expect(result!.endTime).toBe(NOW);
    expect(new Date(result!.startTime).getTime()).toBe(NOW_MS - 300_000);
  });
});

// ── aggregateMultipleMetrics ───────────────────────────────────────

describe('aggregateMultipleMetrics', () => {
  const points: readonly MetricDataPoint[] = [
    makePoint('cpu', 50, 1),
    makePoint('cpu', 70, 3),
    makePoint('mem', 80, 1),
    makePoint('mem', 90, 10),
  ];

  it('aggregates multiple metrics across multiple windows', () => {
    const windows = [createWindow(300_000, '5min'), createWindow(900_000, '15min')];
    const results = aggregateMultipleMetrics(points, windows, NOW);
    // cpu: 5min=2pts, 15min=2pts; mem: 5min=1pt, 15min=2pts → 4 results
    expect(results.length).toBe(4);
  });

  it('skips windows with no matching points', () => {
    const windows = [createWindow(1000, '1s')];
    const results = aggregateMultipleMetrics(points, windows, NOW);
    expect(results).toHaveLength(0);
  });
});

// ── assessProviderHealth ───────────────────────────────────────────

describe('assessProviderHealth', () => {
  it.each([
    { desc: 'healthy', overrides: {}, expected: 'healthy' },
    { desc: 'degraded by latency', overrides: { latencyMs: 6000 }, expected: 'degraded' },
    { desc: 'degraded by error rate', overrides: { errorRate: 0.15 }, expected: 'degraded' },
    { desc: 'down by failures', overrides: { consecutiveFailures: 3 }, expected: 'down' },
    { desc: 'down trumps degraded', overrides: { consecutiveFailures: 5, latencyMs: 6000 }, expected: 'down' },
  ])('returns $expected when $desc', ({ overrides, expected }) => {
    const snapshot = makeSnapshot(overrides);
    expect(assessProviderHealth(snapshot, defaultConfig)).toBe(expected);
  });
});

// ── detectHealthTrend ──────────────────────────────────────────────

describe('detectHealthTrend', () => {
  it('returns stable for single snapshot', () => {
    expect(detectHealthTrend([makeSnapshot()])).toBe('stable');
  });

  it('detects improving trend', () => {
    const snapshots = [
      makeSnapshot({ errorRate: 0.3 }),
      makeSnapshot({ errorRate: 0.25 }),
      makeSnapshot({ errorRate: 0.05 }),
      makeSnapshot({ errorRate: 0.01 }),
    ];
    expect(detectHealthTrend(snapshots)).toBe('improving');
  });

  it('detects degrading trend', () => {
    const snapshots = [
      makeSnapshot({ errorRate: 0.01 }),
      makeSnapshot({ errorRate: 0.02 }),
      makeSnapshot({ errorRate: 0.2 }),
      makeSnapshot({ errorRate: 0.3 }),
    ];
    expect(detectHealthTrend(snapshots)).toBe('degrading');
  });

  it('detects stable trend', () => {
    const snapshots = [
      makeSnapshot({ errorRate: 0.05 }),
      makeSnapshot({ errorRate: 0.05 }),
      makeSnapshot({ errorRate: 0.05 }),
      makeSnapshot({ errorRate: 0.05 }),
    ];
    expect(detectHealthTrend(snapshots)).toBe('stable');
  });
});

// ── updateProviderHealth ───────────────────────────────────────────

describe('updateProviderHealth', () => {
  it('appends snapshot and recalculates trend', () => {
    const history: ProviderHealthHistory = {
      provider: 'claude',
      snapshots: [makeSnapshot({ errorRate: 0.3 })],
      trend: 'stable',
    };
    const newSnap = makeSnapshot({ errorRate: 0.01 });
    const updated = updateProviderHealth(history, newSnap, defaultConfig);
    expect(updated.snapshots).toHaveLength(2);
    expect(updated.provider).toBe('claude');
  });

  it('assesses status on new snapshot', () => {
    const history: ProviderHealthHistory = {
      provider: 'claude',
      snapshots: [],
      trend: 'stable',
    };
    const newSnap = makeSnapshot({ consecutiveFailures: 5 });
    const updated = updateProviderHealth(history, newSnap, defaultConfig);
    expect(updated.snapshots[0].status).toBe('down');
  });

  it('prunes old snapshots beyond retention', () => {
    const oldTime = new Date(NOW_MS - 7_200_000).toISOString(); // 2hr ago
    const history: ProviderHealthHistory = {
      provider: 'claude',
      snapshots: [makeSnapshot({ lastChecked: oldTime })],
      trend: 'stable',
    };
    const newSnap = makeSnapshot();
    const updated = updateProviderHealth(history, newSnap, defaultConfig);
    // old snapshot beyond 1hr retention should be pruned
    expect(updated.snapshots).toHaveLength(1);
  });
});

// ── createDefaultHealthConfig ──────────────────────────────────────

describe('createDefaultHealthConfig', () => {
  it('includes 5 providers', () => {
    const config = createDefaultHealthConfig();
    expect(config.providers).toHaveLength(5);
    expect(config.providers).toContain('claude');
    expect(config.providers).toContain('ollama');
  });
});

// ── formatHealthDashboard ──────────────────────────────────────────

describe('formatHealthDashboard', () => {
  it('produces markdown with status emojis', () => {
    const providers: readonly ProviderHealthHistory[] = [
      {
        provider: 'claude',
        snapshots: [makeSnapshot({ status: 'healthy' })],
        trend: 'stable',
      },
      {
        provider: 'openai',
        snapshots: [makeSnapshot({ provider: 'openai', status: 'down' })],
        trend: 'degrading',
      },
    ];
    const output = formatHealthDashboard(providers);
    expect(output).toContain('\u2705');
    expect(output).toContain('\u274C');
    expect(output).toContain('claude');
    expect(output).toContain('openai');
    expect(output).toContain('|');
  });
});

// ── formatAggregationReport ────────────────────────────────────────

describe('formatAggregationReport', () => {
  it('produces markdown table of aggregated metrics', () => {
    const points: readonly MetricDataPoint[] = [
      makePoint('latency', 100, 1),
      makePoint('latency', 200, 2),
    ];
    const agg = aggregateMetrics(points, createWindow(300_000, '5min'), NOW);
    const output = formatAggregationReport([agg!]);
    expect(output).toContain('latency');
    expect(output).toContain('5min');
    expect(output).toContain('| Metric |');
  });
});
