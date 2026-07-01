/**
 * KageOps — Agent Logs Panel (B-510)
 *
 * All-project agent subprocess output stream. Subscribes to every project's
 * build-verification, template-cloner, github-push, and claude-cli output
 * without a projectId filter. Each line is prefixed with [agent] or [id].
 *
 * Reuses the pure helpers from agent-terminal-panel (ANSI parser, line splitter,
 * scrollback limiter, chunk validator) so there is no duplicated logic.
 */

import {
    parseAnsiToHtml,
    splitChunkIntoLines,
    appendLines,
    parseChunkEvent,
    SCROLLBACK_LIMIT,
    type AgentTerminalLine,
} from './agent-terminal-panel';

declare const kageOps: {
    subscribeAllAgentOutput(callback: (event: unknown) => void): () => void;
};

const AUTOSCROLL_THRESHOLD_PX = 12;

export function initAgentLogsPanel(host: HTMLElement): () => void {
    host.innerHTML = '';

    const root = document.createElement('div');
    root.className = 'agent-terminal';

    // ── Header ────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'agent-terminal__header';

    const title = document.createElement('span');
    title.className = 'agent-terminal__title';
    title.textContent = 'Agent Logs';

    const liveChip = document.createElement('span');
    liveChip.className = 'agent-terminal__status agent-logs__live';
    liveChip.textContent = '● live · all projects';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'ishell-btn ishell-btn--clear';
    clearBtn.textContent = 'Clear';

    header.appendChild(title);
    header.appendChild(liveChip);
    header.appendChild(clearBtn);

    // ── Viewport ─────────────────────────────────────
    const viewport = document.createElement('div');
    viewport.className = 'agent-terminal__viewport';
    viewport.setAttribute('role', 'log');
    viewport.setAttribute('aria-live', 'polite');
    viewport.tabIndex = 0;

    const idleSplash = document.createElement('div');
    idleSplash.className = 'ishell-idle';
    idleSplash.innerHTML = `
        <svg class="ishell-idle-svg" viewBox="0 0 100 100" fill="none" aria-hidden="true">
            <path class="ko-stroke-anim" d="M20 30 L48 30" pathLength="100"/>
            <path class="ko-stroke-anim" d="M20 46 L60 46" pathLength="100"/>
            <path class="ko-stroke-anim" d="M20 62 L52 62" pathLength="100"/>
            <path class="ko-stroke-anim" d="M20 78 L72 78" pathLength="100"/>
            <path class="ko-stroke-anim ko-stroke-anim--accent" d="M76 22 L76 84" pathLength="100"/>
        </svg>
        <div class="ko-idle-phrases">
            <em class="ko-phrase" style="animation-delay:0s">Waiting for agent output…</em>
            <em class="ko-phrase" style="animation-delay:4s">Streams from all active projects.</em>
            <em class="ko-phrase" style="animation-delay:8s">npm, git, claude-cli — everything lands here.</em>
            <em class="ko-phrase" style="animation-delay:12s">Start a mission to see it live.</em>
        </div>`;
    viewport.appendChild(idleSplash);
    let idleVisible = true;

    root.appendChild(header);
    root.appendChild(viewport);
    host.appendChild(root);

    // ── State ─────────────────────────────────────────
    let buffer: readonly AgentTerminalLine[] = [];
    // Per-project partial-line buffers, keyed by projectId
    const pendingByProject = new Map<string, { stdout: string; stderr: string }>();

    // ── Helpers ───────────────────────────────────────
    function isPinnedToBottom(): boolean {
        return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= AUTOSCROLL_THRESHOLD_PX;
    }

    function appendLineToView(line: AgentTerminalLine, label: string): void {
        if (idleVisible) {
            idleSplash.hidden = true;
            idleVisible = false;
        }

        const wasPinned = isPinnedToBottom();
        buffer = appendLines(buffer, [line]);

        const div = document.createElement('div');
        div.className = `agent-terminal__line agent-terminal__line--${line.stream}`;

        const labelEl = document.createElement('span');
        labelEl.className = 'agent-logs__label';
        labelEl.textContent = label + ' ';
        div.appendChild(labelEl);

        const textEl = document.createElement('span');
        textEl.innerHTML = parseAnsiToHtml(line.text);
        div.appendChild(textEl);

        viewport.appendChild(div);

        // Keep DOM in sync with scrollback cap
        while (viewport.children.length > SCROLLBACK_LIMIT) {
            viewport.firstChild?.remove();
        }

        if (wasPinned) viewport.scrollTop = viewport.scrollHeight;
    }

    function handleEvent(event: unknown): void {
        const parsed = parseChunkEvent(event);
        if (parsed === null) return;

        const { projectId } = parsed;
        if (!pendingByProject.has(projectId)) {
            pendingByProject.set(projectId, { stdout: '', stderr: '' });
        }
        const pending = pendingByProject.get(projectId)!;

        const prev = parsed.data.stream === 'stdout' ? pending.stdout : pending.stderr;
        const split = splitChunkIntoLines(prev, parsed.data.chunk);
        if (parsed.data.stream === 'stdout') pending.stdout = split.pending;
        else pending.stderr = split.pending;

        if (split.lines.length === 0) return;

        // Prefer agent name; fall back to short project id
        const label = parsed.agent !== undefined && parsed.agent !== ''
            ? `[${parsed.agent}]`
            : `[${projectId.slice(0, 8)}]`;

        for (const text of split.lines) {
            appendLineToView(
                { source: parsed.data.source, stream: parsed.data.stream, text, ts: parsed.data.ts },
                label,
            );
        }
    }

    clearBtn.addEventListener('click', () => {
        viewport.innerHTML = '';
        viewport.appendChild(idleSplash);
        idleSplash.hidden = false;
        idleVisible = true;
        buffer = [];
        pendingByProject.clear();
    });

    const unsub = kageOps.subscribeAllAgentOutput(handleEvent);
    return unsub;
}
