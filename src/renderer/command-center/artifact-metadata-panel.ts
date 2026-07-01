/**
 * Artifact Browser — task-level metadata panel (B-428).
 *
 * Pure rendering helpers for the "Task details" section that sits below
 * the preview header. Takes a `FileTaskDetails` fetched via IPC and
 * formats it into a compact, accessible `<details>` disclosure.
 *
 * Kept DOM-free so tests can assert HTML strings directly without
 * instantiating jsdom elements — consistent with artifact-browser-preview.
 */

import { escapeHtml } from './artifact-browser-highlight';

/**
 * Mirror of the main-process `FileTaskDetails` interface in
 * [artifact-browser-ipc.ts](../../main/artifact-browser-ipc.ts). Kept
 * structurally identical so the renderer does not import main-process
 * modules.
 */
export interface TaskDetails {
    readonly id: string;
    readonly title: string;
    readonly description: string | null;
    readonly status: string;
    readonly phase: string;
    readonly taskType: string | null;
    readonly assignedAgent: string | null;
    readonly retryCount: number;
    readonly qualityScore: number | null;
    readonly errorMessage: string | null;
    readonly branchName: string | null;
    readonly outputPath: string | null;
    readonly createdAtIso: string;
    readonly startedAtIso: string | null;
    readonly completedAtIso: string | null;
    readonly totalCostUsd: number | null;
    readonly totalTokensIn: number | null;
    readonly totalTokensOut: number | null;
    readonly lastModel: string | null;
}

/** Three render states the metadata panel can be in. */
export type MetadataPanelState =
    | { readonly kind: 'hidden' }           // no producedBy on the file — nothing to show
    | { readonly kind: 'loading' }
    | { readonly kind: 'error'; readonly message: string }
    | { readonly kind: 'unknown-task' }     // producer known but tasks row missing (deleted/orphan)
    | { readonly kind: 'loaded'; readonly task: TaskDetails };

/**
 * Render the metadata panel for a file. Returns an empty string when
 * there is nothing to show (kind === 'hidden'), which keeps the preview
 * pane clean for files that were not produced by any task.
 */
export function renderMetadataPanel(state: MetadataPanelState): string {
    if (state.kind === 'hidden') return '';
    if (state.kind === 'loading') {
        return wrapDetails('Task details', '<div class="ab-meta-loading">Loading…</div>');
    }
    if (state.kind === 'error') {
        return wrapDetails(
            'Task details',
            `<div class="ab-meta-error">${escapeHtml(state.message)}</div>`,
        );
    }
    if (state.kind === 'unknown-task') {
        return wrapDetails(
            'Task details',
            '<div class="ab-meta-empty">The task that produced this file no longer exists.</div>',
        );
    }
    return wrapDetails(`Task details — ${escapeHtml(state.task.title)}`, renderTaskBody(state.task));
}

/** Pure — compute a human-readable duration between started_at and completed_at. */
export function formatTaskDuration(
    startedAtIso: string | null,
    completedAtIso: string | null,
): string | null {
    if (startedAtIso === null || completedAtIso === null) return null;
    const start = Date.parse(startedAtIso);
    const end = Date.parse(completedAtIso);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    const ms = end - start;
    if (ms < 1000) return `${ms} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)} s`;
    const minutes = seconds / 60;
    if (minutes < 60) return `${minutes.toFixed(1)} min`;
    const hours = minutes / 60;
    return `${hours.toFixed(1)} h`;
}

/** Pure — compact cost formatter (always six decimal places for <$0.01). */
export function formatCostUsd(usd: number | null): string | null {
    if (usd === null) return null;
    if (!Number.isFinite(usd)) return null;
    if (usd === 0) return '$0.00';
    if (usd < 0.01) return `$${usd.toFixed(6)}`;
    if (usd < 1) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

/** Pure — compact integer count with thousands separators. */
export function formatTokenCount(n: number | null): string | null {
    if (n === null || !Number.isFinite(n)) return null;
    return n.toLocaleString('en-US');
}

// ── Internal render helpers ──────────────────────────

function wrapDetails(summary: string, body: string): string {
    return (
        '<details class="ab-meta">' +
        `<summary class="ab-meta-summary">${summary}</summary>` +
        `<div class="ab-meta-body">${body}</div>` +
        '</details>'
    );
}

function renderTaskBody(t: TaskDetails): string {
    const rows: string[] = [];
    rows.push(row('Status', badge(t.status)));
    rows.push(row('Phase', escapeHtml(t.phase)));
    if (t.taskType !== null) rows.push(row('Type', escapeHtml(t.taskType)));
    if (t.assignedAgent !== null) rows.push(row('Agent', escapeHtml(t.assignedAgent)));
    if (t.retryCount > 0) rows.push(row('Retries', String(t.retryCount)));
    if (t.qualityScore !== null) rows.push(row('Quality', t.qualityScore.toFixed(1)));
    if (t.branchName !== null) rows.push(row('Branch', `<code>${escapeHtml(t.branchName)}</code>`));

    const duration = formatTaskDuration(t.startedAtIso, t.completedAtIso);
    if (duration !== null) rows.push(row('Duration', duration));

    rows.push(row('Created', escapeHtml(formatTimestamp(t.createdAtIso))));
    if (t.startedAtIso !== null) rows.push(row('Started', escapeHtml(formatTimestamp(t.startedAtIso))));
    if (t.completedAtIso !== null) rows.push(row('Completed', escapeHtml(formatTimestamp(t.completedAtIso))));

    const cost = formatCostUsd(t.totalCostUsd);
    if (cost !== null) rows.push(row('Cost', cost));
    const tokensIn = formatTokenCount(t.totalTokensIn);
    const tokensOut = formatTokenCount(t.totalTokensOut);
    if (tokensIn !== null || tokensOut !== null) {
        const parts: string[] = [];
        if (tokensIn !== null) parts.push(`${tokensIn} in`);
        if (tokensOut !== null) parts.push(`${tokensOut} out`);
        rows.push(row('Tokens', parts.join(' · ')));
    }
    if (t.lastModel !== null) rows.push(row('Model', `<code>${escapeHtml(t.lastModel)}</code>`));

    let body = `<dl class="ab-meta-grid">${rows.join('')}</dl>`;

    if (t.description !== null && t.description.length > 0) {
        body += (
            '<div class="ab-meta-block">' +
            '<div class="ab-meta-block-label">Description</div>' +
            `<div class="ab-meta-block-value">${escapeHtml(t.description)}</div>` +
            '</div>'
        );
    }

    if (t.errorMessage !== null && t.errorMessage.length > 0) {
        body += (
            '<div class="ab-meta-block ab-meta-block--error">' +
            '<div class="ab-meta-block-label">Error</div>' +
            `<div class="ab-meta-block-value">${escapeHtml(t.errorMessage)}</div>` +
            '</div>'
        );
    }

    return body;
}

function row(label: string, valueHtml: string): string {
    return (
        `<dt class="ab-meta-label">${escapeHtml(label)}</dt>` +
        `<dd class="ab-meta-value">${valueHtml}</dd>`
    );
}

function badge(status: string): string {
    const normalized = status.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `<span class="ab-meta-badge ab-meta-badge--${escapeHtml(normalized)}">${escapeHtml(status)}</span>`;
}

function formatTimestamp(iso: string): string {
    try {
        return new Date(iso).toLocaleString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return iso;
    }
}
