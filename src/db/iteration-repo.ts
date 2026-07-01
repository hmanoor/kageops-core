/**
 * Iteration repository (Devin-parity Phase 1 — P1-05a).
 *
 * One row per project lifecycle cycle. Iteration 0 = the original build;
 * iteration 1+ = each reopen cycle (triggered by the Reopen UI button OR
 * by /add-requirement on a terminal-status project).
 *
 * Schema lives in `src/db/migrations/026-iterations.sql` + inline DDL at
 * `src/db/client.ts` (the PGlite-embedded path). Read the plan doc at
 * `docs/plans/p1-02-iteration-loop-plan.md` for the broader Pillar 1.2
 * design — this repo is the first persistence-layer brick.
 *
 * Repository pattern (per common/coding-style.md): pure data access
 * behind a typed surface so consumers can be tested with a fake and
 * the SQL stays in one place.
 *
 * No agent-side changes use this directly yet; Sensei is the sole
 * caller in P1-05a (startProject → recordOriginal, reopenProject →
 * recordReopen, closeProject → closeCurrent). P1-06a will start
 * stamping `tasks.iteration_id` so revision tasks can be grouped.
 */

import { getMany, getOne, query } from './client';
import { createLogger } from '../shared/logger';

const log = createLogger('IterationRepo');

// ── Types ──────────────────────────────────────────────────────────

/**
 * One iteration row as persisted in `iterations`. Mirrors the table
 * columns one-for-one.
 *
 *  - `iterationIndex === 0` → original build (no `requirementText`).
 *  - `iterationIndex >= 1` → reopen cycle (may have `requirementText`
 *    if the reopen came in via `/add-requirement`; null when the
 *    operator clicked Reopen without a prompt).
 *  - `endedAt === null` → cycle is in flight (project is `active` /
 *    `awaiting-input` etc.); set when the project goes terminal.
 */
export interface IterationRow {
    readonly id: string;
    readonly projectId: string;
    readonly iterationIndex: number;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly requirementText: string | null;
}

export interface IterationRepository {
    /**
     * Record iteration 0 for a project that has just been created.
     * Idempotent — re-recording iteration 0 (e.g. after a startProject
     * retry) returns the existing row rather than throwing on the
     * `(project_id, iteration_index)` unique constraint.
     */
    recordOriginal(projectId: string): Promise<IterationRow>;

    /**
     * Record a fresh iteration cycle on reopen. The next index is read
     * inside the same transaction-like sequence here to keep racing
     * concurrent reopens deterministic (the UNIQUE constraint on
     * `(project_id, iteration_index)` is the backstop).
     *
     * `requirementText` is the operator's `/add-requirement` payload
     * when the reopen was prompt-driven; null when the operator
     * clicked the Reopen UI button without a prompt.
     */
    recordReopen(projectId: string, requirementText: string | null): Promise<IterationRow>;

    /**
     * Mark the most recent open iteration on a project as closed
     * (`ended_at = NOW()`). No-op when no open iteration exists —
     * e.g. legacy projects that pre-date this schema, or a project
     * being closed twice.
     */
    closeCurrent(projectId: string): Promise<void>;

    /** Most recent iteration for a project (highest index). `null` for projects with no iterations. */
    getCurrent(projectId: string): Promise<IterationRow | null>;

    /** Every iteration for a project, oldest first. Used by build-summary + the future iteration history UI. */
    listForProject(projectId: string): Promise<readonly IterationRow[]>;
}

// ── Production implementation ──────────────────────────────────────

interface RawRow {
    id: string;
    project_id: string;
    iteration_index: number;
    started_at: string;
    ended_at: string | null;
    requirement_text: string | null;
}

function mapRow(row: RawRow): IterationRow {
    return {
        id: row.id,
        projectId: row.project_id,
        iterationIndex: row.iteration_index,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        requirementText: row.requirement_text,
    };
}

