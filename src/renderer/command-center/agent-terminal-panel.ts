/**
 * KageOps Command Center — Agent Terminal Panel (B-497)
 *
 * Read-only IDE-style integrated terminal that tails stdout/stderr from
 * orchestrator subprocess invocations (npm install/build/test, git, gh,
 * Claude CLI). No PTY, no node-pty, no xterm.js — pure log stream
 * rendered into a bounded scrollback buffer.
 *
 * Public surface:
 *   - `initAgentTerminalPanel(host, deps)` — DOM setup + IPC subscribe.
 *   - Pure helpers (`appendLines`, `parseAnsiToHtml`, `escapeHtml`) are
 *     exported for unit tests so the buffer + escape parsing can be
 *     exercised without a DOM.
 *
 * Out of scope (per ticket): clear-button, search, copy-as-block (browser
 * selection covers the last one for free).
 */

// ── Public types ────────────────────────────────────────

export interface SubprocessChunk {
    readonly projectId: string;
    readonly taskId?: string;
    readonly agent?: string;
    readonly data: {
        readonly source: 'build-verification' | 'template-cloner' | 'github-push' | 'claude-cli';
        readonly stream: 'stdout' | 'stderr';
        readonly chunk: string;
        readonly ts: number;
    };
    readonly timestamp?: string;
}

export interface AgentTerminalLine {
    readonly source: SubprocessChunk['data']['source'];
    readonly stream: SubprocessChunk['data']['stream'];
    readonly text: string;
    readonly ts: number;
}

export interface AgentTerminalDeps {
    readonly subscribe: (
        projectId: string,
        callback: (event: unknown) => void,
    ) => () => void;
    /** Returns the currently-selected projectId, or null if none. */
    readonly getSelectedProjectId: () => string | null;
    /**
     * Optional event source the panel can subscribe to so it re-mounts
     * the IPC subscription whenever the user changes project. If absent
     * the caller is responsible for invoking `handle.setProject(...)`.
     */
    readonly onProjectChange?: (callback: (projectId: string | null) => void) => () => void;
}

export interface AgentTerminalHandle {
    readonly element: HTMLElement;
    setProject(projectId: string | null): void;
    dispose(): void;
}

// ── Constants ───────────────────────────────────────────

/** Ticket: cap scrollback at 10 000 lines per project. */
export const SCROLLBACK_LIMIT = 10_000;

/**
 * Distance in CSS pixels from the bottom within which we consider the
 * user "still pinned" to the tail. Above that we preserve their scroll
 * position when new lines arrive so they can read history without the
 * viewport jumping.
 */
const AUTOSCROLL_THRESHOLD_PX = 12;

// ── Pure helpers (DOM-free, exported for tests) ─────────

/** HTML-escape a raw string. Safe for `innerHTML` insertion. */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Split an incoming chunk into lines. Carriage-return-only sequences
 * (common in npm progress bars) collapse into a single line so the
 * scrollback isn't polluted with redraws.
 *
 * Trailing partial lines (no `\n`) are returned in `pending`. Callers
 * are expected to prepend `pending` to the next chunk before splitting.
 */
export function splitChunkIntoLines(
    pending: string,
    chunk: string,
): { readonly lines: readonly string[]; readonly pending: string } {
    const combined = pending + chunk;
    // Normalize CRLF → LF and drop bare CR (used for in-place rewrites).
    const normalized = combined.replace(/\r\n/g, '\n').replace(/\r(?!\n)/g, '');
    const parts = normalized.split('\n');
    const last = parts.pop() ?? '';
    return { lines: parts, pending: last };
}

/**
 * Append new lines to the buffer, dropping oldest entries if we exceed
 * `SCROLLBACK_LIMIT`. Returns a NEW array — buffer is treated as immutable.
 */
export function appendLines(
    buffer: readonly AgentTerminalLine[],
    incoming: readonly AgentTerminalLine[],
    limit: number = SCROLLBACK_LIMIT,
): readonly AgentTerminalLine[] {
    if (incoming.length === 0) return buffer;
    const next = [...buffer, ...incoming];
    if (next.length <= limit) return next;
    return next.slice(next.length - limit);
}

// ── ANSI → HTML ─────────────────────────────────────────

/**
 * Tiny ANSI escape-sequence parser. Handles SGR (Select Graphic
 * Rendition) codes for the 16 basic colours + reset/bold/underline.
 * Sufficient for the npm/git/gh tools we tail. Codes we don't recognise
 * are silently dropped — never echoed as raw bytes.
 *
 * Output is HTML-safe: every literal character goes through `escapeHtml`
 * before concatenation, and span attributes use a fixed allowlist of
 * class names.
 */
