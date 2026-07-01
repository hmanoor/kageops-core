/**
 * Artifact Browser IPC + custom protocol (B-420 / B-421 / B-422).
 *
 * Focused main-process module that wires three concerns:
 *
 *   • `artifacts:list-tree`  — recursive file tree (B-420)
 *   • `artifacts:read-file`  — file preview payloads (B-421)
 *   • `kageops-artifact://`  — file-protocol proxy used by the sandboxed
 *                              HTML iframe preview (B-422)
 *
 * All paths are resolved against `project.repo_path` and rejected if
 * they escape the project root. The protocol handler uses the same
 * `resolveSafeWorkspacePath` guard as the renderer IPC handlers so a
 * single rule applies to every external surface.
 */

import { ipcMain, protocol } from 'electron';
import * as path from 'path';
import { IPC } from '../shared/ipc-channels';
import {
    ArtifactService,
    resolveSafeWorkspacePath,
    type FileNode,
    type FileReadResult,
    TREE_MAX_DEPTH_DEFAULT,
} from '../workspace/artifact-service';
import { getOne } from '../db/client';
import {
    searchWorkspace,
    type FileSearchHit,
    type SearchWorkspaceOptions,
} from '../workspace/artifact-search';
import { createLogger } from '../shared/logger';

const log = createLogger('ArtifactBrowserIPC');

// ── Types ────────────────────────────────────────────

export interface ListTreeArgs {
    readonly projectId: string;
    readonly maxDepth?: number;
}

export interface ListTreeResponse {
    readonly success: boolean;
    readonly error?: string;
    readonly nodes: readonly FileNode[];
}

export interface ReadFileArgs {
    readonly projectId: string;
    readonly relPath: string;
}

export interface ReadFileResponse {
    readonly success: boolean;
    readonly error?: string;
    readonly file?: FileReadResult;
}

// ── B-428: task-level file metadata ──────────────────

export interface TaskDetailsArgs {
    readonly projectId: string;
    readonly taskId: string;
}

/**
 * Rich task metadata for a single artifact file — the full tasks row
 * plus aggregated agent_logs (total cost, tokens, last model used).
 * Returned by `ARTIFACT_GET_TASK_DETAILS` when a file's producer is known.
 */
export interface FileTaskDetails {
    readonly id: string;
    readonly title: string;
    readonly description: string | null;
    readonly status: string;
    readonly phase: string;
    readonly taskType: string | null;
    readonly assignedAgent: string | null;
    readonly retryCount: number;
    readonly qualityScore: number | null;
    readonly errorMessage: string | null;
    readonly branchName: string | null;
    readonly outputPath: string | null;
    readonly createdAtIso: string;
    readonly startedAtIso: string | null;
    readonly completedAtIso: string | null;
    /** SUM of agent_logs.cost_usd for this task — null when no logs exist. */
    readonly totalCostUsd: number | null;
    readonly totalTokensIn: number | null;
    readonly totalTokensOut: number | null;
    /** Last model observed on an agent_logs row for this task — null when no logs exist. */
    readonly lastModel: string | null;
}

export interface TaskDetailsResponse {
    readonly success: boolean;
    readonly error?: string;
    readonly task?: FileTaskDetails | null;
}

// ── B-429: content search ────────────────────────────

export interface SearchArgs {
    readonly projectId: string;
    readonly query: string;
    readonly caseSensitive?: boolean;
    readonly regex?: boolean;
    readonly maxResults?: number;
}

export interface SearchResponse {
    readonly success: boolean;
    readonly error?: string;
    readonly results: readonly FileSearchHit[];
    readonly totalMatches: number;
    readonly truncated: boolean;
    readonly durationMs: number;
    readonly filesScanned: number;
}

export interface ArtifactProtocolDeps {
    /** Returns the project root (repo_path) for a given project id, or null. */
    readonly lookupProjectRoot: (projectId: string) => Promise<string | null>;
}

