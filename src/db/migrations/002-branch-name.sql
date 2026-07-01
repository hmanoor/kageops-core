-- Migration 002: Add branch_name column to tasks table
-- Part of v0.5 Phase 4 — Git Branch-Per-Task

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS branch_name TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_branch_name ON tasks (branch_name) WHERE branch_name IS NOT NULL;
