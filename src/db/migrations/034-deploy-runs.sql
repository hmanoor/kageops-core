-- Migration 034: Pillar 2.5 PR-F — deploy_runs (deploy run/history state).
--
-- One row = one deploy attempt against a deploy_target. The orchestrator
-- (deploy-orchestrator.ts) writes a row when a deploy starts and
-- transitions it through the lifecycle; the deploy.* event channel mirrors
-- each transition onto the bus; the history panel (PR-H) reads these rows.
--
-- Lifecycle (status):
--   queued → provisioning → deploying → live   (happy path)
--                                     ↘ failed  (any step errors)
--
-- target_id → deploy_targets ON DELETE CASCADE: run history belongs to its
-- target; if the target is removed, its run history goes with it. (The
-- target itself is only deleted after the live Azure resource is torn
-- down — see deploy-target-repo.)
--
-- project_id is snapshotted on the run (not just joined through the
-- target) so history survives the target's project_id being nulled when a
-- project is deleted (deploy_targets.project_id is ON DELETE SET NULL).
--
-- NOTE: production runtime relies on the inline mirror in
-- src/db/client.ts (same pattern as 028-033). This .sql file is the
-- source of truth; the inline must stay in sync.

CREATE TABLE IF NOT EXISTS deploy_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_id       UUID NOT NULL REFERENCES deploy_targets(id) ON DELETE CASCADE,
    project_id      UUID NULL,
    status          TEXT NOT NULL DEFAULT 'queued',
    live_url        TEXT NULL,
    detail          TEXT NULL,
    error_message   TEXT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT deploy_runs_status_check
        CHECK (status IN ('queued', 'provisioning', 'deploying', 'live', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_deploy_runs_target
    ON deploy_runs (target_id);
-- In-flight runs (for a stale-run reaper + the active view).
CREATE INDEX IF NOT EXISTS idx_deploy_runs_active
    ON deploy_runs (status)
    WHERE status IN ('queued', 'provisioning', 'deploying');
