import { describe, it, expect } from 'vitest';
import {
  type Environment,
  type PromptEnvironmentState,
  type PromptDeployment,
  type TokenUsageBreakdown,
  type TestCostRecord,
  ENVIRONMENT_ORDER,
  DEFAULT_MODEL_PRICING,
  canPromote,
  createEnvironmentState,
  getActiveDeployment,
  promotePrompt,
  rollbackDeployment,
  formatDeploymentHistory,
  calculateTokenCost,
  recordTestCost,
  computeCostSummary,
  formatCostReport,
  formatTestCostLine,
} from '../../src/prompts/prompt-environment';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(prompt = 1000, completion = 500, cached = 0): TokenUsageBreakdown {
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, cachedTokens: cached };
}

function makeDeployment(overrides: Partial<PromptDeployment> = {}): PromptDeployment {
  return {
    deploymentId: 'deploy-1',
    promptId: 'p1',
    versionHash: 'abc123',
    environment: 'development',
    deployedAt: '2026-01-01T00:00:00Z',
    deployedBy: 'alice',
    active: true,
    rollbackHash: null,
    ...overrides,
  };
}

function stateWithDeployment(env: Environment, dep: PromptDeployment): PromptEnvironmentState {
  const base = createEnvironmentState(dep.promptId);
  return { ...base, environments: { ...base.environments, [env]: dep } };
}

// ---------------------------------------------------------------------------
// ENVIRONMENT_ORDER
// ---------------------------------------------------------------------------

describe('ENVIRONMENT_ORDER', () => {
  it('has three environments in correct order', () => {
    expect(ENVIRONMENT_ORDER).toEqual(['development', 'staging', 'production']);
  });
});

// ---------------------------------------------------------------------------
// canPromote
// ---------------------------------------------------------------------------

