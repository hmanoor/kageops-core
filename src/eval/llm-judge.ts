export type ScoringDimension =
  | 'correctness'
  | 'completeness'
  | 'code-quality'
  | 'security'
  | 'performance'
  | 'readability'
  | 'test-coverage';

export interface ScoringCriteria {
  readonly dimension: ScoringDimension;
  readonly weight: number;
  readonly description: string;
}

export interface DimensionScore {
  readonly dimension: ScoringDimension;
  readonly score: number;
  readonly reasoning: string;
  readonly weight: number;
}

export interface JudgeVerdict {
  readonly overallScore: number;
  readonly dimensions: readonly DimensionScore[];
  readonly summary: string;
  readonly passed: boolean;
  readonly confidence: number;
}

export interface JudgeConfig {
  readonly criteria: readonly ScoringCriteria[];
  readonly passThreshold: number;
  readonly requireAllDimensions: boolean;
}

export const ALL_DIMENSIONS: readonly ScoringDimension[] = [
  'correctness',
  'completeness',
  'code-quality',
  'security',
  'performance',
  'readability',
  'test-coverage',
];

export const DEFAULT_CRITERIA: readonly ScoringCriteria[] = [
  { dimension: 'correctness', weight: 0.3, description: 'Output correctly solves the task' },
  { dimension: 'completeness', weight: 0.2, description: 'All requirements are addressed' },
  { dimension: 'code-quality', weight: 0.2, description: 'Clean, readable, maintainable code' },
  { dimension: 'security', weight: 0.15, description: 'No security vulnerabilities' },
  { dimension: 'readability', weight: 0.15, description: 'Well-documented and clear' },
];

const DEFAULT_PASS_THRESHOLD = 6;

export function buildJudgePrompt(
  taskDescription: string,
  expectedOutput: string,
  actualOutput: string,
  criteria: readonly ScoringCriteria[],
): string {
  const dimensionInstructions = criteria
    .map(
      (c) =>
        `- **${c.dimension}** (weight: ${c.weight}): ${c.description}`,
    )
    .join('\n');

  const outputFormat = criteria
    .map(
      (c) =>
        `--- DIMENSION: ${c.dimension} ---\nSCORE: <1-10>\nREASONING: <one sentence explanation>\n--- END DIMENSION ---`,
    )
    .join('\n\n');

  return `You are an expert code reviewer and quality evaluator. Score the following task output on each dimension from 1 (very poor) to 10 (excellent).

## Task Description
${taskDescription}

## Expected Output
${expectedOutput}

## Actual Output
${actualOutput}

## Scoring Dimensions
${dimensionInstructions}

## Instructions
Score each dimension carefully. Be objective and precise. After scoring all dimensions, provide a brief overall summary and a confidence score (0.0–1.0) indicating how certain you are of your assessment.

## Required Output Format
${outputFormat}

SUMMARY: <one paragraph overall assessment>
CONFIDENCE: <0.0-1.0>`;
}

export function parseDimensionScore(
  block: string,
  criteria: readonly ScoringCriteria[],
): DimensionScore | null {
  const dimMatch = block.match(/---\s*DIMENSION:\s*([^\s-]+(?:-[^\s-]+)*)\s*---/i);
  const scoreMatch = block.match(/SCORE:\s*(\d+(?:\.\d+)?)/i);
  const reasoningMatch = block.match(/REASONING:\s*(.+?)(?=\n--- END|\n--- DIMENSION|$)/is);

  if (!dimMatch || !scoreMatch) return null;

  const dimension = dimMatch[1].trim().toLowerCase() as ScoringDimension;
  const score = Math.min(10, Math.max(1, parseFloat(scoreMatch[1])));
  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : '';

  const criterion = criteria.find((c) => c.dimension === dimension);
  if (!criterion) return null;

  return { dimension, score, reasoning, weight: criterion.weight };
}

