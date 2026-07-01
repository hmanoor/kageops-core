// B-122: Annotation rubrics — structured scoring UI data model
// B-123: Experiment comparison view — side-by-side agent version comparison

export interface RubricCategory {
  readonly name: string;
  readonly description: string;
  readonly maxScore: number;
}

export interface Annotation {
  readonly id: string;
  readonly sampleId: string;
  readonly annotator: string;
  readonly scores: Readonly<Record<string, number>>;
  readonly comments: Readonly<Record<string, string>>;
  readonly overallComment: string;
  readonly createdAt: string;
}

export interface RubricConfig {
  readonly categories: readonly RubricCategory[];
  readonly requireComments: boolean;
  readonly allowPartialScores: boolean;
}

export interface ExperimentArm {
  readonly name: string;
  readonly runId: string;
  readonly avgScore: number;
  readonly passRate: number;
  readonly avgDuration: number;
  readonly totalCost: number;
  readonly sampleCount: number;
}

export interface ExperimentComparison {
  readonly arms: readonly ExperimentArm[];
  readonly winner: string | null;
  readonly scoreDelta: number;
  readonly costDelta: number;
  readonly speedDelta: number;
  readonly verdict: string;
}

export const DEFAULT_RUBRIC_CATEGORIES: readonly RubricCategory[] = [
  { name: 'correctness', description: 'Output is factually correct and accurate', maxScore: 5 },
  { name: 'completeness', description: 'All required elements are present', maxScore: 5 },
  { name: 'quality', description: 'Overall quality of the output', maxScore: 5 },
  { name: 'clarity', description: 'Output is clear and easy to understand', maxScore: 5 },
  { name: 'efficiency', description: 'Output is concise and avoids unnecessary content', maxScore: 5 },
];

export function createRubricConfig(
  categories: readonly RubricCategory[],
  options?: { requireComments?: boolean; allowPartialScores?: boolean },
): RubricConfig {
  return {
    categories,
    requireComments: options?.requireComments ?? false,
    allowPartialScores: options?.allowPartialScores ?? false,
  };
}

export function createAnnotation(
  id: string,
  sampleId: string,
  annotator: string,
  scores: Record<string, number>,
  comments: Record<string, string>,
  overallComment: string,
): Annotation {
  return {
    id,
    sampleId,
    annotator,
    scores: { ...scores },
    comments: { ...comments },
    overallComment,
    createdAt: new Date().toISOString(),
  };
}

export function validateAnnotation(
  annotation: Annotation,
  rubric: RubricConfig,
): readonly string[] {
  const errors: string[] = [];
  const categoryNames = rubric.categories.map((c) => c.name);

  if (!rubric.allowPartialScores) {
    for (const category of rubric.categories) {
      if (!(category.name in annotation.scores)) {
        errors.push(`Missing score for category: ${category.name}`);
      }
    }
  }

  for (const category of rubric.categories) {
    const score = annotation.scores[category.name];
    if (score !== undefined) {
      if (score < 0 || score > category.maxScore) {
        errors.push(
          `Score ${score} for category '${category.name}' is out of range [0, ${category.maxScore}]`,
        );
      }
    }
  }

  if (rubric.requireComments) {
    for (const name of categoryNames) {
      if (name in annotation.scores && !annotation.comments[name]) {
        errors.push(`Comment required for scored category: ${name}`);
      }
    }
  }

  return errors;
}

export function computeAnnotationScore(
  annotation: Annotation,
  rubric: RubricConfig,
): number {
  const scoredCategories = rubric.categories.filter(
    (c) => c.name in annotation.scores,
  );

  if (scoredCategories.length === 0) return 0;

  const normalizedScores = scoredCategories.map((c) => {
    const raw = annotation.scores[c.name] ?? 0;
    return c.maxScore > 0 ? (raw / c.maxScore) * 10 : 0;
  });

  const sum = normalizedScores.reduce((acc, s) => acc + s, 0);
  return sum / normalizedScores.length;
}

