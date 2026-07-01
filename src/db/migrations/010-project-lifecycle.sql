-- Migration 010: Project lifecycle columns (v2.4)
-- Adds archived_at, paused_at, cancelled_at timestamps.
-- No existing 'status' CHECK constraint — statuses are validated in code
-- and by the `idx_projects_status` index, so we only extend the docset.
--
-- Lifecycle values after this migration:
--   active | awaiting-approval | paused | completed | cancelled | archived | expired

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS paused_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_projects_archived_at
    ON projects (archived_at) WHERE archived_at IS NOT NULL;