export function parseAnsiToHtml(input: string): string {
    if (input === '') return '';
    // eslint-disable-next-line no-control-regex
    const re = /\x1b\[([0-9;]*)m/g;

    let out = '';
    let lastIndex = 0;
    let openSpans = 0;

    const flushClose = (): void => {
        while (openSpans > 0) {
            out += '</span>';
            openSpans -= 1;
        }
    };

    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
        const literal = input.slice(lastIndex, match.index);
        if (literal !== '') out += escapeHtml(literal);

        const codes = match[1] === '' ? [0] : match[1]!.split(';').map((c) => Number(c) | 0);
        for (const code of codes) {
            if (code === 0) {
                // Reset: close every open span.
                flushClose();
                continue;
            }
            const cls = sgrToClass(code);
            if (cls !== null) {
                out += `<span class="${cls}">`;
                openSpans += 1;
            }
            // Unknown codes are dropped silently.
        }
        lastIndex = re.lastIndex;
    }

    const tail = input.slice(lastIndex);
    if (tail !== '') out += escapeHtml(tail);

    flushClose();
    return out;
}

function sgrToClass(code: number): string | null {
    if (code === 1) return 'ansi-bold';
    if (code === 4) return 'ansi-underline';
    if (code === 2) return 'ansi-dim';
    // Foreground colours
    if (code >= 30 && code <= 37) return `ansi-fg-${code - 30}`;
    if (code >= 90 && code <= 97) return `ansi-fg-${code - 90 + 8}`;
    // Background colours
    if (code >= 40 && code <= 47) return `ansi-bg-${code - 40}`;
    if (code >= 100 && code <= 107) return `ansi-bg-${code - 100 + 8}`;
    return null;
}

// ── DOM panel ───────────────────────────────────────────

/**
 * Initialize the Agent Terminal panel. Mounts a viewport into `host`,
 * subscribes to subprocess output for the currently-selected project,
 * and re-binds when the project changes.
 *
 * Idempotent: replaces `host`'s contents on each call.
 */
