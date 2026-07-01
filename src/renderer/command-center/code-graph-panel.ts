/**
 * KageOps Code Graph Panel
 *
 * Lists all KageOps projects, lets the user build a graphify knowledge graph
 * per project, streams build progress live, and displays the interactive
 * graph inline via an iframe viewer.
 */

import { icon } from '../../shared/icons';

// ── Types ─────────────────────────────────────────────

export interface GraphifyProjectEntry {
    readonly projectId: string;
    readonly projectName: string;
    readonly repoPath: string;
    readonly hasGraph: boolean;
    readonly htmlPath: string | null;
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly builtAt: string | null;
}

export interface GraphifyProgressEvent {
    readonly projectId: string;
    readonly line: string;
    readonly done: boolean;
    readonly error: string | null;
    readonly nodeCount?: number;
    readonly edgeCount?: number;
}

export interface GraphifyBuildState {
    readonly status: 'idle' | 'building' | 'done' | 'error';
    readonly log: readonly string[];
}

export interface CodeGraphCallbacks {
    readonly onBuild: (projectId: string, repoPath: string) => void;
    readonly onOpen: (htmlPath: string) => void;
}

// ── Helpers ───────────────────────────────────────────

function esc(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatAge(isoStr: string | null): string {
    if (isoStr === null) return '';
    const diffMs = Date.now() - new Date(isoStr).getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    return `${Math.floor(diffH / 24)}d ago`;
}

function cardStatus(
    entry: GraphifyProjectEntry,
    buildState: ReadonlyMap<string, GraphifyBuildState>
): 'idle' | 'building' | 'done' | 'error' | 'ready' | 'empty' | 'static-only' {
    const state = buildState.get(entry.projectId);
    const isStaticOnly = isStaticProject(state, entry);
    if (state !== undefined) {
        // A finished build that produced zero symbols is "empty", not "done".
        // Without this the badge says Ready and the View button opens a
        // missing/empty graph.html — the blank-panel bug from v0.1.21.
        if (state.status === 'done' && entry.nodeCount === 0) {
            return isStaticOnly ? 'static-only' : 'empty';
        }
        return state.status;
    }
    if (entry.hasGraph && entry.nodeCount === 0) {
        return isStaticOnly ? 'static-only' : 'empty';
    }
    return entry.hasGraph ? 'ready' : 'idle';
}

/**
 * Detect "this project has files but none of them are code graphify can
 * parse" by sniffing the build log. graphify emits "Found N files (0 code)"
 * when the AST detector skipped every file, which is the normal state for
 * landing-page projects (HTML / CSS only). Distinguished from a true empty
 * (no files at all) so the hint can be specific.
 */
function isStaticProject(
    state: GraphifyBuildState | undefined,
    entry: GraphifyProjectEntry,
): boolean {
    if (entry.nodeCount !== 0) return false;
    const logs = state?.log ?? [];
    return logs.some((l) => /Found \d+ files \(0 code\)/.test(l));
}

function badgeHtml(status: ReturnType<typeof cardStatus>): string {
    const map: Record<string, [string, string]> = {
        idle:          ['cg-badge cg-badge--idle',     'No Graph'],
        building:      ['cg-badge cg-badge--building', 'Building…'],
        done:          ['cg-badge cg-badge--ready',    'Ready'],
        ready:         ['cg-badge cg-badge--ready',    'Ready'],
        empty:         ['cg-badge cg-badge--idle',     'Empty'],
        'static-only': ['cg-badge cg-badge--idle',     'Static'],
        error:         ['cg-badge cg-badge--error',    'Error'],
    };
    const [cls, label] = map[status] ?? ['cg-badge cg-badge--idle', status];
    return `<span class="${cls}" data-role="badge">${label}</span>`;
}

function renderCard(
    entry: GraphifyProjectEntry,
    buildState: ReadonlyMap<string, GraphifyBuildState>
): string {
    const status = cardStatus(entry, buildState);
    const state = buildState.get(entry.projectId);
    const logLines = state?.log ?? [];
    const isBuilding = status === 'building';
    const isReady = (status === 'ready' || status === 'done') && entry.nodeCount > 0;
    const isEmpty = status === 'empty';
    const isStaticOnly = status === 'static-only';

    let meta: string;
    if (isReady) {
        meta = `${entry.nodeCount.toLocaleString()} nodes · ${entry.edgeCount.toLocaleString()} edges${entry.builtAt !== null ? ' · ' + formatAge(entry.builtAt) : ''}`;
    } else if (isStaticOnly) {
        // graphify successfully scanned but found only HTML/CSS/markdown —
        // not a tooling problem, the project just has nothing to graph.
        meta = 'Static project — graphify only graphs JS / TS / Python / Go / Rust source.';
    } else if (isEmpty) {
        meta = 'graphify found no symbols — install Python + graphify CLI or check the repo path';
    } else {
        meta = entry.repoPath.replace(/\\/g, '/').split('/').pop() ?? entry.repoPath;
    }

    const logHtml = logLines.length > 0
        ? `<pre class="cg-log" data-role="log">${esc(logLines.join('\n'))}</pre>`
        : `<pre class="cg-log" data-role="log" style="display:none"></pre>`;

    const buildBtnText = (isReady || isEmpty || isStaticOnly) ? 'Rebuild' : 'Build';
    const openBtn = isReady
        ? `<button class="cg-btn cg-btn-open" data-role="open-btn" data-html-path="${esc(entry.htmlPath ?? entry.repoPath + '/graphify-out/graph.html')}">${icon('graph', { size: 11 })} View</button>`
        : '';

    return `
        <div class="cg-card" data-project-id="${esc(entry.projectId)}">
            <div class="cg-card-row">
                <span class="cg-card-name" title="${esc(entry.projectName)}">${esc(entry.projectName)}</span>
                <div class="cg-card-right">
                    <span class="cg-meta" data-role="meta">${esc(meta)}</span>
                    ${badgeHtml(status)}
                    <div class="cg-card-btns">
                        <button class="cg-btn cg-btn-build" data-role="build-btn"
                            data-project-id="${esc(entry.projectId)}"
                            data-repo-path="${esc(entry.repoPath)}"
                            ${isBuilding ? 'disabled' : ''}>
                            ${icon('graph', { size: 11 })} ${buildBtnText}
                        </button>
                        ${openBtn}
                    </div>
                </div>
            </div>
            ${logHtml}
        </div>`;
}

function wireCardButtons(container: HTMLElement, callbacks: CodeGraphCallbacks): void {
    container.querySelectorAll<HTMLButtonElement>('[data-role="build-btn"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const projectId = btn.dataset['projectId'] ?? '';
            const repoPath = btn.dataset['repoPath'] ?? '';
            if (projectId !== '' && repoPath !== '') callbacks.onBuild(projectId, repoPath);
        });
    });
    container.querySelectorAll<HTMLButtonElement>('[data-role="open-btn"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const htmlPath = btn.dataset['htmlPath'] ?? '';
            if (htmlPath !== '') callbacks.onOpen(htmlPath);
        });
    });
}

