// B-162: Environment Promotion (Staging → Prod)
// B-163: Token Usage / Cost Display Per Test

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Environment = 'development' | 'staging' | 'production';

export interface PromptDeployment {
  readonly deploymentId: string;
  readonly promptId: string;
  readonly versionHash: string;
  readonly environment: Environment;
  readonly deployedAt: string;
  readonly deployedBy: string;
  readonly active: boolean;
  readonly rollbackHash: string | null;
}

export interface PromptEnvironmentState {
  readonly promptId: string;
  readonly environments: Readonly<Record<Environment, PromptDeployment | null>>;
}

export interface PromotionRequest {
  readonly promptId: string;
  readonly versionHash: string;
  readonly fromEnv: Environment;
  readonly toEnv: Environment;
  readonly promotedBy: string;
  readonly reason: string;
}

export interface PromotionResult {
  readonly success: boolean;
  readonly deployment: PromptDeployment | null;
  readonly error: string | null;
  readonly previousHash: string | null;
}

export interface TokenUsageBreakdown {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cachedTokens: number;
}

export interface CostBreakdown {
  readonly promptCost: number;
  readonly completionCost: number;
  readonly totalCost: number;
  readonly currency: string;
}

export interface TestCostRecord {
  readonly testId: string;
  readonly promptId: string;
  readonly model: string;
  readonly tokenUsage: TokenUsageBreakdown;
  readonly cost: CostBreakdown;
  readonly durationMs: number;
  readonly timestamp: string;
}

export interface CostSummary {
  readonly totalTests: number;
  readonly totalCost: CostBreakdown;
  readonly totalTokens: TokenUsageBreakdown;
  readonly avgCostPerTest: number;
  readonly avgTokensPerTest: number;
  readonly modelBreakdown: Readonly<Record<string, { readonly count: number; readonly cost: number; readonly tokens: number }>>;
}