export function parseJudgeVerdict(
  aiOutput: string,
  criteria: readonly ScoringCriteria[],
  passThreshold: number,
): JudgeVerdict {
  const blockRegex = /---\s*DIMENSION:[^-]+---[\s\S]*?---\s*END DIMENSION\s*---/gi;
  const blocks = aiOutput.match(blockRegex) ?? [];

  const dimensions: DimensionScore[] = blocks
    .map((block) => parseDimensionScore(block, criteria))
    .filter((d): d is DimensionScore => d !== null);

  // Fallback: try loose line-by-line parsing if structured blocks are absent
  if (dimensions.length === 0) {
    for (const criterion of criteria) {
      const scoreMatch = aiOutput.match(
        new RegExp(`${criterion.dimension}[^\\d]*(\\d+(?:\\.\\d+)?)`, 'i'),
      );
      if (scoreMatch) {
        dimensions.push({
          dimension: criterion.dimension,
          score: Math.min(10, Math.max(1, parseFloat(scoreMatch[1]))),
          reasoning: '',
          weight: criterion.weight,
        });
      }
    }
  }

  const overallScore = dimensions.length > 0 ? calculateWeightedScore(dimensions) : 0;

  const summaryMatch = aiOutput.match(/SUMMARY:\s*(.+?)(?=CONFIDENCE:|$)/is);
  const summary = summaryMatch ? summaryMatch[1].trim() : '';

  const confidenceMatch = aiOutput.match(/CONFIDENCE:\s*([01](?:\.\d+)?)/i);
  const confidence = confidenceMatch
    ? Math.min(1, Math.max(0, parseFloat(confidenceMatch[1])))
    : 0.5;

  return {
    overallScore,
    dimensions,
    summary,
    passed: overallScore >= passThreshold,
    confidence,
  };
}

export function calculateWeightedScore(dimensions: readonly DimensionScore[]): number {
  if (dimensions.length === 0) return 0;

  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
  const normalizer = totalWeight > 0 ? totalWeight : 1;

  const weightedSum = dimensions.reduce((sum, d) => sum + d.score * (d.weight / normalizer), 0);
  return Math.round(weightedSum * 100) / 100;
}

export function buildComparisonJudgePrompt(
  taskDescription: string,
  outputA: string,
  outputB: string,
  criteria: readonly ScoringCriteria[],
): string {
  const dimensionList = criteria.map((c) => `- **${c.dimension}**: ${c.description}`).join('\n');

  return `You are an expert evaluator. Compare two outputs for the same task and score each on the given dimensions (1–10).

## Task Description
${taskDescription}

## Output A
${outputA}

## Output B
${outputB}

## Scoring Dimensions
${dimensionList}

## Instructions
For each dimension, score both Output A and Output B independently (1–10). Then provide an overall winner recommendation.

## Required Output Format (repeat for each dimension)
--- DIMENSION: <name> ---
OUTPUT_A_SCORE: <1-10>
OUTPUT_B_SCORE: <1-10>
REASONING: <comparison reasoning>
--- END DIMENSION ---

WINNER: <A|B|TIE>
SUMMARY: <overall comparison>`;
}

export function createJudgeConfig(overrides?: Partial<JudgeConfig>): JudgeConfig {
  return {
    criteria: DEFAULT_CRITERIA,
    passThreshold: DEFAULT_PASS_THRESHOLD,
    requireAllDimensions: false,
    ...overrides,
  };
}

export function validateCriteria(criteria: readonly ScoringCriteria[]): readonly string[] {
  const errors: string[] = [];

  const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0);
  if (Math.abs(totalWeight - 1) > 0.01) {
    errors.push(
      `Weights must sum to 1 (got ${totalWeight.toFixed(3)})`,
    );
  }

  const seen = new Set<string>();
  for (const c of criteria) {
    if (seen.has(c.dimension)) {
      errors.push(`Duplicate dimension: ${c.dimension}`);
    }
    seen.add(c.dimension);

    if (c.weight <= 0) {
      errors.push(`Weight for dimension '${c.dimension}' must be > 0 (got ${c.weight})`);
    }
  }

  return errors;
}

export function formatVerdictReport(verdict: JudgeVerdict): string {
  const badge = verdict.passed ? '✅ PASSED' : '❌ FAILED';
  const rows = verdict.dimensions
    .map(
      (d) =>
        `| ${d.dimension} | ${d.score}/10 | ${(d.weight * 100).toFixed(0)}% | ${d.reasoning} |`,
    )
    .join('\n');

  return `# Judge Verdict Report

## Result: ${badge}

**Overall Score:** ${verdict.overallScore}/10
**Confidence:** ${(verdict.confidence * 100).toFixed(0)}%

## Dimension Scores

| Dimension | Score | Weight | Reasoning |
|-----------|-------|--------|-----------|
${rows}

## Summary

${verdict.summary}
`;
}
