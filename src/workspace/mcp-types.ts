/**
 * KageOps MCP Type Definitions
 *
 * JSON-RPC 2.0 message shapes for the MCP (Model Context Protocol) stdio transport,
 * plus typed result types for the code-review-graph tools used by CodeGraphBridge.
 */

// ── JSON-RPC 2.0 ─────────────────────────────────────

export interface JsonRpcRequest {
    readonly jsonrpc: '2.0';
    readonly id: number;
    readonly method: string;
    readonly params?: unknown;
}

export interface JsonRpcNotification {
    readonly jsonrpc: '2.0';
    readonly method: string;
    readonly params?: unknown;
}

export interface JsonRpcResponse {
    readonly jsonrpc: '2.0';
    readonly id: number;
    readonly result?: unknown;
    readonly error?: JsonRpcError;
}

export interface JsonRpcError {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
}

// ── MCP Initialize ────────────────────────────────────

export interface McpInitializeParams {
    readonly protocolVersion: string;
    readonly capabilities: Record<string, unknown>;
    readonly clientInfo: {
        readonly name: string;
        readonly version: string;
    };
}

export interface McpInitializeResult {
    readonly protocolVersion: string;
    readonly serverInfo: {
        readonly name: string;
        readonly version: string;
    };
    readonly capabilities: Record<string, unknown>;
}

// ── MCP Tool Call ─────────────────────────────────────

export interface McpToolCallParams {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
}

export interface McpContentBlock {
    readonly type: 'text' | 'image' | 'resource';
    readonly text?: string;
}

export interface McpToolCallResult {
    readonly content: readonly McpContentBlock[];
    readonly isError?: boolean;
}

// ── code-review-graph Tool Result Types ──────────────

export interface BuildGraphResult {
    readonly success: boolean;
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly filesIndexed: number;
    readonly duration: number;
    readonly raw: string;
}

export interface BlastRadiusEntry {
    readonly filePath: string;
    readonly calledBy: readonly string[];
    readonly importsFrom: readonly string[];
}

export interface TestGapEntry {
    readonly filePath: string;
    readonly symbol: string;
    readonly hasCoverage: boolean;
    readonly testFiles: readonly string[];
}

export interface ReviewContextResult {
    readonly blastRadius: readonly BlastRadiusEntry[];
    readonly testGaps: readonly TestGapEntry[];
    readonly riskScore: number;
    readonly summary: string;
    readonly raw: string;
}

export interface ImpactRadiusEntry {
    readonly symbol: string;
    readonly filePath: string;
    readonly callers: readonly string[];
    readonly callees: readonly string[];
    readonly depth: number;
}

export interface ImpactRadiusResult {
    readonly entries: readonly ImpactRadiusEntry[];
    readonly summary: string;
    readonly raw: string;
}

export interface CommunityEntry {
    readonly name: string;
    readonly files: readonly string[];
    readonly cohesion: number;
}

export interface ArchitectureOverviewResult {
    readonly communities: readonly CommunityEntry[];
    readonly couplingScore: number;
    readonly summary: string;
    readonly raw: string;
}

export interface ChangedFunction {
    readonly name: string;
    readonly filePath: string;
    readonly riskScore: number;
    readonly testGap: boolean;
}

export interface DetectChangesResult {
    readonly changedFunctions: readonly ChangedFunction[];
    readonly affectedFiles: readonly string[];
    readonly overallRisk: number;
    readonly summary: string;
    readonly raw: string;
}

export interface MinimalContextResult {
    readonly context: string;
    readonly tokenEstimate: number;
    readonly raw: string;
}

export interface SemanticSearchEntry {
    readonly qualifiedName: string;
    readonly filePath: string;
    readonly kind: string;
    readonly score: number;
    readonly snippet: string;
}

export interface SemanticSearchResult {
    readonly entries: readonly SemanticSearchEntry[];
    readonly raw: string;
}

// ── Graph Status ──────────────────────────────────────

export type GraphStatusState = 'not-started' | 'building' | 'ready' | 'error' | 'unavailable';

export interface CodeGraphStatus {
    readonly repoPath: string;
    readonly state: GraphStatusState;
    readonly nodeCount: number;
    readonly lastBuiltAt: Date | null;
    readonly error: string | null;
}