export interface ModelPricing {
  readonly model: string;
  readonly promptPricePerMToken: number;
  readonly completionPricePerMToken: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ENVIRONMENT_ORDER: readonly Environment[] = [
  'development',
  'staging',
  'production',
] as const;

export const DEFAULT_MODEL_PRICING: readonly ModelPricing[] = [
  { model: 'claude-sonnet', promptPricePerMToken: 3.0, completionPricePerMToken: 15.0 },
  { model: 'claude-opus', promptPricePerMToken: 15.0, completionPricePerMToken: 75.0 },
  { model: 'gpt-4o', promptPricePerMToken: 2.5, completionPricePerMToken: 10.0 },
  { model: 'gemini-pro', promptPricePerMToken: 1.25, completionPricePerMToken: 5.0 },
  { model: 'llama-3', promptPricePerMToken: 0.0, completionPricePerMToken: 0.0 },
] as const;

// ---------------------------------------------------------------------------
// Environment Promotion
// ---------------------------------------------------------------------------

export function canPromote(from: Environment, to: Environment): boolean {
  const fromIdx = ENVIRONMENT_ORDER.indexOf(from);
  const toIdx = ENVIRONMENT_ORDER.indexOf(to);
  return fromIdx >= 0 && toIdx >= 0 && toIdx === fromIdx + 1;
}

export function createEnvironmentState(promptId: string): PromptEnvironmentState {
  return {
    promptId,
    environments: {
      development: null,
      staging: null,
      production: null,
    },
  };
}

export function getActiveDeployment(
  state: PromptEnvironmentState,
  environment: Environment,
): PromptDeployment | null {
  const deployment = state.environments[environment];
  return deployment?.active ? deployment : null;
}

export function promotePrompt(
  state: PromptEnvironmentState,
  request: PromotionRequest,
): PromotionResult {
  if (!canPromote(request.fromEnv, request.toEnv)) {
    return {
      success: false,
      deployment: null,
      error: `Cannot promote from ${request.fromEnv} to ${request.toEnv}`,
      previousHash: null,
    };
  }

  const sourceDeployment = state.environments[request.fromEnv];
  if (!sourceDeployment || sourceDeployment.versionHash !== request.versionHash) {
    return {
      success: false,
      deployment: null,
      error: `Version ${request.versionHash} not found in ${request.fromEnv}`,
      previousHash: null,
    };
  }

  const existing = state.environments[request.toEnv];
  const previousHash = existing?.versionHash ?? null;

  const deployment: PromptDeployment = {
    deploymentId: `deploy-${request.toEnv}-${Date.now()}`,
    promptId: request.promptId,
    versionHash: request.versionHash,
    environment: request.toEnv,
    deployedAt: new Date().toISOString(),
    deployedBy: request.promotedBy,
    active: true,
    rollbackHash: previousHash,
  };

  return {
    success: true,
    deployment,
    error: null,
    previousHash,
  };
}

export function rollbackDeployment(
  state: PromptEnvironmentState,
  environment: Environment,
  deployedBy: string,
): PromotionResult {
  const current = state.environments[environment];
  if (!current) {
    return {
      success: false,
      deployment: null,
      error: `No deployment in ${environment}`,
      previousHash: null,
    };
  }

  if (!current.rollbackHash) {
    return {
      success: false,
      deployment: null,
      error: `No rollback hash available for ${environment}`,
      previousHash: current.versionHash,
    };
  }

  const deployment: PromptDeployment = {
    deploymentId: `deploy-${environment}-${Date.now()}`,
    promptId: current.promptId,
    versionHash: current.rollbackHash,
    environment,
    deployedAt: new Date().toISOString(),
    deployedBy,
    active: true,
    rollbackHash: current.versionHash,
  };

  return {
    success: true,
    deployment,
    error: null,
    previousHash: current.versionHash,
  };
}

export function formatDeploymentHistory(deployments: readonly PromptDeployment[]): string {
  if (deployments.length === 0) {
    return '_No deployments recorded._';
  }

  const lines = deployments.map(
    (d) => `| ${d.deployedAt} | ${d.environment} | \`${d.versionHash}\` | ${d.deployedBy} | ${d.active ? 'active' : 'inactive'} |`,
  );

  return [
    '| Deployed At | Environment | Version | Deployed By | Status |',
    '|-------------|-------------|---------|-------------|--------|',
    ...lines,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Token / Cost Tracking
// ---------------------------------------------------------------------------

export function calculateTokenCost(
  usage: TokenUsageBreakdown,
  pricing: ModelPricing,
): CostBreakdown {
  const effectivePromptTokens = usage.promptTokens - usage.cachedTokens;
  const promptCost = (effectivePromptTokens / 1_000_000) * pricing.promptPricePerMToken;
  const completionCost = (usage.completionTokens / 1_000_000) * pricing.completionPricePerMToken;

  return {
    promptCost,
    completionCost,
    totalCost: promptCost + completionCost,
    currency: 'USD',
  };
}

export function recordTestCost(
  testId: string,
  promptId: string,
  model: string,
  usage: TokenUsageBreakdown,
  pricing: ModelPricing,
  durationMs: number,
): TestCostRecord {
  return {
    testId,
    promptId,
    model,
    tokenUsage: usage,
    cost: calculateTokenCost(usage, pricing),
    durationMs,
    timestamp: new Date().toISOString(),
  };
}

export function computeCostSummary(records: readonly TestCostRecord[]): CostSummary {
  if (records.length === 0) {
    return {
      totalTests: 0,
      totalCost: { promptCost: 0, completionCost: 0, totalCost: 0, currency: 'USD' },
      totalTokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
      avgCostPerTest: 0,
      avgTokensPerTest: 0,
      modelBreakdown: {},
    };
  }

  const totals = records.reduce(
    (acc, r) => ({
      promptCost: acc.promptCost + r.cost.promptCost,
      completionCost: acc.completionCost + r.cost.completionCost,
      totalCost: acc.totalCost + r.cost.totalCost,
      promptTokens: acc.promptTokens + r.tokenUsage.promptTokens,
      completionTokens: acc.completionTokens + r.tokenUsage.completionTokens,
      totalTokens: acc.totalTokens + r.tokenUsage.totalTokens,
      cachedTokens: acc.cachedTokens + r.tokenUsage.cachedTokens,
    }),
    { promptCost: 0, completionCost: 0, totalCost: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
  );

  const modelBreakdown: Record<string, { count: number; cost: number; tokens: number }> = {};
  for (const r of records) {
    const existing = modelBreakdown[r.model] ?? { count: 0, cost: 0, tokens: 0 };
    modelBreakdown[r.model] = {
      count: existing.count + 1,
      cost: existing.cost + r.cost.totalCost,
      tokens: existing.tokens + r.tokenUsage.totalTokens,
    };
  }

  return {
    totalTests: records.length,
    totalCost: {
      promptCost: totals.promptCost,
      completionCost: totals.completionCost,
      totalCost: totals.totalCost,
      currency: 'USD',
    },
    totalTokens: {
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
      cachedTokens: totals.cachedTokens,
    },
    avgCostPerTest: totals.totalCost / records.length,
    avgTokensPerTest: totals.totalTokens / records.length,
    modelBreakdown,
  };
}

export function formatCostReport(summary: CostSummary): string {
  const lines: string[] = [
    '## Cost Summary',
    '',
    `- **Total tests:** ${summary.totalTests}`,
    `- **Total cost:** $${summary.totalCost.totalCost.toFixed(4)} ${summary.totalCost.currency}`,
    `- **Total tokens:** ${summary.totalTokens.totalTokens.toLocaleString()}`,
    `- **Avg cost/test:** $${summary.avgCostPerTest.toFixed(4)}`,
    `- **Avg tokens/test:** ${Math.round(summary.avgTokensPerTest).toLocaleString()}`,
    '',
    '### Model Breakdown',
    '',
    '| Model | Tests | Cost | Tokens |',
    '|-------|-------|------|--------|',
  ];

  for (const [model, data] of Object.entries(summary.modelBreakdown)) {
    lines.push(`| ${model} | ${data.count} | $${data.cost.toFixed(4)} | ${data.tokens.toLocaleString()} |`);
  }

  return lines.join('\n');
}

export function formatTestCostLine(record: TestCostRecord): string {
  return `[${record.model}] ${record.tokenUsage.totalTokens} tokens — $${record.cost.totalCost.toFixed(4)} (${record.durationMs}ms)`;
}
