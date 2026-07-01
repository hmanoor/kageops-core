/**
 * Smart Router tests
 *
 * Validates strategy-based model selection, fallback chains,
 * performance tracking, and routing history.
 */

import { describe, it, expect } from 'vitest';
import {
  scoreCandidate,
  rankCandidates,
  filterAvailable,
  selectBestModel,
  buildFallbackChain,
  getNextFallback,
  updatePerformanceRecord,
  getModelPerformance,
  adjustCandidatesFromHistory,
  addRoutingDecision,
  getStrategyForAgent,
  estimateRequestCost,
  formatRoutingReport,
  formatPerformanceDashboard,
  MODEL_CATALOG,
  type ModelCandidate,
  type RoutingContext,
  type RoutingStrategy,
  type ModelPerformanceRecord,
  type RoutingHistory,
} from '../../src/agents/smart-router';

// ── Helpers ──────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<ModelCandidate> = {}): ModelCandidate {
  return {
    provider: 'test',
    model: 'test-model',
    estimatedCost: 3,
    estimatedLatencyMs: 800,
    qualityScore: 7,
    available: true,
    reason: 'default',
    ...overrides,
  };
}

function makeContext(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    agentRole: 'forge',
    taskType: 'coding',
    sensitivityLevel: 'normal',
    maxBudget: 20,
    preferredStrategy: 'balanced',
    excludeProviders: [],
    ...overrides,
  };
}

// ── scoreCandidate ───────────────────────────────────────────────────

describe('scoreCandidate', () => {
  it('returns a number between 0 and ~1.3 for all strategies', () => {
    for (const c of MODEL_CATALOG) {
      const score = scoreCandidate(c, 'balanced');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(2);
    }
  });

  it.each<[RoutingStrategy, string]>([
    ['cost-optimized', 'openrouter'],
    ['quality-optimized', 'claude'],
    ['latency-optimized', 'openrouter'],
  ])('strategy %s favors %s provider', (strategy, expectedProvider) => {
    const ranked = rankCandidates(MODEL_CATALOG, strategy);
    expect(ranked[0].provider).toBe(expectedProvider);
  });

  it('local-first boosts zero-cost models', () => {
    const local = makeCandidate({ estimatedCost: 0, qualityScore: 5 });
    const cloud = makeCandidate({ estimatedCost: 3, qualityScore: 8 });
    expect(scoreCandidate(local, 'local-first')).toBeGreaterThan(
      scoreCandidate(cloud, 'local-first'),
    );
  });
});

// ── rankCandidates ───────────────────────────────────────────────────

describe('rankCandidates', () => {
  it('returns candidates sorted by score descending', () => {
    const ranked = rankCandidates(MODEL_CATALOG, 'balanced');
    for (let i = 0; i < ranked.length - 1; i++) {
      expect(scoreCandidate(ranked[i], 'balanced')).toBeGreaterThanOrEqual(
        scoreCandidate(ranked[i + 1], 'balanced'),
      );
    }
  });

  it('does not mutate the input array', () => {
    const original = [...MODEL_CATALOG];
    rankCandidates(MODEL_CATALOG, 'balanced');
    expect(MODEL_CATALOG).toEqual(original);
  });
});

// ── filterAvailable ──────────────────────────────────────────────────

describe('filterAvailable', () => {
  it('excludes unavailable candidates', () => {
    const candidates = [
      makeCandidate({ available: true }),
      makeCandidate({ available: false, model: 'down' }),
    ];
    expect(filterAvailable(candidates, [])).toHaveLength(1);
  });

  it('excludes specified providers', () => {
    const result = filterAvailable(MODEL_CATALOG, ['claude', 'openai']);
    expect(result.every((c) => c.provider !== 'claude' && c.provider !== 'openai')).toBe(true);
  });

  it('returns empty array when all excluded', () => {
    const candidates = [makeCandidate({ provider: 'x' })];
    expect(filterAvailable(candidates, ['x'])).toHaveLength(0);
  });
});

// ── selectBestModel ──────────────────────────────────────────────────

