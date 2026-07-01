// B-153: Aggregation Windows & B-154: Provider Health Monitoring

// ── Types ──────────────────────────────────────────────────────────

export interface MetricDataPoint {
  readonly metric: string;
  readonly value: number;
  readonly timestamp: string;
}

export interface AggregationWindow {
  readonly durationMs: number;
  readonly label: string;
}

export interface AggregatedMetric {
  readonly metric: string;
  readonly window: AggregationWindow;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly sum: number;
  readonly count: number;
  readonly p50: number;
  readonly p99: number;
  readonly startTime: string;
  readonly endTime: string;
}

export type ProviderStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface ProviderHealthSnapshot {
  readonly provider: string;
  readonly status: ProviderStatus;
  readonly latencyMs: number;
  readonly errorRate: number;
  readonly uptimePercent: number;
  readonly lastChecked: string;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
}

export interface ProviderHealthHistory {
  readonly provider: string;
  readonly snapshots: readonly ProviderHealthSnapshot[];
  readonly trend: 'improving' | 'stable' | 'degrading';
}

export interface HealthConfig {
  readonly providers: readonly string[];
  readonly checkIntervalMs: number;
  readonly degradedThresholdMs: number;
  readonly downAfterFailures: number;
  readonly historyRetentionMs: number;
}

// ── Aggregation Windows ────────────────────────────────────────────

export function createWindow(durationMs: number, label: string): AggregationWindow {
  return { durationMs, label };
}

export const STANDARD_WINDOWS: readonly AggregationWindow[] = [
  createWindow(60_000, '1min'),
  createWindow(300_000, '5min'),
  createWindow(900_000, '15min'),
  createWindow(3_600_000, '1hr'),
  createWindow(86_400_000, '24hr'),
] as const;

// ── Core Aggregation ───────────────────────────────────────────────

export function filterPointsInWindow(
  points: readonly MetricDataPoint[],
  window: AggregationWindow,
  now: string,
): readonly MetricDataPoint[] {
  const nowMs = new Date(now).getTime();
  const startMs = nowMs - window.durationMs;
  return points.filter((p) => {
    const ts = new Date(p.timestamp).getTime();
    return ts >= startMs && ts <= nowMs;
  });
}

export function computePercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const fraction = index - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

export function aggregateMetrics(
  points: readonly MetricDataPoint[],
  window: AggregationWindow,
  now: string,
): AggregatedMetric | null {
  const filtered = filterPointsInWindow(points, window, now);
  if (filtered.length === 0) return null;

  const values = filtered.map((p) => p.value);
  const sum = values.reduce((a, b) => a + b, 0);
  const nowMs = new Date(now).getTime();

  return {
    metric: filtered[0].metric,
    window,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: sum / values.length,
    sum,
    count: values.length,
    p50: computePercentile(values, 50),
    p99: computePercentile(values, 99),
    startTime: new Date(nowMs - window.durationMs).toISOString(),
    endTime: now,
  };
}

export function aggregateMultipleMetrics(
  points: readonly MetricDataPoint[],
  windows: readonly AggregationWindow[],
  now: string,
): readonly AggregatedMetric[] {
  const metricNames = [...new Set(points.map((p) => p.metric))];
  const results: AggregatedMetric[] = [];

  for (const name of metricNames) {
    const metricPoints = points.filter((p) => p.metric === name);
    for (const window of windows) {
      const agg = aggregateMetrics(metricPoints, window, now);
      if (agg !== null) {
        results.push(agg);
      }
    }
  }

  return results;
}

// ── Provider Health ────────────────────────────────────────────────

export function assessProviderHealth(
  snapshot: ProviderHealthSnapshot,
  config: HealthConfig,
): ProviderStatus {
  if (snapshot.consecutiveFailures >= config.downAfterFailures) return 'down';
  if (snapshot.latencyMs > config.degradedThresholdMs) return 'degraded';
  if (snapshot.errorRate > 0.1) return 'degraded';
  return 'healthy';
}

