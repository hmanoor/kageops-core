-- Migration 019: Org settings (connector configs, per-org preferences)

CREATE TABLE IF NOT EXISTS org_settings (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     TEXT NOT NULL UNIQUE,  -- Clerk org ID (or 'default' for solo users)
    settings   JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER org_settings_updated_at
    BEFORE UPDATE ON org_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Upsert helper: ensure a default settings row exists on first use
INSERT INTO org_settings (org_id, settings)
VALUES ('default', '{"connectors": {}}')
ON CONFLICT (org_id) DO NOTHING;
