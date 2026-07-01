import { describe, it, expect } from 'vitest';
import {
  createDataset,
  addSample,
  removeSample,
  filterSamples,
  createRunConfig,
  computeRunSummary,
  buildEvalRunResult,
  serializeDataset,
  importDataset,
  formatEvalReport,
  compareRuns,
  type EvalSample,
  type EvalSampleResult,
  type EvalRunConfig,
} from '../../src/eval/eval-dataset';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSample(overrides?: Partial<EvalSample>): EvalSample {
  return {
    id: 'sample-1',
    input: 'Write a hello world function',
    expectedOutput: 'function hello() { return "Hello, World!"; }',
    taskType: 'code-generation',
    agent: 'forge',
    metadata: {},
    tags: ['basic', 'typescript'],
    ...overrides,
  };
}

function makeSampleResult(overrides?: Partial<EvalSampleResult>): EvalSampleResult {
  return {
    sampleId: 'sample-1',
    actualOutput: 'function hello() { return "Hello, World!"; }',
    durationMs: 500,
    tokenCount: 100,
    cost: 0.001,
    passed: true,
    score: 8,
    error: null,
    ...overrides,
  };
}

function makeRunConfig(overrides?: Partial<EvalRunConfig>): EvalRunConfig {
  return {
    datasetId: 'ds-1',
    agentOverride: null,
    modelOverride: null,
    maxSamples: null,
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createDataset
// ---------------------------------------------------------------------------

describe('createDataset', () => {
  it('creates dataset with version 1', () => {
    const ds = createDataset('ds-1', 'My Dataset', 'Test runs', []);
    expect(ds.id).toBe('ds-1');
    expect(ds.name).toBe('My Dataset');
    expect(ds.description).toBe('Test runs');
    expect(ds.version).toBe(1);
    expect(ds.samples).toEqual([]);
    expect(ds.createdAt).toBeTruthy();
    expect(ds.updatedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// addSample
// ---------------------------------------------------------------------------

describe('addSample', () => {
  it('appends sample immutably and bumps version', () => {
    const ds = createDataset('ds-1', 'My Dataset', 'Test runs', []);
    const sample = makeSample();
    const updated = addSample(ds, sample);

    // immutable — original unchanged
    expect(ds.samples).toHaveLength(0);
    expect(ds.version).toBe(1);

    // updated has the new sample and bumped version
    expect(updated.samples).toHaveLength(1);
    expect(updated.samples[0]).toBe(sample);
    expect(updated.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// removeSample
// ---------------------------------------------------------------------------

describe('removeSample', () => {
  it('removes sample by id and bumps version', () => {
    const s1 = makeSample({ id: 's1' });
    const s2 = makeSample({ id: 's2' });
    const ds = createDataset('ds-1', 'My Dataset', 'Test', [s1, s2]);
    const updated = removeSample(ds, 's1');

    // immutable
    expect(ds.samples).toHaveLength(2);
    expect(ds.version).toBe(1);

    // updated
    expect(updated.samples).toHaveLength(1);
    expect(updated.samples[0].id).toBe('s2');
    expect(updated.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// filterSamples
// ---------------------------------------------------------------------------

describe('filterSamples', () => {
  const samples: readonly EvalSample[] = [
    makeSample({ id: 's1', taskType: 'code-generation', agent: 'forge', tags: ['basic'] }),
    makeSample({ id: 's2', taskType: 'review', agent: 'vigil', tags: ['advanced'] }),
    makeSample({ id: 's3', taskType: 'code-generation', agent: 'vigil', tags: ['basic', 'security'] }),
  ];
  const ds = createDataset('ds-1', 'Test', 'desc', samples);

  it('filters by taskType', () => {
    const result = filterSamples(ds, { taskType: 'code-generation' });
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('filters by agent', () => {
    const result = filterSamples(ds, { agent: 'vigil' });
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id)).toEqual(['s2', 's3']);
  });

  it('filters by tags (any match)', () => {
    const result = filterSamples(ds, { tags: ['security'] });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('s3');
  });
});

// ---------------------------------------------------------------------------
// createRunConfig
// ---------------------------------------------------------------------------

describe('createRunConfig', () => {
  it('sets defaults when no overrides provided', () => {
    const config = createRunConfig('ds-1');
    expect(config.datasetId).toBe('ds-1');
    expect(config.agentOverride).toBeNull();
    expect(config.modelOverride).toBeNull();
    expect(config.maxSamples).toBeNull();
    expect(config.tags).toEqual([]);
  });

  it('applies overrides', () => {
    const config = createRunConfig('ds-1', {
      agentOverride: 'forge',
      modelOverride: 'claude-3-5-sonnet',
      maxSamples: 10,
      tags: ['smoke'],
    });
    expect(config.agentOverride).toBe('forge');
    expect(config.modelOverride).toBe('claude-3-5-sonnet');
    expect(config.maxSamples).toBe(10);
    expect(config.tags).toEqual(['smoke']);
  });
});

// ---------------------------------------------------------------------------
// computeRunSummary
// ---------------------------------------------------------------------------

describe('computeRunSummary', () => {
  it('calculates averages correctly', () => {
    const results: readonly EvalSampleResult[] = [
      makeSampleResult({ sampleId: 's1', passed: true, score: 8, durationMs: 400, tokenCount: 100, cost: 0.001 }),
      makeSampleResult({ sampleId: 's2', passed: true, score: 6, durationMs: 600, tokenCount: 200, cost: 0.002 }),
    ];
    const summary = computeRunSummary(results);
    expect(summary.avgScore).toBe(7);
    expect(summary.avgDuration).toBe(500);
    expect(summary.totalTokens).toBe(300);
    expect(summary.totalCost).toBeCloseTo(0.003);
  });

  it('calculates pass rate', () => {
    const results: readonly EvalSampleResult[] = [
      makeSampleResult({ sampleId: 's1', passed: true, error: null }),
      makeSampleResult({ sampleId: 's2', passed: false, error: null }),
      makeSampleResult({ sampleId: 's3', passed: false, error: 'timeout' }),
    ];
    const summary = computeRunSummary(results);
    expect(summary.passedCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.errorCount).toBe(1);
    expect(summary.passRate).toBeCloseTo(1 / 3);
  });

  it('handles empty results', () => {
    const summary = computeRunSummary([]);
    expect(summary.totalSamples).toBe(0);
    expect(summary.passRate).toBe(0);
    expect(summary.avgScore).toBe(0);
    expect(summary.avgDuration).toBe(0);
    expect(summary.totalCost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildEvalRunResult
// ---------------------------------------------------------------------------

describe('buildEvalRunResult', () => {
  it('sets timestamps on the result', () => {
    const config = makeRunConfig();
    const results = [makeSampleResult()];
    const runResult = buildEvalRunResult('run-1', 'ds-1', config, results);

    expect(runResult.runId).toBe('run-1');
    expect(runResult.datasetId).toBe('ds-1');
    expect(runResult.startedAt).toBeTruthy();
    expect(runResult.completedAt).toBeTruthy();
    expect(runResult.summary.totalSamples).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// serializeDataset / importDataset
// ---------------------------------------------------------------------------

describe('serializeDataset', () => {
  it('produces valid JSON', () => {
    const ds = createDataset('ds-1', 'My Dataset', 'desc', [makeSample()]);
    const json = serializeDataset(ds);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['id']).toBe('ds-1');
  });
});

describe('importDataset', () => {
  it('parses valid JSON back to dataset', () => {
    const ds = createDataset('ds-1', 'My Dataset', 'desc', [makeSample()]);
    const json = serializeDataset(ds);
    const imported = importDataset(json);
    expect(imported).not.toBeNull();
    expect(imported?.id).toBe('ds-1');
    expect(imported?.version).toBe(1);
  });

  it('returns null for invalid JSON', () => {
    expect(importDataset('not-valid-json')).toBeNull();
    expect(importDataset(JSON.stringify({ wrong: 'shape' }))).toBeNull();
    expect(importDataset('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatEvalReport
// ---------------------------------------------------------------------------

describe('formatEvalReport', () => {
  it('includes summary table in output', () => {
    const config = makeRunConfig();
    const results = [
      makeSampleResult({ sampleId: 's1', passed: true, score: 9 }),
      makeSampleResult({ sampleId: 's2', passed: false, score: 4, error: null }),
    ];
    const runResult = buildEvalRunResult('run-42', 'ds-1', config, results);
    const report = formatEvalReport(runResult);

    expect(report).toContain('# Eval Run Report');
    expect(report).toContain('run-42');
    expect(report).toContain('## Summary');
    expect(report).toContain('Pass Rate');
    expect(report).toContain('Total Samples');
    expect(report).toContain('## Sample Results');
    expect(report).toContain('s1');
    expect(report).toContain('## Cost Breakdown');
  });
});

// ---------------------------------------------------------------------------
// compareRuns
// ---------------------------------------------------------------------------

describe('compareRuns', () => {
  it('shows score delta between two runs', () => {
    const config = makeRunConfig();

    const resultsA = [makeSampleResult({ score: 6, passed: true })];
    const runA = buildEvalRunResult('run-A', 'ds-1', config, resultsA);

    const resultsB = [makeSampleResult({ score: 9, passed: true })];
    const runB = buildEvalRunResult('run-B', 'ds-1', config, resultsB);

    const comparison = compareRuns(runA, runB);

    expect(comparison).toContain('# Eval Run Comparison');
    expect(comparison).toContain('run-A');
    expect(comparison).toContain('run-B');
    expect(comparison).toContain('Avg Score');
    expect(comparison).toContain('+3.00');
  });
});
