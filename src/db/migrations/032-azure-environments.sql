-- Migration 032: Pillar 2.5 — Azure Environments registry (D-A / D-C).
--
-- EXPAND phase of an expand/contract migration that unifies Azure
-- coordinates so they're entered once and shared by both Cloud Burst
-- pools and (future) deploy targets — killing the double-entry where
-- burst_pools and the deployments panel each ask for subscription / RG /
-- region.
--
-- Adds:
--   1. azure_environments — one row per operator Azure environment
--      (subscription / resource group / region / optional tenant +
--      credential ref + operator-facing label). Credentials are NOT
--      stored here in plaintext: credential_ref is an optional pointer
--      to a service principal held via the encrypted deployment_config
--      seam (D-B). The default path is DefaultAzureCredential, so
--      credential_ref stays NULL for most operators.
--
--   2. burst_pools.environment_id — nullable FK to azure_environments.
--      Kept NULLABLE and the existing subscription_id / resource_group /
--      default_region columns are LEFT IN PLACE during the transition so
--      nothing breaks. The CONTRACT phase (drop those duplicated columns
--      from burst_pools + repoint the dispatcher/handlers/panel to read
--      from the environment) lands in a later PR once consumers migrate.
--
--   3. Backfill — create one azure_environments row per existing
--      burst_pool and link it, so pre-existing pools keep working with
--      zero operator action.
--
-- D-C: this lands BEFORE Pillar 2.4 PR-E.2 so in-container dispatch can
-- reference environment_id rather than entrenching duplicate coordinates.
--
-- NOTE: production runtime relies on the inline mirror in
-- src/db/client.ts (same pattern as 028-031). This .sql file is the
-- source of truth; the inline must stay in sync.

-- 1) Azure environments registry --------------------------------------
CREATE TABLE IF NOT EXISTS azure_environments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label               TEXT NOT NULL UNIQUE,        -- operator-facing name, e.g. "Production AU"
    subscription_id     TEXT NOT NULL,
    resource_group      TEXT NOT NULL,
    default_region      TEXT NOT NULL,
    tenant_id           TEXT NULL,                   -- optional; DefaultAzureCredential resolves tenant otherwise
    credential_ref      TEXT NULL,                   -- optional pointer to an encrypted SP (D-B); NULL = DefaultAzureCredential
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) Link burst_pools to an environment (nullable during transition) --
ALTER TABLE burst_pools
    ADD COLUMN IF NOT EXISTS environment_id UUID NULL
        REFERENCES azure_environments(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_burst_pools_environment
    ON burst_pools (environment_id)
    WHERE environment_id IS NOT NULL;

-- 3) Backfill: one environment per existing pool, then link -----------
-- Idempotent: only acts on pools not yet linked, and the label-unique
-- INSERT is ON CONFLICT DO NOTHING so re-running is a no-op.
INSERT INTO azure_environments (label, subscription_id, resource_group, default_region)
SELECT p.name, p.subscription_id, p.resource_group, p.default_region
FROM burst_pools p
WHERE p.environment_id IS NULL
ON CONFLICT (label) DO NOTHING;

UPDATE burst_pools p
SET environment_id = e.id
FROM azure_environments e
WHERE p.environment_id IS NULL
  AND e.label = p.name;
