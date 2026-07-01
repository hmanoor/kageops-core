// B-150: Configurable Alert Thresholds
// B-151: PagerDuty Integration
// B-152: Slack Webhook Alerts

// ─── Types ───────────────────────────────────────────────────────────

export interface AlertThreshold {
  readonly id: string;
  readonly metric: string;
  readonly operator: 'gt' | 'lt' | 'gte' | 'lte' | 'eq';
  readonly value: number;
  readonly severity: 'critical' | 'warning' | 'info';
  readonly message: string;
  readonly enabled: boolean;
}

export interface AlertEvent {
  readonly thresholdId: string;
  readonly metric: string;
  readonly currentValue: number;
  readonly thresholdValue: number;
  readonly severity: 'critical' | 'warning' | 'info';
  readonly message: string;
  readonly triggeredAt: string;
  readonly resolved: boolean;
}

export interface AlertConfig {
  readonly thresholds: readonly AlertThreshold[];
  readonly cooldownMs: number;
  readonly maxAlertsPerHour: number;
}

export interface AlertState {
  readonly activeAlerts: readonly AlertEvent[];
  readonly recentAlerts: readonly AlertEvent[];
  readonly lastChecked: string;
  readonly suppressedCount: number;
}

export interface PagerDutyConfig {
  readonly routingKey: string;
  readonly serviceId: string;
  readonly enabled: boolean;
  readonly severityMapping: Readonly<Record<string, string>>;
}

export interface PagerDutyPayload {
  readonly routing_key: string;
  readonly event_action: 'trigger' | 'acknowledge' | 'resolve';
  readonly payload: {
    readonly summary: string;
    readonly severity: string;
    readonly source: string;
    readonly timestamp: string;
    readonly custom_details: Readonly<Record<string, string | number>>;
  };
}

export interface SlackWebhookConfig {
  readonly webhookUrl: string;
  readonly channel: string;
  readonly username: string;
  readonly iconEmoji: string;
  readonly enabled: boolean;
}

export interface SlackAttachment {
  readonly color: string;
  readonly title: string;
  readonly text: string;
  readonly fields: readonly { readonly title: string; readonly value: string; readonly short: boolean }[];
  readonly ts: number;
}

export interface SlackPayload {
  readonly channel: string;
  readonly username: string;
  readonly icon_emoji: string;
  readonly text: string;
  readonly attachments: readonly SlackAttachment[];
}

export interface NotificationResult {
  readonly success: boolean;
  readonly provider: 'pagerduty' | 'slack' | 'email';
  readonly responseCode: number | null;
  readonly error: string | null;
  readonly sentAt: string;
}

// ─── Functions ───────────────────────────────────────────────────────

export function evaluateThreshold(threshold: AlertThreshold, currentValue: number): boolean {
  switch (threshold.operator) {
    case 'gt': return currentValue > threshold.value;
    case 'lt': return currentValue < threshold.value;
    case 'gte': return currentValue >= threshold.value;
    case 'lte': return currentValue <= threshold.value;
    case 'eq': return currentValue === threshold.value;
  }
}

export function checkAllThresholds(
  config: AlertConfig,
  metrics: Readonly<Record<string, number>>,
): readonly AlertEvent[] {
  const now = new Date().toISOString();
  return config.thresholds
    .filter((t) => t.enabled && t.metric in metrics)
    .filter((t) => evaluateThreshold(t, metrics[t.metric]))
    .map((t): AlertEvent => ({
      thresholdId: t.id,
      metric: t.metric,
      currentValue: metrics[t.metric],
      thresholdValue: t.value,
      severity: t.severity,
      message: t.message,
      triggeredAt: now,
      resolved: false,
    }));
}

export function isInCooldown(
  alert: AlertEvent,
  recentAlerts: readonly AlertEvent[],
  cooldownMs: number,
): boolean {
  const alertTime = new Date(alert.triggeredAt).getTime();
  return recentAlerts.some(
    (r) =>
      r.thresholdId === alert.thresholdId &&
      alertTime - new Date(r.triggeredAt).getTime() < cooldownMs,
  );
}

export function updateAlertState(
  state: AlertState,
  newEvents: readonly AlertEvent[],
  cooldownMs: number,
): AlertState {
  const filtered = newEvents.filter((e) => !isInCooldown(e, state.recentAlerts, cooldownMs));
  const suppressedCount = state.suppressedCount + (newEvents.length - filtered.length);
  return {
    activeAlerts: [...state.activeAlerts, ...filtered],
    recentAlerts: [...state.recentAlerts, ...filtered],
    lastChecked: new Date().toISOString(),
    suppressedCount,
  };
}

