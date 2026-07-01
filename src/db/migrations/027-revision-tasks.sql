-- Migration 027: revision task type fields (P1-06a, Devin-parity Pillar 1.2).
--
-- Adds the per-row metadata that Pillar 1.2's revision flow needs to
-- (a) group tasks into the reopen cycle that created them and (b)
-- carry the operator's natural-language change instruction through to
-- Forge's revision handler (P1-06b).
--
-- `task_type` stays a plain TEXT column — no CHECK constraint exists
-- on the production schema today, so we don't need to extend an enum.
-- The string `'revision'` is the new well-known value Forge will
-- recognise in P1-06b.
--
-- `target_files` is added as nullable JSONB up front so the future
-- decomposer-side workspace-tree scan (Pillar 1.2 follow-on PR) can
-- populate it without a second migration. P1-06a leaves it null.
--
-- All ADDs are idempotent for the embedded-PGlite reapply-on-boot path.

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS iteration_id UUID NULL
        REFERENCES iterations(id) ON DELETE SET NULL;

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS target_files JSONB NULL;

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS revision_instruction TEXT NULL;

-- Hot path: "show me every task created during this iteration cycle".
-- Partial index keeps it cheap — tasks without an iteration_id (the
-- vast majority on legacy projects) are excluded.
CREATE INDEX IF NOT EXISTS idx_tasks_iteration
    ON tasks (iteration_id)
    WHERE iteration_id IS NOT NULL;
