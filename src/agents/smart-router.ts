/**
 * Smart Router — Intelligent Model Routing with Health-Aware Fallback
 *
 * Provides strategy-based model selection, performance tracking,
 * and fallback chains for the KageOps multi-provider AI layer.
 */

// ── Types ────────────────────────────────────────────────────────────

export type RoutingStrategy =
  | 'cost-optimized'
  | 'latency-optimized'
  | 'quality-optimized'
  | 'balanced'
  | 'local-first';

export interface ModelCandidate {
  readonly provider: string;
  readonly model: string;
  readonly estimatedCost: number;
  readonly estimatedLatencyMs: number;
  readonly qualityScore: number;
  readonly available: boolean;
  readonly reason: string;
}

export interface RoutingContext {
  readonly agentRole: string;
  readonly taskType: string;
  readonly sensitivityLevel: string;
  readonly maxBudget: number;
  readonly preferredStrategy: RoutingStrategy;
  readonly excludeProviders: readonly string[];
}

export interface RoutingResult {
  readonly selected: ModelCandidate;
  readonly alternatives: readonly ModelCandidate[];
  readonly strategy: RoutingStrategy;
  readonly decisionReason: string;
  readonly estimatedCost: number;
}

export interface FallbackChain {
  readonly primary: ModelCandidate;
  readonly fallbacks: readonly ModelCandidate[];
  readonly maxRetries: number;
}

export interface ModelPerformanceRecord {
  readonly provider: string;
  readonly model: string;
  readonly avgLatencyMs: number;
  readonly errorRate: number;
  readonly avgCost: number;
  readonly qualityScore: number;
  readonly sampleCount: number;
  readonly lastUsed: string;
}

export interface RoutingHistory {
  readonly decisions: readonly {
    readonly context: RoutingContext;
    readonly result: RoutingResult;
    readonly timestamp: string;
  }[];
  readonly totalDecisions: number;
}

// ── Constants ────────────────────────────────────────────────────────

export const MODEL_CATALOG: readonly ModelCandidate[] = [
  { provider: 'claude', model: 'claude-sonnet-4-20250514', estimatedCost: 3, estimatedLatencyMs: 800, qualityScore: 9, available: true, reason: 'default' },
  { provider: 'claude', model: 'claude-opus-4-20250514', estimatedCost: 15, estimatedLatencyMs: 2000, qualityScore: 10, available: true, reason: 'default' },
  { provider: 'openrouter', model: 'meta-llama/llama-3-70b', estimatedCost: 1, estimatedLatencyMs: 600, qualityScore: 7, available: true, reason: 'default' },
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', estimatedCost: 5, estimatedLatencyMs: 900, qualityScore: 8, available: true, reason: 'default' },
  { provider: 'ollama', model: 'llama3.1', estimatedCost: 0, estimatedLatencyMs: 1200, qualityScore: 6, available: true, reason: 'local' },
  { provider: 'ollama', model: 'codellama', estimatedCost: 0, estimatedLatencyMs: 1000, qualityScore: 5, available: true, reason: 'local' },
  { provider: 'openai', model: 'gpt-4o', estimatedCost: 5, estimatedLatencyMs: 700, qualityScore: 8, available: true, reason: 'default' },
  { provider: 'gemini', model: 'gemini-pro', estimatedCost: 3.5, estimatedLatencyMs: 750, qualityScore: 7, available: true, reason: 'default' },
] as const;

// ── Strategy weights: [cost, latency, quality] ───────────────────────

const STRATEGY_WEIGHTS: Record<RoutingStrategy, readonly [number, number, number]> = {
  'cost-optimized': [0.6, 0.15, 0.25],
  'latency-optimized': [0.1, 0.7, 0.2],
  'quality-optimized': [0.1, 0.1, 0.8],
  'balanced': [0.33, 0.33, 0.34],
  'local-first': [0.5, 0.2, 0.3],
};

// ── Functions ────────────────────────────────────────────────────────

export function scoreCandidate(candidate: ModelCandidate, strategy: RoutingStrategy): number {
  const [wCost, wLatency, wQuality] = STRATEGY_WEIGHTS[strategy];
  const maxCost = 15;
  const maxLatency = 2000;
  const maxQuality = 10;

  const costScore = 1 - candidate.estimatedCost / maxCost;
  const latencyScore = 1 - candidate.estimatedLatencyMs / maxLatency;
  const qualityScore = candidate.qualityScore / maxQuality;

  let score = wCost * costScore + wLatency * latencyScore + wQuality * qualityScore;

  if (strategy === 'local-first' && candidate.estimatedCost === 0) {
    score += 0.3;
  }

  return Math.round(score * 1000) / 1000;
}

export function rankCandidates(
  candidates: readonly ModelCandidate[],
  strategy: RoutingStrategy,
): readonly ModelCandidate[] {
  return [...candidates].sort(
    (a, b) => scoreCandidate(b, strategy) - scoreCandidate(a, strategy),
  );
}

export function filterAvailable(
  candidates: readonly ModelCandidate[],
  excludeProviders: readonly string[],
): readonly ModelCandidate[] {
  return candidates.filter(
    (c) => c.available && !excludeProviders.includes(c.provider),
  );
}

