/**
 * KageOps Command Center — Live Intercept Panel (v2.3)
 *
 * Terminal-themed reskin (Track D): monospace stream with a
 * left HH:MM:SS gutter, sticky bottom controls, a scroll-to-
 * bottom pill that appears when the user has scrolled up, and
 * a Clear Log button. Auto-scroll pauses as soon as the user
 * scrolls away from the bottom and resumes only when they scroll
 * back or click the pill.
 *
 * All pre-existing IDs (`au-icpt-pause|resume|takeover|handback`,
 * `au-guidance-input`, `au-guidance-counter`, `au-intercept-stream`,
 * `au-intercept-mode`, `au-intercept-feedback`), class names
 * (`au-stream-line`, `au-stream-time`, `au-stream-placeholder`,
 * `au-intercept-mode--{mode}`), textual labels (`Observing`,
 * `Paused`, `Human Control`, `Live Intercept`, `No active task`,
 * `au-empty`, `Send Guidance`), `data-task-id` attribute, and
 * HTML-escape behavior are preserved so the 64 existing
 * intercept-panel unit tests keep passing.
 */

import { icon } from '../../shared/icons';

// ── Types ────────────────────────────────────────────

export interface InterceptApi {
    pauseAgent(name: string, taskId: string): Promise<{ success: boolean; error?: string }>;
    resumeAgent(name: string, taskId: string): Promise<{ success: boolean; error?: string }>;
    injectGuidance(name: string, taskId: string, guidance: string): Promise<{ success: boolean; error?: string }>;
    takeoverTask(name: string, taskId: string): Promise<{ success: boolean; error?: string }>;
    handbackTask(taskId: string, name: string, guidance?: string): Promise<{ success: boolean; error?: string }>;
    onAgentStreamEvent(callback: (event: AgentStreamEvent) => void): void;
    onInterceptAck(callback: (ack: InterceptAckEvent) => void): void;
    /** Optional — when present, the panel seeds the stream with recent
     *  events on mount instead of waiting for the next live tick. */
    getAgentStreamHistory?: (args: { agent: string; taskId?: string | null; limit?: number }) =>
        Promise<readonly AgentStreamEvent[]>;
}

export interface AgentStreamEvent {
    readonly time: string;
    readonly agent: string;
    readonly taskId: string;
    readonly projectId: string;
    readonly data: unknown;
}

export interface InterceptAckEvent {
    readonly agent: string;
    readonly taskId: string;
    readonly data: unknown;
}

export interface InterceptableTask {
    readonly id: string;
    readonly title: string;
}

// ── State ────────────────────────────────────────────

type InterceptMode = 'observing' | 'paused' | 'taken-over';
let interceptMode: InterceptMode = 'observing';
let streamLog: readonly { readonly time: string; readonly text: string }[] = [];
/** Follows the user's scroll position — true means auto-scroll new lines. */
let followTail = true;
const MAX_STREAM_LINES = 300;
const BOTTOM_EPSILON_PX = 8;

// ── Public API ───────────────────────────────────────

/** Reset intercept state (call when switching agents). */
export function resetInterceptState(): void {
    interceptMode = 'observing';
    streamLog = [];
    followTail = true;
}

