/**
 * KageOps Code Graph Bridge
 *
 * Manages one `uvx code-review-graph serve` child process per project repo.
 * Communicates over stdio using the MCP JSON-RPC 2.0 protocol.
 *
 * All public methods return null if:
 *   - uvx / Python is not installed (degraded mode)
 *   - The child process crashes
 *   - A tool call times out
 *
 * This ensures agents always degrade gracefully when the graph is unavailable.
 */

import { spawn, ChildProcess } from 'child_process';
import { checkUvxAvailable } from './python-check';
import { createLogger } from '../shared/logger';
import type {
    JsonRpcRequest,
    JsonRpcNotification,
    JsonRpcResponse,
    McpInitializeParams,
    McpInitializeResult,
    McpToolCallParams,
    McpToolCallResult,
    BuildGraphResult,
    ReviewContextResult,
    ImpactRadiusResult,
    ArchitectureOverviewResult,
    DetectChangesResult,
    MinimalContextResult,
    SemanticSearchResult,
    CodeGraphStatus,
    GraphStatusState,
} from './mcp-types';

const log = createLogger('CodeGraphBridge');

// ── Constants ─────────────────────────────────────────

const MCP_PROTOCOL_VERSION = '2024-11-05';
const TOOL_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // rebuild if > 10 min old

// ── McpProcess (one per project repo) ────────────────

type ProcessState = 'starting' | 'ready' | 'error' | 'stopping' | 'stopped';

