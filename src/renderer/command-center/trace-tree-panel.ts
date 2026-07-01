/**
 * KageOps Trace Tree Panel
 *
 * Data model + HTML renderer for Sensei → agent → LLM → tool call tree views.
 * Shows the hierarchy of operations in the command center.
 *
 * NOTE: Does NOT import from trace-context.ts or run-types.ts (built in parallel).
 * Minimal local interfaces are used — wired together later.
 */

import { icon, type IconName } from '../../shared/icons';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TraceNode {
    readonly id: string;
    readonly parentId: string | null;
    readonly operationName: string;
    readonly agentName: string | null;
    readonly runType: string;
    readonly startTime: number;
    readonly endTime: number | null;
    readonly durationMs: number | null;
    readonly status: 'running' | 'completed' | 'failed';
    readonly tokenCount: number;
    readonly cost: number;
    readonly error: string | null;
    readonly depth: number;
}

export interface TraceTreeViewModel {
    readonly traceId: string;
    readonly rootNode: TraceNode;
    readonly allNodes: readonly TraceNode[];
    readonly totalDuration: number | null;
    readonly totalTokens: number;
    readonly totalCost: number;
    readonly nodeCount: number;
}

export interface TraceTreeRenderOptions {
    readonly showCost: boolean;
    readonly showTokens: boolean;
    readonly showDuration: boolean;
    readonly collapsedDepth: number;
    readonly highlightErrors: boolean;
}

// ── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_RENDER_OPTIONS: TraceTreeRenderOptions = {
    showCost: true,
    showTokens: true,
    showDuration: true,
    collapsedDepth: 3,
    highlightErrors: true,
};

// ── Helpers ────────────────────────────────────────────────────────────────

export function getRunTypeIcon(runType: string): IconName {
    const icons: Record<string, IconName> = {
        orchestrate: 'target',
        llm: 'bot',
        tool: 'wrench',
        review: 'search',
        deploy: 'rocket',
        'file-io': 'folder',
        db: 'database',
        event: 'zap',
        security: 'shield',
        test: 'check-circle',
    };
    return icons[runType] ?? 'chevron-right';
}

export function getStatusIcon(status: string): IconName {
    const icons: Record<string, IconName> = {
        running: 'hourglass',
        completed: 'check-circle',
        failed: 'x-circle',
    };
    return icons[status] ?? 'help-circle';
}

export function formatDuration(ms: number | null): string {
    if (ms === null) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
}

export function formatCost(usd: number): string {
    return `$${usd.toFixed(3)}`;
}

// ── Data model ─────────────────────────────────────────────────────────────

/**
 * Takes a flat list of nodes, finds root (parentId === null), calculates totals.
 */
export function buildTraceViewModel(nodes: readonly TraceNode[]): TraceTreeViewModel | null {
    if (nodes.length === 0) return null;

    const root = nodes.find(n => n.parentId === null);
    if (!root) return null;

    const ordered = buildNodeHierarchy(nodes);

    const totalTokens = nodes.reduce((sum, n) => sum + n.tokenCount, 0);
    const totalCost = nodes.reduce((sum, n) => sum + n.cost, 0);

    const allEnded = nodes.every(n => n.endTime !== null);
    const totalDuration = allEnded && root.durationMs !== null ? root.durationMs : null;

    return {
        traceId: root.id,
        rootNode: root,
        allNodes: ordered,
        totalDuration,
        totalTokens,
        totalCost,
        nodeCount: nodes.length,
    };
}

/**
 * Sorts nodes for depth-first tree rendering based on parentId relationships.
 * Returns new nodes with correct `depth` field set.
 */
export function buildNodeHierarchy(nodes: readonly TraceNode[]): readonly TraceNode[] {
    if (nodes.length === 0) return [];

    const byParent = new Map<string | null, TraceNode[]>();
    for (const node of nodes) {
        const list = byParent.get(node.parentId) ?? [];
        byParent.set(node.parentId, [...list, node]);
    }

    const result: TraceNode[] = [];

    function visit(parentId: string | null, depth: number): void {
        const children = byParent.get(parentId) ?? [];
        const sorted = [...children].sort((a, b) => a.startTime - b.startTime);
        for (const child of sorted) {
            result.push({ ...child, depth });
            visit(child.id, depth + 1);
        }
    }

    visit(null, 0);
    return result;
}

// ── Renderer ───────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Renders a single node row with proper indentation, icon, and badges.
 */