export function initAgentTerminalPanel(
    host: HTMLElement,
    deps: AgentTerminalDeps,
): AgentTerminalHandle {
    host.innerHTML = '';

    const root = document.createElement('div');
    root.className = 'agent-terminal';

    const header = document.createElement('div');
    header.className = 'agent-terminal__header';

    const title = document.createElement('span');
    title.className = 'agent-terminal__title';
    title.textContent = 'Agent Terminal';

    const status = document.createElement('span');
    status.className = 'agent-terminal__status';
    status.textContent = '— select a project —';

    header.appendChild(title);
    header.appendChild(status);

    const viewport = document.createElement('div');
    viewport.className = 'agent-terminal__viewport';
    viewport.setAttribute('role', 'log');
    viewport.setAttribute('aria-live', 'polite');
    viewport.tabIndex = 0;

    // Empty-state placeholder so the panel doesn't look broken when
    // no subprocess is running. Removed on first incoming line.
    const placeholder = document.createElement('div');
    placeholder.className = 'agent-terminal__placeholder';
    placeholder.innerHTML =
        '<div style="font-weight:600;margin-bottom:6px;color:var(--text-muted)">No subprocess output yet</div>' +
        '<div style="font-size:11px;line-height:1.6;color:var(--text-muted);max-width:520px">' +
        'This panel tails shell subprocesses spawned by agents — <code>npm install</code>, ' +
        '<code>git push</code>, <code>gh repo create</code>, and similar. Output appears here ' +
        'the moment an agent runs one of those commands.<br><br>' +
        'For Claude CLI prompts and AI responses, open <strong>Autonauts</strong> &rarr; click an ' +
        'agent &rarr; <strong>Live Intercept</strong>. For high-level events, see ' +
        '<strong>Mission Control</strong> &rarr; Agent Activity.' +
        '</div>';
    viewport.appendChild(placeholder);

    root.appendChild(header);
    root.appendChild(viewport);
    host.appendChild(root);

    let buffer: readonly AgentTerminalLine[] = [];
    let pendingStdout = '';
    let pendingStderr = '';
    let unsubscribe: (() => void) | null = null;
    let unsubscribeProjectChange: (() => void) | null = null;
    let activeProjectId: string | null = deps.getSelectedProjectId();

    function userIsPinnedToBottom(): boolean {
        const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        return distance <= AUTOSCROLL_THRESHOLD_PX;
    }

    function applyIncoming(incoming: readonly AgentTerminalLine[]): void {
        if (incoming.length === 0) return;
        // Drop placeholder once real output starts flowing.
        const ph = viewport.querySelector('.agent-terminal__placeholder');
        if (ph !== null) ph.remove();
        const wasPinned = userIsPinnedToBottom();
        const previousLength = buffer.length;
        buffer = appendLines(buffer, incoming);

        // If we dropped lines off the front, re-render from scratch to
        // keep the DOM in sync with the buffer. Otherwise just append.
        const dropped = previousLength + incoming.length - buffer.length;
        if (dropped > 0) {
            renderFull();
        } else {
            for (const line of incoming) {
                viewport.appendChild(buildLineNode(line));
            }
        }

        if (wasPinned) {
            viewport.scrollTop = viewport.scrollHeight;
        }
    }

    function renderFull(): void {
        viewport.innerHTML = '';
        for (const line of buffer) {
            viewport.appendChild(buildLineNode(line));
        }
    }

    function clearBuffer(): void {
        buffer = [];
        pendingStdout = '';
        pendingStderr = '';
        viewport.innerHTML = '';
    }

    function handleEvent(event: unknown): void {
        const parsed = parseChunkEvent(event);
        if (parsed === null) return;

        // Carry over partial line state per-stream so stdout & stderr
        // don't interleave their split state.
        const prev = parsed.data.stream === 'stdout' ? pendingStdout : pendingStderr;
        const split = splitChunkIntoLines(prev, parsed.data.chunk);
        if (parsed.data.stream === 'stdout') pendingStdout = split.pending;
        else pendingStderr = split.pending;

        if (split.lines.length === 0) return;

        const lines: AgentTerminalLine[] = split.lines.map((text) => ({
            source: parsed.data.source,
            stream: parsed.data.stream,
            text,
            ts: parsed.data.ts,
        }));
        applyIncoming(lines);
    }

    function bind(projectId: string | null): void {
        if (unsubscribe !== null) {
            unsubscribe();
            unsubscribe = null;
        }
        clearBuffer();
        activeProjectId = projectId;

        if (projectId === null || projectId === '') {
            status.textContent = '— no project selected —';
            return;
        }

        // Show a short id rather than the raw UUID — readable + still
        // unique enough to spot which run we're tailing.
        const short = projectId.slice(0, 8);
        status.textContent = `tailing ${short}\u2026 \u00b7 waiting for subprocess output`;
        try {
            unsubscribe = deps.subscribe(projectId, handleEvent);
        } catch (err) {
            console.error(
                '[AgentTerminal] subscribe failed:',
                err instanceof Error ? err.message : String(err),
            );
            status.textContent = 'subscribe failed';
        }
    }

    bind(activeProjectId);

    if (deps.onProjectChange !== undefined) {
        unsubscribeProjectChange = deps.onProjectChange((next) => {
            if (next === activeProjectId) return;
            bind(next);
        });
    }

    return {
        element: root,
        setProject: (projectId: string | null): void => {
            if (projectId === activeProjectId) return;
            bind(projectId);
        },
        dispose: (): void => {
            if (unsubscribe !== null) {
                unsubscribe();
                unsubscribe = null;
            }
            if (unsubscribeProjectChange !== null) {
                unsubscribeProjectChange();
                unsubscribeProjectChange = null;
            }
        },
    };
}

// ── Internals ───────────────────────────────────────────

function buildLineNode(line: AgentTerminalLine): HTMLElement {
    const div = document.createElement('div');
    div.className = `agent-terminal__line agent-terminal__line--${line.stream}`;
    div.dataset['source'] = line.source;
    // ANSI is a closed-grammar parser with HTML-escaped literals — safe to
    // assign via innerHTML.
    div.innerHTML = parseAnsiToHtml(line.text);
    return div;
}

/**
 * Validate an incoming IPC payload. Defensive — main may evolve the
 * shape; we want the panel to silently skip malformed events instead of
 * crashing. Exported for tests.
 */
export function parseChunkEvent(raw: unknown): SubprocessChunk | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const rec = raw as Record<string, unknown>;
    const projectId = rec['projectId'];
    const data = rec['data'];
    if (typeof projectId !== 'string' || projectId === '') return null;
    if (typeof data !== 'object' || data === null) return null;
    const drec = data as Record<string, unknown>;
    const source = drec['source'];
    const stream = drec['stream'];
    const chunk = drec['chunk'];
    const ts = drec['ts'];
    if (
        source !== 'build-verification' &&
        source !== 'template-cloner' &&
        source !== 'github-push' &&
        source !== 'claude-cli'
    ) return null;
    if (stream !== 'stdout' && stream !== 'stderr') return null;
    if (typeof chunk !== 'string') return null;
    if (typeof ts !== 'number') return null;

    const out: SubprocessChunk = {
        projectId,
        taskId: typeof rec['taskId'] === 'string' ? rec['taskId'] : undefined,
        agent: typeof rec['agent'] === 'string' ? rec['agent'] : undefined,
        data: { source, stream, chunk, ts },
        timestamp: typeof rec['timestamp'] === 'string' ? rec['timestamp'] : undefined,
    };
    return out;
}
