/**
 * KageOps Web Scraper (firecrawl-inspired)
 *
 * Orchestrates engine selection, HTML→markdown conversion, and Postgres-backed
 * day caching. Agents call `scrape(url)` and get back a normalized result —
 * cache hits skip the network entirely. On a miss the chosen engine is run,
 * the raw HTML is converted to markdown, and everything is persisted.
 *
 * Cache semantics:
 *   - A row in `web_scrapes` is "fresh" while `expires_at > NOW()`.
 *   - Multiple rows per URL are allowed (older fetches kept as history);
 *     the most-recent fresh row wins on read.
 *   - Day-based default expiry is set by the schema (NOW() + 1 day).
 *   - Callers may force a bypass with `forceRefresh: true`.
 */

import { getOne, query } from '../db/client';
import { createLogger } from '../shared/logger';
import {
    Engine,
    EngineHints,
    EngineResponse,
    fetchEngine,
    pickEngine,
} from './engine-cascade';
import {
    ExtractedLink,
    extractFromHtml,
} from './html-to-markdown';

const log = createLogger('WebScraper');

// ── Types ────────────────────────────────────────────

export interface ScrapeOptions {
    readonly hints?: EngineHints;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    readonly userAgent?: string;
    /** If true, skip cache and always re-fetch. */
    readonly forceRefresh?: boolean;
    /**
     * Override for the engine to use. Intended for tests and for higher-level
     * modules that want to force a specific path. Normally not needed.
     */
    readonly engineOverride?: Engine;
}

export interface ScrapeMetadata {
    readonly title: string | null;
    readonly description: string | null;
    readonly contentType: string;
    readonly bytes: number;
    readonly status: number;
    readonly finalUrl: string;
    readonly truncated: boolean;
}

export interface ScrapeResult {
    readonly url: string;
    readonly markdown: string;
    readonly html: string;
    readonly links: readonly ExtractedLink[];
    readonly metadata: ScrapeMetadata;
    readonly engine: string;
    readonly cacheHit: boolean;
}

interface CachedScrapeRow {
    readonly id: string;
    readonly url: string;
    readonly markdown: string;
    readonly html: string;
    readonly metadata: unknown;
    readonly engine_used: string;
    readonly status: string;
}

// ── Public API ───────────────────────────────────────

/**
 * Fetch a URL with full caching + engine cascade.
 * Errors from the engine are rethrown so callers can react.
 */
export async function scrape(url: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
    const forceRefresh = opts.forceRefresh === true;

    if (!forceRefresh) {
        const hit = await readFreshCache(url);
        if (hit !== null) {
            log.info({ url, engine: hit.engine }, 'cache hit');
            return { ...hit, cacheHit: true };
        }
    }

    const engine = opts.engineOverride ?? pickEngine(url, opts.hints);
    log.info({ url, engine: engine.name, forceRefresh }, 'cache miss — running engine');

    let engineResponse: EngineResponse;
    try {
        engineResponse = await engine.fetch({
            url,
            timeoutMs: opts.timeoutMs,
            maxBytes: opts.maxBytes,
            userAgent: opts.userAgent,
            hints: opts.hints,
        });
    } catch (err) {
        // Specialised engines (pdf/playwright) are not implemented yet — fall
        // back to the plain fetch engine so callers still get *something*.
        if (engine !== fetchEngine) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ url, engine: engine.name, err: msg }, 'engine failed — falling back to fetch');
            engineResponse = await fetchEngine.fetch({
                url,
                timeoutMs: opts.timeoutMs,
                maxBytes: opts.maxBytes,
                userAgent: opts.userAgent,
                hints: opts.hints,
            });
        } else {
            await persistErrorScrape(url, err);
            throw err;
        }
    }

    const extracted = extractFromHtml(engineResponse.html);

    const metadata: ScrapeMetadata = {
        title: extracted.title,
        description: extracted.description,
        contentType: engineResponse.contentType,
        bytes: engineResponse.bytes,
        status: engineResponse.status,
        finalUrl: engineResponse.finalUrl,
        truncated: engineResponse.truncated,
    };

    const result: ScrapeResult = {
        url,
        markdown: extracted.markdown,
        html: engineResponse.html,
        links: extracted.links,
        metadata,
        engine: engineResponse.engine,
        cacheHit: false,
    };

    await persistScrape(result);
    return result;
}

// ── Cache helpers ────────────────────────────────────

async function readFreshCache(url: string): Promise<Omit<ScrapeResult, 'cacheHit'> | null> {
    try {
        const row = await getOne<CachedScrapeRow>(
            `SELECT id, url, markdown, html, metadata, engine_used, status
               FROM web_scrapes
              WHERE url = $1
                AND expires_at > NOW()
                AND status = 'ok'
              ORDER BY created_at DESC
              LIMIT 1`,
            [url],
        );
        if (row === null) return null;

        const meta = coerceMetadata(row.metadata);
        const links = extractFromHtml(row.html).links;

        return {
            url: row.url,
            markdown: row.markdown,
            html: row.html,
            links,
            metadata: meta,
            engine: row.engine_used,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ url, err: msg }, 'cache read failed — treating as miss');
        return null;
    }
}

async function persistScrape(result: ScrapeResult): Promise<void> {
    try {
        await query(
            `INSERT INTO web_scrapes (url, markdown, html, metadata, engine_used, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                result.url,
                result.markdown,
                result.html,
                JSON.stringify(result.metadata),
                result.engine,
                'ok',
            ],
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ url: result.url, err: msg }, 'cache write failed — returning fresh result anyway');
    }
}

async function persistErrorScrape(url: string, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    try {
        await query(
            `INSERT INTO web_scrapes (url, markdown, html, metadata, engine_used, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [url, '', '', JSON.stringify({ error: msg }), 'fetch', 'error'],
        );
    } catch (dbErr) {
        const dbMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        log.warn({ url, err: dbMsg }, 'error-scrape persistence failed');
    }
}

function coerceMetadata(raw: unknown): ScrapeMetadata {
    const obj: Record<string, unknown> = typeof raw === 'string'
        ? safeParseJson(raw)
        : (raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {});

    return {
        title: typeof obj.title === 'string' ? obj.title : null,
        description: typeof obj.description === 'string' ? obj.description : null,
        contentType: typeof obj.contentType === 'string' ? obj.contentType : 'text/html',
        bytes: typeof obj.bytes === 'number' ? obj.bytes : 0,
        status: typeof obj.status === 'number' ? obj.status : 200,
        finalUrl: typeof obj.finalUrl === 'string' ? obj.finalUrl : '',
        truncated: obj.truncated === true,
    };
}

function safeParseJson(raw: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(raw);
        return (parsed !== null && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}
