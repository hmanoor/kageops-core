/**
 * KageOps Skill Store — Phase 3 / iter 1
 *
 * CRUD + version tracking for the `skills` table, plus append-only writes
 * to `skill_evolutions`. Pure data-access — no ranking, no embedding. All
 * queries parameterized; all returned objects are frozen.
 *
 * Immutability rules (see CLAUDE.md):
 *   - Every `update()` CREATES A NEW VERSION — we never blindly overwrite.
 *   - Results are converted to domain objects via `rowToSkill()`, which
 *     returns a brand-new object each call.
 */

import { query, getOne, getMany } from '../db/client';
import { createLogger } from '../shared/logger';
import type {
    Skill,
    SkillCreateInput,
    SkillEvolution,
    SkillEvolutionType,
    SkillSource,
    SkillUpdateInput,
} from './types';

const log = createLogger('Skills');

// ── Row shapes (raw DB) ──────────────────────────────

interface SkillRow {
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
}

interface EvolutionRow {
    readonly id: string;
    readonly skill_id: string;
    readonly evolution_type: string;
    readonly trigger_task_id: string | null;
    readonly notes: string;
    readonly created_at: string;
}

// ── Row → domain ─────────────────────────────────────

const VALID_SOURCES: readonly SkillSource[] = ['captured', 'imported', 'derived', 'fixed'];
const VALID_EVOLUTION_TYPES: readonly SkillEvolutionType[] = ['captured', 'derived', 'fixed', 'updated'];

function toSource(value: string): SkillSource {
    return (VALID_SOURCES as readonly string[]).includes(value)
        ? (value as SkillSource)
        : 'imported';
}

function toEvolutionType(value: string): SkillEvolutionType {
    return (VALID_EVOLUTION_TYPES as readonly string[]).includes(value)
        ? (value as SkillEvolutionType)
        : 'updated';
}

