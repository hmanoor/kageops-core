/**
 * Runtime smoke check — load the produced index.html in a DOM engine
 * and catch errors that static checks can't see.
 *
 * Static checks (static-asset-checks.ts) catch the "file is broken at
 * rest" class of defect: missing asset, markdown fence left in, CSS
 * truncated mid-rule. They can't see:
 *
 *   - JS that parses fine but throws at runtime (ReferenceError to an
 *     undefined global, a typo in an ID selector returning null then
 *     `.value` blowing up, etc.)
 *   - `script.js` that loads but whose handlers crash on DOMContentLoaded
 *   - unhandled promise rejections
 *
 * We use jsdom (devDependency) imported dynamically so fresh clones
 * that skip `npm install` still boot — the check just no-ops and logs.
 * Playwright is the obvious alternative but requires
 * `npx playwright install chromium` (~180MB), which is a much bigger
 * hurdle than jsdom for every dev who clones the repo.
 *
 * Opt-out: `KAGEOPS_RUNTIME_SMOKE=0` disables the check entirely. On
 * by default because the failure modes it catches are the ones that
 * actually shipped in prod (see GreenThumb 2026-04-22).
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { createLogger } from '../shared/logger';

const log = createLogger('RuntimeSmoke');

// ── Types ────────────────────────────────────────────

export type RuntimeSmokeCheck =
    | 'runtime-error'
    | 'console-error'
    | 'unhandled-rejection';

export interface RuntimeSmokeViolation {
    readonly check: RuntimeSmokeCheck;
    readonly expected: string;
    readonly message: string;
}

// Default settle window after DOMContentLoaded — enough for most
// synchronous `<script>` handlers to fire and throw, but short enough
// to keep the gate under a second on a clean site.
const DEFAULT_SETTLE_MS = 500;

// ── Public API ───────────────────────────────────────

/**
 * Load index.html under jsdom and report any runtime errors or
 * console.error calls that fire during initialization.
 *
 * Returns [] if the check is disabled, jsdom isn't installed, or
 * no index.html exists — the caller treats "no violations" as pass.
 * We never throw from here; a broken smoke check must not cascade
 * into a false-fail on the whole acceptance gate.
 */
