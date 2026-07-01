-- ═══════════════════════════════════════════════════════
--  KageOps Database Schema
--  PostgreSQL 16 + pgvector
-- ═══════════════════════════════════════════════════════

-- Enable extensions
-- Note: gen_random_uuid() is built into Postgres 17+ (pgcrypto is automatic).
-- PGlite loads vector via the `extensions: { vector }` constructor option.
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Helper: auto-update updated_at ────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════
--  CORE TABLES
-- ═══════════════════════════════════════════════════════

-- ── Projects ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    repo_path TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'discovery',
    trust_level TEXT NOT NULL DEFAULT 'low',
    autonomous_after_design BOOLEAN DEFAULT FALSE,
    budget_usd NUMERIC(10,2) DEFAULT NULL,
    spent_usd NUMERIC(10,6) DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    github_owner TEXT,
    github_repo  TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Lifecycle timestamps written by orchestrator on state transitions.
    cancelled_at TIMESTAMPTZ,
    paused_at    TIMESTAMPTZ,
    archived_at  TIMESTAMPTZ
);

CREATE TRIGGER projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
CREATE INDEX IF NOT EXISTS idx_projects_phase ON projects (phase);

-- ── Tasks ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    task_type TEXT,
    phase TEXT NOT NULL,
    assigned_agent TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 0,
    depends_on UUID[] DEFAULT '{}',
    output_path TEXT,
    quality_score NUMERIC(3,1),
    branch_name TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    response_text TEXT,
    github_issue INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks (assigned_agent);
CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks (phase);
CREATE INDEX IF NOT EXISTS idx_tasks_project_phase ON tasks (project_id, phase);

-- ── Agent Logs ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    agent TEXT NOT NULL,
    action TEXT NOT NULL,
    event_type TEXT,
    model_used TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    cost_usd NUMERIC(10,6) DEFAULT 0,
    quality_score NUMERIC(3,1),
    duration_ms INTEGER,
    output_summary TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_logs_project_id ON agent_logs (project_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_task_id ON agent_logs (task_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_agent ON agent_logs (agent);
CREATE INDEX IF NOT EXISTS idx_agent_logs_event_type ON agent_logs (event_type);
CREATE INDEX IF NOT EXISTS idx_agent_logs_created_at ON agent_logs (created_at DESC);

-- Full-text search on agent logs
ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english', COALESCE(action, '') || ' ' || COALESCE(output_summary, ''))
    ) STORED;
CREATE INDEX IF NOT EXISTS idx_agent_logs_search ON agent_logs USING GIN (search_vector);

-- ── Speciality Matrix ─────────────────────────────────
CREATE TABLE IF NOT EXISTS speciality_matrix (
    agent TEXT NOT NULL,
    skill TEXT NOT NULL,
    score NUMERIC(3,1) NOT NULL DEFAULT 5.0,
    benchmark_count INTEGER NOT NULL DEFAULT 0,
    task_success_count INTEGER NOT NULL DEFAULT 0,
    task_failure_count INTEGER NOT NULL DEFAULT 0,
    last_benchmarked TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent, skill)
);

CREATE TRIGGER speciality_matrix_updated_at
    BEFORE UPDATE ON speciality_matrix
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_speciality_matrix_agent ON speciality_matrix (agent);
CREATE INDEX IF NOT EXISTS idx_speciality_matrix_skill ON speciality_matrix (skill);

-- ── Decisions (Architecture Decision Records) ─────────
CREATE TABLE IF NOT EXISTS decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    context TEXT,
    decision TEXT NOT NULL,
    alternatives TEXT,
    consequences TEXT,
    status TEXT NOT NULL DEFAULT 'proposed',
    decided_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER decisions_updated_at
    BEFORE UPDATE ON decisions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_decisions_project_id ON decisions (project_id);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions (status);

-- Full-text search on decisions
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(context, '') || ' ' || COALESCE(decision, ''))
    ) STORED;
CREATE INDEX IF NOT EXISTS idx_decisions_search ON decisions USING GIN (search_vector);

-- ── Team Members ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'member',
    avatar_url TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER team_members_updated_at
    BEFORE UPDATE ON team_members
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_team_members_status ON team_members (status);
CREATE INDEX IF NOT EXISTS idx_team_members_email ON team_members (email);

-- ── Project Documents ──────────────────────────────────
CREATE TABLE IF NOT EXISTS project_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    uploaded_by TEXT NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_documents_project_id ON project_documents (project_id);

-- ── Communication Queue ───────────────────────────────
CREATE TABLE IF NOT EXISTS comms_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    channel TEXT NOT NULL,
    recipient TEXT,
    subject TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comms_queue_status ON comms_queue (status);
CREATE INDEX IF NOT EXISTS idx_comms_queue_project_id ON comms_queue (project_id);
CREATE INDEX IF NOT EXISTS idx_comms_queue_channel ON comms_queue (channel);

-- ── Build Status ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS build_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    pipeline TEXT NOT NULL,
    run_id TEXT,
    status TEXT NOT NULL,
    branch TEXT,
    commit_sha TEXT,
    url TEXT,
    log_summary TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_build_status_project_id ON build_status (project_id);
