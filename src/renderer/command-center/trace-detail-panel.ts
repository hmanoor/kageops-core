/**
 * KageOps Trace Detail Panel (B-103)
 *
 * Renders a detailed inspector panel when a trace node is clicked.
 * Shows input/output, timing, token counts, cost, and metadata.
 */

import { icon, type IconName } from '../../shared/icons';

// ── Types ─────────────────────────────────────────────

export interface TraceDetailData {
  readonly id: string;
  readonly traceId: string;
  readonly operationName: string;
  readonly agentName: string | null;
  readonly runType: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly startTime: number;
  readonly endTime: number | null;
  readonly durationMs: number | null;
  readonly input: string | null;
  readonly output: string | null;
  readonly tokenCount: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cost: number;
  readonly model: string | null;
  readonly error: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly childCount: number;
}

export interface TraceDetailRenderOptions {
  readonly showRawMetadata: boolean;
  readonly truncateOutput: number;
  readonly showTimestamps: boolean;
}

// ── Defaults ──────────────────────────────────────────

export const DEFAULT_DETAIL_OPTIONS: TraceDetailRenderOptions = {
  showRawMetadata: true,
  truncateOutput: 500,
  showTimestamps: true,
};

// ── Helpers ───────────────────────────────────────────

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mmm = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mmm}`;
}

export function formatTokenCount(n: number): string {
  if (n >= 10000) {
    const k = (n / 1000).toFixed(1);
    return `${k}K tokens`;
  }
  return `${n.toLocaleString()} tokens`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusIconName(status: TraceDetailData['status']): IconName {
  switch (status) {
    case 'completed': return 'check-circle';
    case 'failed': return 'x-circle';
    case 'running': return 'hourglass';
  }
}

function statusLabel(status: TraceDetailData['status']): string {
  switch (status) {
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
    case 'running': return 'Running';
  }
}

// ── Section renderers ─────────────────────────────────

export function renderTimingSection(data: TraceDetailData): string {
  const startFormatted = formatTimestamp(data.startTime);
  const durationHtml = data.durationMs !== null
    ? `<dt>Duration</dt><dd>${escapeHtml(formatDuration(data.durationMs))}</dd>`
    : '';
  const endHtml = data.endTime !== null
    ? `<dt>End</dt><dd>${escapeHtml(formatTimestamp(data.endTime))}</dd>`
    : '';

  return `
<div class="trace-detail-section">
  <h4>Timing</h4>
  <dl>
    <dt>Start</dt><dd>${escapeHtml(startFormatted)}</dd>
    ${endHtml}
    ${durationHtml}
  </dl>
</div>`.trim();
}

export function renderTokenSection(data: TraceDetailData): string {
  const total = data.tokensIn + data.tokensOut;
  const inPct = total > 0 ? Math.round((data.tokensIn / total) * 100) : 50;
  const outPct = 100 - inPct;

  const barHtml = `
  <div class="trace-token-bar">
    <div class="trace-token-bar-in" style="width:${inPct}%" title="Input: ${data.tokensIn}"></div>
    <div class="trace-token-bar-out" style="width:${outPct}%" title="Output: ${data.tokensOut}"></div>
  </div>`.trim();

  const costStr = `$${data.cost.toFixed(4)}`;
  const modelHtml = data.model
    ? `<dt>Model</dt><dd>${escapeHtml(data.model)}</dd>`
    : '';

  return `
<div class="trace-detail-section">
  <h4>Tokens &amp; Cost</h4>
  ${barHtml}
  <dl>
    <dt>Input</dt><dd>${escapeHtml(formatTokenCount(data.tokensIn))}</dd>
    <dt>Output</dt><dd>${escapeHtml(formatTokenCount(data.tokensOut))}</dd>
    <dt>Total</dt><dd>${escapeHtml(formatTokenCount(data.tokenCount))}</dd>
    <dt>Cost</dt><dd>${escapeHtml(costStr)}</dd>
    ${modelHtml}
  </dl>
</div>`.trim();
}

export function renderInputOutputSection(
  input: string | null,
  output: string | null,
  truncateAt: number,
): string {
  function renderBlock(label: string, value: string | null): string {
    if (value === null) {
      return `
<div class="trace-detail-section">
  <h4>${label}</h4>
  <p class="trace-detail-empty">None</p>
</div>`.trim();
    }

    const escaped = escapeHtml(value);
    if (value.length <= truncateAt) {
      return `
<div class="trace-detail-section">
  <h4>${label}</h4>
  <pre class="trace-detail-code">${escaped}</pre>
</div>`.trim();
    }

    const truncated = escapeHtml(value.slice(0, truncateAt));
    const fullEscaped = escapeHtml(value);
    return `
<div class="trace-detail-section">
  <h4>${label}</h4>
  <pre class="trace-detail-code" data-full="${fullEscaped}" data-truncated="true">${truncated}&hellip;</pre>
  <button class="trace-show-more" data-target="${label.toLowerCase()}">Show more</button>