export async function runRuntimeSmoke(
    repoPath: string,
    settleMs: number = DEFAULT_SETTLE_MS,
): Promise<readonly RuntimeSmokeViolation[]> {
    if (process.env.KAGEOPS_RUNTIME_SMOKE === '0') {
        return [];
    }

    const indexPath = path.join(repoPath, 'index.html');
    if (!fs.existsSync(indexPath)) return [];

    const jsdomModule = await loadJsdom();
    if (jsdomModule === null) {
        log.info('jsdom not installed — skipping runtime smoke check');
        return [];
    }

    const html = fs.readFileSync(indexPath, 'utf-8');
    const violations: RuntimeSmokeViolation[] = [];

    // Hooks must be installed before jsdom runs any `<script>`, which
    // happens during construction. `beforeParse` is jsdom's official
    // escape hatch for exactly this.
    const beforeParse = (win: JsdomWindow): void => {
        // Polyfill browser APIs jsdom doesn't ship. These are not real
        // page bugs — the produced HTML works in every real browser, but
        // omitting them causes false-positive `runtime-error` violations
        // (the matchMedia trap that wedged the v4 acceptance loop for 1h40m).
        polyfillMissingBrowserApis(win as unknown as Window);

        // Error events raised from script execution
        win.addEventListener('error', (ev: Event) => {
            const errEv = ev as unknown as { message?: string; error?: { message?: string } };
            const msg = errEv.message ?? errEv.error?.message ?? 'unknown error';
            violations.push({
                check: 'runtime-error',
                expected: 'no runtime errors on page load',
                message: `window.onerror: ${msg}`,
            });
        });

        // Unhandled promise rejections surface here
        win.addEventListener('unhandledrejection', (ev: Event) => {
            const reason = (ev as unknown as { reason?: unknown }).reason;
            const msg = reason instanceof Error ? reason.message : String(reason);
            violations.push({
                check: 'unhandled-rejection',
                expected: 'no unhandled promise rejections',
                message: `unhandledrejection: ${msg}`,
            });
        });

        // Wrap console.error on the jsdom window. We leave the original
        // output flowing so failures are still debuggable from logs.
        const originalError = win.console.error.bind(win.console);
        win.console.error = (...args: unknown[]): void => {
            violations.push({
                check: 'console-error',
                expected: 'no console.error calls',
                message: `console.error: ${args.map((a) => String(a)).join(' ')}`,
            });
            originalError(...args);
        };

        // Belt-and-braces for runtimes where a script's throw doesn't
        // bubble through the DOM error event (older jsdom versions).
        win.addEventListener('uncaughtException' as never, (ev: Event) => {
            violations.push({
                check: 'runtime-error',
                expected: 'no runtime errors on page load',
                message: `uncaughtException: ${String((ev as unknown as { error?: unknown }).error)}`,
            });
        });
    };

    let dom: { window: { close: () => void } } | null = null;
    try {
        dom = new jsdomModule.JSDOM(html, {
            url: pathToFileURL(indexPath).href,
            runScripts: 'dangerously',
            resources: 'usable',
            pretendToBeVisual: true,
            beforeParse,
            virtualConsole: undefined,
        }) as { window: { close: () => void } };

        // Settle microtasks + DOMContentLoaded handlers. Scripts inside
        // the HTML already ran synchronously during construction; this
        // window catches deferred handlers and promise rejections.
        await new Promise<void>((resolve) => {
            setTimeout(resolve, settleMs);
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A jsdom construction failure is itself a smoke signal —
        // parse errors in the produced HTML land here.
        violations.push({
            check: 'runtime-error',
            expected: 'index.html loads without parser errors',
            message: `jsdom threw: ${msg}`,
        });
    } finally {
        try { dom?.window.close(); } catch { /* ignore */ }
    }

    return violations;
}

// ── Internal ─────────────────────────────────────────

interface JsdomWindow {
    readonly console: Console;
    readonly addEventListener: Window['addEventListener'];
}

interface JsdomModule {
    readonly JSDOM: new (html: string, options: unknown) => unknown;
}

async function loadJsdom(): Promise<JsdomModule | null> {
    try {
        return await import('jsdom') as unknown as JsdomModule;
    } catch {
        return null;
    }
}

/**
 * Stub the browser-only APIs jsdom omits so legitimate landing-page code
 * doesn't trigger false-positive runtime errors. These match the shape
 * of the real APIs closely enough for `addEventListener` / `observe` /
 * `.matches` lookups to no-op rather than throw.
 */
function polyfillMissingBrowserApis(win: Window): void {
    const w = win as unknown as Record<string, unknown>;

    if (typeof w['matchMedia'] !== 'function') {
        w['matchMedia'] = (query: string): MediaQueryList => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: () => undefined,
            removeListener: () => undefined,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            dispatchEvent: () => false,
        }) as MediaQueryList;
    }

    if (typeof w['IntersectionObserver'] !== 'function') {
        class IO {
            observe(): void { /* no-op */ }
            unobserve(): void { /* no-op */ }
            disconnect(): void { /* no-op */ }
            takeRecords(): readonly IntersectionObserverEntry[] { return []; }
        }
        w['IntersectionObserver'] = IO as unknown;
    }

    if (typeof w['ResizeObserver'] !== 'function') {
        class RO {
            observe(): void { /* no-op */ }
            unobserve(): void { /* no-op */ }
            disconnect(): void { /* no-op */ }
        }
        w['ResizeObserver'] = RO as unknown;
    }

    if (typeof w['requestAnimationFrame'] !== 'function') {
        w['requestAnimationFrame'] = (cb: FrameRequestCallback): number =>
            setTimeout(() => cb(performance.now()), 16) as unknown as number;
        w['cancelAnimationFrame'] = (id: number): void => clearTimeout(id);
    }
}
