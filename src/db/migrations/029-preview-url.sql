-- Migration 029: per-project preview URL (P2-04, Devin-parity Pillar 2.1).
--
-- Adds a TEXT column for the Vercel preview URL surfaced by Aegis after
-- a successful `deploy-preview` task. NULL means "no preview deployed yet"
-- or "deployer was skipped" — the Command Center reads the column to show
-- the operator a clickable link in the project card.
--
-- AcceptanceGate v2 (P2-05/PR-E) reads this column when its acceptance.kind
-- is 'build-tests-preview' — the gate fetches the URL, performs HTTP 200
-- checks on `/` plus any acceptance.preview_routes declared on the
-- selected_bundle, and reports the result through the existing gate
-- surface.
--
-- Idempotent for the embedded-PGlite reapply-on-boot path.

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS preview_url TEXT NULL;
