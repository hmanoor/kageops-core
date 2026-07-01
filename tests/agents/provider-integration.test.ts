import { describe, it, expect } from 'vitest';
import {
  PROVIDER_CAPABILITIES,
  createProviderPool,
  updateProviderState,
  markProviderUnavailable,
  markProviderAvailable,
  selectProvider,
  recordRequestMetrics,
  computeProviderStats,
  checkBudget,
  updateBudget,
  createDefaultBudget,
  formatProviderDashboard,
  formatCostDashboard,
  getHealthiestProvider,
  type ProviderPool,
  type RequestMetrics,
  type CostBudget,
} from '../../src/agents/provider-integration';

// ── Helpers ──────────────────────────────────────────────────────────

function makeMetric(overrides: Partial<RequestMetrics> = {}): RequestMetrics {
  return {
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    latencyMs: 200,
    cost: 0.001,
    success: true,
    timestamp: '2026-04-11T00:00:00.000Z',
    ...overrides,
  };
}

// ── PROVIDER_CAPABILITIES ────────────────────────────────────────────

describe('PROVIDER_CAPABILITIES', () => {
  it('should contain 5 providers', () => {
    expect(PROVIDER_CAPABILITIES).toHaveLength(5);
  });

  it('should include all expected providers', () => {
    const names = PROVIDER_CAPABILITIES.map((c) => c.provider);
    expect(names).toEqual(['claude', 'openrouter', 'ollama', 'openai', 'gemini']);
  });

  it('should mark ollama as localOnly', () => {
    const ollama = PROVIDER_CAPABILITIES.find((c) => c.provider === 'ollama');
    expect(ollama?.localOnly).toBe(true);
    expect(ollama?.supportsImages).toBe(false);
  });
});

// ── createProviderPool ───────────────────────────────────────────────

describe('createProviderPool', () => {
  it('should create pool with all providers available', () => {
    const pool = createProviderPool(['claude', 'openai']);
    expect(pool.providers).toHaveLength(2);
    expect(pool.providers[0].status).toBe('available');
    expect(pool.providers[1].status).toBe('available');
    expect(pool.preferredOrder).toEqual(['claude', 'openai']);
  });

  it('should initialize error counts to zero', () => {
    const pool = createProviderPool(['claude']);
    expect(pool.providers[0].errorCount).toBe(0);
    expect(pool.providers[0].requestCount).toBe(0);
    expect(pool.providers[0].lastError).toBeNull();
  });
});

// ── updateProviderState ──────────────────────────────────────────────

describe('updateProviderState', () => {
  it('should return a new pool without mutating original', () => {
    const pool = createProviderPool(['claude', 'openai']);
    const updated = updateProviderState(pool, 'claude', { latencyMs: 500 });
    expect(updated).not.toBe(pool);
    expect(pool.providers[0].latencyMs).toBe(0);
    expect(updated.providers[0].latencyMs).toBe(500);
  });

  it('should not change other providers', () => {
    const pool = createProviderPool(['claude', 'openai']);
    const updated = updateProviderState(pool, 'claude', { status: 'degraded' });
    expect(updated.providers[1].status).toBe('available');
  });
});

// ── markProviderUnavailable / markProviderAvailable ──────────────────

describe('markProviderUnavailable', () => {
  it('should set status to unavailable with error', () => {
    const pool = createProviderPool(['claude']);
    const updated = markProviderUnavailable(pool, 'claude', 'timeout');
    expect(updated.providers[0].status).toBe('unavailable');
    expect(updated.providers[0].lastError).toBe('timeout');
  });
});

describe('markProviderAvailable', () => {
  it('should set status to available and clear error', () => {
    let pool = createProviderPool(['claude']);
    pool = markProviderUnavailable(pool, 'claude', 'timeout');
    const updated = markProviderAvailable(pool, 'claude', 150);
    expect(updated.providers[0].status).toBe('available');
    expect(updated.providers[0].latencyMs).toBe(150);
    expect(updated.providers[0].lastError).toBeNull();
  });
});

// ── selectProvider ───────────────────────────────────────────────────

describe('selectProvider', () => {
  it('should select first available provider', () => {
    const pool = createProviderPool(['claude', 'openai']);
    const decision = selectProvider(pool, {});
    expect(decision.selectedProvider).toBe('claude');
    expect(decision.fallbackProviders).toContain('openai');
  });

  it('should skip unavailable providers', () => {
    let pool = createProviderPool(['claude', 'openai']);
    pool = markProviderUnavailable(pool, 'claude', 'down');
    const decision = selectProvider(pool, {});
    expect(decision.selectedProvider).toBe('openai');
  });

  it('should return empty when no provider matches', () => {
    const pool = createProviderPool(['claude']);
    const decision = selectProvider(pool, { localOnly: true });
    expect(decision.selectedProvider).toBe('');
  });

  it('should filter by localOnly requirement', () => {
    const pool = createProviderPool(['claude', 'ollama']);
    const decision = selectProvider(pool, { localOnly: true });
    expect(decision.selectedProvider).toBe('ollama');
  });

  it('should respect maxLatency filter', () => {
    let pool = createProviderPool(['claude', 'openai']);
    pool = updateProviderState(pool, 'claude', { latencyMs: 5000 });
    pool = updateProviderState(pool, 'openai', { latencyMs: 100 });
    const decision = selectProvider(pool, { maxLatency: 1000 });
    expect(decision.selectedProvider).toBe('openai');
  });
});

