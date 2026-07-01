-- Migration 022: tasks.updated_at for optimistic locking (PR C of F-302 V1)
--
-- The tasks table never had `updated_at`, which means there's no version
-- token to feed into optimistic-lock checks at claim / unclaim / status
-- transitions. Two members both clicking 'Claim' on the same task race
-- silently — second click overwrites first.
--
-- Migration adds the column + a trigger that maintains it on UPDATE so
-- every row mutation bumps the version. The renderer reads `updated_at`
-- when displaying task cards and passes it back as `expectedUpdatedAt`
-- on the next mutating IPC call. The handler refuses if the value
-- doesn't match the current row, surfacing a "Bob just claimed this 2s
-- ago" toast.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- The schema's update_updated_at() function from schema.sql is reused
-- here; the trigger is idempotent in DROP-and-CREATE fashion.
DROP TRIGGER IF EXISTS tasks_updated_at ON tasks;
CREATE TRIGGER tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
