/**
 * KageOps — Network Toast (Track D) unit tests
 *
 * No jsdom. We provide a narrow DOM stand-in that mirrors only the
 * surface the toast module touches (createElement, appendChild,
 * removeChild, classList, dataset, innerHTML, addEventListener).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    initNetworkToast,
    type NetworkEventPayload,
    type NetworkToastHandle,
} from '../../src/renderer/command-center/network-toast';

// ── Minimal fake-DOM ─────────────────────────────────────────

interface FakeListener {
    readonly type: string;
    readonly fn: (ev?: unknown) => void;
}

class FakeElement {
    tagName: string;
    className = '';
    innerHTML = '';
    textContent = '';
    readonly childNodes: FakeElement[] = [];
    parentElement: FakeElement | null = null;
    readonly dataset: Record<string, string> = {};
    readonly attributes: Record<string, string> = {};
    private readonly listeners: FakeListener[] = [];

    constructor(tag: string) {
        this.tagName = tag;
    }

    get firstChild(): FakeElement | null {
        return this.childNodes[0] ?? null;
    }

    get children(): readonly FakeElement[] {
        return this.childNodes;
    }

    get classList(): {
        add(name: string): void;
        remove(name: string): void;
        contains(name: string): boolean;
    } {
        const self = this;
        return {
            add(name: string): void {
                const set = new Set(self.className.split(/\s+/).filter(Boolean));
                set.add(name);
                self.className = Array.from(set).join(' ');
            },
            remove(name: string): void {
                const set = new Set(self.className.split(/\s+/).filter(Boolean));
                set.delete(name);
                self.className = Array.from(set).join(' ');
            },
            contains(name: string): boolean {
                return self.className.split(/\s+/).includes(name);
            },
        };
    }

    setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
    }

    getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
    }

    appendChild(child: FakeElement): FakeElement {
        child.parentElement = this;
        this.childNodes.push(child);
        return child;
    }

    removeChild(child: FakeElement): FakeElement {
        const idx = this.childNodes.indexOf(child);
        if (idx !== -1) {
            this.childNodes.splice(idx, 1);
            child.parentElement = null;
        }
        return child;
    }

    addEventListener(type: string, fn: (ev?: unknown) => void): void {
        this.listeners.push({ type, fn });
    }

    trigger(type: string): void {
        for (const l of this.listeners) {
            if (l.type === type) l.fn();
        }
    }
}

function installFakeDom(): { body: FakeElement; restore: () => void } {
    const body = new FakeElement('body');
    const originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as Record<string, unknown>)['document'] = {
        createElement: (tag: string) => new FakeElement(tag),
        body,
    };
    return {
        body,
        restore: () => {
            (globalThis as Record<string, unknown>)['document'] =
                originalDocument as unknown;
        },
    };
}

// ── Helpers ──────────────────────────────────────────────────

function transientEvent(attempt: number): NetworkEventPayload {
    return {
        kind: 'transient',
        data: {
            attempt,
            maxAttempts: 3,
            delayMs: attempt === 1 ? 1000 : attempt === 2 ? 3000 : 9000,
            error: 'ENOTFOUND',
        },
    };
}

// ── Tests ────────────────────────────────────────────────────

describe('network-toast — rendering', () => {
    let dom: ReturnType<typeof installFakeDom>;
    let handle: NetworkToastHandle;

    beforeEach(() => {
        dom = installFakeDom();
        handle = initNetworkToast({ container: dom.body });
    });

    afterEach(() => {
        handle.clear();
        dom.restore();
    });

    it('mounts a stack container into the given host', () => {
        expect(dom.body.childNodes.length).toBe(1);
        const stack = dom.body.childNodes[0];
        expect(stack.className).toContain('network-toast__stack');
    });

    it('uses role=status and aria-live=polite (not alert)', () => {
        const stack = dom.body.childNodes[0];
        expect(stack.getAttribute('role')).toBe('status');
        expect(stack.getAttribute('aria-live')).toBe('polite');
    });

    it('shows a transient toast on network.transient event', () => {
        handle.push(transientEvent(1));
        expect(handle.element.childNodes.length).toBe(1);
        const toast = handle.element.childNodes[0];
        expect(toast.className).toContain('network-toast--transient');
    });

    it('text reflects attempt, maxAttempts, and delay in seconds', () => {
        handle.push(transientEvent(1));
        const toast = handle.element.childNodes[0];
        expect(toast.innerHTML).toContain('1/3');
        expect(toast.innerHTML).toContain('1s');
    });

    it('renders delay in whole seconds rounded from delayMs', () => {
        handle.push(transientEvent(2));
        const toast = handle.element.childNodes[0];
        expect(toast.innerHTML).toContain('2/3');
        expect(toast.innerHTML).toContain('3s');
    });

    it('dataset marks the toast kind', () => {
        handle.push(transientEvent(1));
        const toast = handle.element.childNodes[0];
        expect(toast.dataset['kind']).toBe('transient');
    });
});

describe('network-toast — stacking', () => {
    let dom: ReturnType<typeof installFakeDom>;
    let handle: NetworkToastHandle;

    beforeEach(() => {
        dom = installFakeDom();
        handle = initNetworkToast({ container: dom.body, maxStack: 3 });
    });

    afterEach(() => {
        handle.clear();
        dom.restore();
    });

    it('stacks multiple transient toasts up to cap', () => {
        handle.push(transientEvent(1));
        handle.push(transientEvent(2));
        handle.push(transientEvent(3));
        expect(handle.element.childNodes.length).toBe(3);
    });

    it('evicts the oldest toast beyond the cap', () => {
        handle.push(transientEvent(1));
        handle.push(transientEvent(2));
        handle.push(transientEvent(3));
        handle.push(transientEvent(3));
        expect(handle.element.childNodes.length).toBe(3);
        // First toast (attempt 1) should be evicted — newest is last.
        const contents = handle.element.childNodes.map((c) => c.innerHTML);
        expect(contents.some((h) => h.includes('1/3') && h.includes('1s'))).toBe(false);
    });

    it('respects a custom maxStack of 1', () => {
        handle.clear();
        const one = initNetworkToast({ container: dom.body, maxStack: 1 });
        one.push(transientEvent(1));
        one.push(transientEvent(2));
        expect(one.element.childNodes.length).toBe(1);
    });
});

describe('network-toast — dismiss on click', () => {
    let dom: ReturnType<typeof installFakeDom>;
    let handle: NetworkToastHandle;

    beforeEach(() => {
        dom = installFakeDom();
        handle = initNetworkToast({ container: dom.body });
    });

    afterEach(() => {
        handle.clear();
        dom.restore();
    });

    it('dismisses a toast when clicked', () => {
        vi.useFakeTimers();
        handle.push(transientEvent(1));
        const toast = handle.element.childNodes[0];
        (toast as unknown as FakeElement).trigger('click');

        // Leaving animation runs for one motion-base tick (160ms) before
        // the element is detached; advance timers to observe removal.
        vi.advanceTimersByTime(200);
        expect(handle.element.childNodes.length).toBe(0);
        vi.useRealTimers();
    });
});

describe('network-toast — back online', () => {
    let dom: ReturnType<typeof installFakeDom>;
    let handle: NetworkToastHandle;

    beforeEach(() => {
        dom = installFakeDom();
        vi.useFakeTimers();
        handle = initNetworkToast({
            container: dom.body,
            backOnlineSilenceMs: 15_000,
        });
    });

    afterEach(() => {
        handle.clear();
        vi.useRealTimers();
        dom.restore();
    });

    it('emits "Back online" after eventbus.reconnected', () => {
        handle.push(transientEvent(1));
        handle.push({ kind: 'reconnected' });
        const last = handle.element.childNodes[handle.element.childNodes.length - 1];
        expect(last.innerHTML).toContain('Back online');
    });

    it('auto-dismisses the Back online toast after 4s', () => {
        handle.push(transientEvent(1));
        handle.push({ kind: 'reconnected' });
        expect(handle.element.childNodes.length).toBe(2);
        // 4s auto-dismiss + 160ms leave animation
        vi.advanceTimersByTime(4_200);
        const kinds = handle.element.childNodes.map((c) => c.dataset['kind']);
        expect(kinds).not.toContain('reconnected');
    });

    it('does NOT emit Back online if no transient event preceded it', () => {
        handle.push({ kind: 'reconnected' });
        expect(handle.element.childNodes.length).toBe(0);
    });

    it('emits implicit Back online after silence window elapses', () => {
        handle.push(transientEvent(1));
        // 15s silence → implicit back-online
        vi.advanceTimersByTime(15_100);
        const kinds = handle.element.childNodes.map((c) => c.dataset['kind']);
        expect(kinds).toContain('reconnected');
    });

    it('silence timer resets on each transient event', () => {
        handle.push(transientEvent(1));
        vi.advanceTimersByTime(10_000);
        handle.push(transientEvent(2));
        vi.advanceTimersByTime(10_000); // 20s total — but last reset was at 10s
        const kinds = handle.element.childNodes.map((c) => c.dataset['kind']);
        expect(kinds).not.toContain('reconnected');
    });
});

describe('network-toast — clear()', () => {
    let dom: ReturnType<typeof installFakeDom>;

    beforeEach(() => {
        dom = installFakeDom();
    });

    afterEach(() => {
        dom.restore();
    });

    it('removes every toast and cancels timers', () => {
        vi.useFakeTimers();
        const handle = initNetworkToast({ container: dom.body });
        handle.push(transientEvent(1));
        handle.push(transientEvent(2));
        handle.clear();
        expect(handle.element.childNodes.length).toBe(0);
        // Advancing past the silence window must NOT spawn a reconnected toast.
        vi.advanceTimersByTime(60_000);
        expect(handle.element.childNodes.length).toBe(0);
        vi.useRealTimers();
    });
});