export const ARTIFACT_PROTOCOL_SCHEME = 'kageops-artifact';

// ── Schema registration ──────────────────────────────

/**
 * Register the custom protocol scheme. MUST be called before
 * `app.whenReady()` resolves — Electron does not allow privileged
 * schemes to be registered after the app is ready.
 */
export function registerArtifactSchemesAsPrivileged(): void {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: ARTIFACT_PROTOCOL_SCHEME,
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: false,
                corsEnabled: false,
                bypassCSP: false,
            },
        },
    ]);
}

// ── Handler registration ─────────────────────────────

/**
 * Register the `kageops-artifact://` file protocol and the list-tree /
 * read-file IPC channels. Idempotent — call once during app startup.
 */
export function registerArtifactBrowserHandlers(deps: ArtifactProtocolDeps): void {
    const service = new ArtifactService();

    registerListTreeHandler(service);
    registerReadFileHandler(service);
    registerTaskDetailsHandler();
    registerSearchHandler(service);
    registerFileProtocol(deps);
}

function registerListTreeHandler(service: ArtifactService): void {
    ipcMain.handle(IPC.ARTIFACT_LIST_TREE, async (_event, raw: unknown): Promise<ListTreeResponse> => {
        return handleListTree(service, raw);
    });
}

function registerReadFileHandler(service: ArtifactService): void {
    ipcMain.handle(IPC.ARTIFACT_READ_FILE, async (_event, raw: unknown): Promise<ReadFileResponse> => {
        return handleReadFile(service, raw);
    });
}

function registerTaskDetailsHandler(): void {
    ipcMain.handle(IPC.ARTIFACT_GET_TASK_DETAILS, async (_event, raw: unknown): Promise<TaskDetailsResponse> => {
        return handleTaskDetails(raw);
    });
}

function registerSearchHandler(service: ArtifactService): void {
    ipcMain.handle(IPC.ARTIFACT_SEARCH, async (_event, raw: unknown): Promise<SearchResponse> => {
        return handleArtifactSearch(service, raw);
    });
}

// ── Handlers (exported for testing) ──────────────────

export async function handleListTree(
    service: Pick<ArtifactService, 'listTree'>,
    raw: unknown,
): Promise<ListTreeResponse> {
    const args = coerceListTreeArgs(raw);
    if (args === null) {
        return { success: false, error: 'Invalid projectId', nodes: [] };
    }
    try {
        const nodes = await service.listTree(args.projectId, args.maxDepth ?? TREE_MAX_DEPTH_DEFAULT);
        return { success: true, nodes };
    } catch (err) {
        return { success: false, error: errorMessage(err), nodes: [] };
    }
}

export async function handleReadFile(
    service: Pick<ArtifactService, 'readFile'>,
    raw: unknown,
): Promise<ReadFileResponse> {
    const args = coerceReadFileArgs(raw);
    if (args === null) {
        return { success: false, error: 'Invalid arguments' };
    }
    try {
        const file = await service.readFile(args.projectId, args.relPath);
        return { success: true, file };
    } catch (err) {
        return { success: false, error: errorMessage(err) };
    }
}

/**
 * Row shape returned by the tasks + agent_logs LEFT JOIN query.
 * Exported for test fixture construction.
 */
export interface RawTaskDetailsRow {
    readonly id: string;
    readonly title: string;
    readonly description: string | null;
    readonly status: string;
    readonly phase: string;
    readonly task_type: string | null;
    readonly assigned_agent: string | null;
    readonly retry_count: number;
    readonly quality_score: number | string | null;
    readonly error_message: string | null;
    readonly branch_name: string | null;
    readonly output_path: string | null;
    readonly created_at: Date | string;
    readonly started_at: Date | string | null;
    readonly completed_at: Date | string | null;
    readonly total_cost_usd: number | string | null;
    readonly total_tokens_in: number | string | null;
    readonly total_tokens_out: number | string | null;
    readonly last_model: string | null;
}

