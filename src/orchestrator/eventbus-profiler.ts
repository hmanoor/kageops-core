/**
 * KageOps EventBus Performance Profiler (TD-008)
 *
 * Pure functions for collecting, aggregating, and reporting
 * latency / throughput metrics on EventBus channels.
 */

// ── Types ────────────────────────────────────────────

export interface EventBusMetric {
  readonly channel: string;
  readonly eventCount: number;
  readonly avgLatencyMs: number;
  readonly maxLatencyMs: number;
  readonly errorCount: number;
  readonly lastMeasured: string;
}

export interface ProfileSession {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly metrics: readonly EventBusMetric[];
  readonly totalEvents: number;
  readonly totalErrors: number;
}

export interface LatencyBucket {
  readonly rangeLabel: string;
  readonly minMs: number;
  readonly maxMs: number;
  readonly count: number;
}

export type ChannelStatus = 'healthy' | 'slow' | 'congested' | 'error';

export interface ChannelHealth {
  readonly channel: string;
  readonly status: ChannelStatus;
  readonly avgLatencyMs: number;
  readonly throughput: number;
}

export interface ProfileConfig {
  readonly sampleRate: number;
  readonly slowThresholdMs: number;
  readonly congestedThresholdEvents: number;
  readonly enabled: boolean;
}

// ── Internal Types ───────────────────────────────────

interface RawEvent {
  readonly channel: string;
  readonly latencyMs: number;
  readonly error: boolean;
  readonly timestamp: string;
}

// ── Constants ────────────────────────────────────────

const LATENCY_BUCKETS: readonly { readonly label: string; readonly min: number; readonly max: number }[] = [
  { label: '0-1ms', min: 0, max: 1 },
  { label: '1-5ms', min: 1, max: 5 },
  { label: '5-10ms', min: 5, max: 10 },
  { label: '10-50ms', min: 10, max: 50 },
  { label: '50-100ms', min: 50, max: 100 },
  { label: '100ms+', min: 100, max: Infinity },
];

// ── Functions ────────────────────────────────────────

export function createProfileSession(): ProfileSession {
  return {
    sessionId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    metrics: [],
    totalEvents: 0,
    totalErrors: 0,
  };
}

export function recordEvent(
  session: ProfileSession,
  channel: string,
  latencyMs: number,
  error: boolean,
): ProfileSession {
  const now = new Date().toISOString();
  const existing = session.metrics.find((m) => m.channel === channel);

  const updatedMetric: EventBusMetric = existing
    ? {
        channel,
        eventCount: existing.eventCount + 1,
        avgLatencyMs:
          (existing.avgLatencyMs * existing.eventCount + latencyMs) /
          (existing.eventCount + 1),
        maxLatencyMs: Math.max(existing.maxLatencyMs, latencyMs),
        errorCount: existing.errorCount + (error ? 1 : 0),
        lastMeasured: now,
      }
    : {
        channel,
        eventCount: 1,
        avgLatencyMs: latencyMs,
        maxLatencyMs: latencyMs,
        errorCount: error ? 1 : 0,
        lastMeasured: now,
      };

  const metrics = existing
    ? session.metrics.map((m) => (m.channel === channel ? updatedMetric : m))
    : [...session.metrics, updatedMetric];

  return {
    ...session,
    metrics,
    totalEvents: session.totalEvents + 1,
    totalErrors: session.totalErrors + (error ? 1 : 0),
  };
}

export function computeChannelMetrics(
  session: ProfileSession,
): readonly EventBusMetric[] {
  return session.metrics;
}

export function buildLatencyHistogram(
  latencies: readonly number[],
): readonly LatencyBucket[] {
  return LATENCY_BUCKETS.map(({ label, min, max }) => ({
    rangeLabel: label,
    minMs: min,
    maxMs: max,
    count: latencies.filter((l) => l >= min && l < max).length,
  }));
}

export function assessChannelHealth(
  metric: EventBusMetric,
  config: ProfileConfig,
): ChannelHealth {
  const throughput = metric.eventCount;
  let status: ChannelStatus = 'healthy';

  if (metric.errorCount > 0 && metric.errorCount / metric.eventCount > 0.1) {
    status = 'error';
  } else if (metric.eventCount >= config.congestedThresholdEvents) {
    status = 'congested';
  } else if (metric.avgLatencyMs >= config.slowThresholdMs) {
    status = 'slow';
  }

  return {
    channel: metric.channel,
    status,
    avgLatencyMs: metric.avgLatencyMs,
    throughput,
  };
}

export function getSlowChannels(
  session: ProfileSession,
  thresholdMs: number,
): readonly string[] {
  return session.metrics
    .filter((m) => m.avgLatencyMs >= thresholdMs)
    .map((m) => m.channel);
}

export function createDefaultProfileConfig(): ProfileConfig {
  return {
    sampleRate: 1.0,
    slowThresholdMs: 50,
    congestedThresholdEvents: 1000,
    enabled: true,
  };
}

export function formatProfileReport(session: ProfileSession): string {
  const allLatencies = session.metrics.flatMap((m) =>
    Array.from({ length: m.eventCount }, () => m.avgLatencyMs),
  );
  const histogram = buildLatencyHistogram(allLatencies);

  const lines = [
    '## EventBus Profile Report',
    '',
    `**Session:** ${session.sessionId}`,
    `**Started:** ${session.startedAt}`,
    `**Total events:** ${session.totalEvents}`,
    `**Total errors:** ${session.totalErrors}`,
    '',
    '### Latency Histogram',
    '',
    '| Range | Count |',
    '|-------|-------|',
    ...histogram.map((b) => `| ${b.rangeLabel} | ${b.count} |`),
    '',
    '### Channel Metrics',
    '',
    '| Channel | Events | Avg Latency | Max Latency | Errors |',
    '|---------|--------|-------------|-------------|--------|',
    ...session.metrics.map(
      (m) =>
        `| ${m.channel} | ${m.eventCount} | ${m.avgLatencyMs.toFixed(2)}ms | ${m.maxLatencyMs.toFixed(2)}ms | ${m.errorCount} |`,
    ),
  ];
  return lines.join('\n');
}

export function formatChannelHealthDashboard(
  healths: readonly ChannelHealth[],
): string {
  const lines = [
    '## Channel Health Dashboard',
    '',
    '| Channel | Status | Avg Latency | Throughput |',
    '|---------|--------|-------------|------------|',
    ...healths.map(
      (h) =>
        `| ${h.channel} | ${h.status} | ${h.avgLatencyMs.toFixed(2)}ms | ${h.throughput} |`,
    ),
  ];
  return lines.join('\n');
}

export function computeThroughput(
  session: ProfileSession,
  windowMs: number,
): number {
  if (windowMs <= 0) return 0;
  return (session.totalEvents / windowMs) * 1000;
}
