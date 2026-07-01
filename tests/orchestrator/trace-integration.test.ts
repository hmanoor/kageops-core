import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createTraceSession,
  addTracedEvent,
  completeTraceSession,
  findEventsByAgent,
  findEventsByType,
  computeSessionDuration,
  extractMetrics,
  buildAlertIntegrations,
  shouldTriggerAlert,
  formatTraceSessionSummary,
  getSessionTimeline,
  mergeTraceSessions,
  TracedEvent,
  TraceSession,
} from '../../src/orchestrator/trace-integration';

function makeEvent(overrides: Partial<Omit<TracedEvent, 'traceId'>> = {}): Omit<TracedEvent, 'traceId'> {
  return {
    spanId: 'span-1',
    parentSpanId: null,
    eventType: 'task.completed',
    agentId: 'forge',
    payload: {},
    timestamp: '2026-04-11T10:00:00.000Z',
    ...overrides,
  };
}

describe('trace-integration', () => {
  describe('createTraceSession', () => {
    it('creates a session with the given traceId', () => {
      const session = createTraceSession('trace-abc');
      expect(session.traceId).toBe('trace-abc');
      expect(session.status).toBe('active');
      expect(session.events).toEqual([]);
      expect(session.completedAt).toBeNull();
      expect(session.rootSpanId).toBeDefined();
      expect(session.startedAt).toBeDefined();
    });

    it('generates unique rootSpanIds', () => {
      const s1 = createTraceSession('t1');
      const s2 = createTraceSession('t2');
      expect(s1.rootSpanId).not.toBe(s2.rootSpanId);
    });
  });

  describe('addTracedEvent', () => {
    it('appends event with session traceId', () => {
      const session = createTraceSession('trace-1');
      const updated = addTracedEvent(session, makeEvent());
      expect(updated.events).toHaveLength(1);
      expect(updated.events[0].traceId).toBe('trace-1');
    });

    it('does not mutate the original session', () => {
      const session = createTraceSession('trace-1');
      const updated = addTracedEvent(session, makeEvent());
      expect(session.events).toHaveLength(0);
      expect(updated.events).toHaveLength(1);
    });

    it('preserves existing events', () => {
      let session = createTraceSession('trace-1');
      session = addTracedEvent(session, makeEvent({ spanId: 's1' }));
      session = addTracedEvent(session, makeEvent({ spanId: 's2' }));
      expect(session.events).toHaveLength(2);
      expect(session.events[0].spanId).toBe('s1');
      expect(session.events[1].spanId).toBe('s2');
    });
  });

  describe('completeTraceSession', () => {
    it('marks session as completed', () => {
      const session = createTraceSession('trace-1');
      const completed = completeTraceSession(session, 'completed');
      expect(completed.status).toBe('completed');
      expect(completed.completedAt).not.toBeNull();
    });

    it('marks session as failed', () => {
      const session = createTraceSession('trace-1');
      const failed = completeTraceSession(session, 'failed');
      expect(failed.status).toBe('failed');
      expect(failed.completedAt).not.toBeNull();
    });

    it('does not mutate original', () => {
      const session = createTraceSession('trace-1');
      completeTraceSession(session, 'completed');
      expect(session.status).toBe('active');
    });
  });

  describe('findEventsByAgent', () => {
    it('returns events for the specified agent', () => {
      let session = createTraceSession('t');
      session = addTracedEvent(session, makeEvent({ agentId: 'forge' }));
      session = addTracedEvent(session, makeEvent({ agentId: 'vigil' }));
      session = addTracedEvent(session, makeEvent({ agentId: 'forge' }));
      expect(findEventsByAgent(session, 'forge')).toHaveLength(2);
    });

    it('returns empty array when no match', () => {
      const session = createTraceSession('t');
      expect(findEventsByAgent(session, 'scout')).toEqual([]);
    });
  });

  describe('findEventsByType', () => {
    it('returns events matching event type', () => {
      let session = createTraceSession('t');
      session = addTracedEvent(session, makeEvent({ eventType: 'task.completed' }));
      session = addTracedEvent(session, makeEvent({ eventType: 'task.failed' }));
      session = addTracedEvent(session, makeEvent({ eventType: 'task.completed' }));
      expect(findEventsByType(session, 'task.completed')).toHaveLength(2);
    });

    it('returns empty for no match', () => {
      const session = createTraceSession('t');
      expect(findEventsByType(session, 'nope')).toEqual([]);
    });
  });

  describe('computeSessionDuration', () => {
    it('returns 0 for empty session', () => {
      expect(computeSessionDuration(createTraceSession('t'))).toBe(0);
    });

    it('computes ms between first and last event', () => {
      let session = createTraceSession('t');
      session = addTracedEvent(session, makeEvent({ timestamp: '2026-04-11T10:00:00.000Z' }));
      session = addTracedEvent(session, makeEvent({ timestamp: '2026-04-11T10:00:05.000Z' }));
      session = addTracedEvent(session, makeEvent({ timestamp: '2026-04-11T10:00:02.000Z' }));
      expect(computeSessionDuration(session)).toBe(5000);
    });
  });

  describe('extractMetrics', () => {
    it('extracts numeric values from payloads', () => {
      let session = createTraceSession('t');
      session = addTracedEvent(session, makeEvent({
        agentId: 'forge',
        payload: { latency_ms: 200, status: 'ok' as unknown as string },
        timestamp: '2026-04-11T10:00:00.000Z',
      }));
      const metrics = extractMetrics(session);
      expect(metrics).toHaveLength(1);
      expect(metrics[0].metric).toBe('latency_ms');
      expect(metrics[0].value).toBe(200);
      expect(metrics[0].agentId).toBe('forge');
    });

    it('uses "unknown" for null agentId', () => {
      let session = createTraceSession('t');
      session = addTracedEvent(session, makeEvent({ agentId: null, payload: { count: 5 } }));
      const metrics = extractMetrics(session);
      expect(metrics[0].agentId).toBe('unknown');
    });

    it('returns empty for no numeric payload values', () => {
      let session = createTraceSession('t');
      session = addTracedEvent(session, makeEvent({ payload: { status: 'ok' } }));
      expect(extractMetrics(session)).toEqual([]);
    });
  });

  describe('buildAlertIntegrations', () => {
    it('creates integrations for each pattern', () => {
      const integrations = buildAlertIntegrations(['task.completed', 'task.failed']);
      expect(integrations).toHaveLength(2);
      expect(integrations[0].eventPattern).toBe('task.completed');
      expect(integrations[1].eventPattern).toBe('task.failed');
      expect(integrations[0].enabled).toBe(true);
    });

    it('converts dots to underscores for thresholdMetric', () => {
      const integrations = buildAlertIntegrations(['task.completed']);
      expect(integrations[0].thresholdMetric).toBe('task_completed');
    });

    it('returns empty for empty input', () => {
      expect(buildAlertIntegrations([])).toEqual([]);
    });
  });

  describe('shouldTriggerAlert', () => {
    it('matches exact event type', () => {
      const integrations = buildAlertIntegrations(['task.completed']);
      const event: TracedEvent = { ...makeEvent({ eventType: 'task.completed' }), traceId: 't' };
      expect(shouldTriggerAlert(event, integrations)).toHaveLength(1);
    });

    it('matches wildcard pattern', () => {
      const integrations = buildAlertIntegrations(['task.*']);
      const event: TracedEvent = { ...makeEvent({ eventType: 'task.completed' }), traceId: 't' };
      expect(shouldTriggerAlert(event, integrations)).toHaveLength(1);
    });

    it('does not match unrelated event', () => {
      const integrations = buildAlertIntegrations(['review.passed']);
      const event: TracedEvent = { ...makeEvent({ eventType: 'task.completed' }), traceId: 't' };
      expect(shouldTriggerAlert(event, integrations)).toHaveLength(0);
    });

    it('skips disabled integrations', () => {
      const integrations = [{ alertConfigId: 'x', eventPattern: 'task.completed', thresholdMetric: 'task_completed', enabled: false }];
      const event: TracedEvent = { ...makeEvent({ eventType: 'task.completed' }), traceId: 't' };
      expect(shouldTriggerAlert(event, integrations)).toHaveLength(0);
    });
  });

  describe('formatTraceSessionSummary', () => {
    it('produces markdown with session info', () => {
      let session = createTraceSession('trace-xyz');
      session = addTracedEvent(session, makeEvent({ agentId: 'forge', eventType: 'task.started' }));
      const summary = formatTraceSessionSummary(session);
      expect(summary).toContain('trace-xyz');
      expect(summary).toContain('forge');
      expect(summary).toContain('task.started');
      expect(summary).toContain('active');
    });

    it('shows completed status', () => {
      let session = createTraceSession('t');
      session = completeTraceSession(session, 'failed');
      const summary = formatTraceSessionSummary(session);
      expect(summary).toContain('failed');
    });
  });

  describe('getSessionTimeline', () => {
    it('returns sorted timeline entries', () => {
      let session = createTraceSession('t');
      session = addTracedEvent(session, makeEvent({ timestamp: '2026-04-11T10:00:02.000Z', eventType: 'b' }));
      session = addTracedEvent(session, makeEvent({ timestamp: '2026-04-11T10:00:01.000Z', eventType: 'a' }));
      const timeline = getSessionTimeline(session);
      expect(timeline).toHaveLength(2);
      expect(timeline[0].label).toContain('a');
      expect(timeline[1].label).toContain('b');
    });

    it('includes agentId in label when present', () => {
      let session = createTraceSession('t');
      session = addTracedEvent(session, makeEvent({ agentId: 'forge', eventType: 'task.done' }));
      const timeline = getSessionTimeline(session);
      expect(timeline[0].label).toBe('[forge] task.done');
    });

    it('omits agentId bracket when null', () => {
      let session = createTraceSession('t');
      session = addTracedEvent(session, makeEvent({ agentId: null, eventType: 'system.boot' }));
      const timeline = getSessionTimeline(session);
      expect(timeline[0].label).toBe('system.boot');
    });
  });

  describe('mergeTraceSessions', () => {
    it('merges and sorts events from multiple sessions by timestamp', () => {
      let s1 = createTraceSession('t1');
      s1 = addTracedEvent(s1, makeEvent({ timestamp: '2026-04-11T10:00:03.000Z', spanId: 'c' }));
      s1 = addTracedEvent(s1, makeEvent({ timestamp: '2026-04-11T10:00:01.000Z', spanId: 'a' }));

      let s2 = createTraceSession('t2');
      s2 = addTracedEvent(s2, makeEvent({ timestamp: '2026-04-11T10:00:02.000Z', spanId: 'b' }));

      const merged = mergeTraceSessions([s1, s2]);
      expect(merged).toHaveLength(3);
      expect(merged[0].spanId).toBe('a');
      expect(merged[1].spanId).toBe('b');
      expect(merged[2].spanId).toBe('c');
    });

    it('returns empty for no sessions', () => {
      expect(mergeTraceSessions([])).toEqual([]);
    });

    it('preserves traceIds from respective sessions', () => {
      let s1 = createTraceSession('t1');
      s1 = addTracedEvent(s1, makeEvent({ timestamp: '2026-04-11T10:00:00.000Z' }));
      let s2 = createTraceSession('t2');
      s2 = addTracedEvent(s2, makeEvent({ timestamp: '2026-04-11T10:00:01.000Z' }));
      const merged = mergeTraceSessions([s1, s2]);
      expect(merged[0].traceId).toBe('t1');
      expect(merged[1].traceId).toBe('t2');
    });
  });
});