// ── Theme injection ───────────────────────────────────

/**
 * KageOps dark-theme CSS to inject into the graphify iframe via
 * contentDocument after load (same-origin file:// access).
 *
 * Maps graphify's hardcoded navy palette (#0f0f1a / #1a1a2e) onto VS Code
 * surfaces (#141414 sunken, #1e1e1e base) with moss-green accent (#4d9e6f).
 */
const KAGEOPS_GRAPH_THEME_CSS = `
  body { background: #141414 !important; }
  #sidebar {
    background: #1e1e1e !important;
    border-left-color: rgba(255,255,255,0.08) !important;
  }
  #search-wrap    { border-bottom-color: rgba(255,255,255,0.08) !important; }
  #search-results { border-bottom-color: rgba(255,255,255,0.08) !important; }
  #info-panel     { border-bottom-color: rgba(255,255,255,0.08) !important; }
  #search {
    background: #141414 !important;
    border-color: rgba(255,255,255,0.12) !important;
    color: #d4d4d4 !important;
  }
  #search:focus { border-color: #4d9e6f !important; box-shadow: 0 0 0 2px rgba(77,158,111,0.25) !important; }
  #search::placeholder { color: #6e6e6e !important; }
  .search-item { color: #d4d4d4 !important; }
  .search-item:hover { background: rgba(255,255,255,0.06) !important; }
  #info-panel h3 { color: #6e6e6e !important; }
  #info-content  { color: #9d9d9d !important; }
  #info-content .field b { color: #d4d4d4 !important; }
  #info-content .empty   { color: #4e4e4e !important; }
  .neighbor-link { border-left-color: rgba(255,255,255,0.15) !important; color: #9d9d9d !important; }
  .neighbor-link:hover { background: rgba(255,255,255,0.06) !important; color: #d4d4d4 !important; }
  #communities   { scrollbar-color: rgba(255,255,255,0.15) transparent; }
  #communities h3 { color: #6e6e6e !important; }
  .community-item { border-left-color: rgba(255,255,255,0.10) !important; }
  #stats {
    color: #6e6e6e !important;
    border-top-color: rgba(255,255,255,0.08) !important;
    background: #1e1e1e !important;
  }
`;

