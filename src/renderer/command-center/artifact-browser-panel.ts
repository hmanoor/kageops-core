/**
 * Artifact Browser Panel — workspace file tree + preview (B-420/421/422).
 *
 * Three concerns are composed here:
 *   • `ArtifactTreeView`         — virtualized tree (artifact-browser-tree.ts)
 *   • `renderPreviewHtml`        — preview pipeline (artifact-browser-preview.ts)
 *   • download zip action        — retained from the existing panel
 *
 * The panel re-fetches the tree on every mount; callers should re-mount
 * when the selected project changes. In-memory expanded-set is scoped to
 * a single mount — not persisted.
 */

import { ArtifactTreeView, type FileNode } from './artifact-browser-tree';
import { renderPreviewHtml, type FileReadResult, type PreviewContext } from './artifact-browser-preview';
import {
    renderMetadataPanel,
    type MetadataPanelState,
    type TaskDetails,
} from './artifact-metadata-panel';
import {
    renderSearchShell,
    renderSearchResults,
    stateForResponse,
    type SearchFileHit,
    type SearchPanelState,
} from './artifact-search-panel';
import { escapeHtml } from './artifact-browser-highlight';
import { hydrateIcons, icon } from '../../shared/icons';

export interface ArtifactBrowserCallbacks {
    readonly listArtifactTree: (projectId: string, maxDepth?: number) => Promise<{
        readonly success: boolean;
        readonly nodes: readonly FileNode[];
        readonly error?: string;
    }>;
    readonly readArtifactFile: (projectId: string, relPath: string) => Promise<{
        readonly success: boolean;
        readonly file?: FileReadResult;
        readonly error?: string;
    }>;
    readonly downloadArtifactZip?: (projectId: string) => Promise<{
        readonly success: boolean;
        readonly path?: string;
        readonly error?: string;
    }>;
    readonly startLivePreview?: (projectId: string) => Promise<{
        readonly success: boolean;
        readonly url?: string;
        readonly port?: number;
        readonly error?: string;
    }>;
    readonly stopLivePreview?: (projectId: string) => Promise<{ readonly success: boolean; readonly error?: string }>;
    readonly deleteArtifactPath?: (projectId: string, relPath: string, recursive: boolean) => Promise<{
        readonly success: boolean;
        readonly error?: string;
        readonly kind?: 'file' | 'dir';
    }>;
    readonly pushProjectToGitHub?: (projectId: string, opts?: {
        readonly owner?: string;
        readonly repo?: string;
        readonly private?: boolean;
    }) => Promise<{
        readonly success: boolean;
        readonly error?: string;
        readonly repoUrl?: string;
        readonly branch?: string;
    }>;
    /** Fetch the producing task for a file — drives the metadata panel (B-428). */
    readonly getArtifactTaskDetails?: (projectId: string, taskId: string) => Promise<{
        readonly success: boolean;
        readonly task?: TaskDetails | null;
        readonly error?: string;
    }>;
    /** Content search inside the project workspace (B-429). */
    readonly searchArtifacts?: (
        projectId: string,
        query: string,
        opts?: { caseSensitive?: boolean; regex?: boolean; maxResults?: number },
    ) => Promise<{
        readonly success: boolean;
        readonly error?: string;
        readonly results: readonly SearchFileHit[];
        readonly totalMatches: number;
        readonly truncated: boolean;
        readonly durationMs: number;
        readonly filesScanned: number;
    }>;
    /** Open an external URL (defaults to window.open). */
    readonly openUrl?: (url: string) => void;
    /** Confirm dialog (defaults to window.confirm). Injectable for tests. */
    readonly confirm?: (message: string) => boolean;
}

