-- Migration 013: Prompt optimizations (v0.11 — Phase 4, APO first iteration)
--
-- Agent-lightning-inspired Automatic Prompt Optimization (APO). Each run
-- of the APO engine proposes a rewritten system prompt for a target agent,
-- scored by reward-from-logs against held-out sample tasks. Winning
-- candidates are persisted here; in this iteration we only record
-- proposals — writing them back to `agent-config.<preset>.json` is
-- deferred (B-476).
--
-- Target agents (enforced in app code, not SQL): scout, herald, pixel.
--
-- Status lifecycle:
--   'proposed'    — engine produced a winner; not yet applied to the preset
--   'accepted'    — winner written back to agent-config.<preset>.json
--   'rolled_back' — operator reverted after observing regression
--
-- Compatibility: PGlite-safe SQL only.

CREATE TABLE IF NOT EXISTS prompt_optimizations (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_name        TEXT NOT NULL,
    baseline_prompt   TEXT NOT NULL,
    optimized_prompt  TEXT NOT NULL,
    baseline_reward   NUMERIC(10,6) NOT NULL DEFAULT 0,
    optimized_reward  NUMERIC(10,6) NOT NULL DEFAULT 0,
    reward_delta      NUMERIC(10,6) NOT NULL DEFAULT 0,
    beam_width        INTEGER NOT NULL DEFAULT 4,
    branch_factor     INTEGER NOT NULL DEFAULT 3,
    rounds            INTEGER NOT NULL DEFAULT 5,
    n_samples         INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'proposed',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_prompt_optimizations_agent_name
    ON prompt_optimizations (agent_name);

CREATE INDEX IF NOT EXISTS idx_prompt_optimizations_created_at
    ON prompt_optimizations (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompt_optimizations_agent_created
    ON prompt_optimizations (agent_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompt_optimizations_status
    ON prompt_optimizations (status);
