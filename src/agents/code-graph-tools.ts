// ---------------------------------------------------------------------------
// B-204: MCP Tool Registry for CodeGraphBridge (24 tools, 8 categories)
// ---------------------------------------------------------------------------

export type ToolParamType = 'string' | 'number' | 'boolean' | 'array';
export type ToolCategoryName =
  | 'analysis'
  | 'flows'
  | 'communities'
  | 'refactoring'
  | 'wiki'
  | 'registry'
  | 'search'
  | 'metrics';

export interface ToolParam {
  readonly type: ToolParamType;
  readonly required: boolean;
  readonly description: string;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategoryName;
  readonly inputSchema: Readonly<Record<string, ToolParam>>;
  readonly outputType: string;
}

export interface ToolInvocation {
  readonly toolName: string;
  readonly args: Readonly<Record<string, string | number | boolean>>;
  readonly invokedBy: string;
  readonly timestamp: string;
}

export interface ToolResult {
  readonly toolName: string;
  readonly success: boolean;
  readonly data: string;
  readonly durationMs: number;
  readonly tokenCost: number;
}

export interface CodeGraphConfig {
  readonly serverUrl: string;
  readonly enabled: boolean;
  readonly timeout: number;
  readonly maxConcurrent: number;
  readonly enabledTools: readonly string[];
}

