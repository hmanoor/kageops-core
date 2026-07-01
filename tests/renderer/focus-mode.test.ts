/**
 * Focus Mode — Unit Tests
 *
 * Tests Focus Mode logic using minimal DOM mocking.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Minimal DOM helpers ──────────────────────────────

class MockElement {
    readonly classList: Set<string> = new Set();
    readonly children: MockElement[] = [];
    readonly tagName: string;
    readonly dataset: Record<string, string> = {};
    private readonly listeners: Record<string, Array<(e: unknown) => void>> = {};
    parentElement: MockElement | null = null;

    constructor(tagName: string) {
        this.tagName = tagName;
    }

    addEventListener(event: string, fn: (e: unknown) => void): void {
        if (this.listeners[event] === undefined) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(fn);
    }

    dispatchEvent(event: string, detail?: Record<string, unknown>): void {
        const handlers = this.listeners[event] ?? [];
        for (const fn of handlers) {
            fn({ ...detail, target: this });
        }
    }

    closest(selector: string): MockElement | null {
        if (selector === '.panel' && this.classList.has('panel')) return this;
        if (selector === '.panel' && this.parentElement !== null) {
            return this.parentElement.closest(selector);
        }
        return null;
    }

    hasClass(name: string): boolean {
        return this.classList.has(name);
    }

    addClass(name: string): void {
        this.classList.add(name);
    }

    removeClass(name: string): void {
        this.classList.delete(name);
    }

    toggleClass(name: string, force?: boolean): void {
        if (force === true) {
            this.classList.add(name);
        } else if (force === false) {
            this.classList.delete(name);
        } else if (this.classList.has(name)) {
            this.classList.delete(name);
        } else {
            this.classList.add(name);
        }
    }
}

// ── Focus Mode logic (extracted for testability) ─────

interface FocusModeState {
    readonly active: boolean;
}

function createFocusMode(
    body: MockElement,
    btn: MockElement,
    panels: readonly MockElement[],
): {
    toggle: () => FocusModeState;
    clickPanel: (panel: MockElement) => void;
    escape: () => void;
    isActive: () => boolean;
} {
    let focusModeActive = false;

    return {
        toggle(): FocusModeState {
            focusModeActive = !focusModeActive;
            body.toggleClass('focus-mode', focusModeActive);
            btn.toggleClass('active', focusModeActive);

            if (!focusModeActive) {
                for (const p of panels) {
                    p.removeClass('focus-active');
                }
            }
            return { active: focusModeActive };
        },

        clickPanel(panel: MockElement): void {
            if (!focusModeActive) return;
            for (const p of panels) {
                p.removeClass('focus-active');
            }
            panel.addClass('focus-active');
        },

        escape(): void {
            if (!focusModeActive) return;
            focusModeActive = false;
            body.removeClass('focus-mode');
            btn.removeClass('active');
            for (const p of panels) {
                p.removeClass('focus-active');
            }
        },

        isActive(): boolean {
            return focusModeActive;
        },
    };
}

// ── Tests ────────────────────────────────────────────

describe('Focus Mode', () => {
    let body: MockElement;
    let btn: MockElement;
    let panelA: MockElement;
    let panelB: MockElement;
    let panelC: MockElement;
    let fm: ReturnType<typeof createFocusMode>;

    beforeEach(() => {
        body = new MockElement('BODY');
        btn = new MockElement('BUTTON');
        panelA = new MockElement('SECTION');
        panelA.addClass('panel');
        panelA.dataset['panel'] = 'a';
        panelB = new MockElement('SECTION');
        panelB.addClass('panel');
        panelB.dataset['panel'] = 'b';
        panelC = new MockElement('SECTION');
        panelC.addClass('panel');
        panelC.dataset['panel'] = 'c';
        fm = createFocusMode(body, btn, [panelA, panelB, panelC]);
    });

    it('toggling focus mode adds and removes body class', () => {
        fm.toggle();
        expect(body.hasClass('focus-mode')).toBe(true);
        expect(btn.hasClass('active')).toBe(true);

        fm.toggle();
        expect(body.hasClass('focus-mode')).toBe(false);
        expect(btn.hasClass('active')).toBe(false);
    });

    it('clicking a panel in focus mode adds focus-active class', () => {
        fm.toggle();
        fm.clickPanel(panelA);
        expect(panelA.hasClass('focus-active')).toBe(true);
    });

    it('only one panel is focus-active at a time', () => {
        fm.toggle();
        fm.clickPanel(panelA);
        expect(panelA.hasClass('focus-active')).toBe(true);

        fm.clickPanel(panelB);
        expect(panelB.hasClass('focus-active')).toBe(true);
        expect(panelA.hasClass('focus-active')).toBe(false);
    });

    it('Escape exits focus mode', () => {
        fm.toggle();
        fm.clickPanel(panelA);

        fm.escape();

        expect(body.hasClass('focus-mode')).toBe(false);
        expect(btn.hasClass('active')).toBe(false);
        expect(panelA.hasClass('focus-active')).toBe(false);
    });

    it('panels without focus-active lack the class in focus mode', () => {
        fm.toggle();
        fm.clickPanel(panelA);

        expect(panelA.hasClass('focus-active')).toBe(true);
        expect(panelB.hasClass('focus-active')).toBe(false);
        expect(panelC.hasClass('focus-active')).toBe(false);
    });
});