// ── Viewer ────────────────────────────────────────────

function getOrCreateViewer(container: HTMLElement): {
    viewer: HTMLElement;
    iframe: HTMLIFrameElement;
    titleEl: HTMLElement;
    sideEl: HTMLElement;
} {
    let viewer = container.querySelector<HTMLElement>('.cg-viewer');
    if (viewer === null) {
        const div = document.createElement('div');
        div.className = 'cg-viewer';
        // v0.1.34: viewer now has an expand toggle + a side pane that
        // shows the source file for a clicked graph node. The body is a
        // flex row so the side pane can slide in from the right without
        // re-flowing the iframe.
        div.innerHTML = `
            <div class="cg-viewer-bar">
                <button class="cg-viewer-close" data-role="viewer-close" title="Close viewer" aria-label="Close">
                    <span class="cg-viewer-close-dot"></span>
                </button>
                <span class="cg-viewer-title" data-role="viewer-title">Knowledge Graph</span>
                <span class="cg-viewer-spacer"></span>
                <button class="cg-viewer-btn" data-role="viewer-expand" title="Expand / collapse" aria-label="Expand">⤢</button>
            </div>
            <div class="cg-viewer-body">
                <iframe class="cg-viewer-frame" data-role="viewer-frame" frameborder="0"></iframe>
                <aside class="cg-viewer-side cg-viewer-side--hidden" data-role="viewer-side">
                    <div class="cg-side-bar">
                        <span class="cg-side-title" data-role="side-title">Select a node to view source</span>
                        <button class="cg-side-close" data-role="side-close" title="Close side pane" aria-label="Close side pane">×</button>
                    </div>
                    <div class="cg-side-meta" data-role="side-meta"></div>
                    <pre class="cg-side-content" data-role="side-content"></pre>
                </aside>
            </div>`;
        container.appendChild(div);
        viewer = div;

        const v = viewer;

        v.querySelector('[data-role="viewer-close"]')?.addEventListener('click', () => {
            v.style.display = 'none';
            v.classList.remove('cg-viewer--expanded');
            const frame = v.querySelector<HTMLIFrameElement>('[data-role="viewer-frame"]');
            if (frame !== null) frame.src = 'about:blank';
            closeSidePane(v);
            if (_resizeCleanup !== null) { _resizeCleanup(); _resizeCleanup = null; }
        });

        const expandBtn = v.querySelector<HTMLButtonElement>('[data-role="viewer-expand"]');
        const toggleExpand = (): void => {
            const nowExpanded = v.classList.toggle('cg-viewer--expanded');
            if (expandBtn !== null) {
                expandBtn.textContent = nowExpanded ? '⤡' : '⤢';
                expandBtn.title = nowExpanded ? 'Collapse' : 'Expand';
                expandBtn.setAttribute('aria-label', nowExpanded ? 'Collapse' : 'Expand');
            }
            // Tell the iframe its viewport size changed so vis-network can re-fit
            const frame = v.querySelector<HTMLIFrameElement>('[data-role="viewer-frame"]');
            setTimeout(() => frame?.contentWindow?.postMessage('kageops:resize', '*'), 220);
        };
        expandBtn?.addEventListener('click', toggleExpand);

        // Escape collapses an expanded viewer (so the user can never
        // get "stuck" if the bar buttons happen to be under the window
        // chrome on a smaller screen).
        window.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && v.classList.contains('cg-viewer--expanded')) {
                toggleExpand();
            }
        });

        v.querySelector('[data-role="side-close"]')?.addEventListener('click', () => {
            closeSidePane(v);
        });
    }
    return {
        viewer,
        iframe: viewer.querySelector<HTMLIFrameElement>('[data-role="viewer-frame"]')!,
        titleEl: viewer.querySelector<HTMLElement>('[data-role="viewer-title"]')!,
        sideEl: viewer.querySelector<HTMLElement>('[data-role="viewer-side"]')!,
    };
}