const TASK_DETAILS_SQL = `
    SELECT
        t.id,
        t.title,
        t.description,
        t.status,
        t.phase,
        t.task_type,
        t.assigned_agent,
        t.retry_count,
        t.quality_score,
        t.error_message,
        t.branch_name,
        t.output_path,
        t.created_at,
        t.started_at,
        t.completed_at,
        (SELECT SUM(cost_usd) FROM agent_logs WHERE task_id = t.id) AS total_cost_usd,
        (SELECT SUM(tokens_in) FROM agent_logs WHERE task_id = t.id) AS total_tokens_in,
        (SELECT SUM(tokens_out) FROM agent_logs WHERE task_id = t.id) AS total_tokens_out,
        (SELECT model_used FROM agent_logs WHERE task_id = t.id AND model_used IS NOT NULL
         ORDER BY created_at DESC LIMIT 1) AS last_model
    FROM tasks t
    WHERE t.id = $1 AND t.project_id = $2
    LIMIT 1
`;

/**
 * Injectable DB query for testability. The default is the shared
 * `getOne<RawTaskDetailsRow>` — kept monomorphic on `RawTaskDetailsRow`
 * so tests can pass a simple `vi.fn()` without matching the full generic
 * signature of the real helper.
 */
export type TaskDetailsQuery = (
    sql: string,
    params: readonly unknown[],
) => Promise<RawTaskDetailsRow | null>;

const defaultTaskDetailsQuery: TaskDetailsQuery = (sql, params) =>
    getOne<RawTaskDetailsRow>(sql, params);

/**
 * Handler for `ARTIFACT_GET_TASK_DETAILS`. Exported with an injectable
 * `queryOne` so tests can substitute a mock without touching the real DB.
 * Defaults to the shared `getOne` helper in production.
 */
export async function handleTaskDetails(
    raw: unknown,
    queryOne: TaskDetailsQuery = defaultTaskDetailsQuery,
): Promise<TaskDetailsResponse> {
    const args = coerceTaskDetailsArgs(raw);
    if (args === null) {
        return { success: false, error: 'Invalid arguments' };
    }
    try {
        const row = await queryOne(TASK_DETAILS_SQL, [args.taskId, args.projectId]);
        return { success: true, task: row === null ? null : mapTaskDetailsRow(row) };
    } catch (err) {
        return { success: false, error: errorMessage(err) };
    }
}

/**
 * Convert a DB row into the renderer-facing `FileTaskDetails` shape.
 * Normalizes PostgreSQL NUMERIC (sometimes string) and Date (timestamptz)
 * values to plain numbers / ISO strings so the renderer can stay JSON-only.
 * Exported for test coverage of the mapping.
 */
export function mapTaskDetailsRow(row: RawTaskDetailsRow): FileTaskDetails {
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        phase: row.phase,
        taskType: row.task_type,
        assignedAgent: row.assigned_agent,
        retryCount: safeNumber(row.retry_count) ?? 0,
        qualityScore: safeNullableNumber(row.quality_score),
        errorMessage: row.error_message,
        branchName: row.branch_name,
        outputPath: row.output_path,
        createdAtIso: safeToIso(row.created_at) ?? String(row.created_at),
        startedAtIso: row.started_at === null ? null : safeToIso(row.started_at),
        completedAtIso: row.completed_at === null ? null : safeToIso(row.completed_at),
        totalCostUsd: safeNullableNumber(row.total_cost_usd),
        totalTokensIn: safeNullableNumber(row.total_tokens_in),
        totalTokensOut: safeNullableNumber(row.total_tokens_out),
        lastModel: row.last_model,
    };
}

/**
 * Coerce a NUMERIC/string/number value into a finite number, returning
 * null for null or unparseable input. Exported for test coverage of the
 * boundary behaviour (pg NUMERIC arrives as string, ints arrive as number).
 */
