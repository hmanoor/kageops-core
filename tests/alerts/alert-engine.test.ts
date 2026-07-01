import { describe, it, expect } from 'vitest';
import {
  evaluateThreshold,
  checkAllThresholds,
  updateAlertState,
  isInCooldown,
  buildPagerDutyPayload,
  buildSlackPayload,
  formatAlertMessage,
  formatAlertDashboard,
  createDefaultAlertConfig,
  createDefaultPagerDutyConfig,
  createDefaultSlackConfig,
  severityToColor,
  shouldEscalate,
  resolveAlert,
  type AlertThreshold,
  type AlertEvent,
  type AlertState,
  type PagerDutyConfig,
  type SlackWebhookConfig,
} from '../../src/alerts/alert-engine';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeThreshold(overrides: Partial<AlertThreshold> = {}): AlertThreshold {
  return {
    id: 'test-threshold',
    metric: 'cpu',
    operator: 'gt',
    value: 80,
    severity: 'warning',
    message: 'CPU high',
    enabled: true,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    thresholdId: 'test-threshold',
    metric: 'cpu',
    currentValue: 95,
    thresholdValue: 80,
    severity: 'warning',
    message: 'CPU high',
    triggeredAt: new Date().toISOString(),
    resolved: false,
    ...overrides,
  };
}

function makeState(overrides: Partial<AlertState> = {}): AlertState {
  return {
    activeAlerts: [],
    recentAlerts: [],
    lastChecked: new Date().toISOString(),
    suppressedCount: 0,
    ...overrides,
  };
}

// ─── evaluateThreshold ──────────────────────────────────────────────

describe('evaluateThreshold', () => {
  it.each([
    { operator: 'gt' as const, value: 80, current: 90, expected: true },
    { operator: 'gt' as const, value: 80, current: 80, expected: false },
    { operator: 'gt' as const, value: 80, current: 70, expected: false },
    { operator: 'lt' as const, value: 80, current: 70, expected: true },
    { operator: 'lt' as const, value: 80, current: 80, expected: false },
    { operator: 'lt' as const, value: 80, current: 90, expected: false },
    { operator: 'gte' as const, value: 80, current: 80, expected: true },
    { operator: 'gte' as const, value: 80, current: 90, expected: true },
    { operator: 'gte' as const, value: 80, current: 70, expected: false },
    { operator: 'lte' as const, value: 80, current: 80, expected: true },
    { operator: 'lte' as const, value: 80, current: 70, expected: true },
    { operator: 'lte' as const, value: 80, current: 90, expected: false },
    { operator: 'eq' as const, value: 80, current: 80, expected: true },
    { operator: 'eq' as const, value: 80, current: 81, expected: false },
  ])('$operator: $current vs $value → $expected', ({ operator, value, current, expected }) => {
    const threshold = makeThreshold({ operator, value });
    expect(evaluateThreshold(threshold, current)).toBe(expected);
  });
});

// ─── checkAllThresholds ─────────────────────────────────────────────

describe('checkAllThresholds', () => {
  it('returns events for triggered thresholds', () => {
    const config = {
      thresholds: [makeThreshold({ id: 'a', metric: 'cpu', operator: 'gt', value: 80 })],
      cooldownMs: 60000,
      maxAlertsPerHour: 50,
    };
    const events = checkAllThresholds(config, { cpu: 95 });
    expect(events).toHaveLength(1);
    expect(events[0].thresholdId).toBe('a');
    expect(events[0].currentValue).toBe(95);
  });

  it('skips disabled thresholds', () => {
    const config = {
      thresholds: [makeThreshold({ enabled: false })],
      cooldownMs: 60000,
      maxAlertsPerHour: 50,
    };
    expect(checkAllThresholds(config, { cpu: 95 })).toHaveLength(0);
  });

  it('skips thresholds with missing metrics', () => {
    const config = {
      thresholds: [makeThreshold({ metric: 'cpu' })],
      cooldownMs: 60000,
      maxAlertsPerHour: 50,
    };
    expect(checkAllThresholds(config, { memory: 95 })).toHaveLength(0);
  });

  it('skips thresholds that do not trigger', () => {
    const config = {
      thresholds: [makeThreshold({ operator: 'gt', value: 80 })],
      cooldownMs: 60000,
      maxAlertsPerHour: 50,
    };
    expect(checkAllThresholds(config, { cpu: 50 })).toHaveLength(0);
  });
});

// ─── isInCooldown ───────────────────────────────────────────────────

