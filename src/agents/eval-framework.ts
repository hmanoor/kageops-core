/**
 * 3-Arm Eval Framework (B-212)
 *
 * Evaluates agent enhancements across three arms:
 *   - baseline:      no enhancement
 *   - terse-control: token reduction only (no quality enhancement)
 *   - enhanced:      full feature (token reduction + quality improvement)
 *
 * Separates token savings from genuine skill contribution so we can measure
 * honest improvement.
 */

export type EvalArm = 'baseline' | 'terse-control' | 'enhanced';

export interface EvalCase {
  readonly id: string;
  readonly description: string;
  readonly input: string;
  readonly expectedBehaviors: readonly string[];
}

export interface EvalRunResult {
  readonly caseId: string;
  readonly arm: EvalArm;
  readonly output: string;
  readonly tokenCount: number;
  readonly durationMs: number;
  readonly qualityScore: number;
  readonly behaviorsPassed: readonly boolean[];
}

export interface EvalComparison {
  readonly caseId: string;
  readonly baseline: EvalRunResult;
  readonly terseControl: EvalRunResult;
  readonly enhanced: EvalRunResult;
  readonly tokenSavingsVsBaseline: number;
  readonly qualityDeltaVsBaseline: number;
  readonly qualityDeltaVsTerse: number;
  readonly verdict: 'enhanced-wins' | 'terse-sufficient' | 'baseline-wins' | 'inconclusive';
}

export interface EvalSuiteResult {
  readonly comparisons: readonly EvalComparison[];
  readonly overallVerdict: string;
  readonly avgTokenSavings: number;
  readonly avgQualityDelta: number;
  readonly enhancedWinRate: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ALL_ARMS: readonly EvalArm[] = ['baseline', 'terse-control', 'enhanced'];

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function createEvalCase(
  id: string,
  description: string,
  input: string,
  expectedBehaviors: readonly string[],
): EvalCase {
  return { id, description, input, expectedBehaviors };
}

export function createRunResult(
  caseId: string,
  arm: EvalArm,
  output: string,
  tokenCount: number,
  durationMs: number,
  qualityScore: number,
  behaviorsPassed: readonly boolean[],
): EvalRunResult {
  return { caseId, arm, output, tokenCount, durationMs, qualityScore, behaviorsPassed };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function calcVerdict(
  tokenSavingsVsBaseline: number,
  qualityDeltaVsBaseline: number,
  qualityDeltaVsTerse: number,
): EvalComparison['verdict'] {
  // baseline-wins: enhanced scored below baseline (regardless of terse)
  if (qualityDeltaVsBaseline < 0) {
    return 'baseline-wins';
  }
  if (qualityDeltaVsTerse > 1) {
    return 'enhanced-wins';
  }
  if (qualityDeltaVsTerse <= 1 && tokenSavingsVsBaseline > 20) {
    return 'terse-sufficient';
  }
  return 'inconclusive';
}

export function compareArms(
  baseline: EvalRunResult,
  terseControl: EvalRunResult,
  enhanced: EvalRunResult,
): EvalComparison {
  const tokenSavingsVsBaseline =
    baseline.tokenCount === 0
      ? 0
      : ((baseline.tokenCount - terseControl.tokenCount) / baseline.tokenCount) * 100;

  const qualityDeltaVsBaseline = enhanced.qualityScore - baseline.qualityScore;
  const qualityDeltaVsTerse = enhanced.qualityScore - terseControl.qualityScore;

  const verdict = calcVerdict(tokenSavingsVsBaseline, qualityDeltaVsBaseline, qualityDeltaVsTerse);

  return {
    caseId: baseline.caseId,
    baseline,
    terseControl,
    enhanced,
    tokenSavingsVsBaseline,
    qualityDeltaVsBaseline,
    qualityDeltaVsTerse,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Suite aggregation
// ---------------------------------------------------------------------------

export function runEvalSuite(comparisons: readonly EvalComparison[]): EvalSuiteResult {
  if (comparisons.length === 0) {
    return {
      comparisons,
      overallVerdict: 'No comparisons to evaluate.',
      avgTokenSavings: 0,
      avgQualityDelta: 0,
      enhancedWinRate: 0,
    };
  }

  const avgTokenSavings =
    comparisons.reduce((sum, c) => sum + c.tokenSavingsVsBaseline, 0) / comparisons.length;

  const avgQualityDelta =
    comparisons.reduce((sum, c) => sum + c.qualityDeltaVsBaseline, 0) / comparisons.length;

  const enhancedWins = comparisons.filter((c) => c.verdict === 'enhanced-wins').length;
  const enhancedWinRate = enhancedWins / comparisons.length;

  const overallVerdict = buildOverallVerdict(enhancedWinRate, avgTokenSavings, avgQualityDelta);

  return { comparisons, overallVerdict, avgTokenSavings, avgQualityDelta, enhancedWinRate };
}

function buildOverallVerdict(
  enhancedWinRate: number,
  avgTokenSavings: number,
  avgQualityDelta: number,
): string {
  if (enhancedWinRate >= 0.7) {
    return `Enhancement delivers clear value (wins ${Math.round(enhancedWinRate * 100)}% of cases). Recommend shipping.`;
  }
  if (avgTokenSavings > 20 && avgQualityDelta >= 0) {
    return `Terse-control alone is sufficient — token savings without quality loss. Enhancement not needed.`;
  }
  if (avgQualityDelta < 0) {
    return `Enhancement degrades quality vs baseline. Do not ship without further tuning.`;
  }
  return `Results are inconclusive. Run additional cases or refine evaluation criteria.`;
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

export function formatEvalReport(result: EvalSuiteResult): string {
  const lines: string[] = [];

  lines.push('# 3-Arm Eval Report');
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push(
    '| Case | Baseline Score | Terse Score | Enhanced Score | Token Savings | Verdict |',
  );
  lines.push('|------|---------------|-------------|----------------|---------------|---------|');

  for (const c of result.comparisons) {
    const savings = `${c.tokenSavingsVsBaseline.toFixed(1)}%`;
    lines.push(
      `| ${c.caseId} | ${c.baseline.qualityScore} | ${c.terseControl.qualityScore} | ${c.enhanced.qualityScore} | ${savings} | ${c.verdict} |`,
    );
  }

  lines.push('');

  // Overall statistics
  lines.push('## Overall Statistics');
  lines.push('');
  lines.push(`- **Cases evaluated:** ${result.comparisons.length}`);
  lines.push(`- **Enhanced win rate:** ${(result.enhancedWinRate * 100).toFixed(1)}%`);
  lines.push(`- **Avg token savings (terse vs baseline):** ${result.avgTokenSavings.toFixed(1)}%`);
  lines.push(
    `- **Avg quality delta (enhanced vs baseline):** ${result.avgQualityDelta.toFixed(2)}`,
  );
  lines.push('');

  // Recommendation
  lines.push('## Recommendation');
  lines.push('');
  lines.push(result.overallVerdict);
  lines.push('');

  return lines.join('\n');
}
