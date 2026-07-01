/**
 * P1-05b — pure renderer for the iteration history side-panel.
 *
 * Lives in its own module so:
 *   1. Tests can import the renderer without loading command-center.ts's
 *      4000+ line graph (which transitively pulls in markdown / heavy
 *      modules that confuse vitest's import-analysis pass).
 *   2. A future P1-08b diff-renderer can reuse the same row/badge
 *      conventions for consistency across iteration + revision panels.
 *
 * Pure: takes data, returns HTML string. XSS-safe via local escapeHtml.
 * Caller (command-center.ts:openIterationHistoryPanel) is responsible
 * for the IPC fetch + DOM mount.
 */

export interface IterationHistoryEntry {
    readonly id: string;
    readonly iterationIndex: number;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly requirementText: string | null;
}

export function renderIterationHistory(rows: readonly IterationHistoryEntry[]): string {
    if (rows.length === 0) {
        return `<div class="empty-state">No iteration history yet. Once this project is reopened, each cycle will appear here.</div>`;
    }

    const closed = rows.filter((r) => r.endedAt !== null).length;
    const open = rows.length - closed;
    const items = rows.map(renderRow).join('');

    return `
        <div class="iteration-history">
            <div class="iteration-history-summary">
                ${rows.length} iteration${rows.length === 1 ? '' : 's'}
                · ${closed} closed
                · ${open} open
            </div>
            <div class="iteration-history-rows">${items}</div>
        </div>`;
}

function renderRow(r: IterationHistoryEntry): string {
    const label = r.iterationIndex === 0 ? 'Original build' : `Iteration ${r.iterationIndex}`;
    const stateClass = r.endedAt === null ? 'iteration-row--open' : 'iteration-row--closed';
    const stateText = r.endedAt === null ? 'in flight' : 'closed';
    const reqBlock = r.requirementText !== null && r.requirementText !== ''
        ? `<div class="iteration-row-req">${escapeHtml(r.requirementText)}</div>`
        : (r.iterationIndex === 0
            ? `<div class="iteration-row-req iteration-row-req--muted">From the original brief.</div>`
            : '');

    return `
        <div class="iteration-row ${stateClass}">
            <div class="iteration-row-head">
                <span class="iteration-row-label">${escapeHtml(label)}</span>
                <span class="iteration-row-state">${stateText}</span>
            </div>
            <div class="iteration-row-meta">
                started ${escapeHtml(formatTime(r.startedAt))}
                · ${r.endedAt === null ? 'still running' : `closed ${escapeHtml(formatTime(r.endedAt))}`}
                · ${escapeHtml(formatDuration(r.startedAt, r.endedAt))}
            </div>
            ${reqBlock}
        </div>`;
}

function formatTime(iso: string): string {
    try {
        return new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
        return iso;
    }
}

function formatDuration(started: string, ended: string | null): string {
    if (ended === null) return 'in flight';
    try {
        const ms = new Date(ended).getTime() - new Date(started).getTime();
        if (!Number.isFinite(ms) || ms < 0) return '—';
        const min = Math.floor(ms / 60_000);
        if (min < 60) return `${min} min`;
        const h = Math.floor(min / 60);
        const rem = min % 60;
        return `${h}h ${rem}m`;
    } catch {
        return '—';
    }
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