describe('isInCooldown', () => {
  it('returns true within cooldown window', () => {
    const now = new Date();
    const recent = makeEvent({ triggeredAt: new Date(now.getTime() - 1000).toISOString() });
    const current = makeEvent({ triggeredAt: now.toISOString() });
    expect(isInCooldown(current, [recent], 60000)).toBe(true);
  });

  it('returns false outside cooldown window', () => {
    const now = new Date();
    const old = makeEvent({ triggeredAt: new Date(now.getTime() - 120000).toISOString() });
    const current = makeEvent({ triggeredAt: now.toISOString() });
    expect(isInCooldown(current, [old], 60000)).toBe(false);
  });

  it('returns false for different threshold ids', () => {
    const now = new Date();
    const recent = makeEvent({ thresholdId: 'other', triggeredAt: new Date(now.getTime() - 1000).toISOString() });
    const current = makeEvent({ triggeredAt: now.toISOString() });
    expect(isInCooldown(current, [recent], 60000)).toBe(false);
  });
});

// ─── updateAlertState ───────────────────────────────────────────────

describe('updateAlertState', () => {
  it('adds non-cooldown events to state', () => {
    const state = makeState();
    const events = [makeEvent()];
    const result = updateAlertState(state, events, 60000);
    expect(result.activeAlerts).toHaveLength(1);
    expect(result.recentAlerts).toHaveLength(1);
  });

  it('suppresses cooldown events and increments count', () => {
    const now = new Date();
    const recent = makeEvent({ triggeredAt: new Date(now.getTime() - 1000).toISOString() });
    const state = makeState({ recentAlerts: [recent] });
    const dup = makeEvent({ triggeredAt: now.toISOString() });
    const result = updateAlertState(state, [dup], 60000);
    expect(result.activeAlerts).toHaveLength(0);
    expect(result.suppressedCount).toBe(1);
  });

  it('does not mutate the original state', () => {
    const state = makeState();
    const events = [makeEvent()];
    const result = updateAlertState(state, events, 60000);
    expect(state.activeAlerts).toHaveLength(0);
    expect(result.activeAlerts).toHaveLength(1);
  });
});

// ─── buildPagerDutyPayload ──────────────────────────────────────────

describe('buildPagerDutyPayload', () => {
  const pdConfig: PagerDutyConfig = {
    routingKey: 'test-key',
    serviceId: 'svc-1',
    enabled: true,
    severityMapping: { critical: 'critical', warning: 'warning', info: 'info' },
  };

  it('has correct routing key and event action', () => {
    const payload = buildPagerDutyPayload(makeEvent(), pdConfig);
    expect(payload.routing_key).toBe('test-key');
    expect(payload.event_action).toBe('trigger');
  });

  it('maps severity correctly', () => {
    const event = makeEvent({ severity: 'critical' });
    const payload = buildPagerDutyPayload(event, pdConfig);
    expect(payload.payload.severity).toBe('critical');
  });

  it('includes custom details with metric info', () => {
    const payload = buildPagerDutyPayload(makeEvent(), pdConfig);
    expect(payload.payload.custom_details.metric).toBe('cpu');
    expect(payload.payload.custom_details.current_value).toBe(95);
  });

  it('sets source to kageops-{metric}', () => {
    const payload = buildPagerDutyPayload(makeEvent({ metric: 'latency' }), pdConfig);
    expect(payload.payload.source).toBe('kageops-latency');
  });
});

// ─── buildSlackPayload ──────────────────────────────────────────────

describe('buildSlackPayload', () => {
  const slackConfig: SlackWebhookConfig = {
    webhookUrl: 'https://hooks.slack.com/test',
    channel: '#alerts',
    username: 'Bot',
    iconEmoji: ':robot:',
    enabled: true,
  };

  it('sets channel and username from config', () => {
    const payload = buildSlackPayload(makeEvent(), slackConfig);
    expect(payload.channel).toBe('#alerts');
    expect(payload.username).toBe('Bot');
  });

  it('has color-coded attachment for critical', () => {
    const event = makeEvent({ severity: 'critical' });
    const payload = buildSlackPayload(event, slackConfig);
    expect(payload.attachments[0].color).toBe('#FF0000');
  });

  it('has color-coded attachment for warning', () => {
    const event = makeEvent({ severity: 'warning' });
    const payload = buildSlackPayload(event, slackConfig);
    expect(payload.attachments[0].color).toBe('#FFA500');
  });

  it('includes fields for current value and threshold', () => {
    const payload = buildSlackPayload(makeEvent(), slackConfig);
    const fields = payload.attachments[0].fields;
    expect(fields).toHaveLength(2);
    expect(fields[0].title).toBe('Current Value');
    expect(fields[1].title).toBe('Threshold');
  });
});

// ─── severityToColor ────────────────────────────────────────────────

