-- Migration 031: Pillar 2.4 — Cloud Burst data model.
--
-- Adds:
--   1. projects.client_id (nullable TEXT) — per-decision D-O, lets the
--      operator tag projects with a client label so the burst cost
--      export can group by client and apply per-client markup. NULL
--      keeps the existing "no client" behaviour.
--
--   2. burst_pools — operator-level Azure subscription config.
--      Holds subscription ID, resource group, ACR name, default region,
--      budget cap. Decision D-N: operator's own subscription only;
--      no cross-tenant rows in v1. A given operator may still have
--      multiple pools (e.g. prod + dev Azure subs), so this is a table,
--      not a singleton-column on `settings` — keeps the door open for
--      multi-sub setups without a future migration.
--
--   3. burst_tasks — per-burst lifecycle record.
--      One row per "send to cloud burst" event. Captures container_id,
--      region, cost, timing, heartbeat, status. NOT a hard FK to tasks
--      because tasks can be deleted by the project-lifecycle path
--      while we still want the cost history for billing export.
--
-- NOTE: production runtime relies on the inline ALTER + CREATE TABLE
-- mirrored in src/db/client.ts (same pattern as 028/029/030). This .sql
-- file is the source of truth; the inline must stay in sync.

-- 1) Per-client tagging on projects -----------------------------------
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS client_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_client_id
    ON projects (client_id)
    WHERE client_id IS NOT NULL;

-- 2) Operator-level burst pool config ---------------------------------
CREATE TABLE IF NOT EXISTS burst_pools (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL UNIQUE,
    subscription_id     TEXT NOT NULL,
    resource_group      TEXT NOT NULL,
    container_registry  TEXT NOT NULL,
    default_region      TEXT NOT NULL,
    budget_cap_usd      NUMERIC(10, 2) NOT NULL DEFAULT 5.00,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) Per-burst lifecycle record ---------------------------------------
CREATE TABLE IF NOT EXISTS burst_tasks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id             TEXT NOT NULL,             -- soft FK to tasks.id (string in this schema)
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    pool_id             UUID NOT NULL REFERENCES burst_pools(id) ON DELETE RESTRICT,
    agent_role          TEXT NOT NULL,
    container_id        TEXT NULL,                  -- Azure ACI container-group ARM ID once provisioned
    region              TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'queued',
    cost_usd            NUMERIC(10, 4) NOT NULL DEFAULT 0,
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at          TIMESTAMPTZ NULL,
    completed_at        TIMESTAMPTZ NULL,
    last_heartbeat_at   TIMESTAMPTZ NULL,
    error_message       TEXT NULL,
    CONSTRAINT burst_tasks_status_check CHECK (
        status IN ('queued', 'provisioning', 'running', 'completed', 'failed', 'timeout')
    )
);

CREATE INDEX IF NOT EXISTS idx_burst_tasks_project
    ON burst_tasks (project_id);

CREATE INDEX IF NOT EXISTS idx_burst_tasks_status
    ON burst_tasks (status)
    WHERE status IN ('queued', 'provisioning', 'running');

CREATE INDEX IF NOT EXISTS idx_burst_tasks_pool
    ON burst_tasks (pool_id);