export interface ToolCategory {
  readonly name: string;
  readonly tools: readonly string[];
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Tool definitions — 24 tools across 8 categories
// ---------------------------------------------------------------------------

const filePath: ToolParam = { type: 'string', required: true, description: 'Absolute or repo-relative file path' };
const funcName: ToolParam = { type: 'string', required: true, description: 'Fully qualified function name' };
const className: ToolParam = { type: 'string', required: true, description: 'Class name to inspect' };
const depth: ToolParam = { type: 'number', required: false, description: 'Max traversal depth' };
const query: ToolParam = { type: 'string', required: true, description: 'Search query string' };
const communityId: ToolParam = { type: 'string', required: true, description: 'Community identifier' };
const modulePath: ToolParam = { type: 'string', required: true, description: 'Module path or directory' };
const patternName: ToolParam = { type: 'string', required: true, description: 'Pattern name' };
const patternDesc: ToolParam = { type: 'string', required: true, description: 'Pattern description' };
const limit: ToolParam = { type: 'number', required: false, description: 'Max results to return' };
const includeTests: ToolParam = { type: 'boolean', required: false, description: 'Include test files' };

export const MCP_TOOL_REGISTRY: readonly McpToolDefinition[] = [
  // Analysis (6)
  { name: 'get-file-summary', description: 'Summarise exports, imports, and complexity for a file', category: 'analysis', inputSchema: { filePath }, outputType: 'FileSummary' },
  { name: 'get-function-details', description: 'Return signature, body metrics, and callers for a function', category: 'analysis', inputSchema: { functionName: funcName }, outputType: 'FunctionDetails' },
  { name: 'get-class-hierarchy', description: 'Return inheritance tree for a class', category: 'analysis', inputSchema: { className, depth }, outputType: 'ClassHierarchy' },
  { name: 'get-dependency-graph', description: 'Build a dependency graph rooted at a file', category: 'analysis', inputSchema: { filePath, depth }, outputType: 'DependencyGraph' },
  { name: 'get-import-map', description: 'List all imports and re-exports for a file', category: 'analysis', inputSchema: { filePath }, outputType: 'ImportMap' },
  { name: 'get-complexity-metrics', description: 'Compute cyclomatic and cognitive complexity', category: 'analysis', inputSchema: { filePath }, outputType: 'ComplexityMetrics' },
  // Flows (3)
  { name: 'get-data-flows', description: 'Trace data flow paths through a function', category: 'flows', inputSchema: { functionName: funcName, depth }, outputType: 'DataFlows' },
  { name: 'get-call-graph', description: 'Build call graph from an entry point', category: 'flows', inputSchema: { functionName: funcName, depth }, outputType: 'CallGraph' },
  { name: 'get-control-flow', description: 'Return control flow graph for a function', category: 'flows', inputSchema: { functionName: funcName }, outputType: 'ControlFlow' },
  // Communities (3)
  { name: 'get-communities', description: 'Detect module communities in the codebase', category: 'communities', inputSchema: { includeTests }, outputType: 'CommunityList' },
  { name: 'get-community-members', description: 'List files and symbols in a community', category: 'communities', inputSchema: { communityId }, outputType: 'CommunityMembers' },
  { name: 'get-cross-community-deps', description: 'Find dependencies that cross community boundaries', category: 'communities', inputSchema: { communityId }, outputType: 'CrossDeps' },
  // Refactoring (3)
  { name: 'suggest-extract-method', description: 'Suggest method extraction opportunities', category: 'refactoring', inputSchema: { filePath }, outputType: 'ExtractSuggestions' },
  { name: 'suggest-move-function', description: 'Suggest better module placement for a function', category: 'refactoring', inputSchema: { functionName: funcName }, outputType: 'MoveSuggestions' },
  { name: 'find-dead-code', description: 'Detect unreachable or unused code', category: 'refactoring', inputSchema: { modulePath, includeTests }, outputType: 'DeadCodeReport' },
  // Wiki (3)
  { name: 'generate-module-wiki', description: 'Generate wiki documentation for a module', category: 'wiki', inputSchema: { modulePath }, outputType: 'WikiPage' },
  { name: 'generate-api-docs', description: 'Generate API reference documentation', category: 'wiki', inputSchema: { modulePath }, outputType: 'ApiDocs' },
  { name: 'generate-architecture-diagram', description: 'Generate a Mermaid architecture diagram', category: 'wiki', inputSchema: { modulePath, depth }, outputType: 'ArchDiagram' },
  // Registry (3)
  { name: 'register-pattern', description: 'Register a reusable code pattern', category: 'registry', inputSchema: { patternName, description: patternDesc, filePath }, outputType: 'PatternRecord' },
  { name: 'find-patterns', description: 'Search registered patterns by query', category: 'registry', inputSchema: { query, limit }, outputType: 'PatternList' },
  { name: 'get-pattern-usage', description: 'Find usages of a registered pattern', category: 'registry', inputSchema: { patternName }, outputType: 'PatternUsage' },
  // Search (2)
  { name: 'semantic-search', description: 'Semantic vector search across the codebase', category: 'search', inputSchema: { query, limit }, outputType: 'SearchResults' },
  { name: 'find-similar-code', description: 'Find code structurally similar to a snippet', category: 'search', inputSchema: { filePath, functionName: funcName, limit }, outputType: 'SimilarCode' },
  // Metrics (1)
  { name: 'get-codebase-health-score', description: 'Compute an overall health score for the codebase', category: 'metrics', inputSchema: { includeTests }, outputType: 'HealthScore' },
] as const;

// ---------------------------------------------------------------------------
// Category catalogue
// ---------------------------------------------------------------------------

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  { name: 'analysis', tools: ['get-file-summary', 'get-function-details', 'get-class-hierarchy', 'get-dependency-graph', 'get-import-map', 'get-complexity-metrics'], description: 'Static analysis of files, functions, and classes' },
  { name: 'flows', tools: ['get-data-flows', 'get-call-graph', 'get-control-flow'], description: 'Data and control flow tracing' },
  { name: 'communities', tools: ['get-communities', 'get-community-members', 'get-cross-community-deps'], description: 'Module community detection and cross-boundary analysis' },
  { name: 'refactoring', tools: ['suggest-extract-method', 'suggest-move-function', 'find-dead-code'], description: 'Automated refactoring suggestions' },
  { name: 'wiki', tools: ['generate-module-wiki', 'generate-api-docs', 'generate-architecture-diagram'], description: 'Documentation and diagram generation' },
  { name: 'registry', tools: ['register-pattern', 'find-patterns', 'get-pattern-usage'], description: 'Reusable pattern registration and discovery' },
  { name: 'search', tools: ['semantic-search', 'find-similar-code'], description: 'Semantic and structural code search' },
  { name: 'metrics', tools: ['get-codebase-health-score'], description: 'Codebase-wide health and quality metrics' },
] as const;

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function getToolByName(name: string): McpToolDefinition | null {
  return MCP_TOOL_REGISTRY.find((t) => t.name === name) ?? null;
}

