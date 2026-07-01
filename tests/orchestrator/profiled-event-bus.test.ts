import { describe, it, expect } from 'vitest';
import {
  createProfiledConfig,
  wrapPublish,
  wrapSubscribe,
  recordEventTiming,
  computeEventBusSnapshot,
  identifySlowEvents,
  getSubscriptionMetrics,
  updateSubscriptionMetrics,
  shouldSampleEvent,
  formatEventBusHealth,
  formatSlowEventLog,
  computeChannelThroughput,
  getTopChannelsByVolume,
  resetTimings,
  type EventTiming,
  type SubscriptionMetrics,
  type ProfiledEventConfig,
} from '../../src/orchestrator/profiled-event-bus';

// ── Helpers ─────────────────────────────────────────

function makeTiming(overrides: Partial<EventTiming> = {}): EventTiming {
  return {
    channel: 'task.created',
    startTime: 1000,
    endTime: 1010,
    durationMs: 10,
    success: true,
    listenerCount: 2,
    ...overrides,
  };
}

function makeSub(overrides: Partial<SubscriptionMetrics> = {}): SubscriptionMetrics {
  return {
    channel: 'task.created',
    callbackCount: 1,
    totalInvocations: 0,
    avgHandlerDurationMs: 0,
    errors: 0,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────

describe('createProfiledConfig', () => {
  it('returns sensible defaults', () => {
    const cfg = createProfiledConfig();
    expect(cfg.profilingEnabled).toBe(true);
    expect(cfg.traceEnabled).toBe(false);
    expect(cfg.slowEventThresholdMs).toBe(50);
    expect(cfg.sampleRate).toBe(1.0);
    expect(cfg.logSlowEvents).toBe(true);
  });

  it('applies overrides immutably', () => {
    const cfg = createProfiledConfig({ sampleRate: 0.5, traceEnabled: true });
    expect(cfg.sampleRate).toBe(0.5);
    expect(cfg.traceEnabled).toBe(true);
    expect(cfg.profilingEnabled).toBe(true);
  });
});

describe('wrapPublish', () => {
  it('returns a ProfiledPublishResult with timing', () => {
    const cfg = createProfiledConfig();
    const result = wrapPublish('task.created', '{}', cfg);
    expect(result.channel).toBe('task.created');
    expect(result.delivered).toBe(true);
    expect(result.timing.channel).toBe('task.created');
    expect(result.timing.success).toBe(true);
    expect(result.traceSpanId).toBeNull();
  });

  it('includes traceSpanId when tracing enabled', () => {
    const cfg = createProfiledConfig({ traceEnabled: true });
    const result = wrapPublish('task.created', '{}', cfg);
    expect(result.traceSpanId).not.toBeNull();
    expect(typeof result.traceSpanId).toBe('string');
  });
});

describe('wrapSubscribe', () => {
  it('adds a new subscription to empty list', () => {
    const result = wrapSubscribe('task.created', []);
    expect(result).toHaveLength(1);
    expect(result[0].channel).toBe('task.created');
    expect(result[0].callbackCount).toBe(1);
  });

  it('increments callbackCount for existing channel', () => {
    const existing = [makeSub({ channel: 'task.created', callbackCount: 2 })];
    const result = wrapSubscribe('task.created', existing);
    expect(result).toHaveLength(1);
    expect(result[0].callbackCount).toBe(3);
  });

  it('does not mutate the original array', () => {
    const existing: readonly SubscriptionMetrics[] = [makeSub()];
    const result = wrapSubscribe('task.completed', existing);
    expect(result).toHaveLength(2);
    expect(existing).toHaveLength(1);
  });
});

describe('recordEventTiming', () => {
  it('appends timing immutably', () => {
    const existing = [makeTiming({ channel: 'a' })];
    const newTiming = makeTiming({ channel: 'b' });
    const result = recordEventTiming(existing, newTiming);
    expect(result).toHaveLength(2);
    expect(existing).toHaveLength(1);
    expect(result[1].channel).toBe('b');
  });
});

describe('computeEventBusSnapshot', () => {
  it('returns zeroed snapshot for empty inputs', () => {
    const snap = computeEventBusSnapshot([], []);
    expect(snap.totalEventsProcessed).toBe(0);
    expect(snap.avgLatencyMs).toBe(0);
    expect(snap.slowEventsCount).toBe(0);
    expect(snap.errorCount).toBe(0);
    expect(snap.activeSubscriptions).toEqual([]);
  });

  it('computes correct averages and counts', () => {
    const timings = [
      makeTiming({ durationMs: 10, success: true }),
      makeTiming({ durationMs: 90, success: false }),
    ];
    const subs = [makeSub({ channel: 'task.created' })];
    const snap = computeEventBusSnapshot(timings, subs);
    expect(snap.totalEventsProcessed).toBe(2);
    expect(snap.avgLatencyMs).toBe(50);
    expect(snap.slowEventsCount).toBe(1); // 90ms >= 50
    expect(snap.errorCount).toBe(1);
    expect(snap.activeSubscriptions).toEqual(['task.created']);
  });
});

describe('identifySlowEvents', () => {
  it.each([
    { threshold: 50, expected: 1 },
    { threshold: 100, expected: 0 },
    { threshold: 5, expected: 2 },
  ])('threshold=$threshold yields $expected slow events', ({ threshold, expected }) => {
    const timings = [
      makeTiming({ durationMs: 10 }),
      makeTiming({ durationMs: 60 }),
    ];
    expect(identifySlowEvents(timings, threshold)).toHaveLength(expected);
  });
});

describe('getSubscriptionMetrics', () => {
  it('returns matching subscription', () => {
    const subs = [makeSub({ channel: 'task.created' }), makeSub({ channel: 'task.completed' })];
    const result = getSubscriptionMetrics(subs, 'task.completed');
    expect(result).not.toBeNull();
    expect(result!.channel).toBe('task.completed');
  });

  it('returns null for missing channel', () => {
    expect(getSubscriptionMetrics([], 'nope')).toBeNull();
  });
});

describe('updateSubscriptionMetrics', () => {
  it('updates invocation count and avg duration', () => {
    const subs = [makeSub({ channel: 'task.created', totalInvocations: 1, avgHandlerDurationMs: 10 })];
    const result = updateSubscriptionMetrics(subs, 'task.created', 20, false);
    expect(result[0].totalInvocations).toBe(2);
    expect(result[0].avgHandlerDurationMs).toBe(15); // (10*1 + 20) / 2
    expect(result[0].errors).toBe(0);
  });

  it('increments errors when error=true', () => {
    const subs = [makeSub({ channel: 'task.created', errors: 1 })];
    const result = updateSubscriptionMetrics(subs, 'task.created', 5, true);
    expect(result[0].errors).toBe(2);
  });

  it('does not mutate original array', () => {
    const subs = [makeSub()];
    const result = updateSubscriptionMetrics(subs, 'task.created', 10, false);
    expect(result).not.toBe(subs);
    expect(subs[0].totalInvocations).toBe(0);
  });
});

describe('shouldSampleEvent', () => {
  it('always returns true at rate 1.0', () => {
    for (let i = 0; i < 20; i++) {
      expect(shouldSampleEvent(1.0)).toBe(true);
    }
  });

  it('always returns false at rate 0', () => {
    for (let i = 0; i < 20; i++) {
      expect(shouldSampleEvent(0)).toBe(false);
    }
  });

  it('returns boolean at intermediate rate', () => {
    const result = shouldSampleEvent(0.5);
    expect(typeof result).toBe('boolean');
  });
});

describe('formatEventBusHealth', () => {
  it('produces markdown with snapshot data', () => {
    const snap = computeEventBusSnapshot(
      [makeTiming({ durationMs: 20 })],
      [makeSub({ channel: 'task.created' })],
    );
    const md = formatEventBusHealth(snap);
    expect(md).toContain('## Event Bus Health');
    expect(md).toContain('task.created');
    expect(md).toContain('Total Events');
  });
});

describe('formatSlowEventLog', () => {
  it('returns placeholder when no events', () => {
    expect(formatSlowEventLog([])).toBe('No slow events recorded.');
  });

  it('returns markdown table for slow events', () => {
    const events = [makeTiming({ channel: 'task.failed', durationMs: 120 })];
    const md = formatSlowEventLog(events);
    expect(md).toContain('task.failed');
    expect(md).toContain('120.00');
  });
});

describe('computeChannelThroughput', () => {
  it('returns empty record for zero window', () => {
    expect(computeChannelThroughput([makeTiming()], 0)).toEqual({});
  });

  it.each([
    { windowMs: 1000, expected: 2 },
    { windowMs: 2000, expected: 1 },
    { windowMs: 500, expected: 4 },
  ])('windowMs=$windowMs yields $expected events/sec', ({ windowMs, expected }) => {
    const timings = [makeTiming(), makeTiming()];
    const result = computeChannelThroughput(timings, windowMs);
    expect(result['task.created']).toBe(expected);
  });
});

describe('getTopChannelsByVolume', () => {
  it('returns channels sorted by count descending', () => {
    const timings = [
      makeTiming({ channel: 'a' }),
      makeTiming({ channel: 'b' }),
      makeTiming({ channel: 'b' }),
      makeTiming({ channel: 'c' }),
      makeTiming({ channel: 'c' }),
      makeTiming({ channel: 'c' }),
    ];
    const top = getTopChannelsByVolume(timings, 2);
    expect(top).toHaveLength(2);
    expect(top[0]).toEqual({ channel: 'c', count: 3 });
    expect(top[1]).toEqual({ channel: 'b', count: 2 });
  });

  it('returns empty for empty timings', () => {
    expect(getTopChannelsByVolume([], 5)).toEqual([]);
  });
});

describe('resetTimings', () => {
  it('prunes timings older than threshold', () => {
    const now = 5000;
    const timings = [
      makeTiming({ startTime: 1000 }), // age 4000
      makeTiming({ startTime: 3000 }), // age 2000
      makeTiming({ startTime: 4500 }), // age 500
    ];
    const result = resetTimings(timings, 3000, now);
    expect(result).toHaveLength(2);
    expect(result[0].startTime).toBe(3000);
    expect(result[1].startTime).toBe(4500);
  });

  it('returns all timings if none are old', () => {
    const timings = [makeTiming({ startTime: 9990 })];
    expect(resetTimings(timings, 1000, 10000)).toHaveLength(1);
  });

  it('returns empty if all are old', () => {
    const timings = [makeTiming({ startTime: 100 })];
    expect(resetTimings(timings, 50, 10000)).toHaveLength(0);
  });
});