export function selectBestModel(
  context: RoutingContext,
  candidates: readonly ModelCandidate[],
): RoutingResult {
  const available = filterAvailable(candidates, context.excludeProviders);
  const withinBudget = available.filter((c) => c.estimatedCost <= context.maxBudget);
  const pool = withinBudget.length > 0 ? withinBudget : available;
  const ranked = rankCandidates(pool, context.preferredStrategy);

  if (ranked.length === 0) {
    const empty: ModelCandidate = {
      provider: '', model: '', estimatedCost: 0,
      estimatedLatencyMs: 0, qualityScore: 0, available: false,
      reason: 'no candidates available',
    };
    return {
      selected: empty,
      alternatives: [],
      strategy: context.preferredStrategy,
      decisionReason: 'No eligible models found',
      estimatedCost: 0,
    };
  }

  const selected = ranked[0];
  return {
    selected,
    alternatives: ranked.slice(1),
    strategy: context.preferredStrategy,
    decisionReason: `Selected ${selected.provider}/${selected.model} via ${context.preferredStrategy} strategy for ${context.agentRole}`,
    estimatedCost: selected.estimatedCost,
  };
}

export function buildFallbackChain(result: RoutingResult, maxRetries: number): FallbackChain {
  return {
    primary: result.selected,
    fallbacks: result.alternatives.slice(0, maxRetries),
    maxRetries,
  };
}

export function getNextFallback(
  chain: FallbackChain,
  failedProviders: readonly string[],
): ModelCandidate | null {
  const next = chain.fallbacks.find((c) => !failedProviders.includes(c.provider));
  return next ?? null;
}

export function updatePerformanceRecord(
  records: readonly ModelPerformanceRecord[],
  provider: string,
  model: string,
  latencyMs: number,
  cost: number,
  success: boolean,
): readonly ModelPerformanceRecord[] {
  const existing = records.find((r) => r.provider === provider && r.model === model);

  if (existing === undefined) {
    const newRecord: ModelPerformanceRecord = {
      provider, model,
      avgLatencyMs: latencyMs,
      errorRate: success ? 0 : 1,
      avgCost: cost,
      qualityScore: 5,
      sampleCount: 1,
      lastUsed: new Date().toISOString(),
    };
    return [...records, newRecord];
  }

  const n = existing.sampleCount;
  const updated: ModelPerformanceRecord = {
    ...existing,
    avgLatencyMs: (existing.avgLatencyMs * n + latencyMs) / (n + 1),
    errorRate: (existing.errorRate * n + (success ? 0 : 1)) / (n + 1),
    avgCost: (existing.avgCost * n + cost) / (n + 1),
    sampleCount: n + 1,
    lastUsed: new Date().toISOString(),
  };

  return records.map((r) =>
    r.provider === provider && r.model === model ? updated : r,
  );
}

export function getModelPerformance(
  records: readonly ModelPerformanceRecord[],
  provider: string,
  model: string,
): ModelPerformanceRecord | null {
  return records.find((r) => r.provider === provider && r.model === model) ?? null;
}

export function adjustCandidatesFromHistory(
  candidates: readonly ModelCandidate[],
  records: readonly ModelPerformanceRecord[],
): readonly ModelCandidate[] {
  return candidates.map((c) => {
    const perf = getModelPerformance(records, c.provider, c.model);
    if (perf === null || perf.sampleCount < 3) return c;
    return {
      ...c,
      estimatedLatencyMs: Math.round(perf.avgLatencyMs),
      estimatedCost: Math.round(perf.avgCost * 100) / 100,
      available: perf.errorRate < 0.5 ? c.available : false,
      reason: perf.errorRate >= 0.5 ? 'high error rate' : c.reason,
    };
  });
}

export function addRoutingDecision(
  history: RoutingHistory,
  context: RoutingContext,
  result: RoutingResult,
): RoutingHistory {
  return {
    decisions: [
      ...history.decisions,
      { context, result, timestamp: new Date().toISOString() },
    ],
    totalDecisions: history.totalDecisions + 1,
  };
}

export function getStrategyForAgent(agentRole: string): RoutingStrategy {
  const mapping: Record<string, RoutingStrategy> = {
    forge: 'quality-optimized',
    blueprint: 'quality-optimized',
    vigil: 'quality-optimized',
    scout: 'latency-optimized',
    herald: 'latency-optimized',
    aegis: 'cost-optimized',
    cipher: 'balanced',
    pixel: 'balanced',
    sensei: 'balanced',
  };
  return mapping[agentRole] ?? 'balanced';
}

export function estimateRequestCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const catalog = MODEL_CATALOG.find((c) => c.model === model);
  if (catalog === undefined) return 0;
  // estimatedCost is $/MTok, apply to total tokens
  const totalTokens = promptTokens + completionTokens;
  return Math.round((catalog.estimatedCost * totalTokens) / 1_000_000 * 10000) / 10000;
}

export function formatRoutingReport(result: RoutingResult): string {
  const lines = [
    '## Routing Decision',
    '',
    `**Strategy:** ${result.strategy}`,
    `**Selected:** ${result.selected.provider}/${result.selected.model}`,
    `**Estimated Cost:** $${result.estimatedCost}/MTok`,
    `**Reason:** ${result.decisionReason}`,
    '',
    `**Alternatives:** ${result.alternatives.length}`,
  ];

  for (const alt of result.alternatives.slice(0, 3)) {
    lines.push(`- ${alt.provider}/${alt.model} (quality=${alt.qualityScore}, cost=$${alt.estimatedCost})`);
  }

  return lines.join('\n');
}

export function formatPerformanceDashboard(
  records: readonly ModelPerformanceRecord[],
): string {
  const lines = [
    '## Model Performance Dashboard',
    '',
    '| Provider | Model | Avg Latency | Error Rate | Avg Cost | Quality | Samples |',
    '|----------|-------|-------------|------------|----------|---------|---------|',
  ];

  for (const r of records) {
    lines.push(
      `| ${r.provider} | ${r.model} | ${r.avgLatencyMs.toFixed(0)}ms | ${(r.errorRate * 100).toFixed(1)}% | $${r.avgCost.toFixed(4)} | ${r.qualityScore} | ${r.sampleCount} |`,
    );
  }

  return lines.join('\n');
}