function closeSidePane(viewer: HTMLElement): void {
    const side = viewer.querySelector<HTMLElement>('[data-role="viewer-side"]');
    side?.classList.add('cg-viewer-side--hidden');
    const frame = viewer.querySelector<HTMLIFrameElement>('[data-role="viewer-frame"]');
    setTimeout(() => frame?.contentWindow?.postMessage('kageops:resize', '*'), 220);
}

// Cleanup for the active resize forwarder — one graph open at a time.
let _resizeCleanup: (() => void) | null = null;
let _messageCleanup: (() => void) | null = null;

/** Read-file callback the panel uses to fetch source for a clicked node.
 *  Returns the file content (utf-8) or null when the file can't be read
 *  (out-of-scope path, missing file, IPC error). */
export type ReadFileCallback = (
    projectId: string,
    relPath: string,
) => Promise<{ ok: boolean; content: string | null; error?: string }>;

export function showGraphInViewer(
    container: HTMLElement,
    htmlPath: string,
    projectName: string,
    htmlContent: string,
    projectId?: string,
    readFile?: ReadFileCallback,
): void {
    const { viewer, iframe, titleEl, sideEl } = getOrCreateViewer(container);
    titleEl.textContent = projectName;
    closeSidePane(viewer);

    // If the main process pre-fetched the content and it's missing/empty, render
    // an inline error instead of pointing the iframe at a dead file:// URL —
    // the latter shows a black panel with no actionable hint. Empty content
    // (read failed / file not found) gets the same treatment as too-small
    // content; without this an unbuilt graph.html silently produces a black
    // viewer.
    //
    // v0.1.33: the main process now renders a fallback graph.html from
    // graph.json after every build, so this path should be rare. When we
    // *do* end up here it usually means graph.json itself is missing —
    // graphify didn't run, or the project has no code files. Don't tell
    // the user to `pip install graphify[viz]`: graphify isn't on PyPI,
    // and the built-in viewer no longer needs it.
    if (htmlContent.length < 200) {
        iframe.srcdoc = `<!doctype html><html><body style="background:#141414;color:#d4d4d4;font-family:system-ui;padding:32px;line-height:1.6">
            <h2 style="color:#e06c75;margin-top:0">No graph data to display</h2>
            <p>KageOps could not find a renderable graph at:</p>
            <pre style="background:#1e1e1e;padding:12px;border-radius:4px;overflow:auto">${esc(htmlPath)}</pre>
            <p>Likely causes:</p>
            <ul style="color:#9d9d9d;padding-left:20px">
                <li>The build hasn't finished yet — wait for the badge to read <strong>Ready</strong>, then click <strong>View</strong> again.</li>
                <li>The graphify build produced no <code>graph.json</code> — check the build log on the card for ERROR / WARN lines.</li>
                <li>The project contains only static files (HTML/CSS/markdown) — graphify only graphs JS / TS / Python / Go / Rust source.</li>
            </ul>
            <p style="color:#6e6e6e;font-size:12px">Click <strong>Rebuild</strong> to try again.</p>
        </body></html>`;
        viewer.style.display = '';
        viewer.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }

    // KageOps theme is pre-injected into the HTML by the main process IPC handler.
    // Load as file:// so CDN scripts (vis-network) are not blocked by null-origin restrictions.
    const normalized = htmlPath.replace(/\\/g, '/');
    const fileUrl = /^[a-zA-Z]:/.test(normalized)
        ? `file:///${normalized}`
        : `file://${normalized}`;
    iframe.src = fileUrl;

    viewer.style.display = '';
    viewer.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Tear down any resize / message forwarders from a previously-opened graph.
    if (_resizeCleanup !== null) { _resizeCleanup(); _resizeCleanup = null; }
    if (_messageCleanup !== null) { _messageCleanup(); _messageCleanup = null; }

    iframe.addEventListener('load', () => {
        // postMessage is cross-origin safe; the injected script in the frame handles it.
        setTimeout(() => iframe.contentWindow?.postMessage('kageops:resize', '*'), 120);
        const onResize = () => iframe.contentWindow?.postMessage('kageops:resize', '*');
        window.addEventListener('resize', onResize);
        _resizeCleanup = () => window.removeEventListener('resize', onResize);
    }, { once: true });

    // v0.1.34 — wire the click-to-show-source side pane. Only active when
    // the caller passed both a projectId and a readFile callback (i.e.
    // a real project with an IPC bridge — tests can skip both).
    if (projectId !== undefined && projectId !== '' && readFile !== undefined) {
        const handler = (ev: MessageEvent): void => {
            const data = ev.data as { type?: string; node?: { id?: string; label?: string; file?: string | null; kind?: string | null } };
            if (data === null || typeof data !== 'object') return;
            if (data.type === 'kageops:node-deselect') {
                closeSidePane(viewer);
                return;
            }
            if (data.type !== 'kageops:node-click' || data.node === undefined) return;
            void showNodeSource(sideEl, viewer, projectId, data.node, readFile);
        };
        window.addEventListener('message', handler);
        _messageCleanup = () => window.removeEventListener('message', handler);
    }
}

