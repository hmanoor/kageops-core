/**
 * KageOps Skill Hooks — Phase 3 / Loop A
 *
 * Pure-ish hooks that bridge the agent framework to the skills library.
 * `augmentSystemPrompt` runs BEFORE `sendPrompt` to inject relevant skills
 * into the system prompt. `captureCandidateSkill` runs AFTER a successful
 * AI response and uses a cheap heuristic to persist responses that look
 * like reusable knowledge.
 *
 * Both functions take their dependencies as arguments (no singletons)
 * so callers can pass mocks in tests.
 *
 * Feature-flagged on `KAGEOPS_SKILLS_HOOKS=true`. See `AutonautAgent.askAI`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// ^ ai-adapter AiResponse type is referenced via import()-style interop only
//   for dependency-minimisation in tests. We narrow internally.

import { createLogger } from '../shared/logger';
import type { SkillRegistry } from '../skills/skill-registry';
import type { SkillStore } from '../skills/skill-store';
import type { Skill, SkillSearchResult } from '../skills/types';

const log = createLogger('SkillHooks');

// ── Constants ────────────────────────────────────────

/** Maximum number of skills injected into a single prompt. */
const MAX_SKILLS_IN_PROMPT = 3;
/** Max characters of each skill body inserted into the prompt. */
const SKILL_BODY_TRUNCATE_CHARS = 500;

/** Default capture triggers — override via `KAGEOPS_SKILL_CAPTURE_TRIGGERS`. */
const DEFAULT_CAPTURE_TRIGGERS: readonly string[] = ['how to', 'learn from this'];
/** Threshold at which a long response with code is treated as a capture candidate. */
const LONG_RESPONSE_CHARS = 2000;
/** Max name length for a generated skill. */
const MAX_SKILL_NAME_CHARS = 80;
/** Max description length for a generated skill. */
const MAX_SKILL_DESCRIPTION_CHARS = 240;

// ── Types ────────────────────────────────────────────

export interface AugmentOptions {
    /** Override the max number of skills injected. Default 3. */
    readonly maxSkills?: number;
    /** Override the body truncation length. Default 500. */
    readonly truncateChars?: number;
}

export interface AugmentResult {
    readonly prompt: string;
    readonly hits: readonly SkillSearchResult[];
}

/**
 * Minimal shape of a task that `captureCandidateSkill` cares about.
 * Mirrors `TaskInfo` fields without importing it (avoids a cycle).
 */
export interface SkillCaptureTask {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly taskType?: string;
}

// ── augmentSystemPrompt ──────────────────────────────

/**
 * Search the registry using `userPrompt` and prepend the top matches to
 * `systemPrompt`. Returns the original prompt unchanged when there are
 * no hits, or when the registry throws.
 *
 * Top 3 matches by default; each skill body truncated to 500 chars.
 */
export async function augmentSystemPrompt(
    systemPrompt: string,
    userPrompt: string,
    registry: SkillRegistry,
    opts: AugmentOptions = {}
): Promise<AugmentResult> {
    const maxSkills = opts.maxSkills ?? MAX_SKILLS_IN_PROMPT;
    const truncate = opts.truncateChars ?? SKILL_BODY_TRUNCATE_CHARS;

    let results: readonly SkillSearchResult[];
    try {
        results = await registry.search(userPrompt, { limit: maxSkills });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.debug({ err: msg }, 'skill search failed — passthrough');
        return { prompt: systemPrompt, hits: [] };
    }

    if (results.length === 0) {
        return { prompt: systemPrompt, hits: [] };
    }

    // Registry already orders by score DESC; keep that order and trim defensively.
    const top = results.slice(0, maxSkills);

    const sections: string[] = ['## Relevant skills from the library'];
    for (let i = 0; i < top.length; i += 1) {
        const { skill } = top[i];
        const body = truncateBody(skill.body, truncate);
        sections.push(
            `### ${skill.name}`,
            skill.description,
            '',
            body,
        );
        if (i < top.length - 1) {
            sections.push('---');
        }
    }

    const augmented = `${systemPrompt}\n\n${sections.join('\n')}`;
    return { prompt: augmented, hits: top };
}