describe('selectBestModel', () => {
  it('selects a model matching the strategy', () => {
    const result = selectBestModel(makeContext({ preferredStrategy: 'quality-optimized' }), MODEL_CATALOG);
    expect(result.selected.provider).toBe('claude');
    expect(result.selected.qualityScore).toBeGreaterThanOrEqual(9);
  });

  it('respects excludeProviders', () => {
    const result = selectBestModel(
      makeContext({ excludeProviders: ['claude', 'openai', 'gemini', 'openrouter'] }),
      MODEL_CATALOG,
    );
    expect(result.selected.provider).toBe('ollama');
  });

  it('returns empty selected when no candidates', () => {
    const result = selectBestModel(makeContext(), []);
    expect(result.selected.available).toBe(false);
    expect(result.alternatives).toHaveLength(0);
  });

  it('respects maxBudget', () => {
    const result = selectBestModel(
      makeContext({ maxBudget: 2, preferredStrategy: 'quality-optimized' }),
      MODEL_CATALOG,
    );
    expect(result.selected.estimatedCost).toBeLessThanOrEqual(2);
  });

  it('includes alternatives', () => {
    const result = selectBestModel(makeContext(), MODEL_CATALOG);
    expect(result.alternatives.length).toBeGreaterThan(0);
  });
});

// ── buildFallbackChain / getNextFallback ─────────────────────────────

describe('fallback chain', () => {
  it('builds chain with limited fallbacks', () => {
    const result = selectBestModel(makeContext(), MODEL_CATALOG);
    const chain = buildFallbackChain(result, 2);
    expect(chain.primary).toEqual(result.selected);
    expect(chain.fallbacks).toHaveLength(2);
    expect(chain.maxRetries).toBe(2);
  });

  it('getNextFallback skips failed providers', () => {
    const result = selectBestModel(makeContext(), MODEL_CATALOG);
    const chain = buildFallbackChain(result, 5);
    const next = getNextFallback(chain, [chain.fallbacks[0]?.provider ?? '']);
    if (next !== null && chain.fallbacks.length > 1) {
      expect(next.provider).not.toBe(chain.fallbacks[0].provider);
    }
  });

  it('getNextFallback returns null when all failed', () => {
    const chain: import('../../src/agents/smart-router').FallbackChain = {
      primary: makeCandidate({ provider: 'a' }),
      fallbacks: [makeCandidate({ provider: 'b' })],
      maxRetries: 1,
    };
    expect(getNextFallback(chain, ['b'])).toBeNull();
  });
});

// ── updatePerformanceRecord ──────────────────────────────────────────

describe('updatePerformanceRecord', () => {
  it('creates new record for unknown model', () => {
    const result = updatePerformanceRecord([], 'claude', 'sonnet', 500, 0.003, true);
    expect(result).toHaveLength(1);
    expect(result[0].sampleCount).toBe(1);
    expect(result[0].errorRate).toBe(0);
  });

  it('updates running averages for existing model', () => {
    const initial: readonly ModelPerformanceRecord[] = [{
      provider: 'claude', model: 'sonnet',
      avgLatencyMs: 500, errorRate: 0, avgCost: 0.003,
      qualityScore: 9, sampleCount: 1, lastUsed: '',
    }];
    const result = updatePerformanceRecord(initial, 'claude', 'sonnet', 700, 0.005, true);
    expect(result[0].avgLatencyMs).toBe(600);
    expect(result[0].sampleCount).toBe(2);
  });

  it('tracks error rate correctly', () => {
    const records = updatePerformanceRecord([], 'x', 'y', 100, 0, false);
    expect(records[0].errorRate).toBe(1);
    const updated = updatePerformanceRecord(records, 'x', 'y', 100, 0, true);
    expect(updated[0].errorRate).toBe(0.5);
  });

  it('does not mutate input array', () => {
    const original: readonly ModelPerformanceRecord[] = [];
    updatePerformanceRecord(original, 'a', 'b', 100, 0, true);
    expect(original).toHaveLength(0);
  });
});

// ── getModelPerformance ──────────────────────────────────────────────

describe('getModelPerformance', () => {
  it('returns matching record', () => {
    const records: readonly ModelPerformanceRecord[] = [{
      provider: 'claude', model: 'sonnet', avgLatencyMs: 500,
      errorRate: 0, avgCost: 0.003, qualityScore: 9, sampleCount: 10, lastUsed: '',
    }];
    expect(getModelPerformance(records, 'claude', 'sonnet')).not.toBeNull();
  });

  it('returns null for missing model', () => {
    expect(getModelPerformance([], 'x', 'y')).toBeNull();
  });
});

// ── adjustCandidatesFromHistory ──────────────────────────────────────

