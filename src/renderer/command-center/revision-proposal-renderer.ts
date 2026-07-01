/**
 * P1-08b — Sensei chat revision proposal renderer.
 *
 * Pure module that:
 *   - Computes a per-file line-diff for a proposal returned by
 *     `iteration:list-proposed` IPC.
 *   - Renders the proposal as an inline chat card with file list +
 *     diff blocks + Accept/Reject buttons.
 *
 * Lives in its own module so:
 *   1. The line-diff algorithm is unit-testable without DOM.
 *   2. The chat-side mount code stays a one-liner (just inject the
 *      HTML string + wire button handlers).
 *
 * Diff algorithm: simple line-by-line Myers-style longest common
 * subsequence. Not as polished as `diff2html` but no new dep + works
 * on the renderer's hot path. For revisions where most lines are
 * unchanged (the modify-in-place case from P1-06b/P1-07), the LCS
 * approach renders cleanly with `=` / `+` / `-` markers.
 *
 * XSS-safe via local escapeHtml on every operator-supplied field
 * (file paths, content lines).
 */

// ── Public types ───────────────────────────────────────

export interface RevisionProposalFile {
    readonly path: string;
    readonly sizeBytes: number;
    readonly proposedSha256: string;
    readonly currentSha256: string | null;
    readonly unchanged: boolean;
    /** Contents capped at 64 KB; null when too big to preview. */
    readonly proposedContent: string | null;
    readonly currentContent: string | null;
}

export interface RevisionProposal {
    readonly projectId: string;
    readonly taskId: string;
    readonly createdAt: string;
    readonly files: readonly RevisionProposalFile[];
}

/** One side of a unified diff line. */
export interface DiffLine {
    readonly kind: 'context' | 'add' | 'remove';
    readonly content: string;
    /** 1-based line number in the OLD file (null for additions). */
    readonly oldLine: number | null;
    /** 1-based line number in the NEW file (null for removals). */
    readonly newLine: number | null;
}

// ── Diff algorithm ─────────────────────────────────────

/**
 * Line-by-line diff with context. Returns the unified-diff line
 * stream a renderer can paint with `+`/`-`/` ` prefixes.
 *
 * Handles:
 *   - `current === null` → file is new, every line is an addition.
 *   - `proposed === current` → empty diff (caller filters out).
 *   - Both null → empty array (defensive; caller filters out).
 */
export function computeLineDiff(current: string | null, proposed: string | null): readonly DiffLine[] {
    if (proposed === null) return [];
    if (current === null) {
        return proposed.split('\n').map((line, i) => ({
            kind: 'add' as const,
            content: line,
            oldLine: null,
            newLine: i + 1,
        }));
    }
    if (current === proposed) return [];

    const oldLines = current.split('\n');
    const newLines = proposed.split('\n');

    // LCS table — O(n*m) memory. For typical revision files (<100
    // lines each) this is trivial. For huge files the caller has
    // already capped at 64 KB via the IPC layer.
    const lcs = buildLcsTable(oldLines, newLines);

    // Walk back through the LCS table to produce the line stream.
    const out: DiffLine[] = [];
    let i = oldLines.length;
    let j = newLines.length;
    while (i > 0 && j > 0) {
        if (oldLines[i - 1] === newLines[j - 1]) {
            out.push({ kind: 'context', content: oldLines[i - 1], oldLine: i, newLine: j });
            i--; j--;
        } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
            out.push({ kind: 'remove', content: oldLines[i - 1], oldLine: i, newLine: null });
            i--;
        } else {
            out.push({ kind: 'add', content: newLines[j - 1], oldLine: null, newLine: j });
            j--;
        }
    }
    while (i > 0) {
        out.push({ kind: 'remove', content: oldLines[i - 1], oldLine: i, newLine: null });
        i--;
    }
    while (j > 0) {
        out.push({ kind: 'add', content: newLines[j - 1], oldLine: null, newLine: j });
        j--;
    }

    return out.reverse();
}