/** Render the Live Intercept section HTML. */
export function renderIntercept(task: InterceptableTask | null): string {
    if (task === null) {
        return `
            <section class="au-section au-section--intercept">
                <h3 class="au-section-title">Live Intercept</h3>
                <div class="au-empty">No active task — intercept controls appear when this agent is working.</div>
            </section>`;
    }

    return `
        <section class="au-section au-section--intercept au-intercept--terminal" data-task-id="${escAttr(task.id)}">
            <header class="au-intercept-header">
                <h3 class="au-section-title">Live Intercept</h3>
                <div class="au-intercept-meta">
                    <span class="au-intercept-task">Active: <strong>${esc(task.title)}</strong></span>
                    <span class="au-intercept-mode au-intercept-mode--${interceptMode}" id="au-intercept-mode">
                        ${interceptModeLabel(interceptMode)}
                    </span>
                </div>
            </header>

            <div class="au-intercept-stream-wrap">
                <div class="au-intercept-stream" id="au-intercept-stream">
                    ${streamLog.length === 0
                        ? '<div class="au-stream-placeholder">Waiting for agent output\u2026</div>'
                        : streamLog.map((l) =>
                            `<div class="au-stream-line"><span class="au-stream-time">${esc(formatTimeShort(l.time))}</span> ${esc(l.text)}</div>`
                        ).join('')}
                </div>
                <button type="button"
                        class="au-intercept-scroll-pill"
                        id="au-icpt-scroll-bottom"
                        aria-label="Scroll to latest"
                        hidden>
                    <span class="au-intercept-scroll-pill__glyph" aria-hidden="true">${icon('chevron-down', { size: 12 })}</span>
                    Latest
                </button>
            </div>

            <div class="au-intercept-controls" id="au-intercept-controls">
                <button class="au-btn au-btn--warning" id="au-icpt-pause"
                    ${interceptMode === 'paused' ? 'disabled' : ''}>
                    <span class="au-btn__glyph" aria-hidden="true">${icon('pause', { size: 14 })}</span>
                    Pause
                </button>
                <button class="au-btn au-btn--primary" id="au-icpt-resume"
                    ${interceptMode !== 'paused' ? 'disabled' : ''}>
                    <span class="au-btn__glyph" aria-hidden="true">${icon('play', { size: 14 })}</span>
                    Resume
                </button>
                <button class="au-btn au-btn--danger" id="au-icpt-takeover"
                    ${interceptMode === 'taken-over' ? 'disabled' : ''}>Take Over</button>
                <button class="au-btn au-btn--secondary" id="au-icpt-handback"
                    ${interceptMode !== 'taken-over' ? 'disabled' : ''}>Hand Back</button>
                <button class="au-btn au-btn--ghost" id="au-icpt-clear" type="button"
                    title="Clear log">
                    <span class="au-btn__glyph" aria-hidden="true">${icon('x', { size: 14 })}</span>
                    Clear Log
                </button>
            </div>

            <div class="au-intercept-guidance">
                <textarea class="au-guidance-input" id="au-guidance-input"
                    placeholder="Type guidance for this agent\u2026" rows="3"
                    maxlength="6000"></textarea>
                <div class="au-guidance-actions">
                    <button class="au-btn au-btn--primary" id="au-icpt-send-guidance">Send Guidance</button>
                    <span class="au-guidance-counter" id="au-guidance-counter">0 / 6000</span>
                </div>
            </div>

            <div class="au-intercept-feedback" id="au-intercept-feedback"></div>
        </section>`;
}