interface PanelRefs {
    readonly tree: HTMLElement;
    readonly preview: HTMLElement;
    readonly status: HTMLElement;
    readonly refresh: HTMLButtonElement;
    readonly download: HTMLButtonElement | null;
    readonly live: HTMLButtonElement | null;
    readonly push: HTMLButtonElement | null;
    readonly search: HTMLButtonElement | null;
    readonly searchPane: HTMLElement | null;
}

export function renderArtifactBrowserPanel(
    container: HTMLElement,
    projectId: string,
    projectName: string,
    callbacks: ArtifactBrowserCallbacks,
    initialFile?: string,
): void {
    container.innerHTML = panelScaffold(projectName, {
        hasDownload: callbacks.downloadArtifactZip !== undefined,
        hasLive: callbacks.startLivePreview !== undefined && callbacks.stopLivePreview !== undefined,
        hasPush: callbacks.pushProjectToGitHub !== undefined,
        hasSearch: callbacks.searchArtifacts !== undefined,
    });
    hydrateIcons(container);

    const refs = resolveRefs(container);
    if (refs === null) return;

    const deleteCallback = callbacks.deleteArtifactPath;
    const confirmFn = callbacks.confirm ?? ((m: string) => window.confirm(m));

    // Generation counter — each file click bumps this; in-flight IPCs
    // (preview read + task-details fetch) capture their starting value
    // and only write DOM when it is still current. Prevents a slow IPC
    // for file A from overwriting the metadata slot for file B.
    let previewGeneration = 0;

    const treeView = new ArtifactTreeView(refs.tree, {
        onFileClick: (relPath) => {
            const node = treeView.findNode(relPath);
            const myGen = ++previewGeneration;
            void loadPreview(
                callbacks,
                projectId,
                relPath,
                refs,
                node?.producedBy,
                () => myGen === previewGeneration,
            );
        },
        ...(deleteCallback !== undefined ? {
            onDeleteClick: (relPath, isDir) => {
                void handleDelete(projectId, relPath, isDir, deleteCallback, confirmFn, refs)
                    .then((didDelete) => {
                        if (didDelete) {
                            void loadTree(callbacks, projectId, treeView, refs);
                        }
                    });
            },
        } : {}),
    });

    refs.refresh.addEventListener('click', () => {
        void loadTree(callbacks, projectId, treeView, refs);
    });

    if (refs.download !== null && callbacks.downloadArtifactZip !== undefined) {
        const downloadBtn = refs.download;
        const download = callbacks.downloadArtifactZip;
        downloadBtn.addEventListener('click', () => {
            void handleDownload(projectId, download, downloadBtn, refs.status);
        });
    }

    if (refs.push !== null && callbacks.pushProjectToGitHub !== undefined) {
        const pushBtn = refs.push;
        const push = callbacks.pushProjectToGitHub;
        const open = callbacks.openUrl ?? ((url) => { window.open(url, '_blank', 'noopener,noreferrer'); });
        pushBtn.addEventListener('click', () => {
            void handlePushToGitHub(projectId, push, open, pushBtn, refs.status);
        });
    }

    let liveState: LiveState = { running: false };
    if (refs.live !== null && callbacks.startLivePreview !== undefined && callbacks.stopLivePreview !== undefined) {
        const liveBtn = refs.live;
        const start = callbacks.startLivePreview;
        const stop = callbacks.stopLivePreview;
        const open = callbacks.openUrl ?? ((url) => { window.open(url, '_blank', 'noopener,noreferrer'); });
        liveBtn.addEventListener('click', () => {
            void handleLiveToggle(projectId, liveState, start, stop, open, liveBtn, refs.status).then((next) => {
                liveState = next;
            });
        });
    }

    // Auto-stop the server if the panel is removed from the DOM.
    if (callbacks.stopLivePreview !== undefined) {
        const stop = callbacks.stopLivePreview;
        observeDetach(container, () => {
            if (liveState.running) {
                void stop(projectId);
            }
        });
    }

    // Search mode (B-429) — toggles a sibling pane next to the tree.
    // The tree DOM stays mounted so `ArtifactTreeView`'s internal refs
    // remain valid when the user closes search.
    if (refs.search !== null && callbacks.searchArtifacts !== undefined && refs.searchPane !== null) {
        const searchBtn = refs.search;
        const searchFn = callbacks.searchArtifacts;
        const searchPane = refs.searchPane;
        const searchMount = new SearchPaneController(searchPane, projectId, searchFn, {
            onResultClick: (relPath) => {
                searchMount.close();
                toggleSearchVisible(refs, false);
                searchBtn.classList.remove('ab-btn--active');
                const node = treeView.findNode(relPath);
                const myGen = ++previewGeneration;
                void loadPreview(
                    callbacks,
                    projectId,
                    relPath,
                    refs,
                    node?.producedBy,
                    () => myGen === previewGeneration,
                );
            },
        });
        searchBtn.addEventListener('click', () => {
            if (searchMount.isOpen()) {
                searchMount.close();
                toggleSearchVisible(refs, false);
                searchBtn.classList.remove('ab-btn--active');
            } else {
                toggleSearchVisible(refs, true);
                searchMount.open();
                searchBtn.classList.add('ab-btn--active');
            }
        });
    }

    void loadTree(callbacks, projectId, treeView, refs, initialFile);
}