export const iterationRepository: IterationRepository = {
    async recordOriginal(projectId: string): Promise<IterationRow> {
        // Idempotent — return the existing iteration 0 if it's already
        // there (startProject retries shouldn't double-insert).
        const existing = await getOne<RawRow>(
            `SELECT * FROM iterations WHERE project_id = $1 AND iteration_index = 0`,
            [projectId],
        );
        if (existing !== null) {
            return mapRow(existing);
        }
        const row = await getOne<RawRow>(
            `INSERT INTO iterations (project_id, iteration_index)
             VALUES ($1, 0)
             RETURNING *`,
            [projectId],
        );
        if (row === null) {
            throw new Error(`iterations insert returned no row for projectId=${projectId} index=0`);
        }
        log.debug({ projectId, id: row.id }, 'iteration 0 recorded (original build)');
        return mapRow(row);
    },

    async recordReopen(projectId: string, requirementText: string | null): Promise<IterationRow> {
        const max = await getOne<{ max_index: number | null }>(
            `SELECT COALESCE(MAX(iteration_index), -1)::int AS max_index FROM iterations WHERE project_id = $1`,
            [projectId],
        );
        // If `recordOriginal` was never called (legacy project from before
        // this migration) we want the first reopen to be iteration 1 — so
        // we backfill iteration 0 silently. The synthetic backfill row has
        // started_at = the project's created_at (best-effort), or NOW()
        // when the project lookup races.
        let nextIndex = (max?.max_index ?? -1) + 1;
        if (nextIndex === 0) {
            await this.recordOriginal(projectId);
            nextIndex = 1;
        }
        const row = await getOne<RawRow>(
            `INSERT INTO iterations (project_id, iteration_index, requirement_text)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [projectId, nextIndex, requirementText],
        );
        if (row === null) {
            throw new Error(`iterations insert returned no row for projectId=${projectId} index=${nextIndex}`);
        }
        log.info(
            { projectId, iterationIndex: nextIndex, hasRequirement: requirementText !== null },
            'iteration reopen recorded',
        );
        return mapRow(row);
    },

    async closeCurrent(projectId: string): Promise<void> {
        await query(
            `UPDATE iterations
                SET ended_at = NOW()
              WHERE project_id = $1
                AND ended_at IS NULL
                AND iteration_index = (
                    SELECT MAX(iteration_index) FROM iterations
                     WHERE project_id = $1 AND ended_at IS NULL
                )`,
            [projectId],
        );
    },

    async getCurrent(projectId: string): Promise<IterationRow | null> {
        const row = await getOne<RawRow>(
            `SELECT * FROM iterations
              WHERE project_id = $1
              ORDER BY iteration_index DESC
              LIMIT 1`,
            [projectId],
        );
        return row === null ? null : mapRow(row);
    },

    async listForProject(projectId: string): Promise<readonly IterationRow[]> {
        const rows = await getMany<RawRow>(
            `SELECT * FROM iterations
              WHERE project_id = $1
              ORDER BY iteration_index ASC`,
            [projectId],
        );
        return rows.map(mapRow);
    },
};

// ── Test helpers ───────────────────────────────────────────────────

/**
 * In-memory fake for unit tests that don't want to spin up PGlite.
 * Mirrors the production semantics exactly for the flows Sensei
 * relies on: idempotent original, monotonically-increasing reopen,
 * close-only-the-latest-open, ordered listing.
 */
export function createInMemoryIterationRepository(): IterationRepository {
    const rows = new Map<string, IterationRow>();
    let nextId = 1;
    const fakeId = (): string => `it-${nextId++}`;
    const fakeNow = (): string => new Date().toISOString();

    const forProject = (projectId: string): IterationRow[] =>
        Array.from(rows.values())
            .filter((r) => r.projectId === projectId)
            .sort((a, b) => a.iterationIndex - b.iterationIndex);

    return {
        async recordOriginal(projectId): Promise<IterationRow> {
            const existing = forProject(projectId).find((r) => r.iterationIndex === 0);
            if (existing !== undefined) return existing;
            const row: IterationRow = {
                id: fakeId(),
                projectId,
                iterationIndex: 0,
                startedAt: fakeNow(),
                endedAt: null,
                requirementText: null,
            };
            rows.set(row.id, row);
            return row;
        },

        async recordReopen(projectId, requirementText): Promise<IterationRow> {
            const list = forProject(projectId);
            let nextIndex = list.length === 0 ? 0 : list[list.length - 1].iterationIndex + 1;
            if (nextIndex === 0) {
                // Backfill iteration 0 for legacy projects then assign 1.
                await this.recordOriginal(projectId);
                nextIndex = 1;
            }
            const row: IterationRow = {
                id: fakeId(),
                projectId,
                iterationIndex: nextIndex,
                startedAt: fakeNow(),
                endedAt: null,
                requirementText,
            };
            rows.set(row.id, row);
            return row;
        },

        async closeCurrent(projectId): Promise<void> {
            const open = forProject(projectId).filter((r) => r.endedAt === null);
            if (open.length === 0) return;
            const latest = open[open.length - 1];
            rows.set(latest.id, { ...latest, endedAt: fakeNow() });
        },

        async getCurrent(projectId): Promise<IterationRow | null> {
            const list = forProject(projectId);
            return list.length === 0 ? null : list[list.length - 1];
        },

        async listForProject(projectId): Promise<readonly IterationRow[]> {
            return forProject(projectId);
        },
    };
}