/** Open the side pane and render the source file for the clicked node.
 *  Falls back to a friendly message when the file path can't be derived
 *  or the file is out-of-scope / unreadable. */
async function showNodeSource(
    sideEl: HTMLElement,
    viewer: HTMLElement,
    projectId: string,
    node: { id?: string; label?: string; file?: string | null; kind?: string | null },
    readFile: ReadFileCallback,
): Promise<void> {
    const titleEl   = sideEl.querySelector<HTMLElement>('[data-role="side-title"]');
    const metaEl    = sideEl.querySelector<HTMLElement>('[data-role="side-meta"]');
    const contentEl = sideEl.querySelector<HTMLElement>('[data-role="side-content"]');
    if (titleEl === null || metaEl === null || contentEl === null) return;

    sideEl.classList.remove('cg-viewer-side--hidden');
    // Tell the iframe its viewport just shrunk so vis-network re-fits.
    const frame = viewer.querySelector<HTMLIFrameElement>('[data-role="viewer-frame"]');
    setTimeout(() => frame?.contentWindow?.postMessage('kageops:resize', '*'), 220);

    const label = node.label ?? node.id ?? 'symbol';
    const file  = node.file ?? null;
    const kind  = node.kind ?? null;

    titleEl.textContent = label;
    metaEl.innerHTML = `
        ${file !== null ? `<span class="cg-side-chip">${esc(file)}</span>` : '<span class="cg-side-chip cg-side-chip--muted">file unknown</span>'}
        ${kind !== null ? `<span class="cg-side-chip">${esc(kind)}</span>` : ''}
        <span class="cg-side-chip cg-side-chip--muted" title="${esc(node.id ?? '')}">id</span>`;

    if (file === null) {
        contentEl.textContent = 'This node has no associated source file in the graph metadata. The graphify build may not have recorded a path for it (common for inferred or external symbols).';
        return;
    }

    contentEl.textContent = 'Loading source…';

    try {
        const res = await readFile(projectId, file);
        if (!res.ok || res.content === null) {
            contentEl.textContent = `Could not read ${file}\n\n${res.error ?? 'File not found or out of scope.'}`;
            return;
        }
        contentEl.textContent = res.content;
        // Best-effort: scroll to the line that mentions the symbol (label)
        // so the user lands near the right code. Skip when label === file
        // (file-level node) or the label is too generic to match cleanly.
        if (label !== file && /^[A-Za-z_][A-Za-z0-9_]{1,}$/.test(label.replace(/\(\)$/, ''))) {
            scrollToSymbol(contentEl, label.replace(/\(\)$/, ''));
        }
    } catch (err) {
        contentEl.textContent = `Could not read ${file}\n\n${err instanceof Error ? err.message : String(err)}`;
    }
}

/** Find the first line containing the symbol name and scroll it into view.
 *  No syntax highlighting — this is a plain <pre> so a click on a graph
 *  node lands the source in front of the operator without a full editor. */