function toggleSearchVisible(refs: PanelRefs, showSearch: boolean): void {
    if (refs.searchPane === null) return;
    refs.tree.hidden = showSearch;
    refs.searchPane.hidden = !showSearch;
}

interface LiveState {
    readonly running: boolean;
    readonly url?: string;
}

interface SearchCallbacks {
    readonly onResultClick: (relPath: string) => void;
}

type SearchArtifactsFn = NonNullable<ArtifactBrowserCallbacks['searchArtifacts']>;

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Search-pane controller — owns the DOM inside `treeEl` while search
 * mode is active, and restores the caller's cached tree markup when
 * closed. Keeps search state + debounce + generation counter local.
 */
class SearchPaneController {
    private readonly treeEl: HTMLElement;
    private readonly projectId: string;
    private readonly searchFn: SearchArtifactsFn;
    private readonly callbacks: SearchCallbacks;

    private open_ = false;
    private caseSensitive = false;
    private regex = false;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private generation = 0;

    constructor(
        treeEl: HTMLElement,
        projectId: string,
        searchFn: SearchArtifactsFn,
        callbacks: SearchCallbacks,
    ) {
        this.treeEl = treeEl;
        this.projectId = projectId;
        this.searchFn = searchFn;
        this.callbacks = callbacks;
    }

    isOpen(): boolean {
        return this.open_;
    }

    open(): void {
        if (this.open_) return;
        this.open_ = true;
        this.treeEl.innerHTML = renderSearchShell({
            caseSensitive: this.caseSensitive,
            regex: this.regex,
        });
        this.wireEvents();
        const input = this.treeEl.querySelector<HTMLInputElement>('[data-role="search-input"]');
        if (input !== null) input.focus();
    }

    close(): void {
        if (!this.open_) return;
        this.open_ = false;
        this.generation++;
        if (this.debounceTimer !== null) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        // Pane is toggled hidden by caller; clearing inner DOM also releases
        // the event listeners bound inside wireEvents() for garbage collection.
        this.treeEl.innerHTML = '';
    }

