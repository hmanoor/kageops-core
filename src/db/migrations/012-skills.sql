-- Migration 012: Skills library (v0.11 — Phase 3, first iteration)
--
-- OpenSpace-inspired skill storage. Agents consult learned skills before
-- askAI() to cut cost and latency. First iteration — plain ts_rank search,
-- no embeddings yet (column reserved).
--
-- Tables:
--   skills            — canonical skill records (versioned, tagged)
--   skill_evolutions  — audit trail of every captured / derived / fixed event
--
-- Compatibility: PGlite-safe SQL only (no IVFFlat, no COPY). Embedding
-- column is vector(768) to match OpenSpace defaults; cosine search is NOT
-- wired in this iteration — we fall back to a plain btree index.

-- ── skills ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skills (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL UNIQUE,
    description       TEXT NOT NULL DEFAULT '',
    body              TEXT NOT NULL DEFAULT '',
    tags              TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    source            TEXT NOT NULL DEFAULT 'imported',
    parent_skill_ids  UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    version           INTEGER NOT NULL DEFAULT 1,
    embedding         vector(768),
    usage_count       INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skills_name       ON skills (name);
CREATE INDEX IF NOT EXISTS idx_skills_source     ON skills (source);
CREATE INDEX IF NOT EXISTS idx_skills_tags       ON skills USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_skills_updated_at ON skills (updated_at DESC);

-- Embedding index: plain btree placeholder. IVFFlat intentionally skipped
-- in iter 1 — PGlite's vector extension may balk at ivfflat_cosine_ops
-- depending on build. Swap to IVFFlat when hybrid search lands.
-- CREATE INDEX IF NOT EXISTS idx_skills_embedding
--     ON skills USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ── skill_evolutions ───────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_evolutions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id          UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    evolution_type    TEXT NOT NULL,
    trigger_task_id   UUID,
    notes             TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skill_evolutions_skill_id   ON skill_evolutions (skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_evolutions_type       ON skill_evolutions (evolution_type);
CREATE INDEX IF NOT EXISTS idx_skill_evolutions_created_at ON skill_evolutions (created_at DESC);