// ── recordRequestMetrics ─────────────────────────────────────────────

describe('recordRequestMetrics', () => {
  it('should append metric immutably', () => {
    const original: readonly RequestMetrics[] = [];
    const metric = makeMetric();
    const updated = recordRequestMetrics(original, metric);
    expect(updated).toHaveLength(1);
    expect(original).toHaveLength(0);
  });
});

// ── computeProviderStats ─────────────────────────────────────────────

describe('computeProviderStats', () => {
  it('should return zeros for unknown provider', () => {
    const stats = computeProviderStats([], 'unknown');
    expect(stats).toEqual({ avgLatency: 0, errorRate: 0, totalCost: 0, requestCount: 0 });
  });

  it('should compute correct averages', () => {
    const metrics = [
      makeMetric({ latencyMs: 100, cost: 0.01, success: true }),
      makeMetric({ latencyMs: 300, cost: 0.02, success: false }),
    ];
    const stats = computeProviderStats(metrics, 'claude');
    expect(stats.avgLatency).toBe(200);
    expect(stats.errorRate).toBe(0.5);
    expect(stats.totalCost).toBeCloseTo(0.03);
    expect(stats.requestCount).toBe(2);
  });

  it('should filter by provider', () => {
    const metrics = [
      makeMetric({ provider: 'claude' }),
      makeMetric({ provider: 'openai' }),
    ];
    const stats = computeProviderStats(metrics, 'claude');
    expect(stats.requestCount).toBe(1);
  });
});

// ── Budget ───────────────────────────────────────────────────────────

describe('createDefaultBudget', () => {
  it('should initialize with zero spend', () => {
    const budget = createDefaultBudget(10, 100);
    expect(budget.dailyLimit).toBe(10);
    expect(budget.monthlyLimit).toBe(100);
    expect(budget.currentDaily).toBe(0);
    expect(budget.currentMonthly).toBe(0);
  });
});

describe('checkBudget', () => {
  it('should allow when under budget', () => {
    const budget = createDefaultBudget(10, 100);
    const result = checkBudget(budget, 5);
    expect(result.allowed).toBe(true);
    expect(result.remainingDaily).toBe(10);
  });

  it('should deny when exceeding daily limit', () => {
    const budget: CostBudget = { ...createDefaultBudget(10, 100), currentDaily: 8 };
    const result = checkBudget(budget, 5);
    expect(result.allowed).toBe(false);
  });

  it('should deny when exceeding monthly limit', () => {
    const budget: CostBudget = { ...createDefaultBudget(100, 10), currentMonthly: 8 };
    const result = checkBudget(budget, 5);
    expect(result.allowed).toBe(false);
  });
});

describe('updateBudget', () => {
  it('should add cost immutably', () => {
    const budget = createDefaultBudget(10, 100);
    const updated = updateBudget(budget, 2.5);
    expect(budget.currentDaily).toBe(0);
    expect(updated.currentDaily).toBe(2.5);
    expect(updated.currentMonthly).toBe(2.5);
  });
});

// ── Dashboard Formatting ─────────────────────────────────────────────

describe('formatProviderDashboard', () => {
  it('should produce markdown with status table', () => {
    const pool = createProviderPool(['claude', 'openai']);
    const md = formatProviderDashboard(pool);
    expect(md).toContain('# Provider Status Dashboard');
    expect(md).toContain('claude');
    expect(md).toContain('available');
  });
});

describe('formatCostDashboard', () => {
  it('should show budget and per-provider costs', () => {
    const budget = createDefaultBudget(10, 100);
    const metrics = [makeMetric({ provider: 'claude', cost: 0.05 })];
    const md = formatCostDashboard(budget, metrics);
    expect(md).toContain('# Cost Dashboard');
    expect(md).toContain('claude');
    expect(md).toContain('$0.0500');
  });
});

// ── getHealthiestProvider ────────────────────────────────────────────

describe('getHealthiestProvider', () => {
  it('should return null when all unavailable', () => {
    let pool = createProviderPool(['claude']);
    pool = markProviderUnavailable(pool, 'claude', 'down');
    expect(getHealthiestProvider(pool)).toBeNull();
  });

  it('should return lowest latency provider', () => {
    let pool = createProviderPool(['claude', 'openai']);
    pool = updateProviderState(pool, 'claude', { latencyMs: 500 });
    pool = updateProviderState(pool, 'openai', { latencyMs: 100 });
    expect(getHealthiestProvider(pool)).toBe('openai');
  });
});