export function renderNodeHtml(node: TraceNode, options: TraceTreeRenderOptions): string {
    const runTypeIcon = icon(getRunTypeIcon(node.runType), { size: 14 });
    const statusIcon = icon(getStatusIcon(node.status), { size: 14 });
    const errorClass = options.highlightErrors && node.status === 'failed' ? ' has-error' : '';
    const autoCollapsed = node.depth >= options.collapsedDepth ? ' data-collapsed="true"' : '';

    const durationHtml = options.showDuration
        ? `<span class="trace-duration">${escapeHtml(formatDuration(node.durationMs))}</span>`
        : '';
    const tokensHtml = options.showTokens
        ? `<span class="trace-tokens">${node.tokenCount.toLocaleString()}</span>`
        : '';
    const costHtml = options.showCost
        ? `<span class="trace-cost">${escapeHtml(formatCost(node.cost))}</span>`
        : '';
    const errorHtml = node.error
        ? `<span class="trace-error" title="${escapeHtml(node.error)}">${icon('alert-triangle', { size: 12 })} ${escapeHtml(node.error)}</span>`
        : '';
    const agentHtml = node.agentName
        ? `<span class="trace-agent">${escapeHtml(node.agentName)}</span>`
        : '';

    return `<div class="trace-node depth-${node.depth} status-${node.status}${errorClass}" data-id="${escapeHtml(node.id)}"${autoCollapsed}>
  <span class="trace-icon">${runTypeIcon}</span>
  <span class="trace-name">${escapeHtml(node.operationName)}</span>
  ${agentHtml}
  ${durationHtml}
  ${tokensHtml}
  ${costHtml}
  <span class="trace-status">${statusIcon}</span>
  ${errorHtml}
</div>`;
}

/**
 * Generates complete HTML for the trace tree panel.
 */
export function renderTraceTreeHtml(
    viewModel: TraceTreeViewModel,
    options: Partial<TraceTreeRenderOptions> = {},
): string {
    const opts: TraceTreeRenderOptions = { ...DEFAULT_RENDER_OPTIONS, ...options };

    const nodesHtml = viewModel.allNodes.map(n => renderNodeHtml(n, opts)).join('\n');

    const summaryParts: string[] = [
        `<span class="trace-summary-count">${viewModel.nodeCount} ops</span>`,
    ];
    if (opts.showDuration) {
        summaryParts.push(
            `<span class="trace-summary-duration">${escapeHtml(formatDuration(viewModel.totalDuration))}</span>`,
        );
    }
    if (opts.showTokens) {
        summaryParts.push(
            `<span class="trace-summary-tokens">${viewModel.totalTokens.toLocaleString()} tokens</span>`,
        );
    }
    if (opts.showCost) {
        summaryParts.push(
            `<span class="trace-summary-cost">${escapeHtml(formatCost(viewModel.totalCost))}</span>`,
        );
    }

    return `<div class="trace-tree" data-trace-id="${escapeHtml(viewModel.traceId)}">
  <div class="trace-tree-header">
    <span class="trace-tree-title">Trace: ${escapeHtml(viewModel.traceId)}</span>
    <div class="trace-tree-summary">${summaryParts.join('')}</div>
  </div>
  <div class="trace-tree-nodes">
${nodesHtml}
  </div>
</div>`;
}

/**
 * CSS styles for the trace tree panel.
 */
export function renderTraceTreeCss(): string {
    const depthRules = Array.from({ length: 10 }, (_, i) =>
        `.trace-node.depth-${i} { padding-left: ${i * 20 + 8}px; }`,
    ).join('\n');

    return `
/* Trace Tree Panel */
.trace-tree {
  font-family: var(--font-mono, 'Courier New', monospace);
  font-size: 12px;
  background: var(--bg-secondary, #1a1a2e);
  border-radius: 6px;
  overflow: hidden;
}

.trace-tree-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-tertiary, #16213e);
  border-bottom: 1px solid var(--border-color, #0f3460);
}

.trace-tree-title {
  color: var(--text-primary, #e2e8f0);
  font-weight: 600;
}

.trace-tree-summary {
  display: flex;
  gap: 12px;
  color: var(--text-muted, #94a3b8);
  font-size: 11px;
}

.trace-tree-nodes {
  overflow-y: auto;
  max-height: 600px;
}

.trace-node {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-subtle, #1e293b);
  transition: background 0.15s ease;
  cursor: default;
  white-space: nowrap;
  overflow: hidden;
}

.trace-node:hover {
  background: var(--bg-hover, #1e293b);
}

${depthRules}

.trace-node.status-running {
  border-left: 3px solid var(--color-running, #f59e0b);
}

.trace-node.status-completed {
  border-left: 3px solid var(--color-success, #10b981);
}

.trace-node.status-failed {
  border-left: 3px solid var(--color-error, #ef4444);
}

.trace-node.has-error {
  background: rgba(239, 68, 68, 0.08);
}

.trace-icon {
  flex-shrink: 0;
  width: 18px;
  text-align: center;
}

.trace-name {
  flex: 1;
  color: var(--text-primary, #e2e8f0);
  overflow: hidden;
  text-overflow: ellipsis;
}

.trace-agent {
  color: var(--text-accent, #818cf8);
  font-size: 11px;
  flex-shrink: 0;
}

.trace-duration {
  color: var(--text-muted, #94a3b8);
  font-size: 11px;
  flex-shrink: 0;
  min-width: 50px;
  text-align: right;
}

.trace-tokens {
  color: var(--text-muted, #94a3b8);
  font-size: 11px;
  flex-shrink: 0;
  min-width: 55px;
  text-align: right;
}

.trace-cost {
  color: var(--color-cost, #34d399);
  font-size: 11px;
  flex-shrink: 0;
  min-width: 50px;
  text-align: right;
}

.trace-status {
  flex-shrink: 0;
  width: 18px;
  text-align: center;
}

.trace-error {
  color: var(--color-error, #ef4444);
  font-size: 11px;
  flex-shrink: 0;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trace-node[data-collapsed="true"] {
  opacity: 0.6;
}
`.trim();
}
