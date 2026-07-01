/**
 * EventBus profiler tests (TD-008)
 */

import { describe, it, expect } from 'vitest';
import {
  createProfileSession,
  recordEvent,
  computeChannelMetrics,
  buildLatencyHistogram,
  assessChannelHealth,
  getSlowChannels,
  createDefaultProfileConfig,
  formatProfileReport,
  formatChannelHealthDashboard,
  computeThroughput,
  type ProfileSession,
  type EventBusMetric,
  type ProfileConfig,
} from '../../src/orchestrator/eventbus-profiler';

// ── Helpers ──────────────────────────────────────────

function sessionWithEvents(
  events: readonly { channel: string; latencyMs: number; error: boolean }[],
): ProfileSession {
  return events.reduce(
    (s, e) => recordEvent(s, e.channel, e.latencyMs, e.error),
    createProfileSession(),
  );
}

function makeMetric(overrides?: Partial<EventBusMetric>): EventBusMetric {
  return {
    channel: 'task.created',
    eventCount: 10,
    avgLatencyMs: 5,
    maxLatencyMs: 20,
    errorCount: 0,
    lastMeasured: '2026-04-11T00:00:00Z',
    ...overrides,
  };
}

// ── createProfileSession ─────────────────────────────

describe('createProfileSession', () => {
  it('creates an empty session with a UUID', () => {
    const session = createProfileSession();
    expect(session.sessionId).toBeTruthy();
    expect(session.totalEvents).toBe(0);
    expect(session.totalErrors).toBe(0);
    expect(session.metrics).toHaveLength(0);
  });
});

// ── recordEvent ──────────────────────────────────────

describe('recordEvent', () => {
  it('adds a new channel metric immutably', () => {
    const s0 = createProfileSession();
    const s1 = recordEvent(s0, 'task.created', 5, false);
    expect(s1).not.toBe(s0);
    expect(s1.totalEvents).toBe(1);
    expect(s1.metrics).toHaveLength(1);
    expect(s1.metrics[0].channel).toBe('task.created');
  });

  it('updates existing channel metrics correctly', () => {
    const s0 = createProfileSession();
    const s1 = recordEvent(s0, 'task.created', 10, false);
    const s2 = recordEvent(s1, 'task.created', 20, false);
    expect(s2.metrics).toHaveLength(1);
    expect(s2.metrics[0].eventCount).toBe(2);
    expect(s2.metrics[0].avgLatencyMs).toBe(15);
    expect(s2.metrics[0].maxLatencyMs).toBe(20);
  });

  it('tracks errors', () => {
    const s = recordEvent(createProfileSession(), 'task.failed', 5, true);
    expect(s.totalErrors).toBe(1);
    expect(s.metrics[0].errorCount).toBe(1);
  });
});

// ── computeChannelMetrics ────────────────────────────

describe('computeChannelMetrics', () => {
  it('returns all channel metrics from session', () => {
    const s = sessionWithEvents([
      { channel: 'a', latencyMs: 1, error: false },
      { channel: 'b', latencyMs: 2, error: false },
    ]);
    const metrics = computeChannelMetrics(s);
    expect(metrics).toHaveLength(2);
  });
});

// ── buildLatencyHistogram ────────────────────────────

describe('buildLatencyHistogram', () => {
  it('distributes latencies into correct buckets', () => {
    const histogram = buildLatencyHistogram([0.5, 3, 7, 25, 75, 200]);
    expect(histogram).toHaveLength(6);
    expect(histogram[0].count).toBe(1); // 0-1ms
    expect(histogram[1].count).toBe(1); // 1-5ms
    expect(histogram[2].count).toBe(1); // 5-10ms
    expect(histogram[3].count).toBe(1); // 10-50ms
    expect(histogram[4].count).toBe(1); // 50-100ms
    expect(histogram[5].count).toBe(1); // 100ms+
  });

  it('handles empty latencies', () => {
    const histogram = buildLatencyHistogram([]);
    expect(histogram.every((b) => b.count === 0)).toBe(true);
  });
});

// ── assessChannelHealth ──────────────────────────────

describe('assessChannelHealth', () => {
  const config = createDefaultProfileConfig();

  it.each([
    ['healthy', makeMetric({ avgLatencyMs: 5, eventCount: 10, errorCount: 0 }), 'healthy'],
    ['slow', makeMetric({ avgLatencyMs: 100, eventCount: 10, errorCount: 0 }), 'slow'],
    ['congested', makeMetric({ avgLatencyMs: 5, eventCount: 1500, errorCount: 0 }), 'congested'],
    ['error', makeMetric({ avgLatencyMs: 5, eventCount: 10, errorCount: 5 }), 'error'],
  ] as const)('detects %s status', (_label, metric, expected) => {
    const health = assessChannelHealth(metric, config);
    expect(health.status).toBe(expected);
  });
});

// ── getSlowChannels ──────────────────────────────────

describe('getSlowChannels', () => {
  it('filters channels above threshold', () => {
    const s = sessionWithEvents([
      { channel: 'fast', latencyMs: 1, error: false },
      { channel: 'slow', latencyMs: 100, error: false },
    ]);
    const slow = getSlowChannels(s, 50);
    expect(slow).toEqual(['slow']);
  });

  it('returns empty when all channels fast', () => {
    const s = sessionWithEvents([
      { channel: 'a', latencyMs: 1, error: false },
    ]);
    expect(getSlowChannels(s, 50)).toEqual([]);
  });
});

// ── createDefaultProfileConfig ───────────────────────

describe('createDefaultProfileConfig', () => {
  it('returns expected defaults', () => {
    const config = createDefaultProfileConfig();
    expect(config.sampleRate).toBe(1.0);
    expect(config.slowThresholdMs).toBe(50);
    expect(config.congestedThresholdEvents).toBe(1000);
    expect(config.enabled).toBe(true);
  });
});

// ── formatProfileReport ──────────────────────────────

describe('formatProfileReport', () => {
  it('produces markdown with histogram and metrics', () => {
    const s = sessionWithEvents([
      { channel: 'task.created', latencyMs: 5, error: false },
      { channel: 'task.completed', latencyMs: 50, error: false },
    ]);
    const report = formatProfileReport(s);
    expect(report).toContain('## EventBus Profile Report');
    expect(report).toContain('task.created');
    expect(report).toContain('Latency Histogram');
  });
});

// ── formatChannelHealthDashboard ─────────────────────

describe('formatChannelHealthDashboard', () => {
  it('produces markdown table', () => {
    const healths = [
      { channel: 'task.created', status: 'healthy' as const, avgLatencyMs: 2, throughput: 50 },
      { channel: 'task.failed', status: 'error' as const, avgLatencyMs: 80, throughput: 5 },
    ];
    const dashboard = formatChannelHealthDashboard(healths);
    expect(dashboard).toContain('## Channel Health Dashboard');
    expect(dashboard).toContain('healthy');
    expect(dashboard).toContain('error');
  });
});

// ── computeThroughput ────────────────────────────────

describe('computeThroughput', () => {
  it.each([
    [100, 10_000, 10],
    [0, 10_000, 0],
    [50, 0, 0],
  ])('events=%i windowMs=%i => %f eps', (events, windowMs, expected) => {
    const session: ProfileSession = {
      ...createProfileSession(),
      totalEvents: events,
    };
    expect(computeThroughput(session, windowMs)).toBeCloseTo(expected);
  });
});
