/**
 * KageOps Database Client
 *
 * Dual-mode: embedded PGlite (default, zero-Docker) or external Postgres pool.
 * Selection rule (see `embedded-pg.ts#isEmbeddedMode`):
 *   - KAGEOPS_DB_MODE=embedded|external takes precedence
 *   - DATABASE_URL set → external pg.Pool
 *   - otherwise        → embedded PGlite
 *
 * Query helpers and initDatabase() work identically in either mode.
 */

import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../shared/logger';
import {
    EmbeddedPool,
    closeEmbedded,
    getEmbeddedDb,
    isEmbeddedMode,
} from './embedded-pg';

const log = createLogger('DB');

// ── Types ────────────────────────────────────────────

export interface DbQueryResult<T extends QueryResultRow = QueryResultRow> {
    readonly rows: readonly T[];
    readonly rowCount: number;
}

interface DbClientOptions {
    readonly databaseUrl?: string;
    readonly maxRetries?: number;
    readonly retryDelayMs?: number;
}

/** Minimal Pool-shaped type that both pg.Pool and EmbeddedPool satisfy. */
type PoolLike = Pick<Pool, 'query' | 'end'> & { on(event: 'error', cb: (err: Error) => void): unknown };

// ── Constants ────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 2000;
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');
const SEED_PATH = path.join(__dirname, '..', 'db', 'seed.sql');
const GREENTHUMB_SCHEMA_PATH = path.join(__dirname, '..', 'db', 'greenthumb-schema.sql');

// ── Pool singleton ───────────────────────────────────

let pool: PoolLike | null = null;
let poolMode: 'embedded' | 'external' | null = null;

function getPoolConfig(databaseUrl: string): PoolConfig {
    return {
        connectionString: databaseUrl,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
    };
}

/**
 * Get or create the connection pool.
 * Never mutates existing pool — returns the singleton.
 */
export function getPool(databaseUrl?: string): PoolLike {
    if (pool !== null) {
        return pool;
    }

    if (isEmbeddedMode(databaseUrl)) {
        const embedded = new EmbeddedPool();
        embedded.on('error', (err: Error) => {
            log.error({ err: err.message }, 'Unexpected embedded pool error');
        });
        pool = embedded as unknown as PoolLike;
        poolMode = 'embedded';
        log.info('Using embedded Postgres (PGlite) — no Docker required.');
        return pool;
    }

    const url = databaseUrl ?? process.env['DATABASE_URL'] ?? '';
    if (url === '') {
        throw new Error('[KageOps DB] KAGEOPS_DB_MODE=external but DATABASE_URL is not set.');
    }
    const pgPool = new Pool(getPoolConfig(url));
    pgPool.on('error', (err) => {
        log.error({ err: err.message }, 'Unexpected pool error');
    });
    pool = pgPool;
    poolMode = 'external';
    log.info('Using external Postgres pool.');
    return pool;
}

/** Returns the active mode, or null if the pool has not been initialized yet. */
export function getPoolMode(): 'embedded' | 'external' | null {
    return poolMode;
}

// ── Query helpers ────────────────────────────────────

/**
 * Execute a parameterized SQL query.
 * Returns an immutable result with rows and rowCount.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly unknown[] = []
): Promise<DbQueryResult<T>> {
    const p = getPool();
    const result = (await p.query(sql, params as unknown[])) as QueryResult<T> | { rows: T[]; rowCount: number };
    return {
        rows: Object.freeze([...result.rows]),
        rowCount: (result as { rowCount?: number | null }).rowCount ?? result.rows.length,
    };
}

/**
 * Execute a query and return the first row, or null if none.
 */
export async function getOne<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly unknown[] = []
): Promise<T | null> {
    const result = await query<T>(sql, params);
    return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Execute a query and return all rows.
 */
export async function getMany<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly unknown[] = []
): Promise<readonly T[]> {
    const result = await query<T>(sql, params);
    return result.rows;
}

// ── Connection health ────────────────────────────────

/**
 * Test the database connection with retries.
 */
/**
 * Last connection-attempt error from testConnection(). Captured so
 * initDatabase() can include the actual cause (PGlite WASM load failure,
 * pg ECONNREFUSED, etc.) in its thrown error instead of the generic
 * "Cannot initialize — database connection failed" wrapper. In packaged
 * builds this is the only signal users get.
 */
