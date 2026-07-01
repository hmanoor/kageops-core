-- Migration 028: per-project selected bundle (P1-11, Devin-parity Pillar 1.3).
--
-- Adds a TEXT column that names the bundle Forge should use when
-- generating scaffolds / features for this project. NULL means
-- "no bundle selected — use the legacy inline static-HTML path."
--
-- P1-11 wires the column + the dispatch shim. Nothing writes to it
-- yet — that's P1-12's Scout-side intent matching. So this migration
-- is a no-op at runtime today, but lands the schema up front so
-- P1-12 doesn't need a coordinated rollout.
--
-- Column shape: <kind>::<name> (e.g. "stack::vanilla-html").
-- Loader-level uniqueness ensures the value resolves to at most one
-- bundle when paired with BundleRegistry.get().
--
-- Idempotent for the embedded-PGlite reapply-on-boot path.

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS selected_bundle TEXT NULL;