describe('severityToColor', () => {
  it.each([
    { severity: 'critical', color: '#FF0000' },
    { severity: 'warning', color: '#FFA500' },
    { severity: 'info', color: '#0000FF' },
    { severity: 'unknown', color: '#808080' },
  ])('$severity → $color', ({ severity, color }) => {
    expect(severityToColor(severity)).toBe(color);
  });
});

// ─── formatAlertMessage ─────────────────────────────────────────────

describe('formatAlertMessage', () => {
  it('includes severity, metric, values, and message', () => {
    const msg = formatAlertMessage(makeEvent({ severity: 'critical', metric: 'cpu', currentValue: 95, thresholdValue: 80, message: 'CPU high' }));
    expect(msg).toContain('[CRITICAL]');
    expect(msg).toContain('cpu');
    expect(msg).toContain('95');
    expect(msg).toContain('80');
    expect(msg).toContain('CPU high');
  });
});

// ─── formatAlertDashboard ───────────────────────────────────────────

describe('formatAlertDashboard', () => {
  it('shows no active alerts message when empty', () => {
    const md = formatAlertDashboard(makeState());
    expect(md).toContain('No active alerts.');
  });

  it('lists active alerts', () => {
    const state = makeState({ activeAlerts: [makeEvent()] });
    const md = formatAlertDashboard(state);
    expect(md).toContain('## Active Alerts');
    expect(md).toContain('[WARNING]');
  });

  it('shows resolved status in recent alerts', () => {
    const state = makeState({ recentAlerts: [makeEvent({ resolved: true })] });
    const md = formatAlertDashboard(state);
    expect(md).toContain('[✓]');
  });

  it('shows suppressed count', () => {
    const md = formatAlertDashboard(makeState({ suppressedCount: 5 }));
    expect(md).toContain('Suppressed: 5');
  });
});

// ─── shouldEscalate ─────────────────────────────────────────────────

describe('shouldEscalate', () => {
  it('returns true when 3+ recent alerts with same threshold', () => {
    const event = makeEvent();
    const state = makeState({
      recentAlerts: [makeEvent(), makeEvent(), makeEvent()],
    });
    expect(shouldEscalate(event, state)).toBe(true);
  });

  it('returns false with fewer than 3 occurrences', () => {
    const event = makeEvent();
    const state = makeState({ recentAlerts: [makeEvent(), makeEvent()] });
    expect(shouldEscalate(event, state)).toBe(false);
  });

  it('only counts matching threshold ids', () => {
    const event = makeEvent({ thresholdId: 'target' });
    const state = makeState({
      recentAlerts: [
        makeEvent({ thresholdId: 'other' }),
        makeEvent({ thresholdId: 'other' }),
        makeEvent({ thresholdId: 'other' }),
      ],
    });
    expect(shouldEscalate(event, state)).toBe(false);
  });
});

// ─── resolveAlert ───────────────────────────────────────────────────

describe('resolveAlert', () => {
  it('removes from active and marks resolved in recent', () => {
    const state = makeState({
      activeAlerts: [makeEvent({ thresholdId: 'a' }), makeEvent({ thresholdId: 'b' })],
      recentAlerts: [makeEvent({ thresholdId: 'a' }), makeEvent({ thresholdId: 'b' })],
    });
    const result = resolveAlert(state, 'a');
    expect(result.activeAlerts).toHaveLength(1);
    expect(result.activeAlerts[0].thresholdId).toBe('b');
    expect(result.recentAlerts.find((a) => a.thresholdId === 'a')?.resolved).toBe(true);
  });

  it('does not mutate original state', () => {
    const state = makeState({ activeAlerts: [makeEvent()] });
    const result = resolveAlert(state, 'test-threshold');
    expect(state.activeAlerts).toHaveLength(1);
    expect(result.activeAlerts).toHaveLength(0);
  });
});

// ─── Default configs ────────────────────────────────────────────────

describe('default configs', () => {
  it('createDefaultAlertConfig has 6 thresholds', () => {
    const config = createDefaultAlertConfig();
    expect(config.thresholds).toHaveLength(6);
    expect(config.thresholds.every((t) => t.enabled)).toBe(true);
  });

  it('createDefaultPagerDutyConfig is disabled by default', () => {
    const config = createDefaultPagerDutyConfig();
    expect(config.enabled).toBe(false);
    expect(config.severityMapping).toHaveProperty('critical');
  });

  it('createDefaultSlackConfig is disabled with defaults', () => {
    const config = createDefaultSlackConfig();
    expect(config.enabled).toBe(false);
    expect(config.channel).toBe('#kageops-alerts');
  });
});