export function safeNullableNumber(value: number | string | null): number | null {
    if (value === null) return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

function safeNumber(value: number | string): number | null {
    return safeNullableNumber(value);
}

/**
 * Turn a PostgreSQL TIMESTAMPTZ (arrives as Date or string) into an ISO
 * string. Returns null when the value is unparseable — the caller decides
 * whether to fall back to the raw string or drop the field.
 */
function safeToIso(value: Date | string): string | null {
    const d = value instanceof Date ? value : new Date(value);
    const t = d.getTime();
    if (!Number.isFinite(t)) return null;
    return d.toISOString();
}

/** Maximum rows considered before the handler reports `truncated: true`. */
const SEARCH_MAX_RESULTS_CAP = 1_000;

/**
 * Injectable worker for testability. Defaults to `searchWorkspace` from
 * `artifact-search.ts`; tests pass a fake that returns a canned result
 * without touching disk.
 */
export type WorkspaceSearchFn = (
    root: string,
    query: string,
    opts: SearchWorkspaceOptions,
) => Promise<{
    readonly results: readonly FileSearchHit[];
    readonly totalMatches: number;
    readonly truncated: boolean;
    readonly durationMs: number;
    readonly filesScanned: number;
    readonly filesSkipped: number;
}>;

const emptySearchResponse = (error: string): SearchResponse => ({
    success: false,
    error,
    results: [],
    totalMatches: 0,
    truncated: false,
    durationMs: 0,
    filesScanned: 0,
});

export async function handleArtifactSearch(
    service: Pick<ArtifactService, 'getProjectRootPublic'>,
    raw: unknown,
    searchFn: WorkspaceSearchFn = searchWorkspace,
): Promise<SearchResponse> {
    const args = coerceSearchArgs(raw);
    if (args === null) {
        return emptySearchResponse('Invalid arguments');
    }
    const root = await service.getProjectRootPublic(args.projectId);
    if (root === null) {
        return emptySearchResponse('Project not found');
    }
    const requestedMax = args.maxResults ?? SEARCH_MAX_RESULTS_CAP;
    const maxResults = Math.min(Math.max(1, Math.floor(requestedMax)), SEARCH_MAX_RESULTS_CAP);
    try {
        const out = await searchFn(root, args.query, {
            caseSensitive: args.caseSensitive,
            regex: args.regex,
            maxResults,
        });
        return {
            success: true,
            results: out.results,
            totalMatches: out.totalMatches,
            truncated: out.truncated,
            durationMs: out.durationMs,
            filesScanned: out.filesScanned,
        };
    } catch (err) {
        return emptySearchResponse(errorMessage(err));
    }
}

// ── Protocol handler ─────────────────────────────────

/**
 * Register the `kageops-artifact://<projectId>/<relPath>` scheme as a
 * file protocol. The renderer's sandboxed iframe uses it to fetch HTML
 * previews and their sibling assets (B-422) while staying within the
 * project's `repo_path` boundary.
 */
function registerFileProtocol(deps: ArtifactProtocolDeps): void {
    protocol.registerFileProtocol(ARTIFACT_PROTOCOL_SCHEME, (request, callback) => {
        void resolveProtocolRequest(deps, request.url)
            .then((absPath) => {
                if (absPath === null) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electron callback accepts error objects
                    (callback as unknown as (r: { error: number }) => void)({ error: -6 /* FILE_NOT_FOUND */ });
                    return;
                }
                callback({ path: absPath });
            })
            .catch((err) => {
                log.warn({ err: errorMessage(err), url: request.url }, 'artifact protocol rejected');
                (callback as unknown as (r: { error: number }) => void)({ error: -10 /* ACCESS_DENIED */ });
            });
    });
}

/**
 * Parse `kageops-artifact://<projectId>/<relPath>` → `{ projectId, relPath }`
 * and resolve it to a safe absolute path inside `project.repo_path`. Pure
 * function — exported for unit testing.
 */
