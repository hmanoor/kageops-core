import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRubricConfig,
  createAnnotation,
  validateAnnotation,
  computeAnnotationScore,
  aggregateAnnotations,
  compareExperiments,
  formatComparisonReport,
  formatAnnotationReport,
  renderComparisonHtml,
  DEFAULT_RUBRIC_CATEGORIES,
  type RubricConfig,
  type Annotation,
  type ExperimentArm,
} from '../../src/eval/annotation-rubric.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRubric(options?: { requireComments?: boolean; allowPartialScores?: boolean }): RubricConfig {
  return createRubricConfig(DEFAULT_RUBRIC_CATEGORIES, options);
}

function makeAnnotation(overrides?: Partial<{
  scores: Record<string, number>;
  comments: Record<string, string>;
  overallComment: string;
}>): Annotation {
  const scores = overrides?.scores ?? {
    correctness: 4,
    completeness: 3,
    quality: 5,
    clarity: 4,
    efficiency: 3,
  };
  const comments = overrides?.comments ?? {
    correctness: 'Looks correct',
    completeness: 'Mostly complete',
    quality: 'Great',
    clarity: 'Clear',
    efficiency: 'A bit verbose',
  };
  return createAnnotation(
    'ann-1',
    'sample-1',
    'human',
    scores,
    comments,
    overrides?.overallComment ?? 'Good overall',
  );
}

function makeArm(name: string, avgScore: number, totalCost = 1.0, avgDuration = 2.0): ExperimentArm {
  return {
    name,
    runId: `run-${name}`,
    avgScore,
    passRate: 0.8,
    avgDuration,
    totalCost,
    sampleCount: 10,
  };
}

// ---------------------------------------------------------------------------
// Tests: createRubricConfig
// ---------------------------------------------------------------------------

