/**
 * KageOps Command Center — Network Resilience Toast (Track D)
 *
 * Non-blocking, bottom-right informational toasts that surface
 * `network.transient` retry attempts and a "Back online" message
 * once the EventBus reconnects or the retry stream goes quiet for
 * BACK_ONLINE_SILENCE_MS.
 *
 * Pure module — no external state besides the host container.
 * Stylesheet rules live in shell.css. Tokens only.
 */

// ── Public types ────────────────────────────────────────

export interface NetworkTransientPayload {
    readonly kind: 'transient';
    readonly data: {
        readonly attempt: number;
        readonly maxAttempts: number;
        readonly delayMs: number;
        readonly error?: string;
    };
    readonly timestamp?: string;
}

export interface NetworkReconnectedPayload {
    readonly kind: 'reconnected';
    readonly data?: Record<string, unknown>;
    readonly timestamp?: string;
}

export type NetworkEventPayload =
    | NetworkTransientPayload
    | NetworkReconnectedPayload;

export interface NetworkToastOptions {
    /** Container to mount the toast stack into. Defaults to document.body. */
    readonly container?: HTMLElement;
    /** Silence window (ms) before emitting an implicit "Back online". */
    readonly backOnlineSilenceMs?: number;
    /** Max toasts kept visible — oldest is evicted past this. */
    readonly maxStack?: number;
}

export interface NetworkToastHandle {
    /** Feed one event into the stack. Returns the added toast element or null. */
    push(event: NetworkEventPayload): HTMLElement | null;
    /** Remove all toasts and clear pending timers. */
    clear(): void;
    /** The DOM stack container (for tests). */
    readonly element: HTMLElement;
}

// ── Constants ───────────────────────────────────────────

const DEFAULT_MAX_STACK = 3;
const DEFAULT_BACK_ONLINE_SILENCE_MS = 15_000;
/** Time a back-online toast lingers before auto-dismiss. */
const BACK_ONLINE_AUTO_DISMISS_MS = 4_000;
/** Time a transient toast lingers if no follow-up arrives (safety net). */
const TRANSIENT_AUTO_DISMISS_MS = 60_000;

// ── Implementation ──────────────────────────────────────

export function initNetworkToast(opts: NetworkToastOptions = {}): NetworkToastHandle {
    const container = opts.container ?? document.body;
    const maxStack = opts.maxStack ?? DEFAULT_MAX_STACK;
    const silenceMs = opts.backOnlineSilenceMs ?? DEFAULT_BACK_ONLINE_SILENCE_MS;

    const stack = document.createElement('div');
    stack.className = 'network-toast__stack';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    stack.setAttribute('aria-atomic', 'false');
    container.appendChild(stack);

    // Track pending timers so clear() + consecutive events don't leak.
    const pending: Set<ReturnType<typeof setTimeout>> = new Set();
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let sawTransient = false;

    function scheduleDismiss(el: HTMLElement, ms: number): void {
        const id = setTimeout(() => {
            dismiss(el);
            pending.delete(id);
        }, ms);
        pending.add(id);
    }

    function dismiss(el: HTMLElement): void {
        if (el.parentElement === null) return;
        el.classList.add('network-toast--leaving');
        const remove = setTimeout(() => {
            if (el.parentElement !== null) el.parentElement.removeChild(el);
            pending.delete(remove);
        }, 160);
        pending.add(remove);
    }

    function enforceStackCap(): void {
        while (stack.children.length > maxStack) {
            const first = stack.firstChild;
            if (first === null) break;
            stack.removeChild(first);
        }
    }

    function resetSilenceTimer(): void {
        if (silenceTimer !== null) {
            clearTimeout(silenceTimer);
            pending.delete(silenceTimer);
            silenceTimer = null;
        }
    }

    function scheduleBackOnline(): void {
        resetSilenceTimer();
        const id = setTimeout(() => {
            if (sawTransient) {
                push({
                    kind: 'reconnected',
                    data: { reason: 'silence' },
                });
            }
            silenceTimer = null;
            pending.delete(id);
        }, silenceMs);
        silenceTimer = id;
        pending.add(id);
    }

    function push(event: NetworkEventPayload): HTMLElement | null {
        if (event.kind === 'transient') {
            sawTransient = true;
            const el = renderTransient(event);
            stack.appendChild(el);
            enforceStackCap();
            wireDismiss(el);
            scheduleDismiss(el, TRANSIENT_AUTO_DISMISS_MS);
            scheduleBackOnline();
            return el;
        }

        if (event.kind === 'reconnected') {
            resetSilenceTimer();
            // Only surface "Back online" if we actually showed a transient.
            if (!sawTransient) return null;
            sawTransient = false;
            const el = renderReconnected();
            stack.appendChild(el);
            enforceStackCap();
            wireDismiss(el);
            scheduleDismiss(el, BACK_ONLINE_AUTO_DISMISS_MS);
            return el;
        }

        return null;
    }

    function wireDismiss(el: HTMLElement): void {
        el.addEventListener('click', () => dismiss(el));
    }

    function clear(): void {
        pending.forEach((id) => clearTimeout(id));
        pending.clear();
        silenceTimer = null;
        sawTransient = false;
        while (stack.firstChild !== null) {
            stack.removeChild(stack.firstChild);
        }
    }

    return {
        push,
        clear,
        element: stack,
    };
}

// ── Renderers ───────────────────────────────────────────

function renderTransient(event: NetworkTransientPayload): HTMLElement {
    const el = document.createElement('div');
    el.className = 'network-toast network-toast--transient';
    el.dataset['kind'] = 'transient';

    const { attempt, maxAttempts, delayMs } = event.data;
    const seconds = Math.max(1, Math.round(delayMs / 1000));

    el.innerHTML = [
        '<div class="network-toast__icon" aria-hidden="true">',
        // inline dot; full SVG icon set lives in shared/icons.ts but
        // this keeps the toast self-contained and CSP-safe.
        '<span class="network-toast__pulse"></span>',
        '</div>',
        '<div class="network-toast__body">',
        `<div class="network-toast__title">Network hiccup</div>`,
        `<div class="network-toast__detail">Retrying attempt ${attempt}/${maxAttempts} in ${seconds}s</div>`,
        '</div>',
    ].join('');
    return el;
}

function renderReconnected(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'network-toast network-toast--reconnected';
    el.dataset['kind'] = 'reconnected';

    el.innerHTML = [
        '<div class="network-toast__icon" aria-hidden="true">',
        '<span class="network-toast__check"></span>',
        '</div>',
        '<div class="network-toast__body">',
        '<div class="network-toast__title">Back online</div>',
        '</div>',
    ].join('');
    return el;
}
