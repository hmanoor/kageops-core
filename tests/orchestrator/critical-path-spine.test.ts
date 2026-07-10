/**
 * P0-W2 — schema-first critical-path spine (harness-coherence-fix-plan.md).
 *
 * All three Tier-3 benchmark runs (SiteSense ×2, LinkStash) timed out at
 * `development` with the domain schema NEVER wired — the app kept the bundle's
 * boilerplate `users`/`memberships` tables and every API/page that needed a
 * domain table referenced one that didn't exist. Root cause: the LLM
 * decomposition doesn't guarantee a schema task, doesn't order it first, and
 * doesn't make feature work depend on it — so under a time cap the schema
 * simply never lands.
 *
 * `ensureSchemaFirstSpine` is a deterministic post-filter (same idiom as the
 * BPF-30 shipped-feature filter and the SIMPLE-APP GUARD): for a DB-backed
 * bundle's development phase it GUARANTEES a schema task exists, is the root of
 * the dependency graph (depends on nothing, highest priority), and that every
 * implementation task depends on it.
 */
import { describe, it, expect } from 'vitest';
import { ensureSchemaFirstSpine, SCHEMA_SPINE_TASK_TITLE } from '../../src/orchestrator/critical-path-spine';
import type { DecomposedTask } from '../../src/orchestrator/task-decomposer';

function task(over: Partial<DecomposedTask>): DecomposedTask {
    return {
        title: 'Untitled',
        description: '',
        taskType: 'implement',
        assignedAgent: 'forge',
        priority: 5,
        dependsOn: [],
        phase: 'development',
        outputPath: null,
        ...over,
    };
}

describe('ensureSchemaFirstSpine (P0-W2)', () => {
    it('is a no-op when the project does not need a schema (static / non-DB bundle)', () => {
        const tasks = [task({ title: 'A' }), task({ title: 'B' })];
        expect(ensureSchemaFirstSpine(tasks, { needsSchema: false })).toEqual(tasks);
    });

    it('is a no-op on an empty task list', () => {
        expect(ensureSchemaFirstSpine([], { needsSchema: true })).toEqual([]);
    });

    it('injects a schema task at the front when none exists', () => {
        const tasks = [
            task({ title: 'Build /api/bookmarks', taskType: 'create-api' }),
            task({ title: 'Build the dashboard page', taskType: 'create-ui' }),
        ];
        const out = ensureSchemaFirstSpine(tasks, { needsSchema: true });

        // schema task is first, is Forge, has no deps, highest priority, targets the schema file
        expect(out[0].title).toBe(SCHEMA_SPINE_TASK_TITLE);
        expect(out[0].assignedAgent).toBe('forge');
        expect(out[0].dependsOn).toEqual([]);
        expect(out[0].outputPath).toMatch(/schema\.ts$/);
        expect(out).toHaveLength(3);

        // every implementation task now depends on the schema task
        for (const t of out.slice(1)) {
            expect(t.dependsOn).toContain(SCHEMA_SPINE_TASK_TITLE);
            expect(t.priority).toBeLessThan(out[0].priority);
        }
    });

    it('reuses an existing schema task instead of duplicating it', () => {
        const tasks = [
            task({ title: 'Build /api/bookmarks', taskType: 'create-api' }),
            task({ title: 'Create the database schema', taskType: 'data-schema', assignedAgent: 'cipher', priority: 4 }),
            task({ title: 'Dashboard page', taskType: 'create-ui' }),
        ];
        const out = ensureSchemaFirstSpine(tasks, { needsSchema: true });

        // no injected duplicate — the existing schema task is promoted to root
        const schemaCount = out.filter(
            (t) => t.title === 'Create the database schema' || t.title === SCHEMA_SPINE_TASK_TITLE,
        ).length;
        expect(schemaCount).toBe(1);
        expect(out).toHaveLength(3);
        expect(out[0].title).toBe('Create the database schema');
        expect(out[0].dependsOn).toEqual([]);

        // implementation tasks depend on the promoted schema task
        for (const t of out.filter((x) => x.taskType === 'create-api' || x.taskType === 'create-ui')) {
            expect(t.dependsOn).toContain('Create the database schema');
        }
    });

    it('detects a schema task by title/description keywords, not just taskType', () => {
        const tasks = [
            task({ title: 'Add Drizzle migration for bookmarks table', taskType: 'implement' }),
            task({ title: 'Build /api/bookmarks', taskType: 'create-api' }),
        ];
        const out = ensureSchemaFirstSpine(tasks, { needsSchema: true });
        expect(out).toHaveLength(2); // no injection — the migration task IS the schema task
        expect(out[0].title).toBe('Add Drizzle migration for bookmarks table');
        expect(out[1].dependsOn).toContain('Add Drizzle migration for bookmarks table');
    });

    it('does not force non-implementation tasks (docs, reviews) to depend on schema', () => {
        const tasks = [
            task({ title: 'Build /api/x', taskType: 'create-api' }),
            task({ title: 'Write project docs', taskType: 'documentation', assignedAgent: 'vigil' }),
        ];
        const out = ensureSchemaFirstSpine(tasks, { needsSchema: true });
        const docs = out.find((t) => t.taskType === 'documentation');
        expect(docs?.dependsOn ?? []).not.toContain(SCHEMA_SPINE_TASK_TITLE);
    });
});
