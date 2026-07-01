-- Migration 021: Persistent Sensei chat messages (PR A of F-302 V1)
--
-- Sensei chat history was previously kept in-memory on the orchestrator
-- (`Map<channelId, ChatMessage[]>`) keyed by a free-form channelId that
-- defaulted to 'default'. Two operators on the same project saw two
-- independent threads, neither survived an Electron restart.
--
-- PR B replaces that with a project-scoped persistent thread:
--   channelId becomes `project:<projectUuid>` (or `default` for non-project
--   chat); every message persists; the renderer attributes each message to
--   its sender with role + timestamp; Sensei's system prompt sees the full
--   multi-author thread on every turn.
--
-- The schema below supports that. PR B is the consumer.

CREATE TABLE IF NOT EXISTS sensei_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Either a project UUID (for project-scoped chat) or NULL (for the
    -- legacy / non-project 'default' channel). Indexed below.
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    -- Multi-org-ready (decision: hybrid org model). Default 'default' until
    -- multi-org UX ships in V2.
    org_id          TEXT NOT NULL DEFAULT 'default',
    -- 'user' = an operator typed the message. 'assistant' = Sensei replied.
    -- Same role taxonomy as the in-memory `ChatMessage` interface so the
    -- conversion is mechanical.
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    -- Author identity. For 'assistant' messages, author_user_id is NULL and
    -- author_name is 'Sensei'. For 'user' messages, both are populated from
    -- the Clerk session.
    author_user_id  TEXT,
    author_name     TEXT NOT NULL,
    -- 'owner' / 'reviewer' / 'observer' — captured at write time so the
    -- renderer can show a contemporaneous role badge even if the user's
    -- role changes later. NULL for 'assistant' rows.
    author_role     TEXT,
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the hot read path: load all messages for a project in
-- chronological order.
CREATE INDEX IF NOT EXISTS idx_sensei_messages_project_ts
    ON sensei_messages (project_id, created_at);

-- Useful for org-scoped queries (V2 multi-org dashboards).
CREATE INDEX IF NOT EXISTS idx_sensei_messages_org_id
    ON sensei_messages (org_id);
