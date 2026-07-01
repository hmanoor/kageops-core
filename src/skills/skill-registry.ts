/**
 * KageOps Skill Registry — Phase 3 / iter 1
 *
 * Search facade over `skill-store`. First iteration uses Postgres
 * full-text search (`ts_rank` over name + description + body + tags).
 * Embeddings + BM25 hybrid ranking land in a later iteration.
 *
 * Pin/unpin are exposed as no-op stubs so callers can write forward-
 * compatible code today.
 */

import { getMany, query } from '../db/client';
import { createLogger } from '../shared/logger';
import type {
    Skill,
    SkillSearchOptions,
    SkillSearchResult,
    SkillSource,
} from './types';

const log = createLogger('Skills');

// ── Defaults ─────────────────────────────────────────

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
/** Minimum relevance (ts_rank) to include in results. */
const MIN_SCORE = 1e-6;

// ── Row shape ────────────────────────────────────────

interface RankedSkillRow {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly body: string;
    readonly tags: readonly string[] | null;
    readonly source: string;
    readonly parent_skill_ids: readonly string[] | null;
    readonly version: number;
    readonly usage_count: number;
    readonly embedding: readonly number[] | null;
    readonly created_at: string;
    readonly updated_at: string;
    readonly score: number | string;
}

const VALID_SOURCES: readonly SkillSource[] = ['captured', 'imported', 'derived', 'fixed'];
function toSource(value: string): SkillSource {
    return (VALID_SOURCES as readonly string[]).includes(value)
        ? (value as SkillSource)
        : 'imported';
}

function rowToSkill(row: RankedSkillRow): Skill {
    return Object.freeze({
        id: row.id,
        name: row.name,
        description: row.description,
        body: row.body,
        tags: Object.freeze([...(row.tags ?? [])]),
        source: toSource(row.source),
        parentSkillIds: Object.freeze([...(row.parent_skill_ids ?? [])]),
        version: row.version,
        usageCount: row.usage_count,
        embedding: row.embedding === null ? null : Object.freeze([...row.embedding]),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

// ── Query sanitization ───────────────────────────────

/**
 * Convert a free-form user query into a `to_tsquery`-safe expression.
 * Strategy:
 *   - split on whitespace / punctuation
 *   - drop empties and any term shorter than 2 chars
 *   - escape remaining chars, then AND them with ` & `
 *   - append `:*` to enable prefix matching on each term
 * Returns null when the sanitized query is empty — callers should
 * short-circuit to an empty result.
 */
export function sanitizeQuery(raw: string): string | null {
    const tokens = raw
        .toLowerCase()
        .split(/[^a-z0-9_]+/u)
        .filter((t) => t.length >= 2);
    if (tokens.length === 0) {
        return null;
    }
    return tokens.map((t) => `${t}:*`).join(' & ');
}

// ── Registry ─────────────────────────────────────────

export class SkillRegistry {

    /**
     * Full-text search over name (A), description (B), tags (C), body (D).
     * Returns at most `opts.limit` hits, ordered by descending score.
     *
     * Empty / non-alphanumeric queries return `[]` without hitting the DB.
     */
    async search(
        rawQuery: string,
        opts: SkillSearchOptions = {}
    ): Promise<readonly SkillSearchResult[]> {
        const tsQuery = sanitizeQuery(rawQuery);
        if (tsQuery === null) {
            return [];
        }

        const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
        const tagFilter = opts.tags !== undefined && opts.tags.length > 0 ? [...opts.tags] : null;
        const sourceFilter = opts.source ?? null;

        // Weighted vector: name = A, description = B, tags = C, body = D.
        // array_to_string folds the tag array into the same document.
        const sql = `
            WITH ranked AS (
                SELECT
                    id, name, description, body, tags, source, parent_skill_ids,
                    version, usage_count, embedding, created_at, updated_at,
                    ts_rank(
                        setweight(to_tsvector('english', COALESCE(name, '')), 'A') ||
                        setweight(to_tsvector('english', COALESCE(description, '')), 'B') ||
                        setweight(to_tsvector('english', COALESCE(array_to_string(tags, ' '), '')), 'C') ||
                        setweight(to_tsvector('english', COALESCE(body, '')), 'D'),
                        to_tsquery('english', $1)
                    ) AS score
                FROM skills
                WHERE ($2::text[] IS NULL OR tags && $2::text[])
                  AND ($3::text    IS NULL OR source = $3::text)
            )
            SELECT * FROM ranked
            WHERE score > $4
            ORDER BY score DESC, updated_at DESC
            LIMIT $5
        `;

        try {
            const rows = await getMany<RankedSkillRow>(sql, [
                tsQuery,
                tagFilter,
                sourceFilter,
                MIN_SCORE,
                limit,
            ]);
            return Object.freeze(rows.map((row) => ({
                skill: rowToSkill(row),
                score: typeof row.score === 'string' ? Number(row.score) : row.score,
            })));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg, rawQuery }, 'Full-text search failed — falling back to ILIKE');
            return this.fallbackSearch(rawQuery, { tagFilter, sourceFilter, limit });
        }
    }

    /**
     * ILIKE-based fallback used only when `ts_rank` errors out (some PGlite
     * builds lack full text support). Score = 1 per field that matches.
     */
    private async fallbackSearch(
        rawQuery: string,
        opts: {
            readonly tagFilter: readonly string[] | null;
            readonly sourceFilter: string | null;
            readonly limit: number;
        }
    ): Promise<readonly SkillSearchResult[]> {
        const needle = `%${rawQuery.trim().toLowerCase()}%`;
        if (needle === '%%') {
            return [];
        }
        const tagFilter = opts.tagFilter === null ? null : [...opts.tagFilter];
        const rows = await getMany<RankedSkillRow>(
            `SELECT id, name, description, body, tags, source, parent_skill_ids,
                    version, usage_count, embedding, created_at, updated_at,
                    (CASE WHEN LOWER(name)        LIKE $1 THEN 3 ELSE 0 END
                   + CASE WHEN LOWER(description) LIKE $1 THEN 2 ELSE 0 END
                   + CASE WHEN LOWER(body)        LIKE $1 THEN 1 ELSE 0 END) AS score
             FROM skills
             WHERE (LOWER(name) LIKE $1 OR LOWER(description) LIKE $1 OR LOWER(body) LIKE $1)
               AND ($2::text[] IS NULL OR tags && $2::text[])
               AND ($3::text    IS NULL OR source = $3::text)
             ORDER BY score DESC, updated_at DESC
             LIMIT $4`,
            [needle, tagFilter, opts.sourceFilter, opts.limit]
        );
        return Object.freeze(rows.map((row) => ({
            skill: rowToSkill(row),
            score: typeof row.score === 'string' ? Number(row.score) : row.score,
        })));
    }

    /**
     * STUB — pinning is reserved for the next iteration. Recorded via
     * `query()` so tests can assert it's a no-op against real SQL.
     */
    async pin(_skillId: string): Promise<void> {
        log.debug({ skillId: _skillId }, 'pin() is a no-op in iter 1');
        await query('SELECT 1', []);
    }

    /** STUB — counterpart to `pin()`. Intentionally inert. */
    async unpin(_skillId: string): Promise<void> {
        log.debug({ skillId: _skillId }, 'unpin() is a no-op in iter 1');
        await query('SELECT 1', []);
    }
}