describe('createRubricConfig', () => {
  it('creates config with defaults', () => {
    const rubric = createRubricConfig(DEFAULT_RUBRIC_CATEGORIES);
    expect(rubric.requireComments).toBe(false);
    expect(rubric.allowPartialScores).toBe(false);
    expect(rubric.categories).toBe(DEFAULT_RUBRIC_CATEGORIES);
  });

  it('applies provided options', () => {
    const rubric = createRubricConfig(DEFAULT_RUBRIC_CATEGORIES, {
      requireComments: true,
      allowPartialScores: true,
    });
    expect(rubric.requireComments).toBe(true);
    expect(rubric.allowPartialScores).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: createAnnotation
// ---------------------------------------------------------------------------

describe('createAnnotation', () => {
  it('creates annotation with a timestamp', () => {
    const before = Date.now();
    const annotation = makeAnnotation();
    const after = Date.now();

    const ts = new Date(annotation.createdAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('stores all provided fields', () => {
    const annotation = makeAnnotation();
    expect(annotation.id).toBe('ann-1');
    expect(annotation.sampleId).toBe('sample-1');
    expect(annotation.annotator).toBe('human');
    expect(annotation.overallComment).toBe('Good overall');
  });
});

// ---------------------------------------------------------------------------
// Tests: validateAnnotation
// ---------------------------------------------------------------------------

describe('validateAnnotation', () => {
  it('catches missing categories when partial scores not allowed', () => {
    const rubric = makeRubric();
    const annotation = makeAnnotation({ scores: { correctness: 4 } });
    const errors = validateAnnotation(annotation, rubric);
    expect(errors.some((e) => e.includes('completeness'))).toBe(true);
    expect(errors.some((e) => e.includes('quality'))).toBe(true);
  });

  it('catches out-of-range scores', () => {
    const rubric = makeRubric();
    const annotation = makeAnnotation({
      scores: {
        correctness: 10,  // max is 5
        completeness: 3,
        quality: 5,
        clarity: 4,
        efficiency: 3,
      },
    });
    const errors = validateAnnotation(annotation, rubric);
    expect(errors.some((e) => e.includes('correctness') && e.includes('out of range'))).toBe(true);
  });

  it('catches negative scores', () => {
    const rubric = makeRubric();
    const annotation = makeAnnotation({
      scores: {
        correctness: -1,
        completeness: 3,
        quality: 5,
        clarity: 4,
        efficiency: 3,
      },
    });
    const errors = validateAnnotation(annotation, rubric);
    expect(errors.some((e) => e.includes('correctness') && e.includes('out of range'))).toBe(true);
  });

  it('catches missing comments when requireComments is true', () => {
    const rubric = makeRubric({ requireComments: true });
    const annotation = makeAnnotation({ comments: {} });
    const errors = validateAnnotation(annotation, rubric);
    expect(errors.some((e) => e.includes('Comment required'))).toBe(true);
  });

  it('passes a valid annotation', () => {
    const rubric = makeRubric();
    const annotation = makeAnnotation();
    const errors = validateAnnotation(annotation, rubric);
    expect(errors).toHaveLength(0);
  });

  it('allows partial scores when allowPartialScores is true', () => {
    const rubric = makeRubric({ allowPartialScores: true });
    const annotation = makeAnnotation({ scores: { correctness: 4 } });
    const errors = validateAnnotation(annotation, rubric);
    // should not have "missing category" errors
    expect(errors.filter((e) => e.startsWith('Missing score'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: computeAnnotationScore
// ---------------------------------------------------------------------------

describe('computeAnnotationScore', () => {
  it('normalizes score to 0–10 scale', () => {
    const rubric = makeRubric();
    // All max score (5/5 each) → should be 10
    const annotation = makeAnnotation({
      scores: { correctness: 5, completeness: 5, quality: 5, clarity: 5, efficiency: 5 },
    });
    const score = computeAnnotationScore(annotation, rubric);
    expect(score).toBe(10);
  });

  it('computes average across categories', () => {
    const rubric = makeRubric();
    // 4/5 each → (4/5)*10 = 8 each → avg 8
    const annotation = makeAnnotation({
      scores: { correctness: 4, completeness: 4, quality: 4, clarity: 4, efficiency: 4 },
    });
    const score = computeAnnotationScore(annotation, rubric);
    expect(score).toBeCloseTo(8, 5);
  });

  it('returns 0 for empty scores', () => {
    const rubric = makeRubric({ allowPartialScores: true });
    const annotation = makeAnnotation({ scores: {} });
    const score = computeAnnotationScore(annotation, rubric);
    expect(score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: aggregateAnnotations
// ---------------------------------------------------------------------------

describe('aggregateAnnotations', () => {
  it('averages scores across multiple annotators', () => {
    const ann1 = createAnnotation('a1', 's1', 'human', { correctness: 4 }, {}, '');
    const ann2 = createAnnotation('a2', 's1', 'forge', { correctness: 2 }, {}, '');
    const { avgScores, overallAvg } = aggregateAnnotations([ann1, ann2]);
    expect(avgScores['correctness']).toBe(3);
    expect(overallAvg).toBe(3);
  });

  it('returns empty result for no annotations', () => {
    const { avgScores, overallAvg } = aggregateAnnotations([]);
    expect(Object.keys(avgScores)).toHaveLength(0);
    expect(overallAvg).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: DEFAULT_RUBRIC_CATEGORIES
// ---------------------------------------------------------------------------

describe('DEFAULT_RUBRIC_CATEGORIES', () => {
  it('has exactly 5 categories', () => {
    expect(DEFAULT_RUBRIC_CATEGORIES).toHaveLength(5);
  });

  it('includes correctness, completeness, quality, clarity, efficiency', () => {
    const names = DEFAULT_RUBRIC_CATEGORIES.map((c) => c.name);
    expect(names).toContain('correctness');
    expect(names).toContain('completeness');
    expect(names).toContain('quality');
    expect(names).toContain('clarity');
    expect(names).toContain('efficiency');
  });
});

// ---------------------------------------------------------------------------
// Tests: compareExperiments
// ---------------------------------------------------------------------------

describe('compareExperiments', () => {
  it('picks winner by score when delta > 0.5', () => {
    const arms = [makeArm('v1', 7.0), makeArm('v2', 8.0)];
    const result = compareExperiments(arms);
    expect(result.winner).toBe('v2');
  });

  it('returns null winner when scores are too close', () => {
    const arms = [makeArm('v1', 7.8), makeArm('v2', 8.0)];
    const result = compareExperiments(arms);
    expect(result.winner).toBeNull();
  });

  it('computes scoreDelta, costDelta, speedDelta', () => {
    const arms = [
      makeArm('v1', 7.0, 2.0, 3.0),
      makeArm('v2', 8.0, 1.5, 2.5),
    ];
    const result = compareExperiments(arms);
    expect(result.scoreDelta).toBeCloseTo(1.0);
    // best arm (v2) cost delta vs second (v1): 1.5 - 2.0 = -0.5
    expect(result.costDelta).toBeCloseTo(-0.5);
    // speed delta: v2 duration - v1 duration = 2.5 - 3.0 = -0.5
    expect(result.speedDelta).toBeCloseTo(-0.5);
  });

  it('handles single arm gracefully', () => {
    const arms = [makeArm('v1', 7.0)];
    const result = compareExperiments(arms);
    expect(result.winner).toBe('v1');
    expect(result.scoreDelta).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: formatComparisonReport
// ---------------------------------------------------------------------------

describe('formatComparisonReport', () => {
  it('includes all arm names in the report', () => {
    const arms = [makeArm('v1', 7.0), makeArm('v2', 8.0)];
    const comparison = compareExperiments(arms);
    const report = formatComparisonReport(comparison);
    expect(report).toContain('v1');
    expect(report).toContain('v2');
  });

  it('includes score, pass rate, duration, cost columns', () => {
    const arms = [makeArm('v1', 7.0)];
    const comparison = compareExperiments(arms);
    const report = formatComparisonReport(comparison);
    expect(report).toContain('Avg Score');
    expect(report).toContain('Pass Rate');
    expect(report).toContain('Avg Duration');
    expect(report).toContain('Cost');
  });

  it('includes verdict', () => {
    const arms = [makeArm('v1', 7.0), makeArm('v2', 8.0)];
    const comparison = compareExperiments(arms);
    const report = formatComparisonReport(comparison);
    expect(report).toContain('Verdict');
  });
});

// ---------------------------------------------------------------------------
// Tests: formatAnnotationReport
// ---------------------------------------------------------------------------

describe('formatAnnotationReport', () => {
  it('includes scores and comments', () => {
    const rubric = makeRubric();
    const annotation = makeAnnotation();
    const report = formatAnnotationReport([annotation], rubric);
    expect(report).toContain('correctness');
    expect(report).toContain('4/5');
    expect(report).toContain('Looks correct');
  });

  it('includes overall comment', () => {
    const rubric = makeRubric();
    const annotation = makeAnnotation({ overallComment: 'Excellent work' });
    const report = formatAnnotationReport([annotation], rubric);
    expect(report).toContain('Excellent work');
  });

  it('includes aggregate section for multiple annotations', () => {
    const rubric = makeRubric();
    const ann1 = makeAnnotation();
    const ann2 = makeAnnotation({ overallComment: 'Second reviewer notes' });
    const report = formatAnnotationReport([ann1, ann2], rubric);
    expect(report).toContain('Aggregate');
  });
});

// ---------------------------------------------------------------------------
// Tests: renderComparisonHtml
// ---------------------------------------------------------------------------

describe('renderComparisonHtml', () => {
  it('includes delta indicator elements', () => {
    const arms = [makeArm('v1', 7.0), makeArm('v2', 9.0)];
    const comparison = compareExperiments(arms);
    const html = renderComparisonHtml(comparison);
    expect(html).toContain('delta-positive');
    expect(html).toContain('delta-negative');
  });

  it('includes winner annotation', () => {
    const arms = [makeArm('v1', 7.0), makeArm('v2', 9.0)];
    const comparison = compareExperiments(arms);
    const html = renderComparisonHtml(comparison);
    expect(html).toContain('Winner');
  });

  it('renders valid HTML structure', () => {
    const arms = [makeArm('v1', 7.0)];
    const comparison = compareExperiments(arms);
    const html = renderComparisonHtml(comparison);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<body>');
    expect(html).toContain('v1');
  });
});
