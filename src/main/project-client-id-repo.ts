/**
 * Pillar 2.4 / PR-B / D-O — projects.client_id read/write helper.
 *
 * Tiny repo for the per-client tagging column added in migration 031.
 * Used by:
 *   - The project-card UI (PR-H) to let the operator pick / change
 *     the client for a project.
 *   - The cost-export path (PR-H) to group burst costs by client
 *     and apply the per-client markup multiplier.
 *
 * Trimming + null handling: empty strings collapse to NULL so the
 * column behaves uniformly downstream (`client_id IS NOT NULL` is
 * the canonical "has a client" predicate).
 */

import type { Pool } from 'pg';

import { query, getOne } from '../db/client';
import { createLogger } from '../shared/logger';

const log = createLogger('ProjectClientIdRepo');

export interface ProjectClientIdRepoDeps {
    readonly pool?: Pool;
}

/**
 * Set or clear the client_id for a project. Pass `null` or an empty
 * string to clear back to NULL. Returns the canonical value that
 * landed in the column (trimmed, or null).
 */
export async function setProjectClientId(
    projectId: string,
    rawClientId: string | null,
    deps: ProjectClientIdRepoDeps = {}
): Promise<string | null> {
    const value = rawClientId === null ? null : rawClientId.trim();
    const finalValue = value === null || value === '' ? null : value;
    await runQuery(
        deps.pool,
        `UPDATE projects SET client_id = $1 WHERE id = $2`,
        [finalValue, projectId]
    );
    log.info({ projectId, clientId: finalValue }, 'project client_id updated');
    return finalValue;
}

/** Returns the trimmed client_id, or null when unset or project missing. */
export async function getProjectClientId(
    projectId: string,
    deps: ProjectClientIdRepoDeps = {}
): Promise<string | null> {
    const row = await runGetOne<{ client_id: string | null }>(
        deps.pool,
        `SELECT client_id FROM projects WHERE id = $1`,
        [projectId]
    );
    return row?.client_id ?? null;
}

// ── Helpers ─────────────────────────────────────────────

async function runQuery(
    pool: Pool | undefined,
    sql: string,
    params: readonly unknown[]
): Promise<void> {
    if (pool === undefined) {
        await query(sql, params as unknown[]);
        return;
    }
    await pool.query(sql, params as unknown[]);
}

async function runGetOne<T extends Record<string, unknown>>(
    pool: Pool | undefined,
    sql: string,
    params: readonly unknown[]
): Promise<T | null> {
    if (pool === undefined) {
        return getOne<T>(sql, params as unknown[]);
    }
    const res = await pool.query<T>(sql, params as unknown[]);
    return res.rows[0] ?? null;
}
