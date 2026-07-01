-- Migration 025: task_checkpoints (Devin-parity Phase 1 — P1-01)
--
-- One row per resumable operation inside a task. The orchestrator
-- writes a row BEFORE the operation runs (status='in-flight') and
-- updates it AFTER (status='completed' / 'failed'). On rerun of the
-- same task — e.g. after Forge crashed mid-task or the per-task
-- timeout fired — the agent reads the existing rows for `(task_id)`,
-- compares them to the operations about to run, and:
--
--   * if a row exists for the same `(task_id, op_index)` AND
--     status='completed' → skip the real op, return the cached
--     `output_json` payload (the resume optimisation; for askAI this
--     means we don't pay the LLM again, for writeFile we don't
--     re-write, for exec we don't re-run a potentially destructive
--     shell command).
--   * if status='in-flight' → the prior run crashed mid-op; re-run
--     and overwrite the row.
--   * if no row exists → execute as normal and write a new row.
--
-- `op_index` is a per-task monotonically increasing counter the agent
-- assigns at op-write time. The agent is single-threaded per task —
-- there is no concurrent-op race here.
--
-- `payload_json` shape is op-specific:
--   askai → { promptHash, model, contextLen }
--   write → { repoPath, filePath, bytes, sha256 }
--   exec  → { command, args, cwd }
--   other → freeform
--
-- `output_json` shape is op-specific:
--   askai → { text, tokensIn, tokensOut, costUsd, costSource }
--   write → { bytesWritten }
--   exec  → { exitCode, stdoutPreview, stderrPreview, durationMs }
--   other → freeform
--
-- Indexes:
--   - `(task_id, op_index)` is the resume-lookup hot path (UNIQUE).
--   - `(task_id, created_at)` for the agent log timeline view.
--   - `(status)` for janitor sweeps that GC stale in-flight rows.
--
-- Cascade on task delete: checkpoints are derived data, never the
-- source of truth for cost/quality (those live in `agent_logs`
-- and `tasks.quality_score`). If the parent task is gone, the
-- checkpoint history has no consumer.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS task_checkpoints (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    op_index     INTEGER NOT NULL,
    op_type      TEXT NOT NULL
                     CHECK (op_type IN ('askai', 'write', 'exec', 'other')),
    status       TEXT NOT NULL DEFAULT 'in-flight'
                     CHECK (status IN ('in-flight', 'completed', 'failed')),
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_json  JSONB,
    error_text   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_checkpoints_task_op
    ON task_checkpoints (task_id, op_index);

CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task_created
    ON task_checkpoints (task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_task_checkpoints_status
    ON task_checkpoints (status);
