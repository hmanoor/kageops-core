-- Migration 018: Task claiming + task comments

-- Task claiming columns
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS claimed_by_user_id   TEXT,
    ADD COLUMN IF NOT EXISTS claimed_by_user_name TEXT,
    ADD COLUMN IF NOT EXISTS claimed_at           TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by_user_id
    ON tasks (claimed_by_user_id);

-- Task comments (humans + agents share the same table)
CREATE TABLE IF NOT EXISTS task_comments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author_id   TEXT NOT NULL,   -- Clerk user ID or agent name
    author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent')),
    author_name TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task_id
    ON task_comments (task_id);

CREATE INDEX IF NOT EXISTS idx_task_comments_created_at
    ON task_comments (created_at ASC);