export function aggregateAnnotations(
  annotations: readonly Annotation[],
): { avgScores: Readonly<Record<string, number>>; overallAvg: number } {
  if (annotations.length === 0) {
    return { avgScores: {}, overallAvg: 0 };
  }

  const totals: Record<string, number> = {};
  const counts: Record<string, number> = {};

  for (const annotation of annotations) {
    for (const [category, score] of Object.entries(annotation.scores)) {
      totals[category] = (totals[category] ?? 0) + score;
      counts[category] = (counts[category] ?? 0) + 1;
    }
  }

  const avgScores: Record<string, number> = {};
  for (const category of Object.keys(totals)) {
    avgScores[category] = totals[category]! / counts[category]!;
  }

  const values = Object.values(avgScores);
  const overallAvg = values.length > 0
    ? values.reduce((acc, v) => acc + v, 0) / values.length
    : 0;

  return { avgScores, overallAvg };
}

const WINNER_SCORE_THRESHOLD = 0.5;

export function compareExperiments(
  arms: readonly ExperimentArm[],
): ExperimentComparison {
  if (arms.length === 0) {
    return {
      arms,
      winner: null,
      scoreDelta: 0,
      costDelta: 0,
      speedDelta: 0,
      verdict: 'No arms to compare.',
    };
  }

  const sorted = [...arms].sort((a, b) => b.avgScore - a.avgScore);
  const best = sorted[0]!;
  const second = sorted[1];

  const scoreDelta = second ? best.avgScore - second.avgScore : 0;
  const costDelta = second ? best.totalCost - second.totalCost : 0;
  const speedDelta = second ? best.avgDuration - second.avgDuration : 0;

  const winner =
    arms.length === 1
      ? best.name
      : scoreDelta > WINNER_SCORE_THRESHOLD
        ? best.name
        : null;

  let verdict: string;
  if (arms.length === 1) {
    verdict = `Single arm '${best.name}' with avg score ${best.avgScore.toFixed(2)}.`;
  } else if (winner) {
    verdict = `'${winner}' wins with avg score ${best.avgScore.toFixed(2)} (Δ ${scoreDelta.toFixed(2)} over '${second!.name}').`;
  } else {
    verdict = `Inconclusive — score delta ${scoreDelta.toFixed(2)} is within threshold (${WINNER_SCORE_THRESHOLD}).`;
  }

  return { arms, winner, scoreDelta, costDelta, speedDelta, verdict };
}

export function formatComparisonReport(comparison: ExperimentComparison): string {
  const lines: string[] = [
    '## Experiment Comparison Report',
    '',
    `**Verdict:** ${comparison.verdict}`,
    '',
    '| Arm | Avg Score | Pass Rate | Avg Duration (s) | Cost ($) | Samples |',
    '|-----|-----------|-----------|-----------------|----------|---------|',
  ];

  for (const arm of comparison.arms) {
    const winnerTag = arm.name === comparison.winner ? ' ✓' : '';
    lines.push(
      `| ${arm.name}${winnerTag} | ${arm.avgScore.toFixed(2)} | ${(arm.passRate * 100).toFixed(1)}% | ${arm.avgDuration.toFixed(2)} | $${arm.totalCost.toFixed(4)} | ${arm.sampleCount} |`,
    );
  }

  lines.push('');
  lines.push(`Score Δ: ${comparison.scoreDelta.toFixed(2)} | Cost Δ: $${comparison.costDelta.toFixed(4)} | Speed Δ: ${comparison.speedDelta.toFixed(2)}s`);

  return lines.join('\n');
}

export function formatAnnotationReport(
  annotations: readonly Annotation[],
  rubric: RubricConfig,
): string {
  if (annotations.length === 0) {
    return '## Annotation Report\n\nNo annotations to display.';
  }

  const lines: string[] = ['## Annotation Report', ''];

  for (const annotation of annotations) {
    lines.push(`### Annotator: ${annotation.annotator} (Sample: ${annotation.sampleId})`);
    lines.push('');
    lines.push('| Category | Score | Comment |');
    lines.push('|----------|-------|---------|');

    for (const category of rubric.categories) {
      const score = annotation.scores[category.name];
      const comment = annotation.comments[category.name] ?? '';
      const scoreDisplay = score !== undefined ? `${score}/${category.maxScore}` : 'N/A';
      lines.push(`| ${category.name} | ${scoreDisplay} | ${comment} |`);
    }

    if (annotation.overallComment) {
      lines.push('');
      lines.push(`**Overall:** ${annotation.overallComment}`);
    }

    lines.push('');
  }

  const { avgScores, overallAvg } = aggregateAnnotations(annotations);
  lines.push('### Aggregate Scores');
  lines.push('');
  lines.push('| Category | Avg Score |');
  lines.push('|----------|-----------|');

  for (const [cat, avg] of Object.entries(avgScores)) {
    lines.push(`| ${cat} | ${avg.toFixed(2)} |`);
  }

  lines.push('');
  lines.push(`**Overall Average:** ${overallAvg.toFixed(2)}`);

  return lines.join('\n');
}

