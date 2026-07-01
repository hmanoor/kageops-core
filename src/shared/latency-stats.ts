/**
 * Latency percentile tracking and computation per agent.
 * Pure data model + computation — no DB, no IO.
 */

export interface LatencySample {
  readonly agent: string;
  readonly operationName: string;
  readonly durationMs: number;
  readonly timestamp: number;
  readonly runType: string;
}

export interface PercentileResult {
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly count: number;
  readonly stdDev: number;
}

export interface AgentLatencyProfile {
  readonly agent: string;
  readonly overall: PercentileResult;
  readonly byRunType: Readonly<Record<string, PercentileResult>>;
  readonly byOperation: Readonly<Record<string, PercentileResult>>;
  readonly sampleCount: number;
}

export interface LatencyBucket {
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly p50: number;
  readonly p99: number;
  readonly count: number;
}

export interface LatencyTrend {
  readonly agent: string;
  readonly buckets: readonly LatencyBucket[];
}

const EMPTY_PERCENTILE_RESULT: PercentileResult = {
  p50: 0,
  p75: 0,
  p90: 0,
  p95: 0,
  p99: 0,
  min: 0,
  max: 0,
  mean: 0,
  count: 0,
  stdDev: 0,
};

/**
 * Given a sorted array and a percentile (0–100), returns the value at that
 * percentile using linear interpolation.
 */
export function computePercentile(
  sortedValues: readonly number[],
  percentile: number,
): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];

  const index = (percentile / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sortedValues[lower];

  const fraction = index - lower;
  return sortedValues[lower] * (1 - fraction) + sortedValues[upper] * fraction;
}

/**
 * Computes all percentiles, min, max, mean, count, and stdDev from an
 * unsorted array. Returns zeros for an empty array.
 */
export function computePercentiles(values: readonly number[]): PercentileResult {
  if (values.length === 0) return EMPTY_PERCENTILE_RESULT;

  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / count;

  const variance =
    sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / count;
  const stdDev = Math.sqrt(variance);

  return {
    p50: computePercentile(sorted, 50),
    p75: computePercentile(sorted, 75),
    p90: computePercentile(sorted, 90),
    p95: computePercentile(sorted, 95),
    p99: computePercentile(sorted, 99),
    min: sorted[0],
    max: sorted[count - 1],
    mean,
    count,
    stdDev,
  };
}

/** Groups an array of items by a key extractor. */
function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const k = key(item);
    return { ...acc, [k]: [...(acc[k] ?? []), item] };
  }, {});
}

/**
 * Computes overall + breakdown by runType and operation for a single agent.
 */
export function buildAgentProfile(
  agent: string,
  samples: readonly LatencySample[],
): AgentLatencyProfile {
  const agentSamples = samples.filter((s) => s.agent === agent);
  const durations = agentSamples.map((s) => s.durationMs);

  const byRunTypeGroups = groupBy(agentSamples, (s) => s.runType);
  const byRunType: Record<string, PercentileResult> = Object.fromEntries(
    Object.entries(byRunTypeGroups).map(([rt, ss]) => [
      rt,
      computePercentiles(ss.map((s) => s.durationMs)),
    ]),
  );

  const byOperationGroups = groupBy(agentSamples, (s) => s.operationName);
  const byOperation: Record<string, PercentileResult> = Object.fromEntries(
    Object.entries(byOperationGroups).map(([op, ss]) => [
      op,
      computePercentiles(ss.map((s) => s.durationMs)),
    ]),
  );

  return {
    agent,
    overall: computePercentiles(durations),
    byRunType,
    byOperation,
    sampleCount: agentSamples.length,
  };
}

/**
 * Groups samples by agent, builds a profile for each.
 */
export function buildAllAgentProfiles(
  samples: readonly LatencySample[],
): readonly AgentLatencyProfile[] {
  const agentGroups = groupBy(samples, (s) => s.agent);
  return Object.keys(agentGroups).map((agent) =>
    buildAgentProfile(agent, samples),
  );
}

/**
 * Buckets samples into fixed-width time windows and computes P50/P99 per bucket.
 */
export function buildLatencyTrend(
  agent: string,
  samples: readonly LatencySample[],
  windowMs: number,
): LatencyTrend {
  const agentSamples = samples.filter((s) => s.agent === agent);

  if (agentSamples.length === 0) {
    return { agent, buckets: [] };
  }

  const minTs = Math.min(...agentSamples.map((s) => s.timestamp));
  const maxTs = Math.max(...agentSamples.map((s) => s.timestamp));

  const buckets: LatencyBucket[] = [];
  for (let start = minTs; start <= maxTs; start += windowMs) {
    const end = start + windowMs;
    const inBucket = agentSamples.filter(
      (s) => s.timestamp >= start && s.timestamp < end,
    );
    const durations = inBucket.map((s) => s.durationMs);
    const sorted = [...durations].sort((a, b) => a - b);
    buckets.push({
      windowStart: start,
      windowEnd: end,
      p50: computePercentile(sorted, 50),
      p99: computePercentile(sorted, 99),
      count: inBucket.length,
    });
  }

  return { agent, buckets };
}

/**
 * Returns the N slowest operations across all agents by P99.
 */
export function identifySlowestOperations(
  profiles: readonly AgentLatencyProfile[],
  topN: number,
): readonly { agent: string; operation: string; p99: number }[] {
  const entries: { agent: string; operation: string; p99: number }[] = [];

  for (const profile of profiles) {
    for (const [operation, result] of Object.entries(profile.byOperation)) {
      entries.push({ agent: profile.agent, operation, p99: result.p99 });
    }
  }

  return entries
    .sort((a, b) => b.p99 - a.p99)
    .slice(0, topN);
}

/** Rounds a number to two decimal places for display. */
function fmt(n: number): string {
  return n.toFixed(2);
}

/**
 * Markdown table: agent | P50 | P75 | P90 | P99 | samples.
 */
export function formatLatencyReport(
  profiles: readonly AgentLatencyProfile[],
): string {
  const header =
    '| Agent | P50 (ms) | P75 (ms) | P90 (ms) | P99 (ms) | Samples |';
  const separator = '|-------|----------|----------|----------|----------|---------|';

  const rows = profiles.map((p) => {
    const o = p.overall;
    return `| ${p.agent} | ${fmt(o.p50)} | ${fmt(o.p75)} | ${fmt(o.p90)} | ${fmt(o.p99)} | ${p.sampleCount} |`;
  });

  return [header, separator, ...rows].join('\n');
}

/**
 * Markdown with bucket-by-bucket P50/P99 values.
 */
export function formatTrendReport(trend: LatencyTrend): string {
  const lines: string[] = [
    `## Latency Trend: ${trend.agent}`,
    '',
    '| Window Start | Window End | P50 (ms) | P99 (ms) | Count |',
    '|-------------|------------|----------|----------|-------|',
  ];

  for (const bucket of trend.buckets) {
    lines.push(
      `| ${bucket.windowStart} | ${bucket.windowEnd} | ${fmt(bucket.p50)} | ${fmt(bucket.p99)} | ${bucket.count} |`,
    );
  }

  return lines.join('\n');
}

/**
 * Returns true if current P99 is more than thresholdPercent higher than
 * baseline P99.
 */
export function isLatencyRegression(
  current: PercentileResult,
  baseline: PercentileResult,
  thresholdPercent: number,
): boolean {
  if (baseline.p99 === 0) return false;
  const percentIncrease = ((current.p99 - baseline.p99) / baseline.p99) * 100;
  return percentIncrease > thresholdPercent;
}
