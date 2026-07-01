-- Migration 023: Ownership transfers (PR F of F-302 V1, F-326)
--
-- Without this, founders who hand off projects either delete-and-recreate
-- (loses agent_logs / comments / chat history) or stay nominal owner forever
-- (security risk after they leave the company). Owner transfer is a Team-tier
-- feature with an accept-before-effect flow:
--
--   1. Current owner inserts a row with status='pending'.
--   2. New owner sees the pending request in their UI and either accepts
--      (status='accepted', the project_assignments roles flip atomically)
--      or declines (status='declined'). Auto-expire after 7 days.
--   3. Activity log entry on every state change so audit history exists.

CREATE TABLE IF NOT EXISTS ownership_transfers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    org_id          TEXT NOT NULL DEFAULT 'default',
    from_user_id    TEXT NOT NULL,                -- Clerk user ID of current owner
    from_user_name  TEXT NOT NULL,
    to_user_id      TEXT NOT NULL,                -- Clerk user ID of proposed new owner
    to_user_name    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    -- Optional human-readable note from the requester ('Handing off to Bob
    -- before I leave next month'). Captured contemporaneously so the new
    -- owner sees context, not just a faceless transfer request.
    note            TEXT
);

-- Active-pending uniqueness: a single project can have at most one pending
-- transfer at a time. Cancelling the pending one is the prerequisite for
-- starting another.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ownership_transfers_one_pending_per_project
    ON ownership_transfers (project_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_ownership_transfers_to_user
    ON ownership_transfers (to_user_id, status);

CREATE INDEX IF NOT EXISTS idx_ownership_transfers_org_id
    ON ownership_transfers (org_id);
