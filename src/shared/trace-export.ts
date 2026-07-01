export const EXPORT_VERSION = 1 as const;

export interface ExportedSpan {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly operationName: string;
  readonly agentName: string | null;
  readonly runType: string;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly durationMs: number | null;
  readonly status: 'running' | 'completed' | 'failed';
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cost: number;
  readonly model: string | null;
  readonly error: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ExportedTrace {
  readonly version: 1;
  readonly exportedAt: string;
  readonly traceId: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly spans: readonly ExportedSpan[];
  readonly totalDuration: number | null;
  readonly totalTokens: number;
  readonly totalCost: number;
}

export interface TraceImportResult {
  readonly success: boolean;
  readonly trace: ExportedTrace | null;
  readonly errors: readonly string[];
}

export interface TraceUrl {
  readonly baseUrl: string;
  readonly traceId: string;
  readonly fullUrl: string;
}

export function exportTrace(
  traceId: string,
  projectId: string | null,
  projectName: string | null,
  spans: readonly ExportedSpan[]
): ExportedTrace {
  const totalTokens = spans.reduce((sum, s) => sum + s.tokensIn + s.tokensOut, 0);
  const totalCost = spans.reduce((sum, s) => sum + s.cost, 0);

  const rootSpan = spans.find(s => s.parentSpanId === null);
  let totalDuration: number | null = null;
  if (rootSpan !== null && rootSpan !== undefined && rootSpan.durationMs !== null) {
    totalDuration = rootSpan.durationMs;
  } else if (spans.length > 0) {
    const start = Math.min(...spans.map(s => s.startTime));
    const ends = spans.map(s => s.endTime).filter((e): e is number => e !== null);
    if (ends.length > 0) {
      totalDuration = Math.max(...ends) - start;
    }
  }

  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    traceId,
    projectId,
    projectName,
    spans,
    totalDuration,
    totalTokens,
    totalCost,
  };
}

export function serializeTrace(trace: ExportedTrace): string {
  return JSON.stringify(trace, null, 2);
}

export function validateExportedSpan(span: unknown, index: number): readonly string[] {
  const errors: string[] = [];
  const prefix = `spans[${index}]`;

  if (typeof span !== 'object' || span === null) {
    return [`${prefix}: must be an object`];
  }

  const s = span as Record<string, unknown>;

  if (typeof s['spanId'] !== 'string' || s['spanId'].length === 0) {
    errors.push(`${prefix}.spanId: must be a non-empty string`);
  }
  if (s['parentSpanId'] !== null && typeof s['parentSpanId'] !== 'string') {
    errors.push(`${prefix}.parentSpanId: must be a string or null`);
  }
  if (typeof s['operationName'] !== 'string') {
    errors.push(`${prefix}.operationName: must be a string`);
  }
  if (s['agentName'] !== null && typeof s['agentName'] !== 'string') {
    errors.push(`${prefix}.agentName: must be a string or null`);
  }
  if (typeof s['runType'] !== 'string') {
    errors.push(`${prefix}.runType: must be a string`);
  }
  if (typeof s['startTime'] !== 'number') {
    errors.push(`${prefix}.startTime: must be a number`);
  }
  if (s['endTime'] !== null && typeof s['endTime'] !== 'number') {
    errors.push(`${prefix}.endTime: must be a number or null`);
  }
  if (s['durationMs'] !== null && typeof s['durationMs'] !== 'number') {
    errors.push(`${prefix}.durationMs: must be a number or null`);
  }
  const validStatuses = ['running', 'completed', 'failed'];
  if (!validStatuses.includes(s['status'] as string)) {
    errors.push(`${prefix}.status: must be 'running', 'completed', or 'failed'`);
  }
  if (typeof s['tokensIn'] !== 'number') {
    errors.push(`${prefix}.tokensIn: must be a number`);
  }
  if (typeof s['tokensOut'] !== 'number') {
    errors.push(`${prefix}.tokensOut: must be a number`);
  }
  if (typeof s['cost'] !== 'number') {
    errors.push(`${prefix}.cost: must be a number`);
  }
  if (s['model'] !== null && typeof s['model'] !== 'string') {
    errors.push(`${prefix}.model: must be a string or null`);
  }
  if (s['error'] !== null && typeof s['error'] !== 'string') {
    errors.push(`${prefix}.error: must be a string or null`);
  }
  if (typeof s['metadata'] !== 'object' || s['metadata'] === null || Array.isArray(s['metadata'])) {
    errors.push(`${prefix}.metadata: must be an object`);
  }

  return errors;
}