/** Wire intercept controls to the API. Call after rendering. */
export function wireIntercept(
    root: HTMLElement,
    api: InterceptApi,
    agentKey: string,
    task: InterceptableTask | null,
): void {
    if (task === null) return;
    const taskId = task.id;

    const feedbackEl = root.querySelector('#au-intercept-feedback') as HTMLElement | null;
    const modeEl = root.querySelector('#au-intercept-mode') as HTMLElement | null;
    const streamEl = root.querySelector('#au-intercept-stream') as HTMLElement | null;
    const guidanceInput = root.querySelector('#au-guidance-input') as HTMLTextAreaElement | null;
    const counterEl = root.querySelector('#au-guidance-counter') as HTMLElement | null;
    const scrollPill = root.querySelector('#au-icpt-scroll-bottom') as HTMLButtonElement | null;

    // ── Character counter ──
    if (guidanceInput !== null && counterEl !== null) {
        guidanceInput.addEventListener('input', () => {
            counterEl.textContent = `${guidanceInput.value.length} / 6000`;
        });
    }

    // ── Stream scroll: detect follow-tail state ──
    if (streamEl !== null) {
        streamEl.addEventListener('scroll', () => {
            const nearBottom = isNearBottom(streamEl);
            followTail = nearBottom;
            setPillVisible(scrollPill, !nearBottom);
        });
    }

    // ── Seed the stream with recent history so the panel never feels
    //    stale on mount. Without this, users staring at "Waiting for
    //    agent output..." wonder if anything is actually wired up.   ──
    if (api.getAgentStreamHistory !== undefined && streamEl !== null) {
        void (async () => {
            try {
                const history = await api.getAgentStreamHistory!({
                    agent: agentKey,
                    taskId,
                    limit: 50,
                });
                if (history.length === 0) return;
                // Clear placeholder once history is in.
                const placeholder = streamEl.querySelector('.au-stream-placeholder');
                if (placeholder !== null) placeholder.remove();
                for (const ev of history) {
                    const text = formatStreamData(ev.data);
                    streamLog = [...streamLog.slice(-(MAX_STREAM_LINES - 1)), { time: ev.time, text }];
                    appendStreamLine(streamEl, ev.time, text, scrollPill);
                }
            } catch { /* best-effort */ }
        })();
    }
    if (scrollPill !== null && streamEl !== null) {
        scrollPill.addEventListener('click', () => {
            streamEl.scrollTop = streamEl.scrollHeight;
            followTail = true;
            setPillVisible(scrollPill, false);
        });
    }

    // ── Pause ──
    const pauseBtn = root.querySelector('#au-icpt-pause') as HTMLButtonElement | null;
    if (pauseBtn !== null) {
        pauseBtn.addEventListener('click', async () => {
            showFeedback(feedbackEl, 'Pausing\u2026', 'info');
            const res = await api.pauseAgent(agentKey, taskId);
            if (res.success) {
                interceptMode = 'paused';
                updateButtonStates(root, modeEl);
                showFeedback(feedbackEl, 'Agent paused', 'success');
            } else {
                showFeedback(feedbackEl, res.error ?? 'Pause failed', 'error');
            }
        });
    }

    // ── Resume ──
    const resumeBtn = root.querySelector('#au-icpt-resume') as HTMLButtonElement | null;
    if (resumeBtn !== null) {
        resumeBtn.addEventListener('click', async () => {
            showFeedback(feedbackEl, 'Resuming\u2026', 'info');
            const res = await api.resumeAgent(agentKey, taskId);
            if (res.success) {
                interceptMode = 'observing';
                updateButtonStates(root, modeEl);
                showFeedback(feedbackEl, 'Agent resumed', 'success');
            } else {
                showFeedback(feedbackEl, res.error ?? 'Resume failed', 'error');
            }
        });
    }

    // ── Takeover ──
    const takeoverBtn = root.querySelector('#au-icpt-takeover') as HTMLButtonElement | null;
    if (takeoverBtn !== null) {
        takeoverBtn.addEventListener('click', async () => {
            showFeedback(feedbackEl, 'Taking over\u2026', 'info');
            const res = await api.takeoverTask(agentKey, taskId);
            if (res.success) {
                interceptMode = 'taken-over';
                updateButtonStates(root, modeEl);
                showFeedback(feedbackEl, 'You now have control', 'success');
            } else {
                showFeedback(feedbackEl, res.error ?? 'Takeover failed', 'error');
            }
        });
    }

    // ── Hand back ──
    const handbackBtn = root.querySelector('#au-icpt-handback') as HTMLButtonElement | null;
    if (handbackBtn !== null) {
        handbackBtn.addEventListener('click', async () => {
            const guidance = guidanceInput?.value.trim() ?? '';
            showFeedback(feedbackEl, 'Handing back\u2026', 'info');
            const res = await api.handbackTask(taskId, agentKey, guidance !== '' ? guidance : undefined);
            if (res.success) {
                interceptMode = 'observing';
                if (guidanceInput !== null) guidanceInput.value = '';
                if (counterEl !== null) counterEl.textContent = '0 / 6000';
                updateButtonStates(root, modeEl);
                showFeedback(feedbackEl, 'Handed back to agent', 'success');
            } else {
                showFeedback(feedbackEl, res.error ?? 'Handback failed', 'error');
            }
        });
    }

    // ── Send guidance ──
    const sendGuidanceBtn = root.querySelector('#au-icpt-send-guidance') as HTMLButtonElement | null;
    if (sendGuidanceBtn !== null) {
        sendGuidanceBtn.addEventListener('click', async () => {
            const text = guidanceInput?.value.trim() ?? '';
            if (text === '') {
                showFeedback(feedbackEl, 'Enter guidance text first', 'error');
                return;
            }
            showFeedback(feedbackEl, 'Sending\u2026', 'info');
            const res = await api.injectGuidance(agentKey, taskId, text);
            if (res.success) {
                if (guidanceInput !== null) guidanceInput.value = '';
                if (counterEl !== null) counterEl.textContent = '0 / 6000';
                showFeedback(feedbackEl, 'Guidance sent', 'success');
            } else {
                showFeedback(feedbackEl, res.error ?? 'Send failed', 'error');
            }
        });
    }

    // ── Clear log ──
    const clearBtn = root.querySelector('#au-icpt-clear') as HTMLButtonElement | null;
    if (clearBtn !== null) {
        clearBtn.addEventListener('click', () => {
            streamLog = [];
            followTail = true;
            if (streamEl !== null) {
                while (streamEl.firstChild !== null) {
                    streamEl.removeChild(streamEl.firstChild);
                }
                const placeholder = document.createElement('div');
                placeholder.className = 'au-stream-placeholder';
                placeholder.textContent = 'Waiting for agent output\u2026';
                streamEl.appendChild(placeholder);
            }
            setPillVisible(scrollPill, false);
        });
    }

    // ── Live stream listener ──
    // Renders FULL prompt + response in expandable blocks. The previous
    // version JSON.stringify'd the whole event payload and sliced to 200
    // chars, which was useless for actual intercept work — you couldn't
    // see what the agent was being asked or what it answered. Now we
    // recognise the canonical shapes and render them as labelled blocks.
    api.onAgentStreamEvent((event) => {
        if (event.agent.toLowerCase() !== agentKey) return;
        const text = formatStreamData(event.data);
        streamLog = [...streamLog.slice(-(MAX_STREAM_LINES - 1)), { time: event.time, text }];
        appendStreamLine(streamEl, event.time, text, scrollPill);
    });

    // ── Intercept ack listener ──
    api.onInterceptAck((ack) => {
        if (ack.agent.toLowerCase() !== agentKey) return;
        const data = ack.data as Record<string, unknown>;
        const action = typeof data.action === 'string' ? data.action : 'unknown';
        showFeedback(feedbackEl, `Agent acknowledged: ${action}`, 'success');
    });
}