    private wireEvents(): void {
        const input = this.treeEl.querySelector<HTMLInputElement>('[data-role="search-input"]');
        const caseBox = this.treeEl.querySelector<HTMLInputElement>('[data-role="case-sensitive"]');
        const regexBox = this.treeEl.querySelector<HTMLInputElement>('[data-role="regex"]');
        const resultsEl = this.treeEl.querySelector<HTMLElement>('[data-role="results"]');
        const backBtn = this.treeEl.querySelector<HTMLButtonElement>('[data-role="search-back"]');

        if (input !== null) {
            input.addEventListener('input', () => this.scheduleSearch(input.value, resultsEl));
        }
        if (caseBox !== null) {
            caseBox.addEventListener('change', () => {
                this.caseSensitive = caseBox.checked;
                if (input !== null) this.scheduleSearch(input.value, resultsEl);
            });
        }
        if (regexBox !== null) {
            regexBox.addEventListener('change', () => {
                this.regex = regexBox.checked;
                if (input !== null) this.scheduleSearch(input.value, resultsEl);
            });
        }
        if (backBtn !== null) {
            backBtn.addEventListener('click', () => {
                // Sent as a synthetic click on the toolbar button so the
                // button state + tree markup restore happen in one place.
                const toolbarBtn = this.treeEl.ownerDocument?.querySelector<HTMLButtonElement>(
                    '[data-role="search-toggle"]',
                );
                toolbarBtn?.click();
            });
        }
        if (resultsEl !== null) {
            resultsEl.addEventListener('click', (e) => {
                const target = e.target instanceof HTMLElement ? e.target : null;
                if (target === null) return;
                const match = target.closest<HTMLElement>('[data-role="search-match"]');
                if (match === null) return;
                const relPath = match.dataset['path'] ?? '';
                if (relPath === '') return;
                this.callbacks.onResultClick(relPath);
            });
        }
    }

    private scheduleSearch(query: string, resultsEl: HTMLElement | null): void {
        if (resultsEl === null) return;
        if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
        // Bump first so any in-flight search has its gen mismatch and can't
        // overwrite the DOM after a newer input arrives.
        const myGen = ++this.generation;
        const trimmed = query.trim();
        if (trimmed.length === 0) {
            resultsEl.innerHTML = renderSearchResults({ kind: 'idle' });
            return;
        }
        resultsEl.innerHTML = renderSearchResults({ kind: 'loading', query: trimmed });
        this.debounceTimer = setTimeout(() => {
            if (myGen !== this.generation) return;
            void this.runSearch(trimmed, myGen, resultsEl);
        }, SEARCH_DEBOUNCE_MS);
    }

    private async runSearch(
        query: string,
        myGen: number,
        resultsEl: HTMLElement,
    ): Promise<void> {
        try {
            const res = await this.searchFn(this.projectId, query, {
                caseSensitive: this.caseSensitive,
                regex: this.regex,
            });
            if (myGen !== this.generation) return;
            const state: SearchPanelState = stateForResponse(query, res);
            resultsEl.innerHTML = renderSearchResults(state);
        } catch (err) {
            if (myGen !== this.generation) return;
            const message = err instanceof Error ? err.message : String(err);
            resultsEl.innerHTML = renderSearchResults({ kind: 'error', query, message });
        }
    }
}

// ── Panel plumbing ───────────────────────────────────

function panelScaffold(
    projectName: string,
    opts: { hasDownload: boolean; hasLive: boolean; hasPush: boolean; hasSearch: boolean },
): string {
    const searchBtn = opts.hasSearch
        ? `<button class="ab-btn" data-role="search-toggle" title="Search workspace contents">${icon('search', { size: 14 })} Search</button>`
        : '';
    const downloadBtn = opts.hasDownload
        ? `<button class="ab-btn" data-role="download" title="Download workspace as zip">${icon('cloud-upload', { size: 14 })} Zip</button>`
        : '';
    const liveBtn = opts.hasLive
        ? `<button class="ab-btn" data-role="live" title="Serve workspace over HTTP on 127.0.0.1">${icon('eye', { size: 14 })} Live preview</button>`
        : '';
    const pushBtn = opts.hasPush
        ? `<button class="ab-btn" data-role="push-github" title="Push workspace to the configured GitHub repo">${icon('git-branch', { size: 14 })} Push to GitHub</button>`
        : '';
    return (
        '<div class="artifact-browser ab-root">' +
        '<div class="ab-toolbar">' +
        `<span class="ab-title">${icon('folder', { size: 14 })} ${escapeHtml(projectName)} &mdash; Workspace</span>` +
        `<button class="ab-btn" data-role="refresh" title="Reload tree">${icon('rotate-ccw', { size: 14 })} Refresh</button>` +
        searchBtn +
        liveBtn +
        pushBtn +
        downloadBtn +
        '</div>' +
        '<div class="ab-body">' +
        '<div class="ab-tree" data-role="tree"></div>' +
        (opts.hasSearch ? '<div class="ab-search-pane" data-role="search-pane" hidden></div>' : '') +
        '<div class="ab-preview" data-role="preview"><div class="empty-state">Select a file to preview</div></div>' +
        '</div>' +
        '<div class="ab-status" data-role="status"></div>' +
        '</div>'
    );
}