export function detectHealthTrend(
  snapshots: readonly ProviderHealthSnapshot[],
): 'improving' | 'stable' | 'degrading' {
  if (snapshots.length < 2) return 'stable';

  const mid = Math.floor(snapshots.length / 2);
  const older = snapshots.slice(0, mid);
  const recent = snapshots.slice(mid);

  const avgError = (s: readonly ProviderHealthSnapshot[]): number =>
    s.reduce((sum, snap) => sum + snap.errorRate, 0) / s.length;

  const olderAvg = avgError(older);
  const recentAvg = avgError(recent);
  const diff = recentAvg - olderAvg;

  if (diff < -0.05) return 'improving';
  if (diff > 0.05) return 'degrading';
  return 'stable';
}

export function updateProviderHealth(
  history: ProviderHealthHistory,
  newSnapshot: ProviderHealthSnapshot,
  config: HealthConfig,
): ProviderHealthHistory {
  const status = assessProviderHealth(newSnapshot, config);
  const updatedSnapshot: ProviderHealthSnapshot = {
    ...newSnapshot,
    status,
  };

  const nowMs = new Date(newSnapshot.lastChecked).getTime();
  const cutoff = nowMs - config.historyRetentionMs;
  const retained = history.snapshots.filter(
    (s) => new Date(s.lastChecked).getTime() >= cutoff,
  );

  const allSnapshots = [...retained, updatedSnapshot];
  const trend = detectHealthTrend(allSnapshots);

  return {
    provider: history.provider,
    snapshots: allSnapshots,
    trend,
  };
}

export function createDefaultHealthConfig(): HealthConfig {
  return {
    providers: ['claude', 'openrouter', 'ollama', 'openai', 'gemini'],
    checkIntervalMs: 30_000,
    degradedThresholdMs: 5_000,
    downAfterFailures: 3,
    historyRetentionMs: 3_600_000,
  };
}

// ── Formatting ─────────────────────────────────────────────────────

const STATUS_EMOJI: Record<ProviderStatus, string> = {
  healthy: '\u2705',
  degraded: '\u26A0\uFE0F',
  down: '\u274C',
  unknown: '\u2753',
};

export function formatHealthDashboard(
  providers: readonly ProviderHealthHistory[],
): string {
  const lines: string[] = [
    '| Provider | Status | Latency | Error Rate | Uptime | Trend |',
    '|----------|--------|---------|------------|--------|-------|',
  ];

  for (const h of providers) {
    const latest = h.snapshots.length > 0
      ? h.snapshots[h.snapshots.length - 1]
      : null;
    const status = latest?.status ?? 'unknown';
    const emoji = STATUS_EMOJI[status];
    const latency = latest ? `${latest.latencyMs}ms` : 'N/A';
    const errorRate = latest ? `${(latest.errorRate * 100).toFixed(1)}%` : 'N/A';
    const uptime = latest ? `${latest.uptimePercent.toFixed(1)}%` : 'N/A';
    lines.push(
      `| ${h.provider} | ${emoji} ${status} | ${latency} | ${errorRate} | ${uptime} | ${h.trend} |`,
    );
  }

  return lines.join('\n');
}

export function formatAggregationReport(
  metrics: readonly AggregatedMetric[],
): string {
  const lines: string[] = [
    '| Metric | Window | Min | Max | Avg | P50 | P99 | Count |',
    '|--------|--------|-----|-----|-----|-----|-----|-------|',
  ];

  for (const m of metrics) {
    lines.push(
      `| ${m.metric} | ${m.window.label} | ${m.min.toFixed(2)} | ${m.max.toFixed(2)} | ${m.avg.toFixed(2)} | ${m.p50.toFixed(2)} | ${m.p99.toFixed(2)} | ${m.count} |`,
    );
  }

  return lines.join('\n');
}