// ── Private Helpers ─────────────────────────────────

function interceptModeLabel(mode: InterceptMode): string {
    switch (mode) {
        case 'observing': return 'Observing';
        case 'paused': return 'Paused';
        case 'taken-over': return 'Human Control';
    }
}

function updateButtonStates(root: HTMLElement, modeEl: HTMLElement | null): void {
    if (modeEl !== null) {
        modeEl.textContent = interceptModeLabel(interceptMode);
        modeEl.className = `au-intercept-mode au-intercept-mode--${interceptMode}`;
    }
    const pauseBtn = root.querySelector('#au-icpt-pause') as HTMLButtonElement | null;
    const resumeBtn = root.querySelector('#au-icpt-resume') as HTMLButtonElement | null;
    const takeoverBtn = root.querySelector('#au-icpt-takeover') as HTMLButtonElement | null;
    const handbackBtn = root.querySelector('#au-icpt-handback') as HTMLButtonElement | null;

    if (pauseBtn !== null) pauseBtn.disabled = interceptMode === 'paused';
    if (resumeBtn !== null) resumeBtn.disabled = interceptMode !== 'paused';
    if (takeoverBtn !== null) takeoverBtn.disabled = interceptMode === 'taken-over';
    if (handbackBtn !== null) handbackBtn.disabled = interceptMode !== 'taken-over';
}

