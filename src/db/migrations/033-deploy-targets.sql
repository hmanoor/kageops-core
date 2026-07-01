-- Migration 033: Pillar 2.5 PR-E — deploy_targets registry (P2.5-04).
--
-- One row = one deployable resource: "deploy THIS project to THIS Azure
-- environment as THIS service type, named THIS app." The deploy client
-- (PR-D) consumes a row's coordinates; the orchestrator (PR-F) drives
-- provision → deploy → status against it; the history panel (PR-H) lists
-- deploy runs per target.
--
-- Relationships:
--   environment_id → azure_environments  (NOT NULL, RESTRICT): a target
--     always lives in a registered environment (PR-C). RESTRICT so an
--     environment can't be deleted out from under a target — mirrors the
--     burst_pools.environment_id rule.
--   project_id → projects (NULL, SET NULL): a target usually belongs to a
--     project, but survives the project's deletion ON DELETE SET NULL —
--     deliberately, NOT cascade. A deployed App Service / Static Web App
--     keeps billing until torn down (D-J cost safety); silently deleting
--     the row would orphan a live, billed Azure resource. Keeping the row
--     (project_id nulled) leaves it visible + tear-down-able.
--
-- config is a small JSONB bag for service-specific knobs the deploy
-- client reads (sku, runtime, appServicePlanName). No secrets.
--
-- NOTE: production runtime relies on the inline mirror in
-- src/db/client.ts (same pattern as 028-032). This .sql file is the
-- source of truth; the inline must stay in sync.

CREATE TABLE IF NOT EXISTS deploy_targets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    environment_id  UUID NOT NULL REFERENCES azure_environments(id) ON DELETE RESTRICT,
    project_id      UUID NULL REFERENCES projects(id) ON DELETE SET NULL,
    service_type    TEXT NOT NULL,
    app_name        TEXT NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT deploy_targets_service_type_check
        CHECK (service_type IN ('app-service', 'static-web-app')),
    -- Azure resource names are unique within a subscription; an
    -- environment maps to one subscription, so (environment, app) is the
    -- natural uniqueness key and stops accidental duplicate targets.
    CONSTRAINT deploy_targets_env_app_unique UNIQUE (environment_id, app_name)
);

CREATE INDEX IF NOT EXISTS idx_deploy_targets_environment
    ON deploy_targets (environment_id);
CREATE INDEX IF NOT EXISTS idx_deploy_targets_project
    ON deploy_targets (project_id)
    WHERE project_id IS NOT NULL;
