/**
 * KageOps Web Engine Cascade (firecrawl-inspired)
 *
 * Picks the best rendering engine for a given URL. The first iteration only
 * implements the `fetch` engine (Node global fetch + size/timeout caps).
 * `playwright` and `pdf` engines are declared in the `Engine` interface and
 * the picker table, but intentionally left unimplemented — they will throw
 * `EngineNotImplementedError` if requested. Upstream callers should catch
 * the error and fall back to `fetch` for now.
 *
 * No new npm dependencies — uses only Node built-ins.
 */

import { createLogger } from '../shared/logger';

const log = createLogger('WebEngineCascade');

// ── Types ────────────────────────────────────────────

export type EngineName = 'fetch' | 'playwright' | 'pdf';

export interface EngineHints {
    readonly preferredEngine?: EngineName;
    /** Hint that the page is JS-heavy (SPA, dashboard, interactive) — biases toward playwright. */
    readonly dynamic?: boolean;
    /** Hint that the URL serves a PDF document. */
    readonly isPdf?: boolean;
}

export interface EngineRequest {
    readonly url: string;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    readonly userAgent?: string;
    readonly hints?: EngineHints;
}

export interface EngineResponse {
    readonly url: string;
    readonly finalUrl: string;
    readonly status: number;
    readonly contentType: string;
    readonly bytes: number;
    readonly html: string;
    readonly engine: EngineName;
    readonly truncated: boolean;
    readonly headers: Readonly<Record<string, string>>;
}

export interface Engine {
    readonly name: EngineName;
    readonly canHandle: (req: EngineRequest) => boolean;
    readonly fetch: (req: EngineRequest) => Promise<EngineResponse>;
}

export class EngineNotImplementedError extends Error {
    readonly engine: EngineName;
    constructor(engine: EngineName) {
        super(`[WebEngineCascade] engine '${engine}' is not implemented in this iteration`);
        this.name = 'EngineNotImplementedError';
        this.engine = engine;
    }
}

// ── Constants ────────────────────────────────────────

export const DEFAULT_USER_AGENT =
    'KageOps/0.11 (+https://kageops.ai; web-research)';

/** Default request timeout — short enough to keep agents responsive. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** Hard cap on response bytes kept in memory. Anything beyond is truncated. */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Hostnames/schemes that should never be fetched (SSRF defence-in-depth). */
const DISALLOWED_HOST_PATTERNS: readonly RegExp[] = [
    /^localhost$/i,
    /^127\./,
    /^0\./,
    /^10\./,
    /^192\.168\./,
    /^169\.254\./,
    /^::1$/,
    /^fc00:/i,
    /^fe80:/i,
];

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

// ── URL helpers ──────────────────────────────────────

function assertFetchableUrl(raw: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(`[WebEngineCascade] invalid URL: ${raw}`);
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(`[WebEngineCascade] disallowed protocol ${parsed.protocol} for ${raw}`);
    }
    const host = parsed.hostname;
    for (const pattern of DISALLOWED_HOST_PATTERNS) {
        if (pattern.test(host)) {
            throw new Error(`[WebEngineCascade] disallowed host: ${host}`);
        }
    }
    return parsed;
}

// ── Fetch Engine ─────────────────────────────────────

/**
 * Bare-bones HTTP engine using Node's global fetch (undici).
 * - AbortSignal timeout
 * - User-Agent header
 * - Size cap via streaming reader (truncates rather than consumes unbounded memory)
 */
