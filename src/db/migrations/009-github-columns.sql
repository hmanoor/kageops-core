-- Migration 009: Add GitHub integration columns
-- Adds per-project GitHub repo config and per-task issue linking.
-- All columns are nullable — GitHub integration is fully opt-in.

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS github_owner TEXT,
    ADD COLUMN IF NOT EXISTS github_repo  TEXT;

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS github_issue INTEGER;

-- Index for quick lookups of tasks with GitHub issues
CREATE INDEX IF NOT EXISTS idx_tasks_github_issue ON tasks (github_issue)
    WHERE github_issue IS NOT NULL;