export function getToolsByCategory(category: string): readonly McpToolDefinition[] {
  return MCP_TOOL_REGISTRY.filter((t) => t.category === category);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateToolArgs(
  tool: McpToolDefinition,
  args: Readonly<Record<string, string | number | boolean>>,
): readonly string[] {
  const errors: string[] = [];
  for (const [key, param] of Object.entries(tool.inputSchema)) {
    const val = args[key];
    if (param.required && val === undefined) {
      errors.push(`Missing required argument: ${key}`);
      continue;
    }
    if (val !== undefined) {
      const expected = param.type === 'array' ? 'object' : param.type;
      if (typeof val !== expected) {
        errors.push(`Argument '${key}' expected ${param.type} but got ${typeof val}`);
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function createInvocation(
  toolName: string,
  args: Readonly<Record<string, string | number | boolean>>,
  invokedBy: string,
): ToolInvocation {
  return { toolName, args, invokedBy, timestamp: new Date().toISOString() };
}

export function createDefaultConfig(serverUrl: string): CodeGraphConfig {
  return {
    serverUrl,
    enabled: true,
    timeout: 30_000,
    maxConcurrent: 4,
    enabledTools: MCP_TOOL_REGISTRY.map((t) => t.name),
  };
}

// ---------------------------------------------------------------------------
// Config helpers (immutable)
// ---------------------------------------------------------------------------

export function isToolEnabled(toolName: string, config: CodeGraphConfig): boolean {
  return config.enabledTools.includes(toolName);
}

export function enableTool(config: CodeGraphConfig, toolName: string): CodeGraphConfig {
  if (config.enabledTools.includes(toolName)) return config;
  return { ...config, enabledTools: [...config.enabledTools, toolName] };
}

export function disableTool(config: CodeGraphConfig, toolName: string): CodeGraphConfig {
  if (!config.enabledTools.includes(toolName)) return config;
  return { ...config, enabledTools: config.enabledTools.filter((t) => t !== toolName) };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatToolCatalog(tools: readonly McpToolDefinition[]): string {
  const grouped = new Map<string, readonly McpToolDefinition[]>();
  for (const cat of TOOL_CATEGORIES) {
    const matching = tools.filter((t) => t.category === cat.name);
    if (matching.length > 0) grouped.set(cat.name, matching);
  }
  const lines: string[] = ['# MCP Tool Catalog', ''];
  for (const [catName, catTools] of Array.from(grouped.entries())) {
    const catMeta = TOOL_CATEGORIES.find((c) => c.name === catName);
    lines.push(`## ${catName}`, '');
    if (catMeta) lines.push(catMeta.description, '');
    for (const t of catTools) {
      lines.push(`- **${t.name}** — ${t.description}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Agent role recommendations
// ---------------------------------------------------------------------------

const AGENT_TOOL_MAP: Readonly<Record<string, readonly string[]>> = {
  vigil: ['get-file-summary', 'get-function-details', 'get-complexity-metrics', 'get-codebase-health-score', 'find-dead-code', 'get-class-hierarchy'],
  blueprint: ['get-data-flows', 'get-call-graph', 'get-control-flow', 'get-communities', 'get-community-members', 'get-cross-community-deps', 'generate-architecture-diagram'],
  forge: ['suggest-extract-method', 'suggest-move-function', 'find-dead-code', 'semantic-search', 'find-similar-code', 'get-dependency-graph'],
  scout: ['semantic-search', 'find-patterns', 'get-pattern-usage', 'get-codebase-health-score'],
  aegis: ['get-dependency-graph', 'get-import-map', 'find-dead-code', 'get-codebase-health-score'],
  cipher: ['get-data-flows', 'semantic-search', 'get-complexity-metrics'],
  herald: ['generate-module-wiki', 'generate-api-docs', 'generate-architecture-diagram'],
  pixel: ['generate-architecture-diagram', 'get-communities'],
};

export function getAgentRecommendedTools(agentRole: string): readonly string[] {
  return AGENT_TOOL_MAP[agentRole.toLowerCase()] ?? [];
}
