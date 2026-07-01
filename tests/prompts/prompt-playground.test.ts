import { describe, it, expect } from 'vitest';
import {
  extractVariables,
  createPromptTemplate,
  renderPrompt,
  hashPromptContent,
  createVersion,
  diffPrompts,
  runPlayground,
  compareRuns,
  formatRunReport,
  formatComparisonReport,
  formatVersionHistory,
  getVersionChain,
} from '../../src/prompts/prompt-playground';

describe('extractVariables', () => {
  it.each([
    ['Hello {{name}}', ['name']],
    ['{{a}} and {{b}}', ['a', 'b']],
    ['{{x}} plus {{x}}', ['x']],
    ['no variables here', []],
    ['{{first}} middle {{last}}', ['first', 'last']],
    ['{{a}}{{b}}{{c}}', ['a', 'b', 'c']],
  ])('extracts variables from %j', (content, expected) => {
    expect(extractVariables(content)).toEqual(expected);
  });

  it('handles empty string', () => {
    expect(extractVariables('')).toEqual([]);
  });

  it('ignores malformed placeholders', () => {
    expect(extractVariables('{{ spaced }} {missing} {{ok}}')).toEqual(['ok']);
  });
});

describe('createPromptTemplate', () => {
  it('creates template with defaults', () => {
    const t = createPromptTemplate('test', 'Hello {{name}}');
    expect(t.name).toBe('test');
    expect(t.content).toBe('Hello {{name}}');
    expect(t.variables).toEqual(['name']);
    expect(t.temperature).toBe(0.7);
    expect(t.maxTokens).toBe(1024);
    expect(t.id).toContain('prompt_');
  });

  it('applies overrides', () => {
    const t = createPromptTemplate('test', 'hi', { temperature: 0.2, model: 'gpt-4' });
    expect(t.temperature).toBe(0.2);
    expect(t.model).toBe('gpt-4');
  });
});

describe('renderPrompt', () => {
  it('substitutes all variables', () => {
    const t = createPromptTemplate('t', 'Hello {{name}}, welcome to {{place}}');
    expect(renderPrompt(t, { name: 'Alice', place: 'Wonderland' }))
      .toBe('Hello Alice, welcome to Wonderland');
  });

  it('throws on missing variable', () => {
    const t = createPromptTemplate('t', '{{missing}}');
    expect(() => renderPrompt(t, {})).toThrow('Missing variables: missing');
  });

  it('substitutes duplicate placeholders', () => {
    const t = createPromptTemplate('t', '{{x}} and {{x}}');
    expect(renderPrompt(t, { x: 'val' })).toBe('val and val');
  });
});

describe('hashPromptContent', () => {
  it('returns consistent hex string', () => {
    const h1 = hashPromptContent('hello');
    const h2 = hashPromptContent('hello');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
  });

  it('produces different hashes for different content', () => {
    expect(hashPromptContent('a')).not.toBe(hashPromptContent('b'));
  });
});

describe('createVersion', () => {
  it('creates version with hash and parent link', () => {
    const t = createPromptTemplate('t', 'content v1');
    const v1 = createVersion(t, 'alice', 'initial', null);
    expect(v1.parentHash).toBeNull();
    expect(v1.hash).toBe(hashPromptContent('content v1'));

    const t2 = createPromptTemplate('t', 'content v2');
    const v2 = createVersion(t2, 'bob', 'update', v1.hash);
    expect(v2.parentHash).toBe(v1.hash);
  });

  it('stores prompt content snapshot', () => {
    const t = createPromptTemplate('t', 'snapshot');
    const v = createVersion(t, 'a', 'msg', null);
    expect(v.content).toBe('snapshot');
  });
});

describe('diffPrompts', () => {
  it('detects additions', () => {
    const d = diffPrompts('line1', 'line1\nline2');
    expect(d.additions).toBe(1);
  });

  it('detects deletions', () => {
    const d = diffPrompts('line1\nline2', 'line1');
    expect(d.deletions).toBe(1);
  });

  it('detects modifications', () => {
    const d = diffPrompts('old line', 'new line');
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0].oldLines).toEqual(['old line']);
    expect(d.hunks[0].newLines).toEqual(['new line']);
  });

  it('returns empty hunks for identical content', () => {
    const d = diffPrompts('same', 'same');
    expect(d.hunks).toHaveLength(0);
    expect(d.additions).toBe(0);
    expect(d.deletions).toBe(0);
  });
});

