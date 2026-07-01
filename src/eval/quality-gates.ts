// B-124: Quality gates for CI/CD integration
// B-126: Quality trend tracking over time

export interface QualityGateRule {
  readonly name: string;
  readonly metric: 'avg-score' | 'pass-rate' | 'error-rate' | 'max-cost' | 'max-duration';
  readonly threshold: number;
  readonly operator: 'gte' | 'lte' | 'gt' | 'lt';
  readonly blocking: boolean;
}

export interface QualityGateRuleResult {
  readonly rule: QualityGateRule;
  readonly actualValue: number;
  readonly passed: boolean;
}

export interface QualityGateResult {
  readonly rules: readonly QualityGateRuleResult[];
  readonly passed: boolean;
  readonly blockedBy: readonly string[];
  readonly summary: string;
}

export interface QualityDataPoint {
  readonly timestamp: string;
  readonly runId: string;
  readonly agent: string;
  readonly projectId: string;
  readonly avgScore: number;
  readonly passRate: number;
  readonly sampleCount: number;
  readonly totalCost: number;
}

export interface QualityTrend {
  readonly agent: string;
  readonly projectId: string;
  readonly dataPoints: readonly QualityDataPoint[];
  readonly trend: 'improving' | 'declining' | 'stable' | 'insufficient-data';
  readonly trendSlope: number;
}

// B-124: Default quality gate rules
export const DEFAULT_QUALITY_GATES: readonly QualityGateRule[] = [
  { name: 'avg-score', metric: 'avg-score', threshold: 6, operator: 'gte', blocking: true },
  { name: 'pass-rate', metric: 'pass-rate', threshold: 0.7, operator: 'gte', blocking: true },
  { name: 'error-rate', metric: 'error-rate', threshold: 0.1, operator: 'lte', blocking: true },
  { name: 'max-cost', metric: 'max-cost', threshold: 50, operator: 'lte', blocking: false },
];

export function createQualityGate(rules: readonly QualityGateRule[]): readonly QualityGateRule[] {
  for (const rule of rules) {
    if (!rule.name || rule.name.trim() === '') {
      throw new Error('Quality gate rule must have a non-empty name');
    }
    if (typeof rule.threshold !== 'number' || isNaN(rule.threshold)) {
      throw new Error(`Rule "${rule.name}" must have a numeric threshold`);
    }
  }
  return rules;
}

export function evaluateRule(rule: QualityGateRule, actualValue: number): boolean {
  switch (rule.operator) {
    case 'gte': return actualValue >= rule.threshold;
    case 'lte': return actualValue <= rule.threshold;
    case 'gt':  return actualValue > rule.threshold;
    case 'lt':  return actualValue < rule.threshold;
  }
}

export function evaluateGate(
  rules: readonly QualityGateRule[],
  metrics: {
    avgScore: number;
    passRate: number;
    errorRate: number;
    totalCost: number;
    maxDuration: number;
  }
): QualityGateResult {
  const metricMap: Record<QualityGateRule['metric'], number> = {
    'avg-score': metrics.avgScore,
    'pass-rate': metrics.passRate,
    'error-rate': metrics.errorRate,
    'max-cost': metrics.totalCost,
    'max-duration': metrics.maxDuration,
  };

  const ruleResults: QualityGateRuleResult[] = rules.map((rule) => {
    const actualValue = metricMap[rule.metric];
    const passed = evaluateRule(rule, actualValue);
    return { rule, actualValue, passed };
  });

  const blockedBy = ruleResults
    .filter((r) => r.rule.blocking && !r.passed)
    .map((r) => r.rule.name);

  const passed = blockedBy.length === 0;
  const summary = passed
    ? `Quality gate passed (${ruleResults.filter((r) => r.passed).length}/${ruleResults.length} rules passed)`
    : `Quality gate FAILED — blocked by: ${blockedBy.join(', ')}`;

  return { rules: ruleResults, passed, blockedBy, summary };
}

export function formatGateReport(result: QualityGateResult): string {
  const lines: string[] = ['## Quality Gate Report', ''];
  for (const rr of result.rules) {
    const icon = rr.passed ? '✅' : '❌';
    const blocking = rr.rule.blocking ? ' *(blocking)*' : '';
    lines.push(
      `${icon} **${rr.rule.name}**: ${rr.actualValue} ${rr.rule.operator} ${rr.rule.threshold}${blocking}`
    );
  }
  lines.push('');
  lines.push(`**Result:** ${result.summary}`);
  return lines.join('\n');
}

// B-126: Trend tracking

export function calculateTrend(dataPoints: readonly QualityDataPoint[]): {
  trend: 'improving' | 'declining' | 'stable' | 'insufficient-data';
  slope: number;
} {
  if (dataPoints.length < 3) {
    return { trend: 'insufficient-data', slope: 0 };
  }

  const n = dataPoints.length;
  // Use index as x to avoid large timestamp numbers
  const xs = dataPoints.map((_, i) => i);
  const ys = dataPoints.map((dp) => dp.avgScore);

  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumX2 = xs.reduce((acc, x) => acc + x * x, 0);

  const denominator = n * sumX2 - sumX * sumX;
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;

  let trend: 'improving' | 'declining' | 'stable';
  if (slope > 0.1) trend = 'improving';
  else if (slope < -0.1) trend = 'declining';
  else trend = 'stable';

  return { trend, slope };
}

export function buildQualityTrend(
  agent: string,
  projectId: string,
  dataPoints: readonly QualityDataPoint[]
): QualityTrend {
  const { trend, slope } = calculateTrend(dataPoints);
  return { agent, projectId, dataPoints, trend, trendSlope: slope };
}

export function addDataPoint(trend: QualityTrend, point: QualityDataPoint): QualityTrend {
  const dataPoints = [...trend.dataPoints, point];
  const { trend: newTrend, slope } = calculateTrend(dataPoints);
  return { ...trend, dataPoints, trend: newTrend, trendSlope: slope };
}

export function formatTrendReport(trends: readonly QualityTrend[]): string {
  const lines: string[] = [
    '## Quality Trend Report',
    '',
    '| Agent | Project | Trend | Slope | Data Points |',
    '|-------|---------|-------|-------|-------------|',
  ];

  for (const t of trends) {
    const arrow =
      t.trend === 'improving' ? '📈' :
      t.trend === 'declining' ? '📉' :
      t.trend === 'stable'    ? '➡️' : 'N/A';
    lines.push(
      `| ${t.agent} | ${t.projectId} | ${arrow} ${t.trend} | ${t.trendSlope.toFixed(3)} | ${t.dataPoints.length} |`
    );
  }

  return lines.join('\n');
}

export function detectQualityRegression(trend: QualityTrend, lookback: number): boolean {
  const recent = trend.dataPoints.slice(-lookback);
  if (recent.length < 3) return false;
  const { trend: recentTrend } = calculateTrend(recent);
  return recentTrend === 'declining';
}
