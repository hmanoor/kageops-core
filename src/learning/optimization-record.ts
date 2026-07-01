/**
 * KageOps Learning — Persistence for APO Optimization Records
 *
 * Writes `OptimizationResult`s from `apo-engine.optimize()` to the
 * `prompt_optimizations` table and surfaces read helpers for the
 * Command Center history/diff UI.
 *
 * Lifecycle:
 *   - `persistProposedOptimization(result)` — inserts a fresh row with
 *     `status='proposed'`. Called by the APO scheduler right after a
 *     beam search finishes, before any filesystem writes.
 *   - `markOptimizationAccepted(id, appliedAt)` — flipped by
 *     `applyWinner` after it writes `systemPromptOverride` into the
 *     preset file. Uses UTC `appliedAt` from the caller so tests stay
 *     deterministic.
 *   - `markOptimizationRolledBack(id)` — flipped by the rollback path
 *     when an operator restores a prior preset snapshot.
 *
 * Read helpers:
 *   - `listPromptOptimizations({ agentName?, limit? })` — newest-first
 *     list, optionally filtered by agent.
 *   - `getPromptOptimization(id)` — single-row fetch for the diff view.
 *
 * All DB access goes through the repo's `query`/`getOne`/`getMany`
 * helpers so connection-pool + PGlite/external selection stays in one
 * place. The numeric columns come back as strings from node-postgres
 * and PGlite — we coerce in `rowToRecord`.
 */

import { getOne, getMany, query } from '../db/client';
import { createLogger } from '../shared/logger';
import { APO_ELIGIBLE_AGENTS, type OptimizationResult, type PromptOptimizationRecord, type PromptOptimizationStatus } from './types';

const log = createLogger('APO.OptRecord');

// ── Row shape (as stored) ────────────────────────────

interface PromptOptimizationRow {
    readonly id: string;
    readonly agent_name: string;
    readonly baseline_prompt: string;
    readonly optimized_prompt: string;
    readonly baseline_reward: string | number;
    readonly optimized_reward: string | number;
    readonly reward_delta: string | number;
    readonly beam_width: number;
    readonly branch_factor: number;
    readonly rounds: number;
    readonly n_samples: number;
    readonly status: string;
    readonly created_at: Date | string;
    readonly applied_at: Date | string | null;
}

// ── Public API ───────────────────────────────────────

/**
 * Insert a new `proposed` row from a fresh `OptimizationResult`. The
 * caller is responsible for deciding whether to persist — e.g., the
 * nightly scheduler may skip candidates whose reward delta is below a
 * meaningful threshold to keep the history readable.
 */
export async function persistProposedOptimization(
    result: OptimizationResult,
    opts: { readonly nSamples: number }
): Promise<PromptOptimizationRecord> {
    if (!APO_ELIGIBLE_AGENTS.includes(result.agentName)) {
        throw new Error(
            `[APO.OptRecord] agent "${result.agentName}" is not APO-eligible`
        );
    }
    if (opts.nSamples < 0) {
        throw new Error('[APO.OptRecord] nSamples must be >= 0');
    }

    const row = await getOne<PromptOptimizationRow>(
        `INSERT INTO prompt_optimizations (
            agent_name, baseline_prompt, optimized_prompt,
            baseline_reward, optimized_reward, reward_delta,
            beam_width, branch_factor, rounds, n_samples, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'proposed')
         RETURNING *`,
        [
            result.agentName,
            result.baselinePrompt,
            result.winner,
            result.baselineReward,
            result.winnerReward,
            result.delta,
            result.beamWidth,
            result.branchFactor,
            result.rounds,
            opts.nSamples,
        ]
    );

    if (row === null) {
        throw new Error('[APO.OptRecord] INSERT returned no row');
    }

    log.info(
        { id: row.id, agentName: result.agentName, delta: result.delta },
        'persistProposedOptimization: wrote proposed row'
    );
    return rowToRecord(row);
}

/**
 * Flip a row to `accepted` and stamp `applied_at`. No-op (returns
 * `null`) if the row doesn't exist — callers decide whether to log.
 */
export async function markOptimizationAccepted(
    id: string,
    appliedAt: Date = new Date()
): Promise<PromptOptimizationRecord | null> {
    const row = await getOne<PromptOptimizationRow>(
        `UPDATE prompt_optimizations
         SET status = 'accepted', applied_at = $2
         WHERE id = $1
         RETURNING *`,
        [id, appliedAt.toISOString()]
    );
    return row === null ? null : rowToRecord(row);
}