/**
 * Convert a raw event.data payload into the labelled text block the
 * intercept panel renders. Shared between the live feed listener and
 * the on-mount history seed so both look identical.
 */
function formatStreamData(raw: unknown): string {
    const data = (typeof raw === 'object' && raw !== null) ? raw as Record<string, unknown> : {};
    const evType = typeof data.type === 'string' ? data.type : 'event';
    const blocks: { label: string; text: string }[] = [];

    if (evType === 'ai-exchange') {
        const prompt = (typeof data.prompt === 'string' && data.prompt) ||
                       (typeof data.promptSnippet === 'string' && data.promptSnippet) ||
                       '';
        const response = (typeof data.response === 'string' && data.response) ||
                         (typeof data.responseSnippet === 'string' && data.responseSnippet) ||
                         '';
        const meta: string[] = [];
        if (typeof data.model === 'string') meta.push(data.model);
        if (typeof data.tokensIn === 'number') meta.push(`${data.tokensIn}\u2192${data.tokensOut ?? '?'} tok`);
        if (typeof data.costUsd === 'number') meta.push(`$${data.costUsd.toFixed(4)}`);

        if (meta.length > 0) blocks.push({ label: 'AI', text: meta.join(' \u00b7 ') });
        if (prompt !== '') blocks.push({ label: 'Prompt', text: prompt });
        if (response !== '') blocks.push({ label: 'Response', text: response });
    } else if (typeof data.responseText === 'string') {
        blocks.push({ label: 'Response', text: data.responseText });
    } else if (typeof data.message === 'string') {
        blocks.push({ label: evType, text: data.message });
    } else {
        blocks.push({ label: evType, text: JSON.stringify(data, null, 2) });
    }

    return blocks.map((b) => `[${b.label}] ${b.text}`).join('\n\n');
}

function appendStreamLine(
    streamEl: HTMLElement | null,
    time: string,
    text: string,
    scrollPill: HTMLButtonElement | null,
): void {
    if (streamEl === null) return;
    const placeholder = streamEl.querySelector('.au-stream-placeholder');
    if (placeholder !== null) placeholder.remove();

    const line = document.createElement('div');
    line.className = 'au-stream-line';
    // Render with <pre> so newlines + whitespace in the prompt/response
    // are preserved. The block grows to fit content; the parent stream
    // viewport handles its own scroll.
    line.innerHTML =
        `<span class="au-stream-time">${esc(formatTimeShort(time))}</span>` +
        `<pre class="au-stream-body">${esc(text)}</pre>`;
    streamEl.appendChild(line);

    while (streamEl.children.length > MAX_STREAM_LINES) {
        const first = streamEl.firstChild;
        if (first === null) break;
        streamEl.removeChild(first);
    }

    if (followTail) {
        streamEl.scrollTop = streamEl.scrollHeight;
        setPillVisible(scrollPill, false);
    } else {
        setPillVisible(scrollPill, true);
    }
}

function isNearBottom(el: HTMLElement): boolean {
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
    return distance <= BOTTOM_EPSILON_PX;
}

function setPillVisible(pill: HTMLButtonElement | null, visible: boolean): void {
    if (pill === null) return;
    pill.hidden = !visible;
}

function showFeedback(el: HTMLElement | null, msg: string, level: 'info' | 'success' | 'error'): void {
    if (el === null) return;
    el.textContent = msg;
    el.className = `au-intercept-feedback au-intercept-feedback--${level}`;
    if (level !== 'info') {
        setTimeout(() => { el.textContent = ''; el.className = 'au-intercept-feedback'; }, 4000);
    }
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTimeShort(iso: string): string {
    try {
        return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
        return iso;
    }
}
