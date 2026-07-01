-- ═══════════════════════════════════════════════════════
--  Migration 003: Operational Costs (v0.7 Cost Intelligence)
-- ═══════════════════════════════════════════════════════
-- Safe to run multiple times — all statements use IF NOT EXISTS / IF EXISTS.

-- ── operational_costs table ───────────────────────────
CREATE TABLE IF NOT EXISTS operational_costs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent TEXT,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
    litellm_request_id TEXT UNIQUE,
    cost_type TEXT NOT NULL DEFAULT 'project'
        CHECK (cost_type IN ('project', 'platform')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_operational_costs_agent
    ON operational_costs (agent);

CREATE INDEX IF NOT EXISTS idx_operational_costs_project_id
    ON operational_costs (project_id);

CREATE INDEX IF NOT EXISTS idx_operational_costs_provider
    ON operational_costs (provider);

CREATE INDEX IF NOT EXISTS idx_operational_costs_model
    ON operational_costs (model);

CREATE INDEX IF NOT EXISTS idx_operational_costs_created_at
    ON operational_costs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operational_costs_cost_type
    ON operational_costs (cost_type);