describe('runPlayground', () => {
  it('creates a run record', () => {
    const t = createPromptTemplate('t', 'hello');
    const run = runPlayground(t, {}, 'claude', 'output', 100, 0.01, 500);
    expect(run.promptId).toBe(t.id);
    expect(run.output).toBe('output');
    expect(run.tokenCount).toBe(100);
    expect(run.runId).toContain('run_');
  });
});

describe('compareRuns', () => {
  it('finds best and worst by cost', () => {
    const t = createPromptTemplate('t', 'x');
    const r1 = runPlayground(t, {}, 'm', 'o', 100, 0.01, 500);
    const r2 = runPlayground(t, {}, 'm', 'o', 200, 0.05, 300);
    const r3 = runPlayground(t, {}, 'm', 'o', 150, 0.03, 400);
    const cmp = compareRuns([r1, r2, r3]);
    expect(cmp.bestRunId).toBe(r1.runId);
    expect(cmp.worstRunId).toBe(r2.runId);
  });

  it('computes averages', () => {
    const t = createPromptTemplate('t', 'x');
    const r1 = runPlayground(t, {}, 'm', 'o', 100, 0.10, 300);
    const r2 = runPlayground(t, {}, 'm', 'o', 200, 0.20, 600);
    const cmp = compareRuns([r1, r2]);
    expect(cmp.avgCost).toBeCloseTo(0.15);
    expect(cmp.avgDuration).toBe(450);
    expect(cmp.avgTokens).toBe(150);
  });

  it('handles empty runs', () => {
    const cmp = compareRuns([]);
    expect(cmp.bestRunId).toBeNull();
    expect(cmp.avgCost).toBe(0);
  });
});

describe('formatRunReport', () => {
  it('produces markdown with run details', () => {
    const t = createPromptTemplate('t', 'x');
    const run = runPlayground(t, {}, 'claude', 'hello world', 50, 0.005, 200);
    const report = formatRunReport(run);
    expect(report).toContain('## Run:');
    expect(report).toContain('claude');
    expect(report).toContain('hello world');
    expect(report).toContain('$0.0050');
  });
});

describe('formatComparisonReport', () => {
  it('produces markdown table', () => {
    const t = createPromptTemplate('t', 'x');
    const r1 = runPlayground(t, {}, 'm', 'o', 100, 0.01, 500);
    const cmp = compareRuns([r1]);
    const report = formatComparisonReport(cmp);
    expect(report).toContain('## Comparison Report');
    expect(report).toContain('Avg cost');
  });
});

describe('formatVersionHistory', () => {
  it('produces markdown table of versions', () => {
    const t = createPromptTemplate('t', 'c');
    const v = createVersion(t, 'alice', 'init', null);
    const report = formatVersionHistory([v]);
    expect(report).toContain('## Version History');
    expect(report).toContain('alice');
    expect(report).toContain('init');
  });
});

describe('getVersionChain', () => {
  it('walks parent chain to build history', () => {
    const t1 = createPromptTemplate('t', 'v1');
    const v1 = createVersion(t1, 'a', 'first', null);
    const t2 = createPromptTemplate('t', 'v2');
    const v2 = createVersion(t2, 'a', 'second', v1.hash);
    const t3 = createPromptTemplate('t', 'v3');
    const v3 = createVersion(t3, 'a', 'third', v2.hash);

    const chain = getVersionChain([v1, v2, v3], v3.hash);
    expect(chain).toHaveLength(3);
    expect(chain[0].message).toBe('third');
    expect(chain[1].message).toBe('second');
    expect(chain[2].message).toBe('first');
  });

  it('returns empty array for unknown hash', () => {
    expect(getVersionChain([], 'unknown')).toEqual([]);
  });

  it('stops at root version', () => {
    const t = createPromptTemplate('t', 'only');
    const v = createVersion(t, 'a', 'root', null);
    const chain = getVersionChain([v], v.hash);
    expect(chain).toHaveLength(1);
  });
});
