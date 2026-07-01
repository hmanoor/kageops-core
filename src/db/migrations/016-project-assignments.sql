-- Migration 016: Project assignments + Clerk user ID on team_members

-- Link team_members to Clerk user IDs
ALTER TABLE team_members
    ADD COLUMN IF NOT EXISTS clerk_user_id TEXT,
    ADD COLUMN IF NOT EXISTS clerk_org_id  TEXT;

CREATE INDEX IF NOT EXISTS idx_team_members_clerk_user_id ON team_members (clerk_user_id);

-- Project-scoped human assignments
CREATE TABLE IF NOT EXISTS project_assignments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL,   -- Clerk user ID
    user_name    TEXT NOT NULL,
    user_email   TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'observer'
                     CHECK (role IN ('owner', 'reviewer', 'observer')),
    assigned_by  TEXT,            -- Clerk user ID of assigner
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_assignments_unique
    ON project_assignments (project_id, user_id);

CREATE INDEX IF NOT EXISTS idx_project_assignments_project_id
    ON project_assignments (project_id);

CREATE INDEX IF NOT EXISTS idx_project_assignments_user_id
    ON project_assignments (user_id);