describe('canPromote', () => {
  it.each<[Environment, Environment, boolean]>([
    ['development', 'staging', true],
    ['staging', 'production', true],
    ['development', 'production', false],
    ['production', 'staging', false],
    ['staging', 'development', false],
    ['production', 'development', false],
    ['development', 'development', false],
    ['staging', 'staging', false],
    ['production', 'production', false],
  ])('canPromote(%s, %s) === %s', (from, to, expected) => {
    expect(canPromote(from, to)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// createEnvironmentState
// ---------------------------------------------------------------------------

describe('createEnvironmentState', () => {
  it('creates empty state for all environments', () => {
    const state = createEnvironmentState('prompt-1');
    expect(state.promptId).toBe('prompt-1');
    expect(state.environments.development).toBeNull();
    expect(state.environments.staging).toBeNull();
    expect(state.environments.production).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// promotePrompt
// ---------------------------------------------------------------------------

describe('promotePrompt', () => {
  it('promotes dev to staging and sets rollbackHash', () => {
    const dep = makeDeployment({ environment: 'development', versionHash: 'v1' });
    const state = stateWithDeployment('development', dep);
    const result = promotePrompt(state, {
      promptId: 'p1',
      versionHash: 'v1',
      fromEnv: 'development',
      toEnv: 'staging',
      promotedBy: 'bob',
      reason: 'ready',
    });
    expect(result.success).toBe(true);
    expect(result.deployment?.environment).toBe('staging');
    expect(result.deployment?.versionHash).toBe('v1');
    expect(result.deployment?.active).toBe(true);
    expect(result.previousHash).toBeNull();
  });

  it('sets previousHash when target already has a deployment', () => {
    const devDep = makeDeployment({ environment: 'development', versionHash: 'v2' });
    const stageDep = makeDeployment({ environment: 'staging', versionHash: 'v1' });
    const state: PromptEnvironmentState = {
      promptId: 'p1',
      environments: { development: devDep, staging: stageDep, production: null },
    };
    const result = promotePrompt(state, {
      promptId: 'p1',
      versionHash: 'v2',
      fromEnv: 'development',
      toEnv: 'staging',
      promotedBy: 'bob',
      reason: 'update',
    });
    expect(result.success).toBe(true);
    expect(result.previousHash).toBe('v1');
    expect(result.deployment?.rollbackHash).toBe('v1');
  });

  it('fails for backward promotion', () => {
    const dep = makeDeployment({ environment: 'staging', versionHash: 'v1' });
    const state = stateWithDeployment('staging', dep);
    const result = promotePrompt(state, {
      promptId: 'p1',
      versionHash: 'v1',
      fromEnv: 'staging',
      toEnv: 'development',
      promotedBy: 'bob',
      reason: 'nope',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot promote');
  });

  it('fails when version hash does not match source', () => {
    const dep = makeDeployment({ environment: 'development', versionHash: 'v1' });
    const state = stateWithDeployment('development', dep);
    const result = promotePrompt(state, {
      promptId: 'p1',
      versionHash: 'wrong-hash',
      fromEnv: 'development',
      toEnv: 'staging',
      promotedBy: 'bob',
      reason: 'mismatch',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// rollbackDeployment
// ---------------------------------------------------------------------------

describe('rollbackDeployment', () => {
  it('restores previous hash', () => {
    const dep = makeDeployment({ environment: 'staging', versionHash: 'v2', rollbackHash: 'v1' });
    const state = stateWithDeployment('staging', dep);
    const result = rollbackDeployment(state, 'staging', 'carol');
    expect(result.success).toBe(true);
    expect(result.deployment?.versionHash).toBe('v1');
    expect(result.deployment?.rollbackHash).toBe('v2');
    expect(result.previousHash).toBe('v2');
  });

  it('fails when no deployment exists', () => {
    const state = createEnvironmentState('p1');
    const result = rollbackDeployment(state, 'production', 'carol');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No deployment');
  });

  it('fails when no rollback hash available', () => {
    const dep = makeDeployment({ environment: 'staging', rollbackHash: null });
    const state = stateWithDeployment('staging', dep);
    const result = rollbackDeployment(state, 'staging', 'carol');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No rollback hash');
  });
});

// ---------------------------------------------------------------------------
// getActiveDeployment
// ---------------------------------------------------------------------------

describe('getActiveDeployment', () => {
  it('returns active deployment', () => {
    const dep = makeDeployment({ active: true, environment: 'production' });
    const state = stateWithDeployment('production', dep);
    expect(getActiveDeployment(state, 'production')).toEqual(dep);
  });

  it('returns null for inactive deployment', () => {
    const dep = makeDeployment({ active: false, environment: 'production' });
    const state = stateWithDeployment('production', dep);
    expect(getActiveDeployment(state, 'production')).toBeNull();
  });

  it('returns null for empty environment', () => {
    const state = createEnvironmentState('p1');
    expect(getActiveDeployment(state, 'development')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatDeploymentHistory
// ---------------------------------------------------------------------------

describe('formatDeploymentHistory', () => {
  it('returns placeholder for empty list', () => {
    expect(formatDeploymentHistory([])).toContain('No deployments');
  });

  it('produces markdown table', () => {
    const deps = [makeDeployment(), makeDeployment({ deploymentId: 'deploy-2', versionHash: 'def456' })];
    const md = formatDeploymentHistory(deps);
    expect(md).toContain('Environment');
    expect(md).toContain('abc123');
    expect(md).toContain('def456');
  });
});

// ---------------------------------------------------------------------------
// calculateTokenCost
// ---------------------------------------------------------------------------

describe('calculateTokenCost', () => {
  it('computes correct costs', () => {
    const usage = makeUsage(1_000_000, 500_000, 0);
    const pricing = { model: 'claude-sonnet', promptPricePerMToken: 3.0, completionPricePerMToken: 15.0 };
    const cost = calculateTokenCost(usage, pricing);
    expect(cost.promptCost).toBeCloseTo(3.0);
    expect(cost.completionCost).toBeCloseTo(7.5);
    expect(cost.totalCost).toBeCloseTo(10.5);
    expect(cost.currency).toBe('USD');
  });

  it('subtracts cached tokens from prompt cost', () => {
    const usage = makeUsage(1_000_000, 0, 400_000);
    const pricing = { model: 'test', promptPricePerMToken: 10.0, completionPricePerMToken: 0 };
    const cost = calculateTokenCost(usage, pricing);
    expect(cost.promptCost).toBeCloseTo(6.0); // (1M - 400k) / 1M * 10
  });

  it.each(DEFAULT_MODEL_PRICING.map((p) => [p.model, p.promptPricePerMToken, p.completionPricePerMToken] as const))(
    'pricing for %s uses prompt=$%d/M completion=$%d/M',
    (model, promptPrice, completionPrice) => {
      expect(promptPrice).toBeGreaterThanOrEqual(0);
      expect(completionPrice).toBeGreaterThanOrEqual(0);
    },
  );
});

// ---------------------------------------------------------------------------
// DEFAULT_MODEL_PRICING
// ---------------------------------------------------------------------------

describe('DEFAULT_MODEL_PRICING', () => {
  it('has entries for all expected models', () => {
    const models = DEFAULT_MODEL_PRICING.map((p) => p.model);
    expect(models).toContain('claude-sonnet');
    expect(models).toContain('claude-opus');
    expect(models).toContain('gpt-4o');
    expect(models).toContain('gemini-pro');
    expect(models).toContain('llama-3');
  });
});

// ---------------------------------------------------------------------------
// recordTestCost
// ---------------------------------------------------------------------------

describe('recordTestCost', () => {
  it('creates a cost record with computed cost', () => {
    const usage = makeUsage(2000, 1000, 0);
    const pricing = DEFAULT_MODEL_PRICING[0];
    const record = recordTestCost('t1', 'p1', pricing.model, usage, pricing, 150);
    expect(record.testId).toBe('t1');
    expect(record.cost.totalCost).toBeGreaterThan(0);
    expect(record.durationMs).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// computeCostSummary
// ---------------------------------------------------------------------------

describe('computeCostSummary', () => {
  it('returns zeroed summary for empty records', () => {
    const summary = computeCostSummary([]);
    expect(summary.totalTests).toBe(0);
    expect(summary.totalCost.totalCost).toBe(0);
    expect(summary.avgCostPerTest).toBe(0);
  });

  it('aggregates multiple records correctly', () => {
    const pricing = DEFAULT_MODEL_PRICING[0];
    const r1 = recordTestCost('t1', 'p1', pricing.model, makeUsage(1000, 500), pricing, 100);
    const r2 = recordTestCost('t2', 'p1', pricing.model, makeUsage(2000, 1000), pricing, 200);
    const summary = computeCostSummary([r1, r2]);
    expect(summary.totalTests).toBe(2);
    expect(summary.totalCost.totalCost).toBeCloseTo(r1.cost.totalCost + r2.cost.totalCost);
    expect(summary.totalTokens.totalTokens).toBe(4500);
    expect(summary.avgTokensPerTest).toBe(2250);
  });

  it('builds model breakdown', () => {
    const sonnet = DEFAULT_MODEL_PRICING[0];
    const opus = DEFAULT_MODEL_PRICING[1];
    const r1 = recordTestCost('t1', 'p1', sonnet.model, makeUsage(1000, 500), sonnet, 100);
    const r2 = recordTestCost('t2', 'p1', opus.model, makeUsage(1000, 500), opus, 100);
    const summary = computeCostSummary([r1, r2]);
    expect(Object.keys(summary.modelBreakdown)).toHaveLength(2);
    expect(summary.modelBreakdown['claude-sonnet'].count).toBe(1);
    expect(summary.modelBreakdown['claude-opus'].count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatCostReport
// ---------------------------------------------------------------------------

describe('formatCostReport', () => {
  it('produces readable markdown with model breakdown', () => {
    const pricing = DEFAULT_MODEL_PRICING[0];
    const r1 = recordTestCost('t1', 'p1', pricing.model, makeUsage(1000, 500), pricing, 100);
    const summary = computeCostSummary([r1]);
    const report = formatCostReport(summary);
    expect(report).toContain('## Cost Summary');
    expect(report).toContain('Model Breakdown');
    expect(report).toContain('claude-sonnet');
    expect(report).toContain('$');
  });
});

// ---------------------------------------------------------------------------
// formatTestCostLine
// ---------------------------------------------------------------------------

describe('formatTestCostLine', () => {
  it('formats single-line cost display', () => {
    const pricing = DEFAULT_MODEL_PRICING[0];
    const record = recordTestCost('t1', 'p1', pricing.model, makeUsage(1000, 500), pricing, 250);
    const line = formatTestCostLine(record);
    expect(line).toContain('[claude-sonnet]');
    expect(line).toContain('1500 tokens');
    expect(line).toContain('250ms');
    expect(line).toContain('$');
  });
});
