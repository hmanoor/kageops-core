-- Migration 014: Help docs RAG (v0.12 — Phase 2 of Help system)
--
-- Indexes the markdown files under docs/help/ so Sensei can answer
-- "how do I…" questions from authoritative project documentation
-- instead of relying on prior-conversation memory.
--
-- Strategy: pure Postgres full-text search (ts_rank), mirroring the
-- skills registry pattern. Embeddings are deferred — FTS is plenty
-- for the ~7-doc corpus and stays PGlite-safe.
--
-- Tables:
--   help_documents — one row per .md file (source of truth)
--   help_chunks    — one row per H2 section within a doc (search target)

-- ── help_documents ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS help_documents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          TEXT NOT NULL UNIQUE,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    indexed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_help_documents_slug ON help_documents (slug);

-- ── help_chunks ────────────────────────────────────────
-- One row per H2 section. The chunk is what gets surfaced to Sensei,
-- not the entire document, so search results stay tight.
CREATE TABLE IF NOT EXISTS help_chunks (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id        UUID NOT NULL REFERENCES help_documents(id) ON DELETE CASCADE,
    chunk_index   INTEGER NOT NULL,
    heading       TEXT NOT NULL DEFAULT '',
    content       TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_help_chunks_doc_id ON help_chunks (doc_id);

-- Full-text search vector — heading weighted A, content weighted B.
ALTER TABLE help_chunks ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', COALESCE(heading, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(content, '')), 'B')
    ) STORED;
CREATE INDEX IF NOT EXISTS idx_help_chunks_search ON help_chunks USING GIN (search_vector);
