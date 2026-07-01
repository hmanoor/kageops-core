/**
 * Vitest global setup — jsdom polyfills.
 *
 * jsdom does not implement several browser APIs that React component tests
 * routinely touch. Without these stubs, generated tests fail confusingly with
 * "X is not a function" even though the component code is correct. Wired into
 * vitest.config.ts via `setupFiles` so every test file gets them automatically.
 *
 * This file exists because a generated app shipped ~55 failing tests, several
 * of which were `URL.createObjectURL is not a function` in jsdom — a missing
 * environment polyfill, not a real bug. Keep the stubs minimal and side-effect
 * free; extend only when a real generated test needs another missing API.
 */
import { vi } from 'vitest';

// File/blob download flows (`URL.createObjectURL(blob)`) — jsdom returns
// undefined for these by default.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = vi.fn(() => 'blob:test');
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = vi.fn();
}

// `window.matchMedia` — used by theme/responsive hooks. jsdom omits it.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated, kept for older libs
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// `ResizeObserver` — used by many shadcn/Radix primitives. jsdom omits it.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// `Element.prototype.scrollTo` — jsdom stubs are no-ops; define if absent.
if (typeof window.scrollTo !== 'function') {
  window.scrollTo = vi.fn();
}