function buildLcsTable(a: readonly string[], b: readonly string[]): number[][] {
    const m = a.length;
    const n = b.length;
    const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                table[i][j] = table[i - 1][j - 1] + 1;
            } else {
                table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
            }
        }
    }
    return table;
}

// ── Renderer ────────────────────────────────────────────

/**
 * Render the proposal as an inline chat card. Returns the HTML
 * string the chat-mount code injects into the message slot.
 *
 * Buttons carry `data-action` / `data-project-id` / `data-task-id`
 * attributes the chat-side click delegate uses to dispatch
 * Accept/Reject through the preload bridge.
 */
export function renderRevisionProposal(proposal: RevisionProposal, instruction: string | null): string {
    const changedFiles = proposal.files.filter((f) => !f.unchanged);
    const unchangedFiles = proposal.files.filter((f) => f.unchanged);

    if (proposal.files.length === 0) {
        return `<div class="revision-proposal revision-proposal--empty">
            <div class="revision-proposal-header">Revision proposal · empty (no files staged)</div>
        </div>`;
    }

    const instructionLine = instruction !== null && instruction !== ''
        ? `<div class="revision-proposal-instruction">"${escapeHtml(instruction)}"</div>`
        : '';

    const fileBlocks = changedFiles.map((f) => renderFileBlock(f)).join('');
    const unchangedNote = unchangedFiles.length > 0
        ? `<div class="revision-proposal-unchanged">${unchangedFiles.length} file${unchangedFiles.length === 1 ? '' : 's'} unchanged: ${unchangedFiles.map((f) => `<code>${escapeHtml(f.path)}</code>`).join(', ')}</div>`
        : '';

    return `
        <div class="revision-proposal" data-task-id="${escAttr(proposal.taskId)}">
            <div class="revision-proposal-header">
                <span class="revision-proposal-title">Revision proposal · ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} change</span>
                <span class="revision-proposal-time">${formatTime(proposal.createdAt)}</span>
            </div>
            ${instructionLine}
            <div class="revision-proposal-files">${fileBlocks}</div>
            ${unchangedNote}
            <div class="revision-proposal-actions">
                <button class="btn-revision btn-revision--accept" data-action="accept" data-project-id="${escAttr(proposal.projectId)}" data-task-id="${escAttr(proposal.taskId)}">Accept ${changedFiles.length} change${changedFiles.length === 1 ? '' : 's'}</button>
                <button class="btn-revision btn-revision--reject" data-action="reject" data-project-id="${escAttr(proposal.projectId)}" data-task-id="${escAttr(proposal.taskId)}">Reject</button>
            </div>
        </div>`;
}

function renderFileBlock(file: RevisionProposalFile): string {
    const diff = computeLineDiff(file.currentContent, file.proposedContent);
    const isNew = file.currentSha256 === null;
    const tooBig = file.proposedContent === null && !file.unchanged;

    const summary = isNew
        ? 'new file'
        : `${countOf(diff, 'add')} + / ${countOf(diff, 'remove')} −`;

    const diffBody = tooBig
        ? '<div class="revision-proposal-toolong">(file too large to preview inline; check the staging path)</div>'
        : `<pre class="revision-proposal-diff">${diff.map(renderDiffLine).join('')}</pre>`;

    return `
        <details class="revision-proposal-file" ${isNew || diff.length > 0 ? 'open' : ''}>
            <summary>
                <code class="revision-proposal-path">${escapeHtml(file.path)}</code>
                <span class="revision-proposal-summary">${summary}</span>
            </summary>
            ${diffBody}
        </details>`;
}

function renderDiffLine(line: DiffLine): string {
    const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
    return `<span class="diff-line diff-line--${line.kind}">${prefix} ${escapeHtml(line.content)}\n</span>`;
}

function countOf(diff: readonly DiffLine[], kind: 'add' | 'remove'): number {
    return diff.reduce((n, l) => n + (l.kind === kind ? 1 : 0), 0);
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escAttr(s: string): string {
    return s.replace(/"/g, '&quot;');
}

function formatTime(iso: string): string {
    try {
        return new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}