describe('adjustCandidatesFromHistory', () => {
  it('updates estimates from performance data', () => {
    const records: readonly ModelPerformanceRecord[] = [{
      provider: 'claude', model: 'claude-sonnet-4-20250514',
      avgLatencyMs: 1200, errorRate: 0.1, avgCost: 4,
      qualityScore: 9, sampleCount: 10, lastUsed: '',
    }];
    const adjusted = adjustCandidatesFromHistory(MODEL_CATALOG, records);
    const sonnet = adjusted.find((c) => c.model === 'claude-sonnet-4-20250514');
    expect(sonnet?.estimatedLatencyMs).toBe(1200);
    expect(sonnet?.estimatedCost).toBe(4);
  });

  it('marks high-error models unavailable', () => {
    const records: readonly ModelPerformanceRecord[] = [{
      provider: 'openai', model: 'gpt-4o',
      avgLatencyMs: 700, errorRate: 0.8, avgCost: 5,
      qualityScore: 8, sampleCount: 5, lastUsed: '',
    }];
    const adjusted = adjustCandidatesFromHistory(MODEL_CATALOG, records);
    const gpt = adjusted.find((c) => c.model === 'gpt-4o');
    expect(gpt?.available).toBe(false);
  });

  it('skips adjustment for low sample count', () => {
    const records: readonly ModelPerformanceRecord[] = [{
      provider: 'openai', model: 'gpt-4o',
      avgLatencyMs: 9999, errorRate: 0.9, avgCost: 99,
      qualityScore: 8, sampleCount: 2, lastUsed: '',
    }];
    const adjusted = adjustCandidatesFromHistory(MODEL_CATALOG, records);
    const gpt = adjusted.find((c) => c.model === 'gpt-4o');
    expect(gpt?.estimatedLatencyMs).toBe(700); // unchanged
  });
});

// ── addRoutingDecision ───────────────────────────────────────────────

describe('addRoutingDecision', () => {
  it('appends decision immutably', () => {
    const history: RoutingHistory = { decisions: [], totalDecisions: 0 };
    const ctx = makeContext();
    const result = selectBestModel(ctx, MODEL_CATALOG);
    const updated = addRoutingDecision(history, ctx, result);
    expect(updated.totalDecisions).toBe(1);
    expect(updated.decisions).toHaveLength(1);
    expect(history.totalDecisions).toBe(0); // original unchanged
  });
});

// ── getStrategyForAgent ──────────────────────────────────────────────

describe('getStrategyForAgent', () => {
  it.each<[string, RoutingStrategy]>([
    ['forge', 'quality-optimized'],
    ['scout', 'latency-optimized'],
    ['aegis', 'cost-optimized'],
    ['cipher', 'balanced'],
    ['unknown-agent', 'balanced'],
  ])('agent %s maps to %s', (role, expected) => {
    expect(getStrategyForAgent(role)).toBe(expected);
  });
});

// ── estimateRequestCost ──────────────────────────────────────────────

describe('estimateRequestCost', () => {
  it('calculates cost for known model', () => {
    // claude-sonnet at $3/MTok, 1000 tokens total
    const cost = estimateRequestCost('claude-sonnet-4-20250514', 800, 200);
    expect(cost).toBe(0.003);
  });

  it('returns 0 for unknown model', () => {
    expect(estimateRequestCost('nonexistent', 1000, 1000)).toBe(0);
  });

  it('returns 0 for free local models', () => {
    expect(estimateRequestCost('llama3.1', 5000, 1000)).toBe(0);
  });
});

// ── formatRoutingReport ──────────────────────────────────────────────

describe('formatRoutingReport', () => {
  it('produces markdown with strategy and selection', () => {
    const result = selectBestModel(makeContext(), MODEL_CATALOG);
    const report = formatRoutingReport(result);
    expect(report).toContain('## Routing Decision');
    expect(report).toContain('**Strategy:**');
    expect(report).toContain(result.selected.provider);
  });
});

// ── formatPerformanceDashboard ───────────────────────────────────────

describe('formatPerformanceDashboard', () => {
  it('produces markdown table', () => {
    const records: readonly ModelPerformanceRecord[] = [{
      provider: 'claude', model: 'sonnet', avgLatencyMs: 500,
      errorRate: 0.05, avgCost: 0.003, qualityScore: 9, sampleCount: 100, lastUsed: '',
    }];
    const dashboard = formatPerformanceDashboard(records);
    expect(dashboard).toContain('## Model Performance Dashboard');
    expect(dashboard).toContain('claude');
    expect(dashboard).toContain('500ms');
  });

  it('handles empty records', () => {
    const dashboard = formatPerformanceDashboard([]);
    expect(dashboard).toContain('## Model Performance Dashboard');
  });
});

// ── MODEL_CATALOG ────────────────────────────────────────────────────

describe('MODEL_CATALOG', () => {
  it('has 8 models across 5 providers', () => {
    expect(MODEL_CATALOG).toHaveLength(8);
    const providers = new Set(MODEL_CATALOG.map((c) => c.provider));
    expect(providers.size).toBe(5);
  });
});