function resolveRefs(container: HTMLElement): PanelRefs | null {
    const tree = container.querySelector<HTMLElement>('[data-role="tree"]');
    const preview = container.querySelector<HTMLElement>('[data-role="preview"]');
    const status = container.querySelector<HTMLElement>('[data-role="status"]');
    const refresh = container.querySelector<HTMLButtonElement>('[data-role="refresh"]');
    const download = container.querySelector<HTMLButtonElement>('[data-role="download"]');
    const live = container.querySelector<HTMLButtonElement>('[data-role="live"]');
    const push = container.querySelector<HTMLButtonElement>('[data-role="push-github"]');
    const search = container.querySelector<HTMLButtonElement>('[data-role="search-toggle"]');
    const searchPane = container.querySelector<HTMLElement>('[data-role="search-pane"]');
    if (tree === null || preview === null || status === null || refresh === null) return null;
    return { tree, preview, status, refresh, download, live, push, search, searchPane };
}

async function loadTree(
    callbacks: ArtifactBrowserCallbacks,
    projectId: string,
    treeView: ArtifactTreeView,
    refs: PanelRefs,
    initialFile?: string,
): Promise<void> {
    setStatus(refs.status, 'Loading tree…', false);
    try {
        const result = await callbacks.listArtifactTree(projectId);
        if (!result.success) {
            setStatus(refs.status, result.error ?? 'Failed to load tree', true);
            return;
        }
        treeView.setTree(result.nodes);
        setStatus(refs.status, `${countFiles(result.nodes)} files indexed`, false);
        if (initialFile !== undefined && initialFile !== '') {
            treeView.revealPath(initialFile);
            const node = treeView.findNode(initialFile);
            void loadPreview(callbacks, projectId, initialFile, refs, node?.producedBy, () => true);
        }
    } catch (err) {
        setStatus(refs.status, err instanceof Error ? err.message : String(err), true);
    }
}

async function loadPreview(
    callbacks: ArtifactBrowserCallbacks,
    projectId: string,
    relPath: string,
    refs: PanelRefs,
    producedBy: PreviewContext['producedBy'],
    isCurrent: () => boolean,
): Promise<void> {
    refs.preview.innerHTML = '<div class="empty-state">Loading preview&hellip;</div>';
    try {
        const result = await callbacks.readArtifactFile(projectId, relPath);
        if (!isCurrent()) return;
        if (!result.success || result.file === undefined) {
            refs.preview.innerHTML = `<div class="empty-state">${escapeHtml(result.error ?? 'Preview failed')}</div>`;
            return;
        }
        const ctx: PreviewContext = producedBy !== undefined
            ? { projectId, relPath, producedBy }
            : { projectId, relPath };
        const { html } = renderPreviewHtml(ctx, result.file);
        const metadataState: MetadataPanelState =
            callbacks.getArtifactTaskDetails !== undefined && producedBy !== undefined
                ? { kind: 'loading' }
                : { kind: 'hidden' };
        refs.preview.innerHTML =
            html +
            `<div data-role="metadata">${renderMetadataPanel(metadataState)}</div>`;
        if (callbacks.getArtifactTaskDetails !== undefined && producedBy !== undefined) {
            void loadTaskMetadata(
                callbacks.getArtifactTaskDetails,
                projectId,
                producedBy.taskId,
                refs.preview,
                isCurrent,
            );
        }
    } catch (err) {
        if (!isCurrent()) return;
        const msg = err instanceof Error ? err.message : String(err);
        refs.preview.innerHTML = `<div class="empty-state">${escapeHtml(msg)}</div>`;
    }
}

