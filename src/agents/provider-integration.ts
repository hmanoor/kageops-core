/**
 * Provider Integration Layer
 *
 * Bridges metric-aggregator health monitoring and prompt-environment cost tracking
 * into the AI provider layer. Provides provider pool management, routing decisions,
 * request metrics, and cost budget enforcement.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface ProviderState {
  readonly provider: string;
  readonly status: 'available' | 'degraded' | 'unavailable';
  readonly latencyMs: number;
  readonly errorCount: number;
  readonly requestCount: number;
  readonly lastError: string | null;
  readonly lastChecked: string;
}

export interface ProviderPool {
  readonly providers: readonly ProviderState[];
  readonly preferredOrder: readonly string[];
  readonly lastRotation: string;
}

export interface RequestMetrics {
  readonly provider: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
  readonly cost: number;
  readonly success: boolean;
  readonly timestamp: string;
}

export interface CostBudget {
  readonly dailyLimit: number;
  readonly monthlyLimit: number;
  readonly currentDaily: number;
  readonly currentMonthly: number;
  readonly resetDate: string;
}

export interface RoutingDecision {
  readonly selectedProvider: string;
  readonly selectedModel: string;
  readonly reason: string;
  readonly fallbackProviders: readonly string[];
  readonly estimatedCost: number;
}

export interface ProviderCapability {
  readonly provider: string;
  readonly models: readonly string[];
  readonly supportsStreaming: boolean;
  readonly supportsImages: boolean;
  readonly maxContextTokens: number;
  readonly localOnly: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

export const PROVIDER_CAPABILITIES: readonly ProviderCapability[] = [
  {
    provider: 'claude',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-35-20241022', 'claude-opus-4-20250514'],
    supportsStreaming: true,
    supportsImages: true,
    maxContextTokens: 200000,
    localOnly: false,
  },
  {
    provider: 'openrouter',
    models: ['anthropic/claude-sonnet-4', 'meta-llama/llama-3-70b', 'google/gemini-pro'],
    supportsStreaming: true,
    supportsImages: true,
    maxContextTokens: 128000,
    localOnly: false,
  },
  {
    provider: 'ollama',
    models: ['llama3', 'codellama', 'mistral'],
    supportsStreaming: true,
    supportsImages: false,
    maxContextTokens: 8192,
    localOnly: true,
  },
  {
    provider: 'openai',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1-preview'],
    supportsStreaming: true,
    supportsImages: true,
    maxContextTokens: 128000,
    localOnly: false,
  },
  {
    provider: 'gemini',
    models: ['gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-1.5-pro'],
    supportsStreaming: true,
    supportsImages: true,
    maxContextTokens: 1000000,
    localOnly: false,
  },
] as const;

// ── Provider Pool ────────────────────────────────────────────────────

export function createProviderPool(providers: readonly string[]): ProviderPool {
  const now = new Date().toISOString();
  return {
    providers: providers.map((p) => ({
      provider: p,
      status: 'available' as const,
      latencyMs: 0,
      errorCount: 0,
      requestCount: 0,
      lastError: null,
      lastChecked: now,
    })),
    preferredOrder: providers,
    lastRotation: now,
  };
}

export function updateProviderState(
  pool: ProviderPool,
  provider: string,
  update: Partial<Omit<ProviderState, 'provider'>>,
): ProviderPool {
  return {
    ...pool,
    providers: pool.providers.map((p) =>
      p.provider === provider ? { ...p, ...update } : p,
    ),
  };
}

export function markProviderUnavailable(
  pool: ProviderPool,
  provider: string,
  error: string,
): ProviderPool {
  return updateProviderState(pool, provider, {
    status: 'unavailable',
    lastError: error,
    lastChecked: new Date().toISOString(),
  });
}

export function markProviderAvailable(
  pool: ProviderPool,
  provider: string,
  latencyMs: number,
): ProviderPool {
  return updateProviderState(pool, provider, {
    status: 'available',
    latencyMs,
    lastError: null,
    lastChecked: new Date().toISOString(),
  });
}

// ── Routing ──────────────────────────────────────────────────────────

export function selectProvider(
  pool: ProviderPool,
  requirements: {
    readonly needsStreaming?: boolean;
    readonly needsImages?: boolean;
    readonly localOnly?: boolean;
    readonly maxLatency?: number;
  },
): RoutingDecision {
  const eligible = pool.preferredOrder.filter((name) => {
    const state = pool.providers.find((p) => p.provider === name);
    if (!state || state.status === 'unavailable') return false;
    if (requirements.maxLatency !== undefined && state.latencyMs > requirements.maxLatency && state.latencyMs > 0) return false;

    const cap = PROVIDER_CAPABILITIES.find((c) => c.provider === name);
    if (!cap) return false;
    if (requirements.needsStreaming && !cap.supportsStreaming) return false;
    if (requirements.needsImages && !cap.supportsImages) return false;
    if (requirements.localOnly && !cap.localOnly) return false;

    return true;
  });

  if (eligible.length === 0) {
    return {
      selectedProvider: '',
      selectedModel: '',
      reason: 'No eligible provider found matching requirements',
      fallbackProviders: [],
      estimatedCost: 0,
    };
  }

  const selected = eligible[0];
  const cap = PROVIDER_CAPABILITIES.find((c) => c.provider === selected);
  const defaultModel = cap?.models[0] ?? '';

  return {
    selectedProvider: selected,
    selectedModel: defaultModel,
    reason: `Selected ${selected} as highest-priority eligible provider`,
    fallbackProviders: eligible.slice(1),
    estimatedCost: 0,
  };
}

// ── Metrics ──────────────────────────────────────────────────────────

export function recordRequestMetrics(
  metrics: readonly RequestMetrics[],
  newMetric: RequestMetrics,
): readonly RequestMetrics[] {
  return [...metrics, newMetric];
}

export function computeProviderStats(
  metrics: readonly RequestMetrics[],
  provider: string,
): { readonly avgLatency: number; readonly errorRate: number; readonly totalCost: number; readonly requestCount: number } {
  const providerMetrics = metrics.filter((m) => m.provider === provider);
  const count = providerMetrics.length;

  if (count === 0) {
    return { avgLatency: 0, errorRate: 0, totalCost: 0, requestCount: 0 };
  }

  const totalLatency = providerMetrics.reduce((sum, m) => sum + m.latencyMs, 0);
  const errorCount = providerMetrics.filter((m) => !m.success).length;
  const totalCost = providerMetrics.reduce((sum, m) => sum + m.cost, 0);

  return {
    avgLatency: totalLatency / count,
    errorRate: errorCount / count,
    totalCost,
    requestCount: count,
  };
}

// ── Budget ───────────────────────────────────────────────────────────

export function createDefaultBudget(dailyLimit: number, monthlyLimit: number): CostBudget {
  return {
    dailyLimit,
    monthlyLimit,
    currentDaily: 0,
    currentMonthly: 0,
    resetDate: new Date().toISOString(),
  };
}

export function checkBudget(
  budget: CostBudget,
  estimatedCost: number,
): { readonly allowed: boolean; readonly remainingDaily: number; readonly remainingMonthly: number } {
  const remainingDaily = budget.dailyLimit - budget.currentDaily;
  const remainingMonthly = budget.monthlyLimit - budget.currentMonthly;

  return {
    allowed: estimatedCost <= remainingDaily && estimatedCost <= remainingMonthly,
    remainingDaily,
    remainingMonthly,
  };
}

export function updateBudget(budget: CostBudget, actualCost: number): CostBudget {
  return {
    ...budget,
    currentDaily: budget.currentDaily + actualCost,
    currentMonthly: budget.currentMonthly + actualCost,
  };
}

// ── Dashboard Formatting ─────────────────────────────────────────────

export function formatProviderDashboard(pool: ProviderPool): string {
  const statusEmoji: Record<string, string> = {
    available: '🟢',
    degraded: '🟡',
    unavailable: '🔴',
  };

  const lines = [
    '# Provider Status Dashboard',
    '',
    '| Provider | Status | Latency | Errors | Requests |',
    '|----------|--------|---------|--------|----------|',
  ];

  for (const p of pool.providers) {
    const emoji = statusEmoji[p.status] ?? '⚪';
    lines.push(
      `| ${p.provider} | ${emoji} ${p.status} | ${p.latencyMs}ms | ${p.errorCount} | ${p.requestCount} |`,
    );
  }

  lines.push('', `Last rotation: ${pool.lastRotation}`);
  return lines.join('\n');
}

export function formatCostDashboard(
  budget: CostBudget,
  metrics: readonly RequestMetrics[],
): string {
  const byProvider = new Map<string, number>();
  for (const m of metrics) {
    byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + m.cost);
  }

  const lines = [
    '# Cost Dashboard',
    '',
    `Daily: $${budget.currentDaily.toFixed(2)} / $${budget.dailyLimit.toFixed(2)}`,
    `Monthly: $${budget.currentMonthly.toFixed(2)} / $${budget.monthlyLimit.toFixed(2)}`,
    '',
    '## Cost by Provider',
    '',
    '| Provider | Cost |',
    '|----------|------|',
  ];

  byProvider.forEach((cost, provider) => {
    lines.push(`| ${provider} | $${cost.toFixed(4)} |`);
  });

  lines.push('', `Total requests: ${metrics.length}`);
  return lines.join('\n');
}

// ── Utilities ────────────────────────────────────────────────────────

export function getHealthiestProvider(pool: ProviderPool): string | null {
  const available = pool.providers.filter((p) => p.status === 'available');
  if (available.length === 0) return null;

  const sorted = [...available].sort((a, b) => a.latencyMs - b.latencyMs);
  return sorted[0].provider;
}