function scrollToSymbol(contentEl: HTMLElement, symbol: string): void {
    const text = contentEl.textContent ?? '';
    const lines = text.split('\n');
    const idx = lines.findIndex((line) => new RegExp(`\\b${escapeRegex(symbol)}\\b`).test(line));
    if (idx < 0) return;
    // Each line is roughly 18px tall; approximate the scrollTop.
    contentEl.scrollTop = Math.max(0, idx * 18 - 100);
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Full Render ───────────────────────────────────────

export function renderCodeGraphPanel(
    container: HTMLElement,
    projects: readonly GraphifyProjectEntry[],
    buildState: ReadonlyMap<string, GraphifyBuildState>,
    callbacks: CodeGraphCallbacks
): void {
    // v0.1.35 — DETACH the viewer node before clearing the container,
    // then re-attach the SAME node after re-rendering the list. Previously
    // we did container.innerHTML = `${listHtml} ${viewer.outerHTML}` which
    // rebuilt the viewer from a string and silently dropped every event
    // listener attached to its buttons (expand, side-close, etc). The
    // iframe contents (loaded graph) also got nuked on every re-render.
    const existingViewer = container.querySelector<HTMLElement>('.cg-viewer');
    if (existingViewer !== null) container.removeChild(existingViewer);

    if (projects.length === 0) {
        container.innerHTML = `
            <div class="panel-empty">
                <p>No projects with a repository path found.</p>
                <p class="hint">Run a project to completion — once KageOps writes files to a repo, you can build a code graph here.</p>
            </div>`;
        // If the viewer was open over an empty state (unlikely but possible), keep it.
        if (existingViewer !== null) container.appendChild(existingViewer);
        return;
    }

    container.innerHTML = `
        <div class="cg-list">
            ${projects.map((p) => renderCard(p, buildState)).join('')}
        </div>`;

    wireCardButtons(container, callbacks);

    // Re-attach the preserved viewer node — listeners + iframe contents intact.
    if (existingViewer !== null) container.appendChild(existingViewer);
}

// ── Incremental Progress Update ───────────────────────

export function updateGraphifyBuildProgress(
    container: HTMLElement,
    event: GraphifyProgressEvent,
    callbacks: CodeGraphCallbacks
): void {
    const card = container.querySelector<HTMLElement>(
        `.cg-card[data-project-id="${CSS.escape(event.projectId)}"]`
    );
    if (card === null) return;

    const logEl = card.querySelector<HTMLElement>('[data-role="log"]');
    if (logEl !== null) {
        logEl.style.display = '';
        logEl.textContent = (logEl.textContent ?? '') + event.line + '\n';
        logEl.scrollTop = logEl.scrollHeight;
    }

    const badge = card.querySelector<HTMLElement>('[data-role="badge"]');

    if (!event.done) {
        if (badge !== null) { badge.className = 'cg-badge cg-badge--building'; badge.textContent = 'Building…'; }
        const buildBtn = card.querySelector<HTMLButtonElement>('[data-role="build-btn"]');
        if (buildBtn !== null) buildBtn.disabled = true;
        return;
    }

    const buildBtn = card.querySelector<HTMLButtonElement>('[data-role="build-btn"]');
    if (buildBtn !== null) {
        buildBtn.disabled = false;
        buildBtn.innerHTML = `${icon('graph', { size: 11 })} Rebuild`;
    }

    if (event.error !== null) {
        if (badge !== null) { badge.className = 'cg-badge cg-badge--error'; badge.textContent = 'Error'; }
        return;
    }

    if (badge !== null) { badge.className = 'cg-badge cg-badge--ready'; badge.textContent = 'Ready'; }

    const metaEl = card.querySelector<HTMLElement>('[data-role="meta"]');
    if (metaEl !== null && event.nodeCount !== undefined) {
        metaEl.textContent = `${event.nodeCount.toLocaleString()} nodes · ${(event.edgeCount ?? 0).toLocaleString()} edges · just now`;
    }

    // Insert / update Open button
    const cardRight = card.querySelector<HTMLElement>('.cg-card-btns');
    if (cardRight !== null) {
        let openBtn = card.querySelector<HTMLButtonElement>('[data-role="open-btn"]');
        if (openBtn === null) {
            openBtn = document.createElement('button');
            openBtn.className = 'cg-btn cg-btn-open';
            openBtn.dataset['role'] = 'open-btn';
            cardRight.appendChild(openBtn);
        }
        const repoPath = buildBtn?.dataset['repoPath'] ?? '';
        const htmlPath = repoPath !== '' ? repoPath + '/graphify-out/graph.html' : '';
        openBtn.dataset['htmlPath'] = htmlPath;
        openBtn.innerHTML = `${icon('graph', { size: 11 })} View`;
        const fresh = openBtn.cloneNode(true) as HTMLButtonElement;
        openBtn.replaceWith(fresh);
        fresh.addEventListener('click', () => {
            const p = fresh.dataset['htmlPath'] ?? '';
            if (p !== '') callbacks.onOpen(p);
        });
    }
}
