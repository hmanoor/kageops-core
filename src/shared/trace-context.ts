// B-100: Trace correlation IDs across agent_logs

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly operationName: string;
  readonly startTime: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface Span {
  readonly context: TraceContext;
  readonly endTime: number | null;
  readonly durationMs: number | null;
  readonly status: 'running' | 'completed' | 'failed';
  readonly error: string | null;
}

export interface TraceTree {
  readonly traceId: string;
  readonly rootSpan: Span;
  readonly children: readonly TraceTree[];
}

export function generateTraceId(): string {
  return crypto.randomUUID();
}

export function generateSpanId(): string {
  return crypto.randomUUID();
}

export function createRootContext(
  operationName: string,
  metadata: Record<string, unknown> = {}
): TraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    parentSpanId: null,
    operationName,
    startTime: Date.now(),
    metadata: { ...metadata },
  };
}

export function createChildContext(
  parent: TraceContext,
  operationName: string,
  metadata: Record<string, unknown> = {}
): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    parentSpanId: parent.spanId,
    operationName,
    startTime: Date.now(),
    metadata: { ...metadata },
  };
}

export function startSpan(context: TraceContext): Span {
  return {
    context,
    endTime: null,
    durationMs: null,
    status: 'running',
    error: null,
  };
}

export function endSpan(
  span: Span,
  status: 'completed' | 'failed',
  error?: string
): Span {
  const endTime = Date.now();
  return {
    ...span,
    endTime,
    durationMs: endTime - span.context.startTime,
    status,
    error: error ?? null,
  };
}

export function buildTraceTree(spans: readonly Span[]): TraceTree | null {
  if (spans.length === 0) return null;

  const root = spans.find((s) => s.context.parentSpanId === null);
  if (root === undefined) return null;

  function buildNode(span: Span): TraceTree {
    const childSpans = spans.filter(
      (s) => s.context.parentSpanId === span.context.spanId
    );
    return {
      traceId: span.context.traceId,
      rootSpan: span,
      children: childSpans.map(buildNode),
    };
  }

  return buildNode(root);
}

export function flattenTrace(tree: TraceTree): readonly Span[] {
  const result: Span[] = [tree.rootSpan];
  for (const child of tree.children) {
    result.push(...flattenTrace(child));
  }
  return result;
}

function statusIcon(status: Span['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '✗';
  return '…';
}

function formatNode(tree: TraceTree, depth: number): string {
  const indent = '  '.repeat(depth);
  const span = tree.rootSpan;
  const duration = span.durationMs !== null ? `${span.durationMs}ms` : 'running';
  const icon = statusIcon(span.status);
  const errorPart = span.error ? ` — ${span.error}` : '';
  const header = `${indent}- ${icon} \`${span.context.operationName}\` (${duration})${errorPart}`;
  const childLines = tree.children.map((c) => formatNode(c, depth + 1)).join('\n');
  return childLines ? `${header}\n${childLines}` : header;
}

export function formatTraceReport(tree: TraceTree): string {
  const lines: string[] = [
    `## Trace Report`,
    ``,
    `**Trace ID:** \`${tree.traceId}\``,
    ``,
    `### Spans`,
    ``,
    formatNode(tree, 0),
  ];
  return lines.join('\n');
}

export function serializeContext(context: TraceContext): string {
  return JSON.stringify(context);
}

function isValidContext(value: unknown): value is TraceContext {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['traceId'] === 'string' &&
    typeof obj['spanId'] === 'string' &&
    (obj['parentSpanId'] === null || typeof obj['parentSpanId'] === 'string') &&
    typeof obj['operationName'] === 'string' &&
    typeof obj['startTime'] === 'number' &&
    typeof obj['metadata'] === 'object' &&
    obj['metadata'] !== null
  );
}

export function deserializeContext(data: string): TraceContext | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isValidContext(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