/**
 * Flip a row to `rolled_back`. Does NOT clear `applied_at` — the
 * column still records when the prompt was live so operators can see
 * the "on/off" window. Returns `null` if the row is missing.
 */
export async function markOptimizationRolledBack(
    id: string
): Promise<PromptOptimizationRecord | null> {
    const row = await getOne<PromptOptimizationRow>(
        `UPDATE prompt_optimizations
         SET status = 'rolled_back'
         WHERE id = $1
         RETURNING *`,
        [id]
    );
    return row === null ? null : rowToRecord(row);
}

/**
 * Find the most-recent `accepted` row for the given agent. Used by
 * the rollback path to flip the right row to `rolled_back` without
 * the caller tracking ids. Returns null when no accepted row exists.
 */
export async function findLatestAcceptedForAgent(
    agentName: string
): Promise<PromptOptimizationRecord | null> {
    const row = await getOne<PromptOptimizationRow>(
        `SELECT * FROM prompt_optimizations
         WHERE agent_name = $1 AND status = 'accepted'
         ORDER BY applied_at DESC NULLS LAST, created_at DESC
         LIMIT 1`,
        [agentName]
    );
    return row === null ? null : rowToRecord(row);
}

export interface ListOptimizationsOptions {
    readonly agentName?: string;
    /** Max rows returned. Defaults to 100, capped at 500. */
    readonly limit?: number;
    /** When set, only rows in this status are returned. */
    readonly status?: PromptOptimizationStatus;
}

export async function listPromptOptimizations(
    opts: ListOptimizationsOptions = {}
): Promise<readonly PromptOptimizationRecord[]> {
    const requestedLimit = opts.limit ?? 100;
    const limit = Math.min(Math.max(requestedLimit, 1), 500);

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.agentName !== undefined) {
        params.push(opts.agentName);
        conditions.push(`agent_name = $${params.length}`);
    }
    if (opts.status !== undefined) {
        params.push(opts.status);
        conditions.push(`status = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const limitIdx = params.length;

    const rows = await getMany<PromptOptimizationRow>(
        `SELECT * FROM prompt_optimizations
         ${where}
         ORDER BY created_at DESC
         LIMIT $${limitIdx}`,
        params
    );
    return rows.map(rowToRecord);
}

export async function getPromptOptimization(
    id: string
): Promise<PromptOptimizationRecord | null> {
    const row = await getOne<PromptOptimizationRow>(
        `SELECT * FROM prompt_optimizations WHERE id = $1`,
        [id]
    );
    return row === null ? null : rowToRecord(row);
}

/**
 * Test-only helper — blow the table away. The production caller must
 * never hit this; it exists so vitest suites can start each run from
 * a known-empty state without adding a schema-drop.
 */
export async function truncatePromptOptimizations(): Promise<void> {
    await query(`DELETE FROM prompt_optimizations`);
}

// ── Internals ────────────────────────────────────────

function rowToRecord(row: PromptOptimizationRow): PromptOptimizationRecord {
    return Object.freeze({
        id: row.id,
        agentName: row.agent_name,
        baselinePrompt: row.baseline_prompt,
        optimizedPrompt: row.optimized_prompt,
        baselineReward: toNumber(row.baseline_reward),
        optimizedReward: toNumber(row.optimized_reward),
        rewardDelta: toNumber(row.reward_delta),
        beamWidth: row.beam_width,
        branchFactor: row.branch_factor,
        rounds: row.rounds,
        nSamples: row.n_samples,
        status: toStatus(row.status),
        createdAt: toIsoString(row.created_at),
        appliedAt: row.applied_at === null ? null : toIsoString(row.applied_at),
    });
}

function toNumber(value: string | number): number {
    return typeof value === 'number' ? value : Number(value);
}

function toIsoString(value: Date | string): string {
    if (value instanceof Date) {
        return value.toISOString();
    }
    // PGlite returns strings already in ISO form; node-postgres returns Date.
    // Normalize through Date to catch formats like 'YYYY-MM-DD HH:MM:SS+TZ'.
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function toStatus(raw: string): PromptOptimizationStatus {
    if (raw === 'proposed' || raw === 'accepted' || raw === 'rolled_back') {
        return raw;
    }
    // Defensive — schema default is 'proposed', column has no CHECK.
    log.warn({ raw }, 'toStatus: unexpected status, defaulting to proposed');
    return 'proposed';
}