</div>`.trim();
  }

  return `${renderBlock('Input', input)}\n${renderBlock('Output', output)}`;
}

export function renderMetadataSection(metadata: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(metadata);
  if (keys.length === 0) return '';

  const json = JSON.stringify(metadata, null, 2);
  const escaped = escapeHtml(json);

  return `
<div class="trace-detail-section trace-detail-collapsible">
  <h4 class="trace-detail-toggle">Metadata <span class="trace-toggle-icon">▶</span></h4>
  <pre class="trace-detail-code trace-detail-metadata">${escaped}</pre>
</div>`.trim();
}

export function renderErrorSection(error: string | null): string {
  if (error === null) return '';

  return `
<div class="trace-detail-section trace-detail-error">
  <h4>Error</h4>
  <pre class="trace-detail-code trace-error-body">${escapeHtml(error)}</pre>
</div>`.trim();
}

// ── CSS ───────────────────────────────────────────────

export function renderTraceDetailCss(): string {
  return `
<style>
.trace-detail {
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  color: var(--color-text, #e0e0e0);
  background: var(--color-surface, #1a1a2e);
  padding: 16px;
  overflow-y: auto;
  height: 100%;
  box-sizing: border-box;
}
.trace-detail-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--color-border, #333);
  padding-bottom: 10px;
}
.trace-detail-header h3 {
  margin: 0;
  font-size: 15px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trace-status-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: bold;
  white-space: nowrap;
}
.status-completed { background: #1a4a1a; color: #4caf50; }
.status-failed    { background: #4a1a1a; color: #f44336; }
.status-running   { background: #1a3a4a; color: #2196f3; }
.trace-detail-section {
  margin-bottom: 14px;
}
.trace-detail-section h4 {
  margin: 0 0 6px 0;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-muted, #888);
}
.trace-detail-section dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
}
.trace-detail-section dt {
  color: var(--color-muted, #888);
  font-size: 12px;
}
.trace-detail-section dd {
  margin: 0;
  font-size: 12px;
  word-break: break-word;
}
.trace-detail-code {
  background: var(--color-code-bg, #0d0d1a);
  border: 1px solid var(--color-border, #333);
  border-radius: 4px;
  padding: 8px;
  font-size: 11px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
  margin: 0;
}
.trace-token-bar {
  display: flex;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 8px;
  background: var(--color-border, #333);
}
.trace-token-bar-in  { background: #2196f3; }
.trace-token-bar-out { background: #4caf50; }
.trace-detail-error {
  border: 1px solid #f44336;
  border-radius: 4px;
  padding: 8px;
  background: #2a0a0a;
}
.trace-detail-error h4 { color: #f44336; }
.trace-error-body { border: none; background: transparent; }
.trace-show-more {
  margin-top: 4px;
  font-size: 11px;
  background: none;
  border: 1px solid var(--color-border, #555);
  border-radius: 3px;
  color: var(--color-link, #90caf9);
  cursor: pointer;
  padding: 2px 8px;
}
.trace-detail-empty { color: var(--color-muted, #888); font-style: italic; margin: 0; }
.trace-detail-collapsible .trace-detail-metadata { display: none; }
.trace-detail-toggle { cursor: pointer; user-select: none; }
</style>`.trim();
}

// ── Main renderer ─────────────────────────────────────

export function renderTraceDetailHtml(
  data: TraceDetailData,
  options?: Partial<TraceDetailRenderOptions>,
): string {
  const opts: TraceDetailRenderOptions = {
    ...DEFAULT_DETAIL_OPTIONS,
    ...options,
  };

  const iconMarkup = icon(statusIconName(data.status), { size: 14 });
  const label = statusLabel(data.status);
  const title = `${iconMarkup} ${escapeHtml(data.operationName)}`;
  const statusClass = `status-${data.status}`;

  const agentHtml = data.agentName
    ? `<span class="trace-detail-agent">${escapeHtml(data.agentName)}</span>`
    : '';

  const childHtml = data.childCount > 0
    ? `<span class="trace-child-count">${data.childCount} child span${data.childCount !== 1 ? 's' : ''}</span>`
    : '';

  const timingHtml = opts.showTimestamps ? renderTimingSection(data) : '';
  const tokenHtml = renderTokenSection(data);
  const ioHtml = renderInputOutputSection(data.input, data.output, opts.truncateOutput);
  const metaHtml = opts.showRawMetadata ? renderMetadataSection(data.metadata) : '';
  const errorHtml = renderErrorSection(data.error);

  return `
<div class="trace-detail">
  <div class="trace-detail-header">
    <h3>${title}</h3>
    ${agentHtml}
    ${childHtml}
    <span class="trace-status-badge ${statusClass}">${escapeHtml(label)}</span>
  </div>
  ${errorHtml}
  ${timingHtml}
  ${tokenHtml}
  ${ioHtml}
  ${metaHtml}
</div>`.trim();
}
