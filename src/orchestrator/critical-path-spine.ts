/**
 * P0-W2 — schema-first critical-path spine.
 *
 * See docs/plans/harness-coherence-fix-plan.md. All three Tier-3 benchmark
 * runs timed out at `development` with the domain schema NEVER wired: the app
 * kept the bundle's boilerplate tables and every API/page referenced a domain
 * table that didn't exist. The LLM decomposition doesn't guarantee a schema
 * task, doesn't order it first, and doesn't make feature work depend on it — so
 * under a time cap the schema simply never lands and nothing downstream can
 * work.
 *
 * `ensureSchemaFirstSpine` is a deterministic post-filter (same idiom as the
 * BPF-30 shipped-feature filter and the SIMPLE-APP GUARD in TaskDecomposer):
 * for a DB-backed bundle's development phase it GUARANTEES a schema task exists,
 * is the root of the dependency graph (no deps, highest priority), and that
 * every implementation task depends on it. It never removes tasks and is a
 * pure function — trivially testable and safe to apply unconditionally when
 * `needsSchema` is true.
 */

import type { DecomposedTask } from './task-decomposer';

/** Title of the schema task injected when the decomposition produced none. */
export const SCHEMA_SPINE_TASK_TITLE = 'Define domain schema and generate migration';

export interface SchemaSpineOptions {
    /** True for DB-backed (full-stack) bundles — computed from the selected bundle. */
    readonly needsSchema: boolean;
}

/**
 * Task types that write application code depending on the data model. These get
 * a dependency edge to the schema task so the schema is built first. Excludes
 * `setup-project` (scaffold precedes the schema) and doc/test/review types
 * (test-ordering is a separate workstream).
 */
const IMPLEMENTATION_TASK_TYPES: ReadonlySet<string> = new Set([
    'implement',
    'create-api',
    'create-ui',
    'data-pipeline',
]);

/** taskTypes that inherently ARE schema work. */
const SCHEMA_TASK_TYPES: ReadonlySet<string> = new Set([
    'data-schema',
    'database-design',
]);

/** Title/description tell-tales for a schema task the LLM phrased its own way. */
const SCHEMA_TEXT_RE = /\b(schema|migration|drizzle|pgtable|data model)\b|\btables?\b/i;

function isSchemaTask(t: DecomposedTask): boolean {
    return (
        SCHEMA_TASK_TYPES.has(t.taskType) ||
        SCHEMA_TEXT_RE.test(t.title) ||
        SCHEMA_TEXT_RE.test(t.description)
    );
}

/**
 * Guarantee a schema-first critical-path spine for a DB-backed bundle's
 * development-phase tasks. Returns a new ordered task list; never mutates the
 * input. No-op when `needsSchema` is false or the list is empty.
 */
export function ensureSchemaFirstSpine(
    tasks: readonly DecomposedTask[],
    opts: SchemaSpineOptions,
): readonly DecomposedTask[] {
    if (!opts.needsSchema || tasks.length === 0) {
        return tasks;
    }

    // Find an existing schema task, or synthesise one.
    const existingIdx = tasks.findIndex(isSchemaTask);

    let schemaTitle: string;
    let schemaTask: DecomposedTask;
    let rest: readonly DecomposedTask[];

    if (existingIdx >= 0) {
        const found = tasks[existingIdx];
        schemaTitle = found.title;
        // Promote it to the graph root: no deps, top priority.
        schemaTask = { ...found, dependsOn: [], priority: 9 };
        rest = tasks.filter((_, i) => i !== existingIdx);
    } else {
        schemaTitle = SCHEMA_SPINE_TASK_TITLE;
        schemaTask = {
            title: SCHEMA_SPINE_TASK_TITLE,
            description:
                'Add every domain table the brief and design docs require to the ' +
                'Drizzle schema (lib/db/schema.ts) and generate the migration. This is ' +
                'the foundation every API route and page depends on — implement it ' +
                'before any feature work. Do NOT leave the scaffold placeholder tables ' +
                'as the only schema.',
            taskType: 'implement',
            assignedAgent: 'forge',
            priority: 9,
            dependsOn: [],
            phase: 'development',
            outputPath: 'lib/db/schema.ts',
        };
        rest = tasks;
    }

    // Every implementation task depends on the schema task (built first), and is
    // capped below the schema's priority so ordering agrees with the dep graph.
    const wired = rest.map((t) => {
        if (!IMPLEMENTATION_TASK_TYPES.has(t.taskType)) return t;
        const dependsOn = t.dependsOn.includes(schemaTitle)
            ? t.dependsOn
            : [schemaTitle, ...t.dependsOn];
        const priority = t.priority >= 9 ? 8 : t.priority;
        return { ...t, dependsOn, priority };
    });

    return [schemaTask, ...wired];
}
