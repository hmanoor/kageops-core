import { describe, it, expect } from 'vitest';
import {
  generateTraceId,
  generateSpanId,
  createRootContext,
  createChildContext,
  startSpan,
  endSpan,
  buildTraceTree,
  flattenTrace,
  formatTraceReport,
  serializeContext,
  deserializeContext,
} from '../../src/shared/trace-context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateTraceId', () => {
  it('returns valid UUID v4 format', () => {
    expect(generateTraceId()).toMatch(UUID_RE);
  });
});

describe('generateSpanId', () => {
  it('returns unique values on repeated calls', () => {
    const a = generateSpanId();
    const b = generateSpanId();
    expect(a).not.toBe(b);
  });
});

describe('createRootContext', () => {
  it('sets traceId and spanId as UUIDs, parentSpanId null', () => {
    const ctx = createRootContext('test.op');
    expect(ctx.traceId).toMatch(UUID_RE);
    expect(ctx.spanId).toMatch(UUID_RE);
    expect(ctx.parentSpanId).toBeNull();
  });

  it('sets operationName', () => {
    const ctx = createRootContext('sensei.orchestrate');
    expect(ctx.operationName).toBe('sensei.orchestrate');
  });
});

describe('createChildContext', () => {
  it('inherits traceId from parent', () => {
    const parent = createRootContext('root');
    const child = createChildContext(parent, 'child.op');
    expect(child.traceId).toBe(parent.traceId);
  });

  it('sets parentSpanId to parent spanId', () => {
    const parent = createRootContext('root');
    const child = createChildContext(parent, 'child.op');
    expect(child.parentSpanId).toBe(parent.spanId);
  });

  it('gets new spanId different from parent', () => {
    const parent = createRootContext('root');
    const child = createChildContext(parent, 'child.op');
    expect(child.spanId).not.toBe(parent.spanId);
  });
});

describe('startSpan', () => {
  it('creates a running span', () => {
    const ctx = createRootContext('op');
    const span = startSpan(ctx);
    expect(span.status).toBe('running');
    expect(span.endTime).toBeNull();
    expect(span.durationMs).toBeNull();
  });
});

describe('endSpan', () => {
  it('sets endTime and durationMs', () => {
    const ctx = createRootContext('op');
    const span = startSpan(ctx);
    const ended = endSpan(span, 'completed');
    expect(ended.endTime).toBeTypeOf('number');
    expect(ended.durationMs).toBeGreaterThanOrEqual(0);
    expect(ended.status).toBe('completed');
  });

  it('includes error message when status is failed', () => {
    const ctx = createRootContext('op');
    const span = startSpan(ctx);
    const ended = endSpan(span, 'failed', 'something went wrong');
    expect(ended.status).toBe('failed');
    expect(ended.error).toBe('something went wrong');
  });
});

describe('buildTraceTree', () => {
  it('builds tree from flat spans', () => {
    const root = createRootContext('root');
    const child = createChildContext(root, 'child');
    const spans = [startSpan(root), startSpan(child)];
    const tree = buildTraceTree(spans);
    expect(tree).not.toBeNull();
    expect(tree?.rootSpan.context.operationName).toBe('root');
    expect(tree?.children).toHaveLength(1);
  });

  it('returns null for empty input', () => {
    expect(buildTraceTree([])).toBeNull();
  });

  it('handles multi-level nesting', () => {
    const root = createRootContext('root');
    const child = createChildContext(root, 'child');
    const grandchild = createChildContext(child, 'grandchild');
    const spans = [startSpan(root), startSpan(child), startSpan(grandchild)];
    const tree = buildTraceTree(spans);
    expect(tree?.children[0]?.children).toHaveLength(1);
    expect(tree?.children[0]?.children[0]?.rootSpan.context.operationName).toBe('grandchild');
  });
});

describe('flattenTrace', () => {
  it('returns all spans depth-first', () => {
    const root = createRootContext('root');
    const child = createChildContext(root, 'child');
    const grandchild = createChildContext(child, 'grandchild');
    const spans = [startSpan(root), startSpan(child), startSpan(grandchild)];
    const tree = buildTraceTree(spans);
    const flat = flattenTrace(tree!);
    expect(flat).toHaveLength(3);
    expect(flat[0].context.operationName).toBe('root');
    expect(flat[1].context.operationName).toBe('child');
    expect(flat[2].context.operationName).toBe('grandchild');
  });
});

describe('formatTraceReport', () => {
  it('includes indentation for children', () => {
    const root = createRootContext('root.op');
    const child = createChildContext(root, 'child.op');
    const rootSpan = endSpan(startSpan(root), 'completed');
    const childSpan = endSpan(startSpan(child), 'completed');
    const tree = buildTraceTree([rootSpan, childSpan]);
    const report = formatTraceReport(tree!);
    expect(report).toContain('root.op');
    expect(report).toContain('  - ');
    expect(report).toContain('child.op');
  });
});

describe('serializeContext', () => {
  it('produces valid JSON', () => {
    const ctx = createRootContext('op');
    const json = serializeContext(ctx);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json)).toMatchObject({ operationName: 'op' });
  });
});

describe('deserializeContext', () => {
  it('parses valid JSON back to TraceContext', () => {
    const ctx = createRootContext('op');
    const json = serializeContext(ctx);
    const result = deserializeContext(json);
    expect(result).not.toBeNull();
    expect(result?.traceId).toBe(ctx.traceId);
  });

  it('returns null for invalid input', () => {
    expect(deserializeContext('not-json')).toBeNull();
    expect(deserializeContext('{"foo":"bar"}')).toBeNull();
  });
});
