/**
 * Help docs search — the read side of the Phase 2 Help RAG.
 *
 * Sensei calls this when a user asks a "how do I…" / configuration /
 * troubleshooting question. Returns the top-K chunks ordered by FTS
 * relevance, then formats them into a context block ready to drop
 * into a system prompt.
 *
 * Mirrors the skill-registry pattern: ts_rank with prefix matching,
 * ILIKE fallback when ts_query errors out (some PGlite builds).
 */

import { getMany } from '../db/client';
import { createLogger } from '../shared/logger';

const log = createLogger('HelpSearch');

// ── Defaults ─────────────────────────────────────────

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;
const MIN_SCORE = 1e-6;

// ── Types ────────────────────────────────────────────

export interface HelpHit {
    readonly docSlug: string;
    readonly docTitle: string;
    readonly heading: string;
    readonly content: string;
    readonly score: number;
}

export interface HelpSearchOptions {
    readonly limit?: number;
}

interface RankedChunkRow {
    readonly doc_slug: string;
    readonly doc_title: string;
    readonly heading: string;
    readonly content: string;
    readonly score: number | string;
}

// ── Public API ───────────────────────────────────────

/**
 * Search help_chunks by FTS over heading+content. Returns at most
 * `opts.limit` hits (default 3). Empty / non-alphanumeric queries
 * return `[]` without hitting the DB.
 */
export async function searchHelp(
    rawQuery: string,
    opts: HelpSearchOptions = {}
): Promise<readonly HelpHit[]> {
    const tsQuery = sanitiseQuery(rawQuery);
    if (tsQuery === null) {
        return [];
    }

    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

    const sql = `
        WITH ranked AS (
            SELECT
                d.slug   AS doc_slug,
                d.title  AS doc_title,
                c.heading,
                c.content,
                ts_rank(c.search_vector, to_tsquery('english', $1)) AS score
            FROM help_chunks c
            JOIN help_documents d ON d.id = c.doc_id
        )
        SELECT * FROM ranked
        WHERE score > $2
        ORDER BY score DESC
        LIMIT $3
    `;

    try {
        const rows = await getMany<RankedChunkRow>(sql, [tsQuery, MIN_SCORE, limit]);
        return Object.freeze(rows.map(rowToHit));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err: msg, rawQuery }, 'Help FTS failed — falling back to ILIKE');
        return fallbackSearch(rawQuery, limit);
    }
}

/**
 * Format hits as a system-prompt block. Returns `null` if no hits —
 * callers should skip prepending in that case.
 */
export function formatHelpContext(hits: readonly HelpHit[]): string | null {
    if (hits.length === 0) return null;
    const blocks = hits.map((h, i) => {
        const headingLabel = h.heading.length > 0 ? `${h.heading} — ` : '';
        return [
            `[Help #${i + 1}: ${headingLabel}${h.docTitle} (docs/help/${h.docSlug}.md)]`,
            h.content,
        ].join('\n');
    });
    return [
        'RELEVANT HELP DOCS (cite by docs/help/<slug>.md when answering):',
        ...blocks,
    ].join('\n\n');
}

// ── Internal ─────────────────────────────────────────

function rowToHit(row: RankedChunkRow): HelpHit {
    return Object.freeze({
        docSlug: row.doc_slug,
        docTitle: row.doc_title,
        heading: row.heading,
        content: row.content,
        score: typeof row.score === 'string' ? Number(row.score) : row.score,
    });
}

function sanitiseQuery(raw: string): string | null {
    const tokens = raw
        .toLowerCase()
        .split(/[^a-z0-9_]+/u)
        .filter((t) => t.length >= 2);
    if (tokens.length === 0) return null;
    return tokens.map((t) => `${t}:*`).join(' & ');
}

async function fallbackSearch(rawQuery: string, limit: number): Promise<readonly HelpHit[]> {
    const needle = `%${rawQuery.trim().toLowerCase()}%`;
    if (needle === '%%') return [];

    const rows = await getMany<RankedChunkRow>(
        `SELECT
            d.slug  AS doc_slug,
            d.title AS doc_title,
            c.heading,
            c.content,
            (CASE WHEN LOWER(c.heading) LIKE $1 THEN 2 ELSE 0 END
           + CASE WHEN LOWER(c.content) LIKE $1 THEN 1 ELSE 0 END) AS score
         FROM help_chunks c
         JOIN help_documents d ON d.id = c.doc_id
         WHERE LOWER(c.heading) LIKE $1 OR LOWER(c.content) LIKE $1
         ORDER BY score DESC
         LIMIT $2`,
        [needle, limit]
    );

    return Object.freeze(rows.map(rowToHit));
}

// ── Test export ──────────────────────────────────────

export const __test__ = {
    sanitiseQuery,
};
