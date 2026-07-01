// Trace context and alert engine integration for the orchestration layer

import { generateTraceId, generateSpanId } from '../shared/trace-context';

// ─── Types ───────────────────────────────────────────────────────────

export interface TracedEvent {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly eventType: string;
  readonly agentId: string | null;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
  readonly timestamp: string;
}

export interface TraceSession {
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly events: readonly TracedEvent[];
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly status: 'active' | 'completed' | 'failed';
}

export interface AlertIntegration {
  readonly alertConfigId: string;
  readonly eventPattern: string;
  readonly thresholdMetric: string;
  readonly enabled: boolean;
}

export interface MetricSnapshot {
  readonly agentId: string;
  readonly metric: string;
  readonly value: number;
  readonly timestamp: string;
}

// ─── Functions ───────────────────────────────────────────────────────

export function createTraceSession(traceId: string): TraceSession {
  return {
    traceId,
    rootSpanId: generateSpanId(),
    events: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'active',
  };
}

export function addTracedEvent(
  session: TraceSession,
  event: Omit<TracedEvent, 'traceId'>,
): TraceSession {
  const tracedEvent: TracedEvent = {
    ...event,
    traceId: session.traceId,
  };
  return {
    ...session,
    events: [...session.events, tracedEvent],
  };
}

export function completeTraceSession(
  session: TraceSession,
  status: 'completed' | 'failed',
): TraceSession {
  return {
    ...session,
    completedAt: new Date().toISOString(),
    status,
  };
}

export function findEventsByAgent(
  session: TraceSession,
  agentId: string,
): readonly TracedEvent[] {
  return session.events.filter((e) => e.agentId === agentId);
}

export function findEventsByType(
  session: TraceSession,
  eventType: string,
): readonly TracedEvent[] {
  return session.events.filter((e) => e.eventType === eventType);
}

export function computeSessionDuration(session: TraceSession): number {
  if (session.events.length === 0) return 0;
  const timestamps = session.events.map((e) => new Date(e.timestamp).getTime());
  return Math.max(...timestamps) - Math.min(...timestamps);
}

export function extractMetrics(session: TraceSession): readonly MetricSnapshot[] {
  const snapshots: MetricSnapshot[] = [];
  for (const event of session.events) {
    for (const [key, value] of Object.entries(event.payload)) {
      if (typeof value === 'number') {
        snapshots.push({
          agentId: event.agentId ?? 'unknown',
          metric: key,
          value,
          timestamp: event.timestamp,
        });
      }
    }
  }
  return snapshots;
}

export function buildAlertIntegrations(
  eventPatterns: readonly string[],
): readonly AlertIntegration[] {
  return eventPatterns.map((pattern): AlertIntegration => ({
    alertConfigId: generateTraceId(),
    eventPattern: pattern,
    thresholdMetric: pattern.replace(/\./g, '_'),
    enabled: true,
  }));
}

export function shouldTriggerAlert(
  event: TracedEvent,
  integrations: readonly AlertIntegration[],
): readonly AlertIntegration[] {
  return integrations.filter((integration) => {
    if (!integration.enabled) return false;
    if (integration.eventPattern === event.eventType) return true;
    // Wildcard support: "task.*" matches "task.completed"
    if (integration.eventPattern.endsWith('.*')) {
      const prefix = integration.eventPattern.slice(0, -2);
      return event.eventType.startsWith(prefix + '.');
    }
    return false;
  });
}

export function formatTraceSessionSummary(session: TraceSession): string {
  const duration = computeSessionDuration(session);
  const agentIds = [...new Set(session.events.map((e) => e.agentId).filter(Boolean))];
  const eventTypes = [...new Set(session.events.map((e) => e.eventType))];

  const lines: string[] = [
    `## Trace Session Summary`,
    ``,
    `**Trace ID:** \`${session.traceId}\``,
    `**Status:** ${session.status}`,
    `**Started:** ${session.startedAt}`,
    session.completedAt !== null ? `**Completed:** ${session.completedAt}` : `**Completed:** —`,
    `**Duration:** ${duration}ms`,
    `**Events:** ${session.events.length}`,
    ``,
    `### Agents`,
    agentIds.length > 0 ? agentIds.map((a) => `- ${a}`).join('\n') : '- (none)',
    ``,
    `### Event Types`,
    eventTypes.length > 0 ? eventTypes.map((t) => `- ${t}`).join('\n') : '- (none)',
  ];

  return lines.join('\n');
}

export function getSessionTimeline(
  session: TraceSession,
): readonly { readonly timestamp: string; readonly label: string }[] {
  return session.events
    .slice()
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .map((e) => ({
      timestamp: e.timestamp,
      label: e.agentId !== null ? `[${e.agentId}] ${e.eventType}` : e.eventType,
    }));
}

export function mergeTraceSessions(
  sessions: readonly TraceSession[],
): readonly TracedEvent[] {
  const allEvents: TracedEvent[] = [];
  for (const session of sessions) {
    allEvents.push(...session.events);
  }
  return allEvents
    .slice()
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}
