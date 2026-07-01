import { describe, it, expect } from 'vitest';
import {
  buildJudgePrompt,
  parseJudgeVerdict,
  parseDimensionScore,
  calculateWeightedScore,
  buildComparisonJudgePrompt,
  createJudgeConfig,
  validateCriteria,
  formatVerdictReport,
  ALL_DIMENSIONS,
  DEFAULT_CRITERIA,
  type ScoringCriteria,
  type DimensionScore,
} from '../../src/eval/llm-judge';

const SAMPLE_CRITERIA: readonly ScoringCriteria[] = [
  { dimension: 'correctness', weight: 0.6, description: 'Correctly solves the task' },
  { dimension: 'readability', weight: 0.4, description: 'Well documented' },
];

const STRUCTURED_AI_OUTPUT = `
--- DIMENSION: correctness ---
SCORE: 8
REASONING: Output correctly implements the feature but misses one edge case.
--- END DIMENSION ---

--- DIMENSION: readability ---
SCORE: 7
REASONING: Code is generally readable with decent naming.
--- END DIMENSION ---

SUMMARY: Overall a solid implementation with minor gaps.
CONFIDENCE: 0.85
`;

describe('buildJudgePrompt', () => {
  it('includes task description', () => {
    const prompt = buildJudgePrompt('Build a login form', 'A form with email and password', 'Here is the form', SAMPLE_CRITERIA);
    expect(prompt).toContain('Build a login form');
  });

  it('includes all criteria dimensions', () => {
    const prompt = buildJudgePrompt('task', 'expected', 'actual', SAMPLE_CRITERIA);
    expect(prompt).toContain('correctness');
    expect(prompt).toContain('readability');
  });

  it('includes expected and actual output', () => {
    const prompt = buildJudgePrompt('task', 'EXPECTED_CONTENT', 'ACTUAL_CONTENT', SAMPLE_CRITERIA);
    expect(prompt).toContain('EXPECTED_CONTENT');
    expect(prompt).toContain('ACTUAL_CONTENT');
  });
});

describe('parseJudgeVerdict', () => {
  it('parses structured blocks', () => {
    const verdict = parseJudgeVerdict(STRUCTURED_AI_OUTPUT, SAMPLE_CRITERIA, 6);
    expect(verdict.dimensions).toHaveLength(2);
    expect(verdict.dimensions[0].dimension).toBe('correctness');
    expect(verdict.dimensions[0].score).toBe(8);
    expect(verdict.dimensions[1].dimension).toBe('readability');
    expect(verdict.dimensions[1].score).toBe(7);
  });

  it('calculates weighted average', () => {
    const verdict = parseJudgeVerdict(STRUCTURED_AI_OUTPUT, SAMPLE_CRITERIA, 6);
    // correctness: 8 * 0.6 = 4.8, readability: 7 * 0.4 = 2.8 => 7.6
    expect(verdict.overallScore).toBeCloseTo(7.6, 1);
  });

  it('sets passed based on threshold', () => {
    const passing = parseJudgeVerdict(STRUCTURED_AI_OUTPUT, SAMPLE_CRITERIA, 6);
    expect(passing.passed).toBe(true);

    const failing = parseJudgeVerdict(STRUCTURED_AI_OUTPUT, SAMPLE_CRITERIA, 9);
    expect(failing.passed).toBe(false);
  });

  it('handles missing dimensions gracefully', () => {
    const partialOutput = `
--- DIMENSION: correctness ---
SCORE: 5
REASONING: Partially correct.
--- END DIMENSION ---
SUMMARY: Incomplete.
CONFIDENCE: 0.5
`;
    const verdict = parseJudgeVerdict(partialOutput, SAMPLE_CRITERIA, 6);
    expect(verdict.dimensions).toHaveLength(1);
    expect(verdict.overallScore).toBeGreaterThan(0);
  });
});

