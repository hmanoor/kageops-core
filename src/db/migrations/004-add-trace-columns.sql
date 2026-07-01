-- v1.3 Migration: Add trace correlation columns
ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS trace_id UUID;
ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS span_id UUID;
ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS parent_span_id UUID;
ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS operation_name TEXT;
ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS span_status TEXT DEFAULT 'completed';

CREATE INDEX IF NOT EXISTS idx_agent_logs_trace_id ON agent_logs (trace_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_span_id ON agent_logs (span_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_parent_span_id ON agent_logs (parent_span_id);
