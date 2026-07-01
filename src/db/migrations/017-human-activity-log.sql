-- Migration 017: Human activity log (mirrors agent_logs for human actions)

CREATE TABLE IF NOT EXISTS human_activity_log (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    TEXT NOT NULL,   -- Clerk user ID
    user_name  TEXT NOT NULL,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    task_id    UUID REFERENCES tasks(id)    ON DELETE SET NULL,
    action     TEXT NOT NULL,  -- 'task.claimed' | 'task.completed' | 'approval.given' etc.
    detail     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_human_activity_log_user_id
    ON human_activity_log (user_id);

CREATE INDEX IF NOT EXISTS idx_human_activity_log_project_id
    ON human_activity_log (project_id);

CREATE INDEX IF NOT EXISTS idx_human_activity_log_created_at
    ON human_activity_log (created_at DESC);
