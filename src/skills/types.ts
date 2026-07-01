/**
 * KageOps Skills — Shared Types
 *
 * OpenSpace-inspired skill library (v0.11, Phase 3 — first iteration).
 * All types are `readonly` to match the immutability rules in CLAUDE.md.
 */

// ── Sources + evolutions ─────────────────────────────

/** Where a skill originated. */
export type SkillSource = 'captured' | 'imported' | 'derived' | 'fixed';

/** Discrete lifecycle events recorded in `skill_evolutions`. */
export type SkillEvolutionType = 'captured' | 'derived' | 'fixed' | 'updated';

// ── Entities ─────────────────────────────────────────

/**
 * Canonical skill record.
 * Rows come from the `skills` table via `skill-store.ts`.
 */
export interface Skill {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly body: string;
    readonly tags: readonly string[];
    readonly source: SkillSource;
    readonly parentSkillIds: readonly string[];
    readonly version: number;
    readonly usageCount: number;
    /** Vector(768) — null when the skill has not been embedded yet. */
    readonly embedding: readonly number[] | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

/**
 * Audit trail row from `skill_evolutions`.
 * Immutable by design — never updated in place.
 */
export interface SkillEvolution {
    readonly id: string;
    readonly skillId: string;
    readonly evolutionType: SkillEvolutionType;
    readonly triggerTaskId: string | null;
    readonly notes: string;
    readonly createdAt: string;
}

// ── Search / registry ────────────────────────────────

/** A single result from `SkillRegistry.search()`. */
export interface SkillSearchResult {
    readonly skill: Skill;
    /** Non-negative relevance score. Higher = better match. */
    readonly score: number;
}

/** Options for `SkillRegistry.search()`. */
export interface SkillSearchOptions {
    /** Max results to return. Default 10. */
    readonly limit?: number;
    /** Restrict to skills tagged with any of these values. */
    readonly tags?: readonly string[];
    /** Restrict to a particular source (e.g. 'imported'). */
    readonly source?: SkillSource;
}

// ── Inputs ───────────────────────────────────────────

/** Input shape for `SkillStore.create()`. */
export interface SkillCreateInput {
    readonly name: string;
    readonly description: string;
    readonly body: string;
    readonly tags?: readonly string[];
    readonly source?: SkillSource;
    readonly parentSkillIds?: readonly string[];
}

/**
 * Input shape for `SkillStore.update()`.
 * `name` is the lookup key. Any provided field overrides the existing value;
 * omitted fields are preserved. Every update bumps `version` by 1.
 */
export interface SkillUpdateInput {
    readonly description?: string;
    readonly body?: string;
    readonly tags?: readonly string[];
    readonly source?: SkillSource;
    readonly parentSkillIds?: readonly string[];
}
