-- Migration 011: Web scrapes cache table (v0.11 Phase 2)
-- Firecrawl-inspired scrape cache. Every Scout/Herald web fetch lands here.
-- Day-based cache: a fresh scrape is returned when expires_at > NOW(),
-- otherwise the URL is re-fetched and the row is overwritten.
--
-- engine_used: which fetch path produced the content ('fetch', later 'playwright', 'pdf').
-- status:      'ok' | 'error' | 'empty'
-- metadata:    JSONB bag — { title, description, contentType, bytes, redirectChain, headers }

CREATE TABLE IF NOT EXISTS web_scrapes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT NOT NULL,
    markdown TEXT NOT NULL DEFAULT '',
    html TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    engine_used TEXT NOT NULL DEFAULT 'fetch',
    status TEXT NOT NULL DEFAULT 'ok',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 day')
);

CREATE INDEX IF NOT EXISTS idx_web_scrapes_url ON web_scrapes (url);
CREATE INDEX IF NOT EXISTS idx_web_scrapes_created_at ON web_scrapes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_scrapes_url_expires ON web_scrapes (url, expires_at DESC);
