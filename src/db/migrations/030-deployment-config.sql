-- 030-deployment-config.sql
--
-- Pillar 2.2 / D-D Option A — encrypted per-project deployment config.
--
-- Stores the bundle-declared env var values (Neon DATABASE_URL, Clerk
-- keys, Stripe keys, etc.) that an operator pastes into the New-Project
-- modal. Encrypted at rest via Electron `safeStorage` (OS keychain
-- backed); the column is opaque to direct SQL inspection.
--
-- The Vercel auth token itself is operator-scoped (Pillar 2.1 D-12) and
-- lives in the existing keychain entry — NOT in this column.
--
-- NOTE: production runtime relies on the inline ALTER mirrored in
-- src/db/client.ts (same pattern as 028-selected-bundle.sql and
-- 029-preview-url.sql). This .sql file is the source of truth; the
-- inline must stay in sync.

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS deployment_config BYTEA NULL;