function rowToSkill(row: SkillRow): Skill {
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

function rowToEvolution(row: EvolutionRow): SkillEvolution {
    return Object.freeze({
        id: row.id,
        skillId: row.skill_id,
        evolutionType: toEvolutionType(row.evolution_type),
        triggerTaskId: row.trigger_task_id,
        notes: row.notes,
        createdAt: row.created_at,
    });
}

const SKILL_COLUMNS = `
    id, name, description, body, tags, source, parent_skill_ids,
    version, usage_count, embedding, created_at, updated_at
`;

// ── Store ────────────────────────────────────────────

export class SkillStore {

    /**
     * Insert a new skill at version 1. Returns the persisted record.
     * Throws when a skill with the same `name` already exists — use
     * `update()` (by name) for idempotent upserts.
     */
    async create(input: SkillCreateInput): Promise<Skill> {
        const tags = [...(input.tags ?? [])];
        const parents = [...(input.parentSkillIds ?? [])];
        const source: SkillSource = input.source ?? 'captured';

        const result = await query<SkillRow>(
            `INSERT INTO skills
                (name, description, body, tags, source, parent_skill_ids, version, usage_count)
             VALUES ($1, $2, $3, $4, $5, $6, 1, 0)
             RETURNING ${SKILL_COLUMNS}`,
            [input.name, input.description, input.body, tags, source, parents]
        );
        if (result.rows.length === 0) {
            throw new Error(`[SkillStore] Insert returned no row for "${input.name}"`);
        }
        const skill = rowToSkill(result.rows[0]);
        log.debug({ id: skill.id, name: skill.name, source: skill.source }, 'Skill created');
        return skill;
    }

    /**
     * Update a skill by name, bumping `version` by 1 and refreshing
     * `updated_at`. Returns `null` when no skill with that name exists.
     *
     * Only provided fields are changed — omitted fields keep their
     * existing values (atomic via COALESCE).
     */
    async update(name: string, input: SkillUpdateInput): Promise<Skill | null> {
        const tags = input.tags === undefined ? null : [...input.tags];
        const parents = input.parentSkillIds === undefined ? null : [...input.parentSkillIds];

        const result = await query<SkillRow>(
            `UPDATE skills
             SET description      = COALESCE($2, description),
                 body             = COALESCE($3, body),
                 tags             = COALESCE($4, tags),
                 source           = COALESCE($5, source),
                 parent_skill_ids = COALESCE($6, parent_skill_ids),
                 version          = version + 1,
                 updated_at       = NOW()
             WHERE name = $1
             RETURNING ${SKILL_COLUMNS}`,
            [
                name,
                input.description ?? null,
                input.body ?? null,
                tags,
                input.source ?? null,
                parents,
            ]
        );
        if (result.rows.length === 0) {
            return null;
        }
        const skill = rowToSkill(result.rows[0]);
        log.debug({ id: skill.id, name: skill.name, version: skill.version }, 'Skill updated');
        return skill;
    }

    /** Look up a skill by primary key. */
    async getById(id: string): Promise<Skill | null> {
        const row = await getOne<SkillRow>(
            `SELECT ${SKILL_COLUMNS} FROM skills WHERE id = $1`,
            [id]
        );
        return row === null ? null : rowToSkill(row);
    }

    /** Look up a skill by unique name. */
    async getByName(name: string): Promise<Skill | null> {
        const row = await getOne<SkillRow>(
            `SELECT ${SKILL_COLUMNS} FROM skills WHERE name = $1`,
            [name]
        );
        return row === null ? null : rowToSkill(row);
    }

    /**
     * List skills ordered by most-recently-updated.
     * `limit` defaults to 50.
     */
    async list(limit: number = 50): Promise<readonly Skill[]> {
        const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
        const rows = await getMany<SkillRow>(
            `SELECT ${SKILL_COLUMNS} FROM skills
             ORDER BY updated_at DESC
             LIMIT $1`,
            [safeLimit]
        );
        return Object.freeze(rows.map(rowToSkill));
    }

    /** Delete by primary key. Returns true when a row was removed. */
    async delete(id: string): Promise<boolean> {
        const result = await query(`DELETE FROM skills WHERE id = $1`, [id]);
        return result.rowCount > 0;
    }

    /**
     * Append an entry to `skill_evolutions`. This is the only way to
     * record why a skill changed — never mutate an existing row.
     */
    async recordEvolution(
        skillId: string,
        evolutionType: SkillEvolutionType,
        opts: { readonly triggerTaskId?: string | null; readonly notes?: string } = {}
    ): Promise<SkillEvolution> {
        const result = await query<EvolutionRow>(
            `INSERT INTO skill_evolutions (skill_id, evolution_type, trigger_task_id, notes)
             VALUES ($1, $2, $3, $4)
             RETURNING id, skill_id, evolution_type, trigger_task_id, notes, created_at`,
            [skillId, evolutionType, opts.triggerTaskId ?? null, opts.notes ?? '']
        );
        if (result.rows.length === 0) {
            throw new Error(`[SkillStore] Evolution insert returned no row for skill ${skillId}`);
        }
        return rowToEvolution(result.rows[0]);
    }

    /** Fetch the evolution log for a single skill, newest first. */
    async getEvolutions(skillId: string): Promise<readonly SkillEvolution[]> {
        const rows = await getMany<EvolutionRow>(
            `SELECT id, skill_id, evolution_type, trigger_task_id, notes, created_at
             FROM skill_evolutions
             WHERE skill_id = $1
             ORDER BY created_at DESC`,
            [skillId]
        );
        return Object.freeze(rows.map(rowToEvolution));
    }

    /** Increment usage_count — called after a search hit is actually used. */
    async incrementUsage(id: string): Promise<void> {
        await query(
            `UPDATE skills SET usage_count = usage_count + 1 WHERE id = $1`,
            [id]
        );
    }
}