let lastConnectionError: string | null = null;

export function getLastConnectionError(): string | null {
    return lastConnectionError;
}

export async function testConnection(options: DbClientOptions = {}): Promise<boolean> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    lastConnectionError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const p = getPool(options.databaseUrl);
            const result = await p.query('SELECT 1 AS ok');
            if ((result.rows[0] as { ok?: number } | undefined)?.ok === 1) {
                log.info({ mode: poolMode }, 'Connection verified.');
                lastConnectionError = null;
                return true;
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            lastConnectionError = message;
            log.warn({ attempt, maxRetries, err: message }, 'Connection attempt failed');
            if (attempt < maxRetries) {
                await sleep(retryDelay);
            }
        }
    }

    log.error({ err: lastConnectionError }, 'Failed to connect after all retries.');
    return false;
}

// ── Schema initialization ────────────────────────────

/**
 * Check if the core tables already exist.
 */
async function tablesExist(): Promise<boolean> {
    try {
        const result = await getOne<{ exists: boolean }>(
            `SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'public'
                AND table_name = 'projects'
            ) AS exists`
        );
        return result?.exists ?? false;
    } catch {
        return false;
    }
}

/**
 * Read and execute a SQL file.
 * Uses PGlite's `exec()` in embedded mode (multi-statement capable).
 */
async function executeSqlFile(filePath: string): Promise<void> {
    let resolvedPath = filePath;
    if (!fs.existsSync(resolvedPath)) {
        const rootPath = path.resolve(__dirname, '..', '..', 'src', 'db', path.basename(filePath));
        if (fs.existsSync(rootPath)) {
            resolvedPath = rootPath;
        } else {
            throw new Error(`SQL file not found: ${filePath} (also tried ${rootPath})`);
        }
    }

    const sql = fs.readFileSync(resolvedPath, 'utf-8');

    if (poolMode === 'embedded' || (poolMode === null && isEmbeddedMode())) {
        const db = await getEmbeddedDb();
        await db.exec(sql);
        return;
    }

    const p = getPool();
    await p.query(sql);
}

/**
 * Apply additive column migrations — safe to run on every startup.
 * All statements use IF NOT EXISTS / ON CONFLICT DO NOTHING semantics.
 */
