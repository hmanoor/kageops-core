-- Migration 026: project iteration tracking (P1-05a, Devin-parity Pillar 1.2).
--
-- Adds the schema needed to model multiple reopen cycles per project as
-- first-class "iterations". Iteration 0 = the original build; iteration
-- 1+ = each reopen cycle. Tasks created within a cycle reference the
-- iteration row so the build-summary report (F-300) + future UI panels
-- can render per-iteration timelines without scanning task created_at
-- timestamps and guessing where one cycle ends + the next begins.
--
-- No behaviour change in this migration alone — the columns + table are
-- populated by P1-05a's orchestrator wiring (`Sensei.reopenProject`
-- increments + writes the iteration row; `Sensei.startProject` writes
-- iteration 0 for new projects so the schema is uniform). Without that
-- wiring these columns sit at default values and are observably no-ops.
--
-- Idempotent (`IF NOT EXISTS` everywhere) per the inline-DDL convention
-- in src/db/client.ts — embedded PGlite re-runs every migration on boot.

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS reopen_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS last_reopened_at TIMESTAMPTZ NULL;

-- Iteration cycles. Iteration 0 is the original build (no
-- requirement_text); iteration 1+ are reopens triggered by either the
-- explicit Reopen UI button OR /add-requirement on a terminal project.
-- The (project_id, iteration_index) uniqueness guard catches the
-- "double-reopen-in-flight" race where two concurrent reopens would
-- otherwise both try to write iteration N+1.
CREATE TABLE IF NOT EXISTS iterations (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    iteration_index  INTEGER NOT NULL,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at         TIMESTAMPTZ NULL,
    requirement_text TEXT NULL,
    UNIQUE (project_id, iteration_index)
);

CREATE INDEX IF NOT EXISTS idx_iterations_project
    ON iterations (project_id, iteration_index);

-- Useful for the "show me the iterations that are still in flight"
-- queries the operator UI will eventually want; cheap to add up front
-- so we don't have to ship a follow-up migration just for an index.
CREATE INDEX IF NOT EXISTS idx_iterations_open
    ON iterations (project_id) WHERE ended_at IS NULL;