export async function resolveProtocolRequest(
    deps: ArtifactProtocolDeps,
    url: string,
): Promise<string | null> {
    const parsed = parseArtifactUrl(url);
    if (parsed === null) {
        throw new Error(`Invalid artifact URL: ${url}`);
    }
    const root = await deps.lookupProjectRoot(parsed.projectId);
    if (root === null) return null;
    // resolveSafeWorkspacePath throws on traversal — let it bubble up to
    // the protocol handler which maps it to ACCESS_DENIED.
    const abs = resolveSafeWorkspacePath(root, parsed.relPath);
    return abs;
}

export function parseArtifactUrl(url: string): { projectId: string; relPath: string } | null {
    const prefix = `${ARTIFACT_PROTOCOL_SCHEME}://`;
    if (!url.startsWith(prefix)) return null;
    const rest = url.slice(prefix.length);
    // Strip query / fragment — siblings may include them (e.g. ?v=1).
    const qIdx = rest.search(/[?#]/);
    const cleaned = qIdx === -1 ? rest : rest.slice(0, qIdx);
    if (cleaned === '') return null;
    const slash = cleaned.indexOf('/');
    if (slash === -1) {
        // Just a project id with no path — treat as root index.html? Reject.
        return null;
    }
    const projectId = decodeURIComponent(cleaned.slice(0, slash));
    const relPath = decodeURIComponent(cleaned.slice(slash + 1));
    if (projectId === '' || relPath === '') return null;
    // Normalize — forbid embedded backslashes and absolute-ish prefixes.
    if (relPath.startsWith('/')) return null;
    if (path.isAbsolute(relPath)) return null;
    return { projectId, relPath };
}

// ── Argument coercion ────────────────────────────────

function coerceListTreeArgs(raw: unknown): ListTreeArgs | null {
    const obj = (typeof raw === 'object' && raw !== null) ? raw as Record<string, unknown> : {};
    const projectId = typeof obj['projectId'] === 'string' ? obj['projectId'] : '';
    if (projectId === '') return null;
    const maxDepthRaw = obj['maxDepth'];
    const maxDepth = typeof maxDepthRaw === 'number' && Number.isFinite(maxDepthRaw) && maxDepthRaw >= 0
        ? Math.floor(maxDepthRaw)
        : undefined;
    return { projectId, maxDepth };
}

function coerceReadFileArgs(raw: unknown): ReadFileArgs | null {
    const obj = (typeof raw === 'object' && raw !== null) ? raw as Record<string, unknown> : {};
    const projectId = typeof obj['projectId'] === 'string' ? obj['projectId'] : '';
    const relPath = typeof obj['relPath'] === 'string' ? obj['relPath'] : '';
    if (projectId === '' || relPath === '') return null;
    return { projectId, relPath };
}

function coerceTaskDetailsArgs(raw: unknown): TaskDetailsArgs | null {
    const obj = (typeof raw === 'object' && raw !== null) ? raw as Record<string, unknown> : {};
    const projectId = typeof obj['projectId'] === 'string' ? obj['projectId'] : '';
    const taskId = typeof obj['taskId'] === 'string' ? obj['taskId'] : '';
    if (projectId === '' || taskId === '') return null;
    return { projectId, taskId };
}

function coerceSearchArgs(raw: unknown): SearchArgs | null {
    const obj = (typeof raw === 'object' && raw !== null) ? raw as Record<string, unknown> : {};
    const projectId = typeof obj['projectId'] === 'string' ? obj['projectId'] : '';
    const query = typeof obj['query'] === 'string' ? obj['query'] : '';
    if (projectId === '' || query === '') return null;
    const caseSensitive = obj['caseSensitive'] === true ? true : undefined;
    const regex = obj['regex'] === true ? true : undefined;
    const maxRaw = obj['maxResults'];
    const maxResults = typeof maxRaw === 'number' && Number.isFinite(maxRaw) && maxRaw > 0
        ? Math.floor(maxRaw)
        : undefined;
    return { projectId, query, caseSensitive, regex, maxResults };
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