export function renderComparisonHtml(comparison: ExperimentComparison): string {
  const armCards = comparison.arms
    .map((arm) => {
      const isWinner = arm.name === comparison.winner;
      const borderStyle = isWinner ? 'border: 2px solid #22c55e;' : 'border: 1px solid #e5e7eb;';

      const scoreDeltaStr = comparison.arms.length > 1
        ? formatDeltaIndicator(arm.avgScore - averageExcluding(comparison.arms, arm.name, 'avgScore'))
        : '';

      const costDeltaStr = comparison.arms.length > 1
        ? formatDeltaIndicator(
            -(arm.totalCost - averageExcluding(comparison.arms, arm.name, 'totalCost')),
            true,
          )
        : '';

      const speedDeltaStr = comparison.arms.length > 1
        ? formatDeltaIndicator(
            -(arm.avgDuration - averageExcluding(comparison.arms, arm.name, 'avgDuration')),
            true,
          )
        : '';

      return `
    <div class="arm-card" style="flex:1; padding:16px; border-radius:8px; ${borderStyle}">
      <h3 style="margin:0 0 8px;">${arm.name}${isWinner ? ' <span style="color:#22c55e;">✓ Winner</span>' : ''}</h3>
      <table style="width:100%; border-collapse:collapse;">
        <tr><td>Avg Score</td><td><strong>${arm.avgScore.toFixed(2)}</strong> ${scoreDeltaStr}</td></tr>
        <tr><td>Pass Rate</td><td>${(arm.passRate * 100).toFixed(1)}%</td></tr>
        <tr><td>Avg Duration</td><td>${arm.avgDuration.toFixed(2)}s ${speedDeltaStr}</td></tr>
        <tr><td>Total Cost</td><td>$${arm.totalCost.toFixed(4)} ${costDeltaStr}</td></tr>
        <tr><td>Samples</td><td>${arm.sampleCount}</td></tr>
      </table>
    </div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Experiment Comparison</title>
  <style>
    body { font-family: sans-serif; padding: 24px; }
    .delta-positive { color: #22c55e; font-size: 0.85em; }
    .delta-negative { color: #ef4444; font-size: 0.85em; }
    .delta-neutral { color: #6b7280; font-size: 0.85em; }
    table td { padding: 4px 8px; }
  </style>
</head>
<body>
  <h1>Experiment Comparison</h1>
  <p><strong>Verdict:</strong> ${comparison.verdict}</p>
  <div style="display:flex; gap:16px; flex-wrap:wrap;">
${armCards}
  </div>
</body>
</html>`;
}

function averageExcluding(
  arms: readonly ExperimentArm[],
  excludeName: string,
  field: keyof ExperimentArm,
): number {
  const others = arms.filter((a) => a.name !== excludeName);
  if (others.length === 0) return 0;
  const sum = others.reduce((acc, a) => acc + (a[field] as number), 0);
  return sum / others.length;
}

function formatDeltaIndicator(delta: number, higherIsBetter = false): string {
  const adjusted = higherIsBetter ? delta : delta;
  if (Math.abs(adjusted) < 0.001) {
    return '<span class="delta-neutral">—</span>';
  }
  const positive = adjusted > 0;
  const cls = positive ? 'delta-positive' : 'delta-negative';
  const sign = positive ? '▲' : '▼';
  return `<span class="${cls}">${sign} ${Math.abs(adjusted).toFixed(2)}</span>`;
}
