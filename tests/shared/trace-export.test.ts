import { describe, it, expect } from 'vitest';
import {
  EXPORT_VERSION,
  exportTrace,
  serializeTrace,
  importTrace,
  validateExportedSpan,
  validateExportedTrace,
  buildTraceUrl,
  parseTraceUrl,
  summarizeTrace,
  diffTraces,
  type ExportedSpan,
  type ExportedTrace,
} from '../../src/shared/trace-export';

function makeSpan(overrides: Partial<ExportedSpan> = {}): ExportedSpan {
  return {
    spanId: 'span-1',
    parentSpanId: null,
    operationName: 'test-op',
    agentName: 'Forge',
    runType: 'agent',
    startTime: 1000,
    endTime: 2500,
    durationMs: 1500,
    status: 'completed',
    tokensIn: 100,
    tokensOut: 50,
    cost: 0.01,
    model: 'claude-sonnet',
    error: null,
    metadata: {},
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExportedTrace> = {}): ExportedTrace {
  return {
    version: 1,
    exportedAt: '2026-04-11T00:00:00.000Z',
    traceId: 'trace-abc123',
    projectId: 'proj-1',
    projectName: 'Test Project',
    spans: [makeSpan()],
    totalDuration: 1500,
    totalTokens: 150,
    totalCost: 0.01,
    ...overrides,
  };
}

describe('EXPORT_VERSION', () => {
  it('is 1', () => {
    expect(EXPORT_VERSION).toBe(1);
  });
});

describe('exportTrace', () => {
  it('sets version to 1', () => {
    const spans = [makeSpan({ tokensIn: 100, tokensOut: 50, cost: 0.01 })];
    const trace = exportTrace('t1', null, null, spans);
    expect(trace.version).toBe(1);
  });

  it('calculates totalTokens correctly', () => {
    const spans = [
      makeSpan({ spanId: 'a', tokensIn: 100, tokensOut: 50, cost: 0.01 }),
      makeSpan({ spanId: 'b', tokensIn: 200, tokensOut: 75, cost: 0.02, parentSpanId: 'a' }),
    ];
    const trace = exportTrace('t1', null, null, spans);
    expect(trace.totalTokens).toBe(425);
  });

  it('calculates totalCost correctly', () => {
    const spans = [
      makeSpan({ spanId: 'a', cost: 0.05 }),
      makeSpan({ spanId: 'b', cost: 0.03, parentSpanId: 'a' }),
    ];
    const trace = exportTrace('t1', null, null, spans);
    expect(trace.totalCost).toBeCloseTo(0.08);
  });

  it('calculates totalDuration from root span', () => {
    const spans = [
      makeSpan({ spanId: 'root', durationMs: 3000 }),
      makeSpan({ spanId: 'child', parentSpanId: 'root', durationMs: 1000 }),
    ];
    const trace = exportTrace('t1', null, null, spans);
    expect(trace.totalDuration).toBe(3000);
  });

  it('calculates totalDuration from start/end when no root span duration', () => {
    const spans = [
      makeSpan({ spanId: 'a', startTime: 1000, endTime: 4000, durationMs: null }),
      makeSpan({ spanId: 'b', parentSpanId: 'a', startTime: 2000, endTime: 3500, durationMs: null }),
    ];
    const trace = exportTrace('t1', null, null, spans);
    expect(trace.totalDuration).toBe(3000);
  });
});

describe('serializeTrace', () => {
  it('produces valid JSON', () => {
    const trace = makeTrace();
    const json = serializeTrace(trace);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('uses 2-space indentation', () => {
    const trace = makeTrace();
    const json = serializeTrace(trace);
    expect(json).toContain('  "version"');
  });
});

describe('importTrace', () => {
  it('parses valid JSON', () => {
    const trace = makeTrace();
    const json = serializeTrace(trace);
    const result = importTrace(json);
    expect(result.success).toBe(true);
    expect(result.trace).not.toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  it('rejects invalid JSON', () => {
    const result = importTrace('not valid json {{{');
    expect(result.success).toBe(false);
    expect(result.trace).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/Failed to parse JSON/);
  });

  it('rejects wrong version', () => {
    const trace = { ...makeTrace(), version: 99 };
    const result = importTrace(JSON.stringify(trace));
    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.includes('version'))).toBe(true);
  });

  it('validates span structure', () => {
    const trace = {
      ...makeTrace(),
      spans: [{ spanId: '', status: 'bad-status' }],
    };
    const result = importTrace(JSON.stringify(trace));
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('validateExportedSpan', () => {
  it('catches missing spanId', () => {
    const span = { ...makeSpan(), spanId: '' };
    const errors = validateExportedSpan(span, 0);
    expect(errors.some(e => e.includes('spanId'))).toBe(true);
  });

  it('catches invalid status', () => {
    const span = { ...makeSpan(), status: 'unknown' };
    const errors = validateExportedSpan(span, 0);
    expect(errors.some(e => e.includes('status'))).toBe(true);
  });

  it('returns empty array for valid span', () => {
    const errors = validateExportedSpan(makeSpan(), 0);
    expect(errors).toHaveLength(0);
  });
});

describe('validateExportedTrace', () => {
  it('catches missing traceId', () => {
    const trace = { ...makeTrace(), traceId: '' };
    const errors = validateExportedTrace(trace);
    expect(errors.some(e => e.includes('traceId'))).toBe(true);
  });

  it('returns empty array for valid trace', () => {
    const errors = validateExportedTrace(makeTrace());
    expect(errors).toHaveLength(0);
  });

  it('returns error for non-object', () => {
    const errors = validateExportedTrace('not an object');
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('buildTraceUrl', () => {
  it('creates correct URL', () => {
    const result = buildTraceUrl('https://kageops.ai', 'abc123');
    expect(result.fullUrl).toBe('https://kageops.ai/traces/abc123');
    expect(result.baseUrl).toBe('https://kageops.ai');
    expect(result.traceId).toBe('abc123');
  });

  it('handles trailing slash in base URL', () => {
    const result = buildTraceUrl('https://kageops.ai/', 'abc123');
    expect(result.fullUrl).toBe('https://kageops.ai/traces/abc123');
  });
});

describe('parseTraceUrl', () => {
  it('extracts traceId', () => {
    const result = parseTraceUrl('https://kageops.ai/traces/abc123');
    expect(result).toEqual({ traceId: 'abc123' });
  });

  it('returns null for invalid URL', () => {
    expect(parseTraceUrl('https://kageops.ai/dashboard')).toBeNull();
    expect(parseTraceUrl('not-a-url')).toBeNull();
    expect(parseTraceUrl('')).toBeNull();
  });

  it('handles query params after traceId', () => {
    const result = parseTraceUrl('https://kageops.ai/traces/abc123?view=detail');
    expect(result).toEqual({ traceId: 'abc123' });
  });
});

describe('summarizeTrace', () => {
  it('includes all key metrics', () => {
    const trace = makeTrace({
      traceId: 'xyz789',
      spans: [makeSpan(), makeSpan({ spanId: 'span-2', parentSpanId: 'span-1' })],
      totalDuration: 2300,
      totalTokens: 1234,
      totalCost: 0.05,
    });
    const summary = summarizeTrace(trace);
    expect(summary).toContain('xyz789');
    expect(summary).toContain('2 spans');
    expect(summary).toContain('2.3s');
    expect(summary).toContain('1,234 tokens');
    expect(summary).toContain('$0.05');
  });

  it('handles null duration', () => {
    const trace = makeTrace({ totalDuration: null });
    const summary = summarizeTrace(trace);
    expect(summary).toContain('n/a');
  });
});

describe('diffTraces', () => {
  it('reports span count difference', () => {
    const traceA = makeTrace({ spans: [makeSpan()] });
    const traceB = makeTrace({
      traceId: 'trace-b',
      spans: [makeSpan(), makeSpan({ spanId: 'span-2', parentSpanId: 'span-1' })],
    });
    const diff = diffTraces(traceA, traceB);
    expect(diff).toContain('Spans');
    expect(diff).toContain('+1');
  });

  it('reports duration difference', () => {
    const traceA = makeTrace({ totalDuration: 1000 });
    const traceB = makeTrace({ traceId: 'trace-b', totalDuration: 3000 });
    const diff = diffTraces(traceA, traceB);
    expect(diff).toContain('Duration');
    expect(diff).toContain('+2.0s');
  });

  it('produces markdown table format', () => {
    const traceA = makeTrace();
    const traceB = makeTrace({ traceId: 'trace-b' });
    const diff = diffTraces(traceA, traceB);
    expect(diff).toContain('## Trace Diff');
    expect(diff).toContain('|');
    expect(diff).toContain('---');
  });
});

describe('round-trip', () => {
  it('exportTrace → serializeTrace → importTrace preserves data', () => {
    const spans = [
      makeSpan({ spanId: 's1', tokensIn: 300, tokensOut: 150, cost: 0.03 }),
      makeSpan({ spanId: 's2', parentSpanId: 's1', tokensIn: 200, tokensOut: 100, cost: 0.02 }),
    ];
    const original = exportTrace('round-trip-id', 'proj-rt', 'RT Project', spans);
    const json = serializeTrace(original);
    const result = importTrace(json);

    expect(result.success).toBe(true);
    expect(result.trace).not.toBeNull();
    const imported = result.trace!;
    expect(imported.traceId).toBe('round-trip-id');
    expect(imported.projectId).toBe('proj-rt');
    expect(imported.projectName).toBe('RT Project');
    expect(imported.spans).toHaveLength(2);
    expect(imported.totalTokens).toBe(750);
    expect(imported.totalCost).toBeCloseTo(0.05);
    expect(imported.version).toBe(1);
  });
});
