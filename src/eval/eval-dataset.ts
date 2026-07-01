// B-120: Dataset-driven agent evaluation for KageOps

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvalSample {
  readonly id: string;
  readonly input: string;
  readonly expectedOutput: string;
  readonly taskType: string;
  readonly agent: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
}

export interface EvalDataset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly samples: readonly EvalSample[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EvalRunConfig {
  readonly datasetId: string;
  readonly agentOverride: string | null;
  readonly modelOverride: string | null;
  readonly maxSamples: number | null;
  readonly tags: readonly string[];
}

export interface EvalSampleResult {
  readonly sampleId: string;
  readonly actualOutput: string;
  readonly durationMs: number;
  readonly tokenCount: number;
  readonly cost: number;
  readonly passed: boolean;
  readonly score: number;
  readonly error: string | null;
}

export interface EvalRunSummary {
  readonly totalSamples: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly errorCount: number;
  readonly avgScore: number;
  readonly avgDuration: number;
  readonly totalTokens: number;
  readonly totalCost: number;
  readonly passRate: number;
}

export interface EvalRunResult {
  readonly runId: string;
  readonly datasetId: string;
  readonly config: EvalRunConfig;
  readonly results: readonly EvalSampleResult[];
  readonly summary: EvalRunSummary;
  readonly startedAt: string;
  readonly completedAt: string;
}

// ---------------------------------------------------------------------------
// Dataset management
// ---------------------------------------------------------------------------

export function createDataset(
  id: string,
  name: string,
  description: string,
  samples: readonly EvalSample[],
): EvalDataset {
  const now = new Date().toISOString();
  return {
    id,
    name,
    description,
    version: 1,
    samples,
    createdAt: now,
    updatedAt: now,
  };
}

export function addSample(dataset: EvalDataset, sample: EvalSample): EvalDataset {
  return {
    ...dataset,
    samples: [...dataset.samples, sample],
    version: dataset.version + 1,
    updatedAt: new Date().toISOString(),
  };
}

export function removeSample(dataset: EvalDataset, sampleId: string): EvalDataset {
  return {
    ...dataset,
    samples: dataset.samples.filter((s) => s.id !== sampleId),
    version: dataset.version + 1,
    updatedAt: new Date().toISOString(),
  };
}

export function filterSamples(
  dataset: EvalDataset,
  filter: {
    taskType?: string;
    agent?: string;
    tags?: readonly string[];
  },
): readonly EvalSample[] {
  return dataset.samples.filter((sample) => {
    if (filter.taskType !== undefined && sample.taskType !== filter.taskType) {
      return false;
    }
    if (filter.agent !== undefined && sample.agent !== filter.agent) {
      return false;
    }
    if (filter.tags !== undefined && filter.tags.length > 0) {
      const hasAnyTag = filter.tags.some((tag) => sample.tags.includes(tag));
      if (!hasAnyTag) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Run configuration
// ---------------------------------------------------------------------------

export function createRunConfig(
  datasetId: string,
  overrides?: Partial<Omit<EvalRunConfig, 'datasetId'>>,
): EvalRunConfig {
  return {
    datasetId,
    agentOverride: overrides?.agentOverride ?? null,
    modelOverride: overrides?.modelOverride ?? null,
    maxSamples: overrides?.maxSamples ?? null,
    tags: overrides?.tags ?? [],
  };
}

// ---------------------------------------------------------------------------
// Summary computation
// ---------------------------------------------------------------------------

export function computeRunSummary(results: readonly EvalSampleResult[]): EvalRunSummary {
  if (results.length === 0) {
    return {
      totalSamples: 0,
      passedCount: 0,
      failedCount: 0,
      errorCount: 0,
      avgScore: 0,
      avgDuration: 0,
      totalTokens: 0,
      totalCost: 0,
      passRate: 0,
    };
  }

  const passedCount = results.filter((r) => r.passed && r.error === null).length;
  const errorCount = results.filter((r) => r.error !== null).length;
  const failedCount = results.length - passedCount - errorCount;
  const totalTokens = results.reduce((sum, r) => sum + r.tokenCount, 0);
  const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  const avgDuration = results.reduce((sum, r) => sum + r.durationMs, 0) / results.length;

  return {
    totalSamples: results.length,
    passedCount,
    failedCount,
    errorCount,
    avgScore,
    avgDuration,
    totalTokens,
    totalCost,
    passRate: passedCount / results.length,
  };
}

// ---------------------------------------------------------------------------
// Run result builder
// ---------------------------------------------------------------------------

export function buildEvalRunResult(
  runId: string,
  datasetId: string,
  config: EvalRunConfig,
  results: readonly EvalSampleResult[],
): EvalRunResult {
  const now = new Date().toISOString();
  return {
    runId,
    datasetId,
    config,
    results,
    summary: computeRunSummary(results),
    startedAt: now,
    completedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeDataset(dataset: EvalDataset): string {
  return JSON.stringify(dataset, null, 2);
}

export function importDataset(json: string): EvalDataset | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isEvalDataset(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isEvalDataset(value: unknown): value is EvalDataset {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['name'] === 'string' &&
    typeof obj['description'] === 'string' &&
    typeof obj['version'] === 'number' &&
    Array.isArray(obj['samples']) &&
    typeof obj['createdAt'] === 'string' &&
    typeof obj['updatedAt'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatEvalReport(result: EvalRunResult): string {
  const { summary, results, runId, datasetId, startedAt, completedAt } = result;
  const pct = (summary.passRate * 100).toFixed(1);

  const lines: string[] = [
    `# Eval Run Report`,
    ``,
    `**Run ID:** ${runId}  `,
    `**Dataset:** ${datasetId}  `,
    `**Started:** ${startedAt}  `,
    `**Completed:** ${completedAt}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total Samples | ${summary.totalSamples} |`,
    `| Passed | ${summary.passedCount} |`,
    `| Failed | ${summary.failedCount} |`,
    `| Errors | ${summary.errorCount} |`,
    `| Pass Rate | ${pct}% |`,
    `| Avg Score | ${summary.avgScore.toFixed(2)} |`,
    `| Avg Duration | ${summary.avgDuration.toFixed(0)}ms |`,
    `| Total Tokens | ${summary.totalTokens} |`,
    `| Total Cost | $${summary.totalCost.toFixed(4)} |`,
    ``,
    `## Sample Results`,
    ``,
    `| Sample ID | Passed | Score | Duration | Tokens | Cost | Error |`,
    `|-----------|--------|-------|----------|--------|------|-------|`,
  ];

  for (const r of results) {
    const status = r.error !== null ? 'ERROR' : r.passed ? 'PASS' : 'FAIL';
    const errorCell = r.error !== null ? r.error.slice(0, 40) : '-';
    lines.push(
      `| ${r.sampleId} | ${status} | ${r.score.toFixed(1)} | ${r.durationMs}ms | ${r.tokenCount} | $${r.cost.toFixed(4)} | ${errorCell} |`,
    );
  }

  lines.push(``, `## Cost Breakdown`, ``);
  lines.push(`Total tokens used: **${summary.totalTokens}**`);
  lines.push(`Total cost: **$${summary.totalCost.toFixed(4)}**`);
  lines.push(`Average cost per sample: **$${(summary.totalSamples > 0 ? summary.totalCost / summary.totalSamples : 0).toFixed(4)}**`);

  return lines.join('\n');
}

export function compareRuns(runA: EvalRunResult, runB: EvalRunResult): string {
  const scoreDelta = runB.summary.avgScore - runA.summary.avgScore;
  const passRateDelta = runB.summary.passRate - runA.summary.passRate;
  const costDelta = runB.summary.totalCost - runA.summary.totalCost;
  const durationDelta = runB.summary.avgDuration - runA.summary.avgDuration;
  const tokenDelta = runB.summary.totalTokens - runA.summary.totalTokens;

  const sign = (n: number): string => (n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2));
  const signPct = (n: number): string =>
    n >= 0 ? `+${(n * 100).toFixed(1)}%` : `${(n * 100).toFixed(1)}%`;
  const signCost = (n: number): string => (n >= 0 ? `+$${n.toFixed(4)}` : `-$${Math.abs(n).toFixed(4)}`);

  const lines: string[] = [
    `# Eval Run Comparison`,
    ``,
    `**Run A:** ${runA.runId} (dataset: ${runA.datasetId})  `,
    `**Run B:** ${runB.runId} (dataset: ${runB.datasetId})`,
    ``,
    `## Delta Summary`,
    ``,
    `| Metric | Run A | Run B | Delta |`,
    `|--------|-------|-------|-------|`,
    `| Avg Score | ${runA.summary.avgScore.toFixed(2)} | ${runB.summary.avgScore.toFixed(2)} | ${sign(scoreDelta)} |`,
    `| Pass Rate | ${(runA.summary.passRate * 100).toFixed(1)}% | ${(runB.summary.passRate * 100).toFixed(1)}% | ${signPct(passRateDelta)} |`,
    `| Total Cost | $${runA.summary.totalCost.toFixed(4)} | $${runB.summary.totalCost.toFixed(4)} | ${signCost(costDelta)} |`,
    `| Avg Duration | ${runA.summary.avgDuration.toFixed(0)}ms | ${runB.summary.avgDuration.toFixed(0)}ms | ${sign(durationDelta)}ms |`,
    `| Total Tokens | ${runA.summary.totalTokens} | ${runB.summary.totalTokens} | ${tokenDelta >= 0 ? '+' : ''}${tokenDelta} |`,
    `| Passed | ${runA.summary.passedCount} | ${runB.summary.passedCount} | ${runB.summary.passedCount - runA.summary.passedCount >= 0 ? '+' : ''}${runB.summary.passedCount - runA.summary.passedCount} |`,
    `| Failed | ${runA.summary.failedCount} | ${runB.summary.failedCount} | ${runB.summary.failedCount - runA.summary.failedCount >= 0 ? '+' : ''}${runB.summary.failedCount - runA.summary.failedCount} |`,
    `| Errors | ${runA.summary.errorCount} | ${runB.summary.errorCount} | ${runB.summary.errorCount - runA.summary.errorCount >= 0 ? '+' : ''}${runB.summary.errorCount - runA.summary.errorCount} |`,
  ];

  return lines.join('\n');
}
