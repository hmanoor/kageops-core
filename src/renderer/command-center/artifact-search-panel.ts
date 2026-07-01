/**
 * Artifact Browser — content search panel (B-429).
 *
 * Pure rendering helpers for the search pane that replaces the tree
 * view when the user activates search. Mirrors the DOM-free HTML-string
 * pattern of `artifact-browser-preview.ts` and
 * `artifact-metadata-panel.ts` so it can be unit-tested without jsdom.
 *
 * The panel itself ships in `artifact-browser-panel.ts` — this module
 * is just view plus helpers.
 */

import { escapeHtml } from './artifact-browser-highlight';

export interface SearchMatchView {
    readonly line: number;
    readonly content: string;
    readonly columnStart: number;
    readonly columnEnd: number;
}

export interface SearchFileHit {
    readonly relPath: string;
    readonly matches: readonly SearchMatchView[];
}

export interface SearchResultsView {
    readonly results: readonly SearchFileHit[];
    readonly totalMatches: number;
    readonly truncated: boolean;
    readonly durationMs: number;
    readonly filesScanned: number;
}

export type SearchPanelState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'loading'; readonly query: string }
    | { readonly kind: 'empty'; readonly query: string; readonly filesScanned: number; readonly durationMs: number }
    | { readonly kind: 'results'; readonly query: string; readonly view: SearchResultsView }
    | { readonly kind: 'error'; readonly query: string; readonly message: string };

/**
 * Render the static shell — input, filter toggles, results container.
 * Called once when the panel opens; subsequent updates only rewrite the
 * results container (via `renderSearchResults`).
 */
export function renderSearchShell(state: { caseSensitive: boolean; regex: boolean }): string {
    return (
        '<div class="ab-search">' +
        '<div class="ab-search-toolbar">' +
        '<input type="search" class="ab-search-input" data-role="search-input"' +
        ' placeholder="Search files (content)…" autocomplete="off" spellcheck="false">' +
        '<label class="ab-search-toggle">' +
        `<input type="checkbox" data-role="case-sensitive"${state.caseSensitive ? ' checked' : ''}> Aa` +
        '</label>' +
        '<label class="ab-search-toggle">' +
        `<input type="checkbox" data-role="regex"${state.regex ? ' checked' : ''}> .*` +
        '</label>' +
        '<button class="ab-btn" data-role="search-back" title="Return to file tree">Close</button>' +
        '</div>' +
        '<div class="ab-search-results" data-role="results">' +
        renderSearchResults({ kind: 'idle' }) +
        '</div>' +
        '</div>'
    );
}

/**
 * Render the inner HTML for the results container. Driven entirely by
 * the discriminated `SearchPanelState` — swap the state, call this,
 * write the returned string into `[data-role="results"]`.
 */
export function renderSearchResults(state: SearchPanelState): string {
    if (state.kind === 'idle') {
        return '<div class="ab-search-empty">Start typing to search file contents.</div>';
    }
    if (state.kind === 'loading') {
        return `<div class="ab-search-loading">Searching for “${escapeHtml(state.query)}”…</div>`;
    }
    if (state.kind === 'error') {
        return (
            '<div class="ab-search-error">' +
            `<strong>Search failed:</strong> ${escapeHtml(state.message)}` +
            '</div>'
        );
    }
    if (state.kind === 'empty') {
        return (
            '<div class="ab-search-empty">' +
            `No matches for “${escapeHtml(state.query)}” — ` +
            `scanned ${state.filesScanned} file(s) in ${state.durationMs} ms.` +
            '</div>'
        );
    }

    const { view } = state;
    const summaryParts = [
        `${view.totalMatches} match${view.totalMatches === 1 ? '' : 'es'}`,
        `${view.results.length} file${view.results.length === 1 ? '' : 's'}`,
        `${view.filesScanned} scanned`,
        `${view.durationMs} ms`,
    ];
    const truncatedNote = view.truncated
        ? ' <span class="ab-search-truncated">(truncated — refine your query)</span>'
        : '';
    const header =
        '<div class="ab-search-summary">' +
        escapeHtml(`Results for "${state.query}" — `) +
        escapeHtml(summaryParts.join(' · ')) +
        truncatedNote +
        '</div>';
    const body = view.results.map(renderFileHit).join('');
    return header + '<ol class="ab-search-files">' + body + '</ol>';
}

function renderFileHit(hit: SearchFileHit): string {
    const rows = hit.matches.map((m) => renderMatchRow(hit.relPath, m)).join('');
    return (
        '<li class="ab-search-file">' +
        `<div class="ab-search-file-header" data-role="search-file" data-path="${escapeHtml(hit.relPath)}">` +
        `<span class="ab-search-file-path">${escapeHtml(hit.relPath)}</span>` +
        `<span class="ab-search-file-count">${hit.matches.length}</span>` +
        '</div>' +
        `<ol class="ab-search-matches">${rows}</ol>` +
        '</li>'
    );
}

function renderMatchRow(relPath: string, m: SearchMatchView): string {
    return (
        `<li class="ab-search-match" data-role="search-match"` +
        ` data-path="${escapeHtml(relPath)}" data-line="${m.line}">` +
        `<span class="ab-search-match-line">${m.line}</span>` +
        `<span class="ab-search-match-content">${highlightRange(m.content, m.columnStart, m.columnEnd)}</span>` +
        '</li>'
    );
}

/**
 * Wrap the [start, end) slice of `content` in a `<mark>` and escape
 * every other character. Exported for unit tests.
 */
export function highlightRange(content: string, start: number, end: number): string {
    const safeStart = Math.max(0, Math.min(start, content.length));
    const safeEnd = Math.max(safeStart, Math.min(end, content.length));
    if (safeStart === safeEnd) {
        return escapeHtml(content);
    }
    return (
        escapeHtml(content.slice(0, safeStart)) +
        `<mark class="ab-search-hit">${escapeHtml(content.slice(safeStart, safeEnd))}</mark>` +
        escapeHtml(content.slice(safeEnd))
    );
}

/**
 * Derive the initial state for a response. Separating this from the
 * renderer keeps `loadSearch` in the panel wiring trivial.
 */
export function stateForResponse(
    query: string,
    response: {
        readonly success: boolean;
        readonly error?: string;
        readonly results: readonly SearchFileHit[];
        readonly totalMatches: number;
        readonly truncated: boolean;
        readonly durationMs: number;
        readonly filesScanned: number;
    },
): SearchPanelState {
    if (!response.success) {
        return { kind: 'error', query, message: response.error ?? 'Search failed' };
    }
    if (response.totalMatches === 0) {
        return {
            kind: 'empty',
            query,
            filesScanned: response.filesScanned,
            durationMs: response.durationMs,
        };
    }
    return {
        kind: 'results',
        query,
        view: {
            results: response.results,
            totalMatches: response.totalMatches,
            truncated: response.truncated,
            durationMs: response.durationMs,
            filesScanned: response.filesScanned,
        },
    };
}
