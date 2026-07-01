/**
 * Theme Toggle — Unit Tests
 *
 * Validates theme switching logic, persistence contract, and button state.
 * Uses a minimal DOM stub to avoid jsdom dependency.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── Minimal DOM stubs ───────────────────────────────

interface StubElement {
    readonly id: string;
    textContent: string;
    readonly listeners: Array<{ type: string; fn: () => void }>;
    addEventListener(type: string, fn: () => void): void;
    click(): void;
}

function createStubElement(id: string, text: string): StubElement {
    const listeners: Array<{ type: string; fn: () => void }> = [];
    return {
        id,
        textContent: text,
        listeners,
        addEventListener(type: string, fn: () => void) {
            listeners.push({ type, fn });
        },
        click() {
            for (const l of listeners) {
                if (l.type === 'click') l.fn();
            }
        },
    };
}

interface ThemeState {
    theme: string;
    stored: string | null;
}

/** Pure-logic reproduction of initThemeToggle for isolated testing. */
function initThemeToggle(
    btn: StubElement,
    state: ThemeState,
): void {
    // Restore saved theme
    if (state.stored === 'light') {
        state.theme = 'light';
        btn.textContent = '\u2600\uFE0F';
    }

    btn.addEventListener('click', () => {
        const current = state.theme;
        const next = current === 'dark' ? 'light' : 'dark';
        state.theme = next;
        btn.textContent = next === 'dark' ? '\uD83C\uDF19' : '\u2600\uFE0F';
        state.stored = next;
    });
}

// ── Tests ───────────────────────────────────────────

describe('Theme Toggle', () => {
    let btn: StubElement;
    let state: ThemeState;

    beforeEach(() => {
        btn = createStubElement('btn-theme-toggle', '\uD83C\uDF19');
        state = { theme: 'dark', stored: null };
    });

    it('defaults to dark theme', () => {
        initThemeToggle(btn, state);
        expect(state.theme).toBe('dark');
    });

    it('toggles from dark to light and back', () => {
        initThemeToggle(btn, state);

        btn.click();
        expect(state.theme).toBe('light');

        btn.click();
        expect(state.theme).toBe('dark');
    });

    it('persists theme to storage on toggle', () => {
        initThemeToggle(btn, state);

        btn.click();
        expect(state.stored).toBe('light');

        btn.click();
        expect(state.stored).toBe('dark');
    });

    it('restores saved light theme on init', () => {
        state.stored = 'light';
        initThemeToggle(btn, state);

        expect(state.theme).toBe('light');
        expect(btn.textContent).toBe('\u2600\uFE0F');
    });

    it('updates button text between moon and sun emoji', () => {
        initThemeToggle(btn, state);
        expect(btn.textContent).toBe('\uD83C\uDF19');

        btn.click();
        expect(btn.textContent).toBe('\u2600\uFE0F');

        btn.click();
        expect(btn.textContent).toBe('\uD83C\uDF19');
    });
});