/**
 * Fetch producing-task details and patch the metadata slot inside the
 * preview pane. Safe to call without awaiting — it handles its own
 * errors by rendering an error state into the slot. Gated by `isCurrent`
 * so a slow response for a previously-selected file cannot overwrite
 * the slot that belongs to a newer selection.
 */
async function loadTaskMetadata(
    getTaskDetails: NonNullable<ArtifactBrowserCallbacks['getArtifactTaskDetails']>,
    projectId: string,
    taskId: string,
    previewEl: HTMLElement,
    isCurrent: () => boolean,
): Promise<void> {
    const write = (state: MetadataPanelState): void => {
        if (!isCurrent()) return;
        const slot = previewEl.querySelector<HTMLElement>('[data-role="metadata"]');
        if (slot === null) return;
        slot.innerHTML = renderMetadataPanel(state);
    };
    try {
        const res = await getTaskDetails(projectId, taskId);
        if (!res.success) {
            write({ kind: 'error', message: res.error ?? 'Failed to load task details' });
            return;
        }
        if (res.task === null || res.task === undefined) {
            write({ kind: 'unknown-task' });
            return;
        }
        write({ kind: 'loaded', task: res.task });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        write({ kind: 'error', message: msg });
    }
}

/**
 * Start/stop the live server. Returns the new state so the caller can
 * keep track without reaching into button internals.
 */
async function handleLiveToggle(
    projectId: string,
    state: LiveState,
    start: NonNullable<ArtifactBrowserCallbacks['startLivePreview']>,
    stop: NonNullable<ArtifactBrowserCallbacks['stopLivePreview']>,
    open: (url: string) => void,
    button: HTMLButtonElement,
    statusEl: HTMLElement,
): Promise<LiveState> {
    button.disabled = true;
    try {
        if (state.running) {
            const res = await stop(projectId);
            if (!res.success) {
                setStatus(statusEl, res.error ?? 'Failed to stop live preview', true);
                return state;
            }
            setStatus(statusEl, 'Live preview stopped', false);
            button.innerHTML = `${icon('eye', { size: 14 })} Live preview`;
            return { running: false };
        }
        const res = await start(projectId);
        if (!res.success || res.url === undefined) {
            setStatus(statusEl, res.error ?? 'Failed to start live preview', true);
            return state;
        }
        open(res.url);
        setStatus(statusEl, `Live preview at ${res.url}`, false);
        button.innerHTML = `${icon('eye', { size: 14 })} Stop preview`;
        return { running: true, url: res.url };
    } finally {
        button.disabled = false;
    }
}

/**
 * Fire `onDetach` exactly once when the container is removed from the DOM.
 * Used so the live server stops automatically when the Artifact Browser
 * overlay closes.
 */
function observeDetach(container: HTMLElement, onDetach: () => void): void {
    const root = container.ownerDocument?.body ?? document.body;
    if (root === null) return;
    const observer = new MutationObserver(() => {
        if (!root.contains(container)) {
            observer.disconnect();
            onDetach();
        }
    });
    observer.observe(root, { childList: true, subtree: true });
}

/**
 * Confirm → delete a file or directory → refresh status. Returns `true`
 * when a delete actually completed so the caller can reload the tree.
 * Directory deletes require a second, more explicit confirm because
 * `recursive: true` nukes any children.
 */