describe('parseDimensionScore', () => {
  it('extracts score and reasoning', () => {
    const block = `--- DIMENSION: correctness ---\nSCORE: 9\nREASONING: Excellent implementation.\n--- END DIMENSION ---`;
    const result = parseDimensionScore(block, SAMPLE_CRITERIA);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(9);
    expect(result!.reasoning).toBe('Excellent implementation.');
    expect(result!.dimension).toBe('correctness');
  });

  it('returns null for malformed block', () => {
    const block = `Some random text without proper structure`;
    const result = parseDimensionScore(block, SAMPLE_CRITERIA);
    expect(result).toBeNull();
  });
});

describe('calculateWeightedScore', () => {
  it('computes correctly', () => {
    const dimensions: readonly DimensionScore[] = [
      { dimension: 'correctness', score: 8, reasoning: '', weight: 0.6 },
      { dimension: 'readability', score: 6, reasoning: '', weight: 0.4 },
    ];
    const score = calculateWeightedScore(dimensions);
    expect(score).toBeCloseTo(7.2, 1);
  });

  it('normalizes weights that do not sum to 1', () => {
    const dimensions: readonly DimensionScore[] = [
      { dimension: 'correctness', score: 10, reasoning: '', weight: 2 },
      { dimension: 'readability', score: 10, reasoning: '', weight: 2 },
    ];
    const score = calculateWeightedScore(dimensions);
    expect(score).toBeCloseTo(10, 1);
  });
});

describe('buildComparisonJudgePrompt', () => {
  it('includes both outputs', () => {
    const prompt = buildComparisonJudgePrompt('task', 'OUTPUT_A_CONTENT', 'OUTPUT_B_CONTENT', SAMPLE_CRITERIA);
    expect(prompt).toContain('OUTPUT_A_CONTENT');
    expect(prompt).toContain('OUTPUT_B_CONTENT');
  });
});

describe('createJudgeConfig', () => {
  it('uses defaults when no overrides provided', () => {
    const config = createJudgeConfig();
    expect(config.passThreshold).toBe(6);
    expect(config.requireAllDimensions).toBe(false);
    expect(config.criteria).toBe(DEFAULT_CRITERIA);
  });

  it('applies overrides', () => {
    const config = createJudgeConfig({ passThreshold: 8, requireAllDimensions: true });
    expect(config.passThreshold).toBe(8);
    expect(config.requireAllDimensions).toBe(true);
    expect(config.criteria).toBe(DEFAULT_CRITERIA);
  });
});

describe('validateCriteria', () => {
  it('catches weights not summing to 1', () => {
    const bad: readonly ScoringCriteria[] = [
      { dimension: 'correctness', weight: 0.5, description: 'test' },
      { dimension: 'readability', weight: 0.3, description: 'test' },
    ];
    const errors = validateCriteria(bad);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/weight/i);
  });

  it('catches duplicate dimensions', () => {
    const bad: readonly ScoringCriteria[] = [
      { dimension: 'correctness', weight: 0.5, description: 'test' },
      { dimension: 'correctness', weight: 0.5, description: 'test' },
    ];
    const errors = validateCriteria(bad);
    expect(errors.some((e) => e.includes('correctness'))).toBe(true);
  });
});

describe('formatVerdictReport', () => {
  it('includes all dimensions', () => {
    const verdict = parseJudgeVerdict(STRUCTURED_AI_OUTPUT, SAMPLE_CRITERIA, 6);
    const report = formatVerdictReport(verdict);
    expect(report).toContain('correctness');
    expect(report).toContain('readability');
  });
});

describe('ALL_DIMENSIONS', () => {
  it('has 7 entries', () => {
    expect(ALL_DIMENSIONS).toHaveLength(7);
  });
});

describe('DEFAULT_CRITERIA', () => {
  it('weights sum to 1', () => {
    const total = DEFAULT_CRITERIA.reduce((sum, c) => sum + c.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});