async function runMigrations(): Promise<void> {
    const p = getPool();
    // v1.1 — response_text on tasks (persists full AI output for task detail view)
    await p.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS response_text TEXT`);

    // v2.4 — project lifecycle timestamps. The orchestrator writes
    //   cancelled_at / paused_at / archived_at on cancel/pause/archive
    //   transitions, but the original schema never declared them — so
    //   any old DB initialised before this migration blows up at the
    //   first cancel/pause click. Additive ALTERs are safe to re-run.
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS paused_at    TIMESTAMPTZ`);
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ`);

    // v2.6 — onboarding metadata. Captured up-front in the New Project
    // form so agents don't burn cycles guessing tech, goals, or which
    // phases the user actually wants. enabled_phases is the canonical
    // list; getNextPhase() skips any phase not in this array.
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type    TEXT`);
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS enabled_phases  TEXT[]`);
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS tech_stack      TEXT`);
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS goal            TEXT`);

    // v2.7 — per-project preset override (setup-wizard plan, Q5).
    // NULL means "inherit the global default preset at runtime"; a non-null
    // value names a `~/.kageops/agent-config.<value>.json` file that overrides
    // the global default for ALL agents in this project. Concurrent projects
    // with different presets work natively because every askAI() call is
    // project-scoped — no shared mutable agent config.
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS agent_config_preset TEXT`);

    // v1.2 — team_members table
    await p.query(`
        CREATE TABLE IF NOT EXISTS team_members (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL DEFAULT 'member',
            avatar_url TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_team_members_status ON team_members (status)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_team_members_email ON team_members (email)`);
    // v1.2 — agent_enabled flag on speciality_matrix (if not already added)
    await p.query(`ALTER TABLE speciality_matrix ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE`);

    // v1.3 — provider_keys table (multi-key registry per provider)
    await p.query(`
        CREATE TABLE IF NOT EXISTS provider_keys (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            provider TEXT NOT NULL,
            label TEXT NOT NULL,
            keychain_account TEXT,
            project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys (provider)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_provider_keys_project_id ON provider_keys (project_id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_provider_keys_default ON provider_keys (provider, is_default) WHERE is_default = true`);

    // v1.4 — project_documents table
    await p.query(`
        CREATE TABLE IF NOT EXISTS project_documents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER NOT NULL DEFAULT 0,
            mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
            uploaded_by TEXT NOT NULL DEFAULT 'user',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_project_documents_project_id ON project_documents (project_id)`);

    // v1.5 — runs (immutable archive) + incidents (self-healing memory)
    await p.query(`
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
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_runs_project_id ON runs (project_id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_runs_final_status ON runs (final_status)`);

    await p.query(`
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
        )
    `);
    await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_signature ON incidents (signature)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_incidents_agent ON incidents (agent)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_incidents_task_type ON incidents (task_type)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_incidents_last_seen ON incidents (last_seen DESC)`);

    // v0.11 Phase 2 — web_scrapes cache (firecrawl-inspired)
    // Mirrors src/db/migrations/011-web-scrapes.sql; inline here so the
    // table exists on fresh boots without running a separate migration step.
    await p.query(`
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
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_web_scrapes_url ON web_scrapes (url)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_web_scrapes_created_at ON web_scrapes (created_at DESC)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_web_scrapes_url_expires ON web_scrapes (url, expires_at DESC)`);

    // v0.11 Phase 3 — skills library (OpenSpace-inspired). Mirror of
    // src/db/migrations/012-skills.sql so the tables exist on every boot
    // regardless of whether that file was applied via the migration runner.
    await p.query(`
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
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_skills_name       ON skills (name)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_skills_source     ON skills (source)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_skills_tags       ON skills USING GIN (tags)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_skills_updated_at ON skills (updated_at DESC)`);
    // NOTE: IVFFlat embedding index intentionally skipped in iter 1 —
    // some PGlite builds reject ivfflat_cosine_ops. See migration 012.

    await p.query(`
        CREATE TABLE IF NOT EXISTS skill_evolutions (
            id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            skill_id          UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
            evolution_type    TEXT NOT NULL,
            trigger_task_id   UUID,
            notes             TEXT NOT NULL DEFAULT '',
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_skill_evolutions_skill_id   ON skill_evolutions (skill_id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_skill_evolutions_type       ON skill_evolutions (evolution_type)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_skill_evolutions_created_at ON skill_evolutions (created_at DESC)`);

    // v0.11 Phase 4 — prompt_optimizations (APO, agent-lightning-inspired).
    // Mirrors src/db/migrations/013-prompt-optimizations.sql so the table
    // exists on every boot without requiring the migration runner. First
    // iteration only records proposals — writing winners back to
    // agent-config.<preset>.json is deferred (B-476).
    await p.query(`
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
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_prompt_optimizations_agent_name   ON prompt_optimizations (agent_name)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_prompt_optimizations_created_at   ON prompt_optimizations (created_at DESC)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_prompt_optimizations_agent_created ON prompt_optimizations (agent_name, created_at DESC)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_prompt_optimizations_status       ON prompt_optimizations (status)`);

    // ─── F-302 PR A — team collaboration foundations ──────────────────────
    //
    // Migrations 016-021 in src/db/migrations/ are documentary; the runtime
    // path is this inline block. Without it the team panel calls SQL against
    // tables that never get created, and silently returns empty arrays.
    //
    // All DDL is idempotent so existing installs roll forward smoothly.

    // 016 — clerk_user_id / clerk_org_id on team_members
    await p.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS clerk_user_id TEXT`);
    await p.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS clerk_org_id  TEXT`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_team_members_clerk_user_id ON team_members (clerk_user_id)`);

    // 016 + 020 — project_assignments (with org_id and soft-delete)
    await p.query(`
        CREATE TABLE IF NOT EXISTS project_assignments (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            user_id      TEXT NOT NULL,
            user_name    TEXT NOT NULL,
            user_email   TEXT NOT NULL,
            role         TEXT NOT NULL DEFAULT 'observer'
                             CHECK (role IN ('owner', 'reviewer', 'observer')),
            assigned_by  TEXT,
            org_id       TEXT NOT NULL DEFAULT 'default',
            removed_at   TIMESTAMPTZ,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await p.query(`ALTER TABLE project_assignments ADD COLUMN IF NOT EXISTS org_id     TEXT NOT NULL DEFAULT 'default'`);
    await p.query(`ALTER TABLE project_assignments ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ`);
    // Active uniqueness: a removed user can be re-invited but a duplicate
    // active membership is rejected. Drop the older non-conditional index if
    // present — it's incompatible with the soft-delete semantics.
    await p.query(`DROP INDEX IF EXISTS idx_project_assignments_unique`);
    await p.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_project_assignments_active_unique
            ON project_assignments (project_id, user_id)
            WHERE removed_at IS NULL
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_project_assignments_org_id ON project_assignments (org_id)`);

    // 017 + 020 — human_activity_log with org_id
    await p.query(`
        CREATE TABLE IF NOT EXISTS human_activity_log (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id    TEXT NOT NULL,
            user_name  TEXT NOT NULL,
            project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
            task_id    UUID REFERENCES tasks(id)    ON DELETE SET NULL,
            action     TEXT NOT NULL,
            detail     TEXT,
            org_id     TEXT NOT NULL DEFAULT 'default',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await p.query(`ALTER TABLE human_activity_log ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default'`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_human_activity_log_user_id    ON human_activity_log (user_id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_human_activity_log_project_id ON human_activity_log (project_id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_human_activity_log_created_at ON human_activity_log (created_at DESC)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_human_activity_log_org_id     ON human_activity_log (org_id)`);

    // 018 — task claim columns
    await p.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claimed_by_user_id   TEXT`);
    await p.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claimed_by_user_name TEXT`);
    await p.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claimed_at           TIMESTAMPTZ`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by_user_id ON tasks (claimed_by_user_id)`);

    // 018 + 020 — task_comments with org_id
    await p.query(`
        CREATE TABLE IF NOT EXISTS task_comments (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            author_id   TEXT NOT NULL,
            author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent')),
            author_name TEXT NOT NULL,
            body        TEXT NOT NULL,
            org_id      TEXT NOT NULL DEFAULT 'default',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await p.query(`ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default'`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_task_comments_task_id ON task_comments (task_id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_task_comments_org_id  ON task_comments (org_id)`);

    // 019 — org_settings
    await p.query(`
        CREATE TABLE IF NOT EXISTS org_settings (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id     TEXT NOT NULL UNIQUE,
            settings   JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await p.query(`
        INSERT INTO org_settings (org_id, settings)
        VALUES ('default', '{"connectors": {}}')
        ON CONFLICT (org_id) DO NOTHING
    `);

    // 020 — team_members.org_id (alias of clerk_org_id, defaults to 'default')
    await p.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default'`);
    await p.query(`UPDATE team_members SET org_id = COALESCE(NULLIF(clerk_org_id, ''), 'default') WHERE org_id = 'default'`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_team_members_org_id ON team_members (org_id)`);

    // 021 — sensei_messages (persistent shared chat history)
    await p.query(`
        CREATE TABLE IF NOT EXISTS sensei_messages (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
            org_id          TEXT NOT NULL DEFAULT 'default',
            role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            author_user_id  TEXT,
            author_name     TEXT NOT NULL,
            author_role     TEXT,
            content         TEXT NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_sensei_messages_project_ts ON sensei_messages (project_id, created_at)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_sensei_messages_org_id     ON sensei_messages (org_id)`);

    // 022 — tasks.updated_at + auto-update trigger for optimistic locking.
    // Without this, two team members racing 'Claim' silently overwrite.
    await p.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await p.query(`DROP TRIGGER IF EXISTS tasks_updated_at ON tasks`);
    await p.query(`
        CREATE TRIGGER tasks_updated_at
            BEFORE UPDATE ON tasks
            FOR EACH ROW EXECUTE FUNCTION update_updated_at()
    `);

    // 023 — ownership_transfers (PR F of F-302 V1, F-326).
    // Team-tier-gated; accept-before-effect; 7-day expiry default.
    await p.query(`
        CREATE TABLE IF NOT EXISTS ownership_transfers (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            org_id          TEXT NOT NULL DEFAULT 'default',
            from_user_id    TEXT NOT NULL,
            from_user_name  TEXT NOT NULL,
            to_user_id      TEXT NOT NULL,
            to_user_name    TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
            requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved_at     TIMESTAMPTZ,
            expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
            note            TEXT
        )
    `);
    await p.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ownership_transfers_one_pending_per_project
            ON ownership_transfers (project_id)
            WHERE status = 'pending'
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_ownership_transfers_to_user ON ownership_transfers (to_user_id, status)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_ownership_transfers_org_id  ON ownership_transfers (org_id)`);

    // 024 — phase_task_selections (issue #165). Per-project JSONB carrying
    // the operator's per-phase task-type checklist. NULL = LLM picks freely
    // from the phase's allowed task types (today's behaviour). When set,
    // the decomposer injects a HARD CONSTRAINT block listing only those
    // task types so quality doesn't degrade when phases are skipped.
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS phase_task_selections JSONB DEFAULT NULL`);

    // 025 — task_checkpoints (Devin-parity Phase 1 — P1-01). One row per
    // resumable operation inside a task. Mirrors `migrations/025-task-
    // checkpoints.sql`; the inline DDL here is what runs on PGlite boot.
    // No call sites read/write this yet — wiring lands in P1-01b/c/d.
    await p.query(`
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
        )
    `);
    await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_checkpoints_task_op ON task_checkpoints (task_id, op_index)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task_created   ON task_checkpoints (task_id, created_at)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_task_checkpoints_status         ON task_checkpoints (status)`);

    // 026 — project iteration tracking (Devin-parity Phase 1 — P1-05a).
    // Mirrors `migrations/026-iterations.sql`. New columns on `projects`
    // for fast UI queries + a sibling `iterations` table that groups all
    // tasks from a single reopen cycle. Iteration 0 = original build.
    // Schema-only at this layer — Sensei wiring (startProject writes
    // iteration 0, reopenProject increments + writes N+1, closeProject
    // sets ended_at) lives in src/orchestrator/sensei.ts. The columns +
    // table sit at default values + empty until that wiring runs.
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS reopen_count INTEGER NOT NULL DEFAULT 0`);
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_reopened_at TIMESTAMPTZ NULL`);
    await p.query(`
        CREATE TABLE IF NOT EXISTS iterations (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            iteration_index  INTEGER NOT NULL,
            started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ended_at         TIMESTAMPTZ NULL,
            requirement_text TEXT NULL,
            UNIQUE (project_id, iteration_index)
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_iterations_project ON iterations (project_id, iteration_index)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_iterations_open ON iterations (project_id) WHERE ended_at IS NULL`);

    // 027 — revision-task metadata (Devin-parity Phase 1 — P1-06a).
    // Mirrors `migrations/027-revision-tasks.sql`. New columns on `tasks`
    // for grouping into iteration cycles + carrying the operator's
    // natural-language change instruction through to Forge's revision
    // handler (P1-06b). No CHECK on task_type (it's free-text); the
    // string 'revision' is the new well-known value.
    await p.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS iteration_id UUID NULL REFERENCES iterations(id) ON DELETE SET NULL`);
    await p.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_files JSONB NULL`);
    await p.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS revision_instruction TEXT NULL`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_tasks_iteration ON tasks (iteration_id) WHERE iteration_id IS NOT NULL`);

    // 028 — selected bundle (Devin-parity Pillar 1.3 / P1-11).
    // Wires what migrations/028-selected-bundle.sql declared. P1-11 added
    // the .sql file but never the inline ALTER; bundle dispatch could
    // therefore never write to the column on a fresh PGlite. Surfaced
    // during the P2-01 smoke (column missing on a fresh data dir).
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS selected_bundle TEXT NULL`);

    // 029 — preview URL (Devin-parity Pillar 2.1 / P2-04). Aegis's
    // deploy-preview task writes here; AcceptanceGate v2 reads it.
    // Mirror of migrations/029-preview-url.sql.
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_url TEXT NULL`);

    // 030 — encrypted per-project deployment config (Devin-parity Pillar 2.2 / D-D).
    // Holds the bundle-declared env values the operator pastes in the
    // New-Project modal (Neon URL, Clerk keys, Stripe keys). Always
    // encrypted via Electron safeStorage before write. Opaque to SQL.
    // Mirror of migrations/030-deployment-config.sql.
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS deployment_config BYTEA NULL`);

    // 031 — Pillar 2.4 Cloud Burst data model.
    // Adds projects.client_id (per-client tagging, D-O), burst_pools
    // (operator-level Azure subscription config), and burst_tasks
    // (per-burst lifecycle). Mirror of migrations/031-burst-pool-client-id.sql.
    await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_id TEXT NULL`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects (client_id) WHERE client_id IS NOT NULL`);

    await p.query(`
        CREATE TABLE IF NOT EXISTS burst_pools (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name                TEXT NOT NULL UNIQUE,
            subscription_id     TEXT NOT NULL,
            resource_group      TEXT NOT NULL,
            container_registry  TEXT NOT NULL,
            default_region      TEXT NOT NULL,
            budget_cap_usd      NUMERIC(10, 2) NOT NULL DEFAULT 5.00,
            enabled             BOOLEAN NOT NULL DEFAULT TRUE,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await p.query(`
        CREATE TABLE IF NOT EXISTS burst_tasks (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            task_id             TEXT NOT NULL,
            project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            pool_id             UUID NOT NULL REFERENCES burst_pools(id) ON DELETE RESTRICT,
            agent_role          TEXT NOT NULL,
            container_id        TEXT NULL,
            region              TEXT NOT NULL,
            status              TEXT NOT NULL DEFAULT 'queued',
            cost_usd            NUMERIC(10, 4) NOT NULL DEFAULT 0,
            requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            started_at          TIMESTAMPTZ NULL,
            completed_at        TIMESTAMPTZ NULL,
            last_heartbeat_at   TIMESTAMPTZ NULL,
            error_message       TEXT NULL,
            CONSTRAINT burst_tasks_status_check CHECK (
                status IN ('queued', 'provisioning', 'running', 'completed', 'failed', 'timeout')
            )
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_burst_tasks_project ON burst_tasks (project_id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_burst_tasks_status ON burst_tasks (status) WHERE status IN ('queued', 'provisioning', 'running')`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_burst_tasks_pool ON burst_tasks (pool_id)`);

    // 032 — Pillar 2.5 Azure Environments registry (D-A / D-C).
    // Expand phase: add azure_environments + a nullable burst_pools FK and
    // backfill one environment per existing pool. The duplicated pool
    // columns stay in place during the transition (contract phase drops
    // them later). Lands before 2.4 PR-E.2 so dispatch references the
    // environment, not entrenched duplicate coordinates.
    // Mirror of migrations/032-azure-environments.sql.
    await p.query(`
        CREATE TABLE IF NOT EXISTS azure_environments (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            label               TEXT NOT NULL UNIQUE,
            subscription_id     TEXT NOT NULL,
            resource_group      TEXT NOT NULL,
            default_region      TEXT NOT NULL,
            tenant_id           TEXT NULL,
            credential_ref      TEXT NULL,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await p.query(`
        ALTER TABLE burst_pools
            ADD COLUMN IF NOT EXISTS environment_id UUID NULL
                REFERENCES azure_environments(id) ON DELETE RESTRICT
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_burst_pools_environment ON burst_pools (environment_id) WHERE environment_id IS NOT NULL`);
    await p.query(`
        INSERT INTO azure_environments (label, subscription_id, resource_group, default_region)
        SELECT p.name, p.subscription_id, p.resource_group, p.default_region
        FROM burst_pools p
        WHERE p.environment_id IS NULL
        ON CONFLICT (label) DO NOTHING
    `);
    await p.query(`
        UPDATE burst_pools p
        SET environment_id = e.id
        FROM azure_environments e
        WHERE p.environment_id IS NULL
          AND e.label = p.name
    `);

    // 033 — Pillar 2.5 PR-E deploy_targets registry (P2.5-04).
    // One row = "deploy THIS project to THIS environment as THIS service
    // type, named THIS app." environment_id RESTRICT (can't orphan a
    // target); project_id SET NULL on project delete (a live billed
    // resource must stay visible + tear-down-able — D-J).
    // Mirror of migrations/033-deploy-targets.sql.
    await p.query(`
        CREATE TABLE IF NOT EXISTS deploy_targets (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            environment_id  UUID NOT NULL REFERENCES azure_environments(id) ON DELETE RESTRICT,
            project_id      UUID NULL REFERENCES projects(id) ON DELETE SET NULL,
            service_type    TEXT NOT NULL,
            app_name        TEXT NOT NULL,
            config          JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT deploy_targets_service_type_check
                CHECK (service_type IN ('app-service', 'static-web-app')),
            CONSTRAINT deploy_targets_env_app_unique UNIQUE (environment_id, app_name)
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_deploy_targets_environment ON deploy_targets (environment_id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_deploy_targets_project ON deploy_targets (project_id) WHERE project_id IS NOT NULL`);

    // 034 — Pillar 2.5 PR-F deploy_runs (deploy run/history state).
    // One row per deploy attempt; the orchestrator transitions it
    // queued → provisioning → deploying → live (or → failed). target_id
    // CASCADE (history belongs to the target); project_id snapshotted so
    // history survives the target's project_id being nulled.
    // Mirror of migrations/034-deploy-runs.sql.
    await p.query(`
        CREATE TABLE IF NOT EXISTS deploy_runs (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            target_id       UUID NOT NULL REFERENCES deploy_targets(id) ON DELETE CASCADE,
            project_id      UUID NULL,
            status          TEXT NOT NULL DEFAULT 'queued',
            live_url        TEXT NULL,
            detail          TEXT NULL,
            error_message   TEXT NULL,
            started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            finished_at     TIMESTAMPTZ NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT deploy_runs_status_check
                CHECK (status IN ('queued', 'provisioning', 'deploying', 'live', 'failed'))
        )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_deploy_runs_target ON deploy_runs (target_id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_deploy_runs_active ON deploy_runs (status) WHERE status IN ('queued', 'provisioning', 'deploying')`);
}

/**
 * Initialize the database — runs schema.sql if tables don't exist.
 * Safe to call multiple times (idempotent).
 */
export async function initDatabase(options: DbClientOptions = {}): Promise<void> {
    const connected = await testConnection(options);
    if (!connected) {
        const cause = lastConnectionError ?? '(no further detail captured)';
        const modeHint = poolMode === 'embedded' || (poolMode === null && isEmbeddedMode(options.databaseUrl))
            ? 'embedded PGlite'
            : 'external Postgres';
        throw new Error(
            `[KageOps DB] Cannot initialize ${modeHint} — ${cause}`,
        );
    }

    const exists = await tablesExist();
    if (exists) {
        log.info('Tables already exist — skipping schema init.');
        await runMigrations();
        return;
    }

    log.info('Initializing database schema...');
    await executeSqlFile(SCHEMA_PATH);
    log.info('Schema applied.');

    log.info('Seeding default data...');
    await executeSqlFile(SEED_PATH);
    log.info('Seed data inserted.');

    await runMigrations();

    log.info('Database initialization complete.');

    // GreenThumb schema — idempotent, safe to run on every boot
    await initGreenThumbSchema();
}

/**
 * Apply the GreenThumb schema (gt_plants, gt_collection, gt_watering_log, gt_reminders).
 * Uses CREATE TABLE IF NOT EXISTS — safe to call on every startup.
 */
export async function initGreenThumbSchema(): Promise<void> {
    try {
        await executeSqlFile(GREENTHUMB_SCHEMA_PATH);
        log.info('GreenThumb schema applied.');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err: message }, 'GreenThumb schema migration skipped or failed — non-critical.');
    }
}

// ── Shutdown ─────────────────────────────────────────

/**
 * Gracefully close the connection pool (and the embedded PGlite instance, if any).
 */
export async function closePool(): Promise<void> {
    if (pool !== null) {
        await pool.end();
        pool = null;
    }
    if (poolMode === 'embedded') {
        await closeEmbedded();
    }
    poolMode = null;
    log.info('Connection pool closed.');
}

// ── Utilities ────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