interface PendingRequest {
    readonly resolve: (result: McpToolCallResult) => void;
    readonly reject: (err: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

class McpProcess {
    private proc: ChildProcess | null = null;
    private state: ProcessState = 'stopped';
    private nextId = 1;
    private readonly pending = new Map<number, PendingRequest>();
    private buffer = '';
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly log = createLogger('McpProcess');

    constructor(
        private readonly repoPath: string,
        private readonly uvxCommand: string
    ) {}

    async start(): Promise<void> {
        if (this.state === 'ready') return;
        if (this.state === 'starting') {
            // Wait for existing start
            await this.waitForState('ready', 30_000);
            return;
        }

        this.state = 'starting';
        this.log.debug({ repoPath: this.repoPath }, 'Spawning code-review-graph serve');

        const args = this.uvxCommand === 'uvx'
            ? ['code-review-graph', 'serve']
            : ['-m', 'code_review_graph', 'serve'];

        this.proc = spawn(this.uvxCommand, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
        });

        // Route stderr to debug log only — never mix with stdout
        this.proc.stderr?.on('data', (chunk: Buffer) => {
            this.log.debug({ stderr: chunk.toString().trim() }, 'code-review-graph stderr');
        });

        // Buffer stdout and parse complete JSON lines
        this.proc.stdout?.on('data', (chunk: Buffer) => {
            this.buffer += chunk.toString();
            this.drainBuffer();
        });

        this.proc.on('error', (err) => {
            this.log.warn({ err: err.message, repoPath: this.repoPath }, 'Process error');
            this.setError(new Error(`Process error: ${err.message}`));
        });

        this.proc.on('exit', (code, signal) => {
            this.log.debug({ code, signal, repoPath: this.repoPath }, 'Process exited');
            this.setError(new Error(`Process exited with code ${String(code)} signal ${String(signal)}`));
        });

        // Send MCP initialize handshake
        try {
            await this.initialize();
            this.state = 'ready';
            this.log.info({ repoPath: this.repoPath }, 'MCP server ready');
            this.resetIdleTimer();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn({ err: msg, repoPath: this.repoPath }, 'MCP initialize failed');
            this.state = 'error';
            throw err;
        }
    }

    async callTool(name: string, args: Record<string, unknown>, timeoutMs = TOOL_TIMEOUT_MS): Promise<McpToolCallResult> {
        if (this.state !== 'ready') {
            await this.start();
        }

        this.resetIdleTimer();

        const id = this.nextId++;
        const params: McpToolCallParams = { name, arguments: args };
        const request: JsonRpcRequest = {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params,
        };

        return new Promise<McpToolCallResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Tool ${name} timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timer });
            this.writeLine(JSON.stringify(request));
        });
    }

    async shutdown(): Promise<void> {
        if (this.state === 'stopped' || this.state === 'stopping') return;
        this.state = 'stopping';

        this.clearIdleTimer();

        // Send shutdown notification (fire-and-forget)
        const notification: JsonRpcNotification = { jsonrpc: '2.0', method: 'shutdown' };
        try { this.writeLine(JSON.stringify(notification)); } catch { /* ignore */ }

        // Give it 1 second to exit cleanly, then SIGTERM
        await new Promise<void>((resolve) => {
            const killTimer = setTimeout(() => {
                try { this.proc?.kill('SIGTERM'); } catch { /* ignore */ }
                resolve();
            }, 1000);

            this.proc?.on('exit', () => {
                clearTimeout(killTimer);
                resolve();
            });
        });

        this.state = 'stopped';
        this.proc = null;
    }

    get currentState(): ProcessState { return this.state; }

    // ── Private ─────────────────────────────────────────

    private async initialize(): Promise<void> {
        const id = this.nextId++;
        const params: McpInitializeParams = {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'kageops', version: '0.8.0' },
        };
        const request: JsonRpcRequest = {
            jsonrpc: '2.0',
            id,
            method: 'initialize',
            params,
        };

        const result = await new Promise<McpInitializeResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('MCP initialize timed out'));
            }, 15_000);

            // Use a one-off resolver that casts result to McpInitializeResult
            this.pending.set(id, {
                resolve: (r) => resolve(r as unknown as McpInitializeResult),
                reject,
                timer,
            });

            this.writeLine(JSON.stringify(request));
        });

        this.log.debug(
            { serverVersion: result.protocolVersion },
            'MCP initialize complete'
        );

        // Send initialized notification
        const initialized: JsonRpcNotification = {
            jsonrpc: '2.0',
            method: 'notifications/initialized',
        };
        this.writeLine(JSON.stringify(initialized));
    }

    private drainBuffer(): void {
        const lines = this.buffer.split('\n');
        // Last element may be incomplete — keep in buffer
        this.buffer = lines.pop() ?? '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '') continue;

            let parsed: JsonRpcResponse;
            try {
                parsed = JSON.parse(trimmed) as JsonRpcResponse;
            } catch {
                this.log.warn({ line: trimmed.slice(0, 200) }, 'Unparseable JSON from MCP server');
                continue;
            }

            const pending = this.pending.get(parsed.id);
            if (!pending) {
                this.log.debug({ id: parsed.id }, 'No pending request for response ID');
                continue;
            }

            clearTimeout(pending.timer);
            this.pending.delete(parsed.id);

            if (parsed.error !== undefined) {
                pending.reject(new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`));
            } else {
                pending.resolve(parsed.result as McpToolCallResult);
            }
        }
    }

    private setError(err: Error): void {
        this.state = 'error';
        this.clearIdleTimer();

        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(err);
            this.pending.delete(id);
        }
    }

    private writeLine(line: string): void {
        if (this.proc?.stdin === null || this.proc?.stdin === undefined) {
            throw new Error('Process stdin not available');
        }
        this.proc.stdin.write(line + '\n');
    }

    private resetIdleTimer(): void {
        this.clearIdleTimer();
        this.idleTimer = setTimeout(() => {
            this.log.debug({ repoPath: this.repoPath }, 'Idle timeout — shutting down MCP process');
            void this.shutdown().catch((err: unknown) => {
                this.log.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    'Idle shutdown error'
                );
            });
        }, IDLE_TIMEOUT_MS);
    }

    private clearIdleTimer(): void {
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    private waitForState(target: ProcessState, timeoutMs: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const poll = (): void => {
                if (this.state === target) {
                    resolve();
                    return;
                }
                if (this.state === 'error') {
                    reject(new Error('Process entered error state while waiting'));
                    return;
                }
                if (Date.now() - start > timeoutMs) {
                    reject(new Error(`Timed out waiting for state ${target}`));
                    return;
                }
                setTimeout(poll, 50);
            };
            poll();
        });
    }
}

// ── ProjectGraphState ─────────────────────────────────

interface ProjectGraphState {
    readonly mcpProcess: McpProcess;
    state: GraphStatusState;
    nodeCount: number;
    lastBuiltAt: Date | null;
    error: string | null;
}

// ── CodeGraphBridge ───────────────────────────────────

export class CodeGraphBridge {
    private readonly projects = new Map<string, ProjectGraphState>();
    private uvxCommand = '';
    private degraded = false;

    // ── Lifecycle ────────────────────────────────────────

    async initialize(): Promise<void> {
        const check = await checkUvxAvailable();
        if (!check.available) {
            this.degraded = true;
            log.warn('CodeGraphBridge running in degraded mode — uvx/Python not found');
            return;
        }

        this.uvxCommand = check.command;
        log.info({ command: check.command, version: check.version }, 'CodeGraphBridge initialized');
    }

    async shutdownAll(): Promise<void> {
        const shutdowns = [...this.projects.values()].map((p) =>
            p.mcpProcess.shutdown().catch((err: unknown) => {
                log.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    'Error during MCP process shutdown'
                );
            })
        );
        await Promise.all(shutdowns);
        this.projects.clear();
    }

    get isDegraded(): boolean { return this.degraded; }

    // ── Status ───────────────────────────────────────────

    getStatus(repoPath: string): CodeGraphStatus {
        const normalized = normalizePath(repoPath);
        const project = this.projects.get(normalized);

        if (this.degraded) {
            return { repoPath: normalized, state: 'unavailable', nodeCount: 0, lastBuiltAt: null, error: null };
        }

        if (!project) {
            return { repoPath: normalized, state: 'not-started', nodeCount: 0, lastBuiltAt: null, error: null };
        }

        return {
            repoPath: normalized,
            state: project.state,
            nodeCount: project.nodeCount,
            lastBuiltAt: project.lastBuiltAt,
            error: project.error,
        };
    }

    getAllStatuses(): readonly CodeGraphStatus[] {
        if (this.degraded) return [];
        return Array.from(this.projects.keys()).map((repoPath) => this.getStatus(repoPath));
    }

    // ── Public API ────────────────────────────────────────

    async buildGraph(repoPath: string): Promise<BuildGraphResult | null> {
        if (this.degraded) return null;

        const normalized = normalizePath(repoPath);
        const project = this.getOrCreateProject(normalized);

        project.state = 'building';
        project.error = null;

        try {
            const result = await project.mcpProcess.callTool(
                'build_or_update_graph_tool',
                { repo_path: normalized },
                BUILD_TIMEOUT_MS
            );

            const raw = extractText(result);
            const parsed = parseBuildResult(raw);
            project.state = 'ready';
            project.nodeCount = parsed.nodeCount;
            project.lastBuiltAt = new Date();
            log.info({ repoPath: normalized, nodeCount: parsed.nodeCount }, 'Graph built');
            return parsed;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            project.state = 'error';
            project.error = msg;
            log.warn({ err: msg, repoPath: normalized }, 'buildGraph failed');
            return null;
        }
    }

    async getReviewContext(
        repoPath: string,
        changedFiles: readonly string[]
    ): Promise<ReviewContextResult | null> {
        if (this.degraded) return null;

        const normalized = normalizePath(repoPath);
        await this.ensureBuiltInternal(normalized);

        try {
            const result = await this.callTool(normalized, 'get_review_context_tool', {
                repo_path: normalized,
                file_paths: changedFiles.map(normalizePath),
            });
            return parseReviewContext(extractText(result));
        } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, 'getReviewContext failed');
            return null;
        }
    }

    async getImpactRadius(
        repoPath: string,
        filePath: string,
        depth = 2
    ): Promise<ImpactRadiusResult | null> {
        if (this.degraded) return null;

        const normalized = normalizePath(repoPath);
        await this.ensureBuiltInternal(normalized);

        try {
            const result = await this.callTool(normalized, 'get_impact_radius_tool', {
                repo_path: normalized,
                file_path: normalizePath(filePath),
                depth,
            });
            return parseImpactRadius(extractText(result));
        } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, 'getImpactRadius failed');
            return null;
        }
    }

    async getArchitectureOverview(repoPath: string): Promise<ArchitectureOverviewResult | null> {
        if (this.degraded) return null;

        const normalized = normalizePath(repoPath);
        await this.ensureBuiltInternal(normalized);

        try {
            const result = await this.callTool(normalized, 'get_architecture_overview_tool', {
                repo_path: normalized,
            });
            return parseArchitectureOverview(extractText(result));
        } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, 'getArchitectureOverview failed');
            return null;
        }
    }

    async detectChanges(repoPath: string, baseSha: string): Promise<DetectChangesResult | null> {
        if (this.degraded) return null;

        const normalized = normalizePath(repoPath);
        await this.ensureBuiltInternal(normalized);

        try {
            const result = await this.callTool(normalized, 'detect_changes_tool', {
                repo_path: normalized,
                base_ref: baseSha,
            });
            return parseDetectChanges(extractText(result));
        } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, 'detectChanges failed');
            return null;
        }
    }

    async getMinimalContext(repoPath: string, task: string): Promise<MinimalContextResult | null> {
        if (this.degraded) return null;

        const normalized = normalizePath(repoPath);
        await this.ensureBuiltInternal(normalized);

        try {
            const result = await this.callTool(normalized, 'get_minimal_context_tool', {
                repo_path: normalized,
                task_description: task,
            });
            return parseMinimalContext(extractText(result));
        } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, 'getMinimalContext failed');
            return null;
        }
    }

    async semanticSearch(repoPath: string, query: string): Promise<SemanticSearchResult | null> {
        if (this.degraded) return null;

        const normalized = normalizePath(repoPath);
        await this.ensureBuiltInternal(normalized);

        try {
            const result = await this.callTool(normalized, 'semantic_search_nodes_tool', {
                repo_path: normalized,
                query,
                limit: 10,
            });
            return parseSemanticSearch(extractText(result));
        } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, 'semanticSearch failed');
            return null;
        }
    }

    // ── Private helpers ───────────────────────────────────

    private getOrCreateProject(normalized: string): ProjectGraphState {
        const existing = this.projects.get(normalized);
        if (existing) return existing;

        const project: ProjectGraphState = {
            mcpProcess: new McpProcess(normalized, this.uvxCommand),
            state: 'not-started',
            nodeCount: 0,
            lastBuiltAt: null,
            error: null,
        };
        this.projects.set(normalized, project);
        return project;
    }

    async ensureBuilt(repoPath: string): Promise<void> {
        return this.ensureBuiltInternal(normalizePath(repoPath));
    }

    private async ensureBuiltInternal(normalized: string): Promise<void> {
        const project = this.projects.get(normalized);

        // Not started or stale → trigger rebuild
        if (!project || project.state === 'not-started') {
            await this.buildGraph(normalized);
            return;
        }

        if (project.state === 'ready' && project.lastBuiltAt !== null) {
            const age = Date.now() - project.lastBuiltAt.getTime();
            if (age > STALE_THRESHOLD_MS) {
                // Fire-and-forget incremental refresh
                void this.buildGraph(normalized).catch(() => { /* degraded */ });
            }
        }
    }

    private async callTool(
        normalized: string,
        toolName: string,
        args: Record<string, unknown>
    ): Promise<import('./mcp-types').McpToolCallResult> {
        const project = this.getOrCreateProject(normalized);
        return project.mcpProcess.callTool(toolName, args, TOOL_TIMEOUT_MS);
    }
}

// ── Singleton factory ─────────────────────────────────

let instance: CodeGraphBridge | null = null;

export function getCodeGraphBridge(): CodeGraphBridge {
    if (instance === null) {
        instance = new CodeGraphBridge();
    }
    return instance;
}

export function resetCodeGraphBridgeForTesting(): void {
    instance = null;
}

// ── Utilities ─────────────────────────────────────────

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
}

function extractText(result: import('./mcp-types').McpToolCallResult): string {
    return result.content
        .filter((b) => b.type === 'text' && b.text !== undefined)
        .map((b) => b.text ?? '')
        .join('\n');
}

// ── Result parsers ────────────────────────────────────
// The code-review-graph tools return rich text/JSON in the `content` blocks.
// These parsers extract structured data from the text, with safe fallbacks.

function parseBuildResult(raw: string): BuildGraphResult {
    // Try to extract numbers from the text (e.g. "Indexed 142 nodes, 89 edges in 3.2s")
    const nodeMatch = raw.match(/(\d+)\s+node/i);
    const edgeMatch = raw.match(/(\d+)\s+edge/i);
    const fileMatch = raw.match(/(\d+)\s+file/i);
    const durationMatch = raw.match(/in\s+([\d.]+)s/i);

    return {
        success: !raw.toLowerCase().includes('error'),
        nodeCount: nodeMatch ? parseInt(nodeMatch[1], 10) : 0,
        edgeCount: edgeMatch ? parseInt(edgeMatch[1], 10) : 0,
        filesIndexed: fileMatch ? parseInt(fileMatch[1], 10) : 0,
        duration: durationMatch ? parseFloat(durationMatch[1]) : 0,
        raw,
    };
}

function parseReviewContext(raw: string): ReviewContextResult {
    const riskMatch = raw.match(/risk(?:\s+score)?[:\s]+(\d+)(?:\/10)?/i);
    return {
        blastRadius: [],
        testGaps: [],
        riskScore: riskMatch ? parseInt(riskMatch[1], 10) : 5,
        summary: raw.slice(0, 500),
        raw,
    };
}

function parseImpactRadius(raw: string): ImpactRadiusResult {
    return {
        entries: [],
        summary: raw.slice(0, 500),
        raw,
    };
}

function parseArchitectureOverview(raw: string): ArchitectureOverviewResult {
    const couplingMatch = raw.match(/coupling[:\s]+([\d.]+)/i);
    return {
        communities: [],
        couplingScore: couplingMatch ? parseFloat(couplingMatch[1]) : 0,
        summary: raw.slice(0, 800),
        raw,
    };
}

function parseDetectChanges(raw: string): DetectChangesResult {
    const riskMatch = raw.match(/risk[:\s]+([\d.]+)/i);
    return {
        changedFunctions: [],
        affectedFiles: [],
        overallRisk: riskMatch ? parseFloat(riskMatch[1]) : 0,
        summary: raw.slice(0, 500),
        raw,
    };
}

function parseMinimalContext(raw: string): MinimalContextResult {
    return {
        context: raw,
        tokenEstimate: Math.ceil(raw.length / 4),
        raw,
    };
}

function parseSemanticSearch(raw: string): SemanticSearchResult {
    return {
        entries: [],
        raw,
    };
}
