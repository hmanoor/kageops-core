/**
 * KageOps Learning — Golden-task loader (B-471 follow-up)
 *
 * Loads the held-out task corpus for APO live-eval from
 * `golden-tasks.json`. Kept as a thin wrapper so the JSON stays
 * hand-editable without round-tripping through TypeScript.
 *
 * Scope: agents listed in `APO_ELIGIBLE_AGENTS` only. Calling
 * `loadGoldenTasks('sensei')` throws — it's a coding error, not a runtime
 * one, since Sensei is explicitly out of APO scope.
 *
 * The JSON shape is minimal on purpose:
 *   ```
 *   { "scout": [ { id, description, metadata? }, ... ], "herald": [...] }
 *   ```
 * Fields other than `id` and `description` pass through as `metadata` so
 * callers can tag tasks with custom keys (e.g., reward weights) later
 * without breaking the loader contract.
 */

import goldenTasksJson from './golden-tasks.json';
import type { SampleTask } from './apo-engine';
import { APO_ELIGIBLE_AGENTS } from './types';

// ── Public ───────────────────────────────────────────

/**
 * Return the held-out task set for the given agent.
 *
 * Throws if the agent is not APO-eligible or has no tasks defined.
 * The returned array (and every task) is deep-frozen — callers must
 * clone if they need mutability.
 */
export function loadGoldenTasks(agentName: string): readonly SampleTask[] {
    if (!APO_ELIGIBLE_AGENTS.includes(agentName)) {
        throw new Error(
            `[APO.GoldenTasks] agent "${agentName}" is not APO-eligible ` +
                `(allowed: ${APO_ELIGIBLE_AGENTS.join(', ')})`
        );
    }

    const corpus = goldenTasksJson as unknown as Record<string, readonly RawTask[] | undefined>;
    const raw = corpus[agentName];
    if (raw === undefined || raw.length === 0) {
        throw new Error(
            `[APO.GoldenTasks] no tasks defined for agent "${agentName}" in golden-tasks.json`
        );
    }

    return Object.freeze(raw.map(normalize));
}

/**
 * Return every agent that has at least one task defined. Handy for
 * nightly scheduling — iterate `listAgentsWithGoldenTasks()` instead of
 * hard-coding the list.
 */
export function listAgentsWithGoldenTasks(): readonly string[] {
    const corpus = goldenTasksJson as unknown as Record<string, readonly RawTask[] | undefined>;
    const agents: string[] = [];
    for (const name of APO_ELIGIBLE_AGENTS) {
        const tasks = corpus[name];
        if (tasks !== undefined && tasks.length > 0) {
            agents.push(name);
        }
    }
    return Object.freeze(agents);
}

// ── Internals ────────────────────────────────────────

interface RawTask {
    readonly id?: unknown;
    readonly description?: unknown;
    readonly metadata?: unknown;
}

function normalize(raw: RawTask): SampleTask {
    if (typeof raw.id !== 'string' || raw.id.trim() === '') {
        throw new Error(
            `[APO.GoldenTasks] task missing string "id" (got ${JSON.stringify(raw)})`
        );
    }
    if (typeof raw.description !== 'string' || raw.description.trim() === '') {
        throw new Error(
            `[APO.GoldenTasks] task "${raw.id}" missing string "description"`
        );
    }
    const task: SampleTask = {
        id: raw.id,
        description: raw.description,
        ...(raw.metadata !== undefined && typeof raw.metadata === 'object' && raw.metadata !== null
            ? { metadata: Object.freeze({ ...(raw.metadata as Record<string, unknown>) }) }
            : {}),
    };
    return Object.freeze(task);
}