async function handleDelete(
    projectId: string,
    relPath: string,
    isDir: boolean,
    del: NonNullable<ArtifactBrowserCallbacks['deleteArtifactPath']>,
    confirm: (message: string) => boolean,
    refs: PanelRefs,
): Promise<boolean> {
    const kindLabel = isDir ? 'directory' : 'file';
    const prompt = isDir
        ? `Delete the directory "${relPath}" and everything inside it?\n\nThis cannot be undone.`
        : `Delete the file "${relPath}"?\n\nThis cannot be undone.`;
    if (!confirm(prompt)) return false;
    setStatus(refs.status, `Deleting ${kindLabel}…`, false);
    try {
        const res = await del(projectId, relPath, isDir);
        if (!res.success) {
            setStatus(refs.status, res.error ?? `Failed to delete ${kindLabel}`, true);
            return false;
        }
        setStatus(refs.status, `${kindLabel === 'file' ? 'File' : 'Directory'} deleted: ${relPath}`, false);
        return true;
    } catch (err) {
        setStatus(refs.status, err instanceof Error ? err.message : String(err), true);
        return false;
    }
}

/**
 * Push the project workspace to its configured GitHub repo (B-427).
 * The main process handles token + git plumbing; the panel just shows
 * pending state and surfaces the resulting PR/repo URL.
 */
async function handlePushToGitHub(
    projectId: string,
    push: NonNullable<ArtifactBrowserCallbacks['pushProjectToGitHub']>,
    open: (url: string) => void,
    button: HTMLButtonElement,
    statusEl: HTMLElement,
): Promise<void> {
    button.disabled = true;
    const originalHtml = button.innerHTML;
    button.textContent = 'Pushing…';
    setStatus(statusEl, 'Pushing to GitHub…', false);
    try {
        const result = await push(projectId);
        if (!result.success) {
            setStatus(statusEl, result.error ?? 'GitHub push failed', true);
            return;
        }
        if (result.repoUrl !== undefined && result.repoUrl !== '') {
            setStatus(
                statusEl,
                `Pushed${result.branch !== undefined ? ` ${result.branch}` : ''} → ${result.repoUrl}`,
                false,
            );
            open(result.repoUrl);
        } else {
            setStatus(statusEl, 'Pushed to GitHub', false);
        }
    } catch (err) {
        setStatus(statusEl, err instanceof Error ? err.message : 'Push failed', true);
    } finally {
        button.disabled = false;
        button.innerHTML = originalHtml;
    }
}

async function handleDownload(
    projectId: string,
    download: NonNullable<ArtifactBrowserCallbacks['downloadArtifactZip']>,
    button: HTMLButtonElement,
    statusEl: HTMLElement,
): Promise<void> {
    button.disabled = true;
    const originalHtml = button.innerHTML;
    button.textContent = 'Preparing…';
    setStatus(statusEl, 'Building zip…', false);
    try {
        const result = await download(projectId);
        if (result.success) {
            setStatus(statusEl, result.path !== undefined ? `Saved: ${result.path}` : 'Saved.', false);
        } else {
            setStatus(statusEl, result.error ?? 'Download failed', true);
        }
    } catch (err) {
        setStatus(statusEl, err instanceof Error ? err.message : 'Download failed', true);
    } finally {
        button.disabled = false;
        button.innerHTML = originalHtml;
    }
}

function setStatus(el: HTMLElement, text: string, isError: boolean): void {
    el.textContent = text;
    el.className = `ab-status${isError ? ' ab-status--error' : ''}`;
}

function countFiles(nodes: readonly FileNode[]): number {
    let total = 0;
    const walk = (list: readonly FileNode[]): void => {
        for (const n of list) {
            if (n.type === 'file') {
                total++;
            } else if (n.children !== undefined) {
                walk(n.children);
            }
        }
    };
    walk(nodes);
    return total;
}