export function validateExportedTrace(data: unknown): readonly string[] {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null) {
    return ['trace: must be an object'];
  }

  const t = data as Record<string, unknown>;

  if (t['version'] !== EXPORT_VERSION) {
    errors.push(`version: must be ${EXPORT_VERSION}, got ${String(t['version'])}`);
  }
  if (typeof t['exportedAt'] !== 'string') {
    errors.push('exportedAt: must be a string');
  }
  if (typeof t['traceId'] !== 'string' || t['traceId'].length === 0) {
    errors.push('traceId: must be a non-empty string');
  }
  if (t['projectId'] !== null && typeof t['projectId'] !== 'string') {
    errors.push('projectId: must be a string or null');
  }
  if (t['projectName'] !== null && typeof t['projectName'] !== 'string') {
    errors.push('projectName: must be a string or null');
  }
  if (!Array.isArray(t['spans'])) {
    errors.push('spans: must be an array');
  } else {
    for (let i = 0; i < t['spans'].length; i++) {
      const spanErrors = validateExportedSpan(t['spans'][i], i);
      errors.push(...spanErrors);
    }
  }
  if (t['totalDuration'] !== null && typeof t['totalDuration'] !== 'number') {
    errors.push('totalDuration: must be a number or null');
  }
  if (typeof t['totalTokens'] !== 'number') {
    errors.push('totalTokens: must be a number');
  }
  if (typeof t['totalCost'] !== 'number') {
    errors.push('totalCost: must be a number');
  }

  return errors;
}

export function importTrace(jsonString: string): TraceImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    return {
      success: false,
      trace: null,
      errors: [`Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const errors = validateExportedTrace(parsed);
  if (errors.length > 0) {
    return { success: false, trace: null, errors };
  }

  return { success: true, trace: parsed as ExportedTrace, errors: [] };
}

export function buildTraceUrl(baseUrl: string, traceId: string): TraceUrl {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const fullUrl = `${normalizedBase}/traces/${traceId}`;
  return { baseUrl: normalizedBase, traceId, fullUrl };
}

export function parseTraceUrl(url: string): { traceId: string } | null {
  const match = /\/traces\/([^/?#]+)(?:[/?#].*)?$/.exec(url);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    return null;
  }
  return { traceId: match[1] };
}

export function summarizeTrace(trace: ExportedTrace): string {
  const spanCount = trace.spans.length;
  const durationStr =
    trace.totalDuration !== null ? `${(trace.totalDuration / 1000).toFixed(1)}s` : 'n/a';
  const tokens = trace.totalTokens.toLocaleString();
  const cost = `$${trace.totalCost.toFixed(2)}`;
  return `Trace ${trace.traceId} | ${spanCount} span${spanCount !== 1 ? 's' : ''} | ${durationStr} | ${tokens} tokens | ${cost}`;
}

export function diffTraces(traceA: ExportedTrace, traceB: ExportedTrace): string {
  const lines: string[] = ['## Trace Diff', ''];

  lines.push(`| Metric | Trace A (${traceA.traceId}) | Trace B (${traceB.traceId}) | Delta |`);
  lines.push('|--------|---------|---------|-------|');

  const spanDelta = traceB.spans.length - traceA.spans.length;
  lines.push(
    `| Spans | ${traceA.spans.length} | ${traceB.spans.length} | ${spanDelta >= 0 ? '+' : ''}${spanDelta} |`
  );

  const durA = traceA.totalDuration !== null ? `${(traceA.totalDuration / 1000).toFixed(1)}s` : 'n/a';
  const durB = traceB.totalDuration !== null ? `${(traceB.totalDuration / 1000).toFixed(1)}s` : 'n/a';
  let durDelta = 'n/a';
  if (traceA.totalDuration !== null && traceB.totalDuration !== null) {
    const d = traceB.totalDuration - traceA.totalDuration;
    durDelta = `${d >= 0 ? '+' : ''}${(d / 1000).toFixed(1)}s`;
  }
  lines.push(`| Duration | ${durA} | ${durB} | ${durDelta} |`);

  const tokenDelta = traceB.totalTokens - traceA.totalTokens;
  lines.push(
    `| Tokens | ${traceA.totalTokens.toLocaleString()} | ${traceB.totalTokens.toLocaleString()} | ${tokenDelta >= 0 ? '+' : ''}${tokenDelta.toLocaleString()} |`
  );

  const costDelta = traceB.totalCost - traceA.totalCost;
  lines.push(
    `| Cost | $${traceA.totalCost.toFixed(4)} | $${traceB.totalCost.toFixed(4)} | ${costDelta >= 0 ? '+' : ''}$${costDelta.toFixed(4)} |`
  );

  return lines.join('\n');
}