export function buildPagerDutyPayload(
  event: AlertEvent,
  config: PagerDutyConfig,
): PagerDutyPayload {
  const mappedSeverity = config.severityMapping[event.severity] ?? event.severity;
  return {
    routing_key: config.routingKey,
    event_action: 'trigger',
    payload: {
      summary: formatAlertMessage(event),
      severity: mappedSeverity,
      source: `kageops-${event.metric}`,
      timestamp: event.triggeredAt,
      custom_details: {
        metric: event.metric,
        current_value: event.currentValue,
        threshold_value: event.thresholdValue,
        threshold_id: event.thresholdId,
      },
    },
  };
}

export function severityToColor(severity: string): string {
  switch (severity) {
    case 'critical': return '#FF0000';
    case 'warning': return '#FFA500';
    case 'info': return '#0000FF';
    default: return '#808080';
  }
}

export function buildSlackPayload(
  event: AlertEvent,
  config: SlackWebhookConfig,
): SlackPayload {
  return {
    channel: config.channel,
    username: config.username,
    icon_emoji: config.iconEmoji,
    text: formatAlertMessage(event),
    attachments: [
      {
        color: severityToColor(event.severity),
        title: `[${event.severity.toUpperCase()}] ${event.metric}`,
        text: event.message,
        fields: [
          { title: 'Current Value', value: String(event.currentValue), short: true },
          { title: 'Threshold', value: String(event.thresholdValue), short: true },
        ],
        ts: Math.floor(new Date(event.triggeredAt).getTime() / 1000),
      },
    ],
  };
}

export function formatAlertMessage(event: AlertEvent): string {
  return `[${event.severity.toUpperCase()}] ${event.metric}: ${event.currentValue} (threshold: ${event.thresholdValue}) — ${event.message}`;
}

export function formatAlertDashboard(state: AlertState): string {
  const lines: string[] = ['# Alert Dashboard', ''];
  lines.push(`Last checked: ${state.lastChecked}`);
  lines.push(`Suppressed: ${state.suppressedCount}`, '');

  lines.push('## Active Alerts');
  if (state.activeAlerts.length === 0) {
    lines.push('No active alerts.');
  } else {
    for (const a of state.activeAlerts) {
      lines.push(`- ${formatAlertMessage(a)}`);
    }
  }

  lines.push('', '## Recent Alerts');
  if (state.recentAlerts.length === 0) {
    lines.push('No recent alerts.');
  } else {
    for (const a of state.recentAlerts) {
      const status = a.resolved ? '✓' : '✗';
      lines.push(`- [${status}] ${formatAlertMessage(a)}`);
    }
  }

  return lines.join('\n');
}

export function createDefaultAlertConfig(): AlertConfig {
  return {
    cooldownMs: 300_000,
    maxAlertsPerHour: 50,
    thresholds: [
      { id: 'cost-high', metric: 'cost_per_hour', operator: 'gt', value: 10, severity: 'critical', message: 'Hourly cost exceeded $10', enabled: true },
      { id: 'latency-high', metric: 'latency_ms', operator: 'gt', value: 5000, severity: 'warning', message: 'Latency above 5s', enabled: true },
      { id: 'error-rate', metric: 'error_rate', operator: 'gt', value: 0.05, severity: 'critical', message: 'Error rate above 5%', enabled: true },
      { id: 'token-usage', metric: 'token_usage_pct', operator: 'gt', value: 90, severity: 'warning', message: 'Token usage above 90%', enabled: true },
      { id: 'queue-depth', metric: 'queue_depth', operator: 'gt', value: 100, severity: 'warning', message: 'Queue depth above 100', enabled: true },
      { id: 'response-time', metric: 'response_time_ms', operator: 'gt', value: 10000, severity: 'critical', message: 'Response time above 10s', enabled: true },
    ],
  };
}

export function createDefaultPagerDutyConfig(): PagerDutyConfig {
  return {
    routingKey: '',
    serviceId: '',
    enabled: false,
    severityMapping: { critical: 'critical', warning: 'warning', info: 'info' },
  };
}

export function createDefaultSlackConfig(): SlackWebhookConfig {
  return {
    webhookUrl: '',
    channel: '#kageops-alerts',
    username: 'KageOps Alert Bot',
    iconEmoji: ':ninja:',
    enabled: false,
  };
}

export function shouldEscalate(event: AlertEvent, state: AlertState): boolean {
  const count = state.recentAlerts.filter((a) => a.thresholdId === event.thresholdId).length;
  return count >= 3;
}

export function resolveAlert(state: AlertState, thresholdId: string): AlertState {
  return {
    ...state,
    activeAlerts: state.activeAlerts.filter((a) => a.thresholdId !== thresholdId),
    recentAlerts: state.recentAlerts.map((a) =>
      a.thresholdId === thresholdId ? { ...a, resolved: true } : a,
    ),
  };
}
