-- Migration 020: Team collaboration foundations (PR A of F-302 V1)
--
-- Three things land here:
--   1. `org_id` column on every team-scoped table that didn't already have it.
--      Decision from team-collaboration-plan.md: V1 ships single-org UX
--      but the schema is multi-org-ready so V2's org switcher doesn't need
--      a backfill migration. Default value 'default' for every existing row.
--   2. `removed_at TIMESTAMPTZ` on project_assignments for soft-delete.
--      Removed members keep attribution on chat / comments / activity feed
--      via a (former member) badge in the renderer; the assignment row stays
--      so historical joins still resolve.
--   3. Unique index on project_assignments narrowed to active rows only
--      (`WHERE removed_at IS NULL`) so a removed member can be re-invited.
--
-- Role values stay as ('owner', 'reviewer', 'observer') from migration 016
-- — the V1 plan used owner/editor/viewer in places but the actual names in
-- code are owner/reviewer/observer. Keeping them avoids touching team-ipc.ts
-- + team-members-panel.ts in this PR. Semantics map directly:
--     owner = owner          (delete, set budget, transfer)
--     reviewer = editor      (approve gates, claim tasks, comment)
--     observer = viewer      (read-only + comments + dry-runs only)

-- ─── 1. org_id column on team-scoped tables ──────────────────────

ALTER TABLE project_assignments
    ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE human_activity_log
    ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE task_comments
    ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_project_assignments_org_id
    ON project_assignments (org_id);

CREATE INDEX IF NOT EXISTS idx_human_activity_log_org_id
    ON human_activity_log (org_id);

CREATE INDEX IF NOT EXISTS idx_task_comments_org_id
    ON task_comments (org_id);

-- team_members already has `clerk_org_id` from migration 016. Add a plain
-- `org_id` alias for consistency with the rest of the schema. Backfill from
-- clerk_org_id when present, otherwise 'default'.
ALTER TABLE team_members
    ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default';

UPDATE team_members
   SET org_id = COALESCE(NULLIF(clerk_org_id, ''), 'default')
 WHERE org_id = 'default';

CREATE INDEX IF NOT EXISTS idx_team_members_org_id
    ON team_members (org_id);

-- ─── 2. Soft delete on project_assignments ──────────────────────

ALTER TABLE project_assignments
    ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

-- ─── 3. Re-shape uniqueness so removed members can be re-invited ─

DROP INDEX IF EXISTS idx_project_assignments_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_assignments_active_unique
    ON project_assignments (project_id, user_id)
    WHERE removed_at IS NULL;