export const fetchEngine: Engine = {
    name: 'fetch',
    canHandle(req: EngineRequest): boolean {
        if (req.hints?.isPdf === true) return false;
        if (req.hints?.preferredEngine !== undefined && req.hints.preferredEngine !== 'fetch') return false;
        return true;
    },
    async fetch(req: EngineRequest): Promise<EngineResponse> {
        const parsed = assertFetchableUrl(req.url);
        const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
        const ua = req.userAgent ?? DEFAULT_USER_AGENT;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(parsed.toString(), {
                method: 'GET',
                redirect: 'follow',
                signal: controller.signal,
                headers: {
                    'User-Agent': ua,
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
            });

            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => { headers[key] = value; });

            const { text, bytes, truncated } = await readWithCap(response, maxBytes);

            return {
                url: req.url,
                finalUrl: response.url,
                status: response.status,
                contentType: response.headers.get('content-type') ?? 'text/html',
                bytes,
                html: text,
                engine: 'fetch',
                truncated,
                headers: Object.freeze(headers),
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ url: req.url, err: msg }, 'fetch engine failed');
            throw new Error(`[WebEngineCascade] fetch failed for ${req.url}: ${msg}`);
        } finally {
            clearTimeout(timer);
        }
    },
};

async function readWithCap(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
    const reader = response.body?.getReader();
    if (reader === undefined) {
        // Fallback for mocked responses without a body stream.
        const text = await response.text();
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > maxBytes) {
            return {
                text: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'),
                bytes: maxBytes,
                truncated: true,
            };
        }
        return { text, bytes, truncated: false };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        if (total + value.byteLength > maxBytes) {
            const remaining = maxBytes - total;
            if (remaining > 0) {
                chunks.push(value.subarray(0, remaining));
                total += remaining;
            }
            truncated = true;
            try { await reader.cancel(); } catch { /* best effort */ }
            break;
        }
        chunks.push(value);
        total += value.byteLength;
    }

    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { text: buffer.toString('utf8'), bytes: total, truncated };
}

// ── Placeholder engines (schemas only) ───────────────

/**
 * Playwright engine placeholder. NOT implemented — adding Playwright would
 * bloat the Electron bundle by ~400 MB. Tracked for a later iteration.
 */
export const playwrightEngine: Engine = {
    name: 'playwright',
    canHandle(req: EngineRequest): boolean {
        return req.hints?.preferredEngine === 'playwright' || req.hints?.dynamic === true;
    },
    async fetch(): Promise<EngineResponse> {
        throw new EngineNotImplementedError('playwright');
    },
};

/**
 * PDF engine placeholder. NOT implemented — a native PDF parser (e.g. pdf.js
 * or pdf-parse) will be added once the core cascade is shipped.
 */
export const pdfEngine: Engine = {
    name: 'pdf',
    canHandle(req: EngineRequest): boolean {
        if (req.hints?.isPdf === true) return true;
        const lower = req.url.toLowerCase();
        return lower.endsWith('.pdf') || lower.includes('/pdf/');
    },
    async fetch(): Promise<EngineResponse> {
        throw new EngineNotImplementedError('pdf');
    },
};

// ── Engine Registry & Picker ─────────────────────────

export const ENGINES: readonly Engine[] = Object.freeze([
    pdfEngine,
    playwrightEngine,
    fetchEngine,
]);

/**
 * Pick the best engine for a URL given optional hints.
 * Precedence:
 *   1. Explicit `preferredEngine` hint (even if not yet implemented — caller
 *      gets a clear EngineNotImplementedError instead of a silent downgrade).
 *   2. PDF detection.
 *   3. Dynamic-content hint → playwright (currently placeholder).
 *   4. Default → fetch.
 */
export function pickEngine(url: string, hints?: EngineHints): Engine {
    const req: EngineRequest = { url, hints };

    if (hints?.preferredEngine !== undefined) {
        const explicit = ENGINES.find((e) => e.name === hints.preferredEngine);
        if (explicit !== undefined) return explicit;
    }

    // Prefer a specialised engine when it volunteers, else fall back.
    for (const engine of ENGINES) {
        if (engine.name === 'fetch') continue;
        if (engine.canHandle(req)) return engine;
    }
    return fetchEngine;
}

/** Test-only: check if a URL would be rejected before any network call. */
export function isFetchableUrl(url: string): boolean {
    try {
        assertFetchableUrl(url);
        return true;
    } catch {
        return false;
    }
}
