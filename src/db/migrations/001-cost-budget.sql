-- Migration 001: Add budget tracking columns to projects table
-- Part of v0.5 Phase 3 — Cost Tracking and Budget Enforcement

ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_usd NUMERIC(10,2) DEFAULT NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS spent_usd NUMERIC(10,6) DEFAULT 0;

-- Index for cost reporting queries
CREATE INDEX IF NOT EXISTS idx_projects_budget ON projects (budget_usd) WHERE budget_usd IS NOT NULL;