function truncateBody(body: string, maxChars: number): string {
    if (body.length <= maxChars) return body;
    return `${body.slice(0, maxChars).trimEnd()}\n… (truncated)`;
}

// ── captureCandidateSkill ────────────────────────────

/**
 * Heuristic capture. Fire-and-forget — never throws. Runs after a
 * successful AI response. First-iteration rules:
 *
 *  1. `task.description` contains any configured trigger phrase, OR
 *  2. the response is long (> 2000 chars) AND contains a code fence.
 *
 * When the rule fires, insert a skill with `source='captured'` and
 * record an evolution row (best-effort — a store failure is logged
 * at debug level and swallowed).
 *
 * This is intentionally dumb — an LLM-based evolver lands in a later loop.
 */
export async function captureCandidateSkill(
    responseText: string,
    task: SkillCaptureTask,
    store: SkillStore,
    opts: { readonly triggers?: readonly string[] } = {}
): Promise<Skill | null> {
    try {
        const triggers = opts.triggers ?? loadTriggersFromEnv();
        if (!shouldCapture(responseText, task, triggers)) {
            return null;
        }

        const name = makeSkillName(task);
        const description = makeSkillDescription(task);
        const body = responseText;

        // Don't clobber existing skills — skip silently when the name is taken.
        const existing = await store.getByName(name);
        if (existing !== null) {
            log.debug({ name, taskId: task.id }, 'skill already exists — skipping capture');
            return null;
        }

        const skill = await store.create({
            name,
            description,
            body,
            source: 'captured',
            tags: buildCaptureTags(task),
        });

        // Best-effort audit trail; don't fail capture if this throws.
        try {
            await store.recordEvolution(skill.id, 'captured', {
                triggerTaskId: task.id,
                notes: `Auto-captured by heuristic from task "${task.title}"`,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.debug({ err: msg, skillId: skill.id }, 'evolution record failed (capture still succeeded)');
        }

        log.info({ skillId: skill.id, taskId: task.id, name }, 'captured candidate skill');
        return skill;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.debug({ err: msg, taskId: task.id }, 'captureCandidateSkill failed (swallowed)');
        return null;
    }
}

/**
 * Split the comma-separated `KAGEOPS_SKILL_CAPTURE_TRIGGERS` env var into
 * a trigger list. Falls back to the defaults when unset/empty.
 */
export function loadTriggersFromEnv(): readonly string[] {
    const raw = process.env['KAGEOPS_SKILL_CAPTURE_TRIGGERS'];
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_CAPTURE_TRIGGERS;
    }
    const parts = raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    return parts.length > 0 ? parts : DEFAULT_CAPTURE_TRIGGERS;
}

/**
 * The heuristic decision function — exposed for tests.
 * Trigger match is case-insensitive.
 */
export function shouldCapture(
    responseText: string,
    task: SkillCaptureTask,
    triggers: readonly string[]
): boolean {
    const descLower = task.description.toLowerCase();
    const hasTrigger = triggers.some((t) => descLower.includes(t));
    if (hasTrigger) return true;

    const longEnough = responseText.length > LONG_RESPONSE_CHARS;
    const hasFence = responseText.includes('```');
    return longEnough && hasFence;
}

function makeSkillName(task: SkillCaptureTask): string {
    const slug = task.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, MAX_SKILL_NAME_CHARS);
    const safeSlug = slug.length > 0 ? slug : 'task';
    // Suffix with task id to keep names unique when two captures share a title.
    return `captured-${safeSlug}-${task.id.slice(0, 8)}`;
}

function makeSkillDescription(task: SkillCaptureTask): string {
    const desc = task.description.trim();
    if (desc.length === 0) {
        return `Captured knowledge from task "${task.title}"`;
    }
    if (desc.length <= MAX_SKILL_DESCRIPTION_CHARS) return desc;
    return `${desc.slice(0, MAX_SKILL_DESCRIPTION_CHARS).trimEnd()}…`;
}

function buildCaptureTags(task: SkillCaptureTask): readonly string[] {
    const tags: string[] = ['captured'];
    if (task.taskType !== undefined && task.taskType.length > 0) {
        tags.push(task.taskType);
    }
    return tags;
}