CREATE INDEX IF NOT EXISTS idx_build_status_status ON build_status (status);

-- ═══════════════════════════════════════════════════════
--  VECTOR TABLES (pgvector)
-- ═══════════════════════════════════════════════════════

-- ── Document Embeddings ───────────────────────────────
CREATE TABLE IF NOT EXISTS doc_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_embeddings_project_id ON doc_embeddings (project_id);
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_file_path ON doc_embeddings (file_path);

-- IVFFlat index for cosine similarity (created after data exists for best accuracy,
-- but we create it here with a low list count for initial use)
-- Note: For production with >10k rows, recreate with higher lists value
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_vector
    ON doc_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

-- ── Code Summaries (vector) ───────────────────────────
CREATE TABLE IF NOT EXISTS code_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    symbol_name TEXT,
    symbol_type TEXT,
    summary TEXT NOT NULL,
    embedding VECTOR(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_code_summaries_project_id ON code_summaries (project_id);
CREATE INDEX IF NOT EXISTS idx_code_summaries_file_path ON code_summaries (file_path);

CREATE INDEX IF NOT EXISTS idx_code_summaries_vector
    ON code_summaries USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

-- Full-text search on code summaries
ALTER TABLE code_summaries ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english', COALESCE(symbol_name, '') || ' ' || COALESCE(summary, ''))
    ) STORED;
CREATE INDEX IF NOT EXISTS idx_code_summaries_search ON code_summaries USING GIN (search_vector);

-- ═══════════════════════════════════════════════════════
--  COST INTELLIGENCE (v0.7)
-- ═══════════════════════════════════════════════════════

-- ── Operational Costs ─────────────────────────────────
-- Tracks platform-level AI spend synced from LiteLLM_SpendLogs.
-- Two cost types:
--   'project'  = tokens agents spent building user projects
--   'platform' = KageOps overhead (Sensei, phase gates, etc.)
CREATE TABLE IF NOT EXISTS operational_costs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent TEXT,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
    -- Deduplication key: matches LiteLLM_SpendLogs.request_id
    -- ON CONFLICT DO NOTHING prevents double-counting on restart
    litellm_request_id TEXT UNIQUE,
    cost_type TEXT NOT NULL DEFAULT 'project'
        CHECK (cost_type IN ('project', 'platform')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operational_costs_agent ON operational_costs (agent);
CREATE INDEX IF NOT EXISTS idx_operational_costs_project_id ON operational_costs (project_id);
CREATE INDEX IF NOT EXISTS idx_operational_costs_provider ON operational_costs (provider);
CREATE INDEX IF NOT EXISTS idx_operational_costs_model ON operational_costs (model);
CREATE INDEX IF NOT EXISTS idx_operational_costs_created_at ON operational_costs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_costs_cost_type ON operational_costs (cost_type);

-- ═══════════════════════════════════════════════════════
--  RUNS & INCIDENTS (self-healing v1.0)
-- ═══════════════════════════════════════════════════════

-- ── Runs (immutable archive of every pipeline run) ────
-- Never deleted by cleanup scripts. Used as a historical ledger
-- for learning from successful and failed runs.
CREATE TABLE IF NOT EXISTS runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    project_name TEXT NOT NULL,
    description_hash TEXT,
    trust_level TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    final_phase TEXT,
    final_status TEXT,
    tasks_completed INTEGER NOT NULL DEFAULT 0,
    tasks_failed INTEGER NOT NULL DEFAULT 0,
    total_tokens_in BIGINT NOT NULL DEFAULT 0,
    total_tokens_out BIGINT NOT NULL DEFAULT 0,
    total_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
    killed_by_budget BOOLEAN NOT NULL DEFAULT FALSE,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_project_id ON runs (project_id);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_final_status ON runs (final_status);

-- ── Incidents (failure signatures + fixes for reflexion) ─
-- Populated by the post-task reflector on task.failed. Semantic
-- deduplication via `signature` — times_seen increments when the
-- same signature recurs.
CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signature TEXT NOT NULL,
    agent TEXT,
    task_type TEXT,
    symptom TEXT NOT NULL,
    root_cause TEXT,
    suggested_fix TEXT,
    fix_applied TEXT,
    worked BOOLEAN,
    times_seen INTEGER NOT NULL DEFAULT 1,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    last_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    embedding VECTOR(1536)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_signature ON incidents (signature);
CREATE INDEX IF NOT EXISTS idx_incidents_agent ON incidents (agent);
CREATE INDEX IF NOT EXISTS idx_incidents_task_type ON incidents (task_type);
CREATE INDEX IF NOT EXISTS idx_incidents_last_seen ON incidents (last_seen DESC);

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english', COALESCE(symptom, '') || ' ' || COALESCE(root_cause, '') || ' ' || COALESCE(suggested_fix, ''))
    ) STORED;
CREATE INDEX IF NOT EXISTS idx_incidents_search ON incidents USING GIN (search_vector);
