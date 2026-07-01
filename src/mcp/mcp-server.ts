// ---------------------------------------------------------------------------
// MCP Server — JSON-RPC 2.0 protocol layer for code-graph tools
// ---------------------------------------------------------------------------

// -- Types ------------------------------------------------------------------

export interface McpError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface McpRequest {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>> | null;
}

export interface McpResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: McpError | null;
}

export interface McpNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>> | null;
}

export interface McpServerConfig {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly transport: 'stdio' | 'http' | 'websocket';
  readonly port: number | null;
  readonly capabilities: readonly string[];
}

export interface McpToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { readonly type: string; readonly description: string }>>;
    readonly required: readonly string[];
  };
}

export interface McpServerState {
  readonly config: McpServerConfig;
  readonly registeredTools: readonly McpToolSchema[];
  readonly activeConnections: number;
  readonly totalRequests: number;
  readonly startedAt: string;
}

// -- Error codes ------------------------------------------------------------

export const MCP_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TOOL_NOT_FOUND: -32001,
  TOOL_EXECUTION_FAILED: -32002,
} as const;

// -- Factory helpers --------------------------------------------------------

export function createServerConfig(
  name: string,
  overrides?: Partial<Omit<McpServerConfig, 'name'>>,
): McpServerConfig {
  return {
    name,
    version: overrides?.version ?? '1.0.0',
    description: overrides?.description ?? `${name} MCP server`,
    transport: overrides?.transport ?? 'stdio',
    port: overrides?.port ?? null,
    capabilities: overrides?.capabilities ?? ['tools', 'notifications'],
  };
}

export function createServerState(config: McpServerConfig): McpServerState {
  return {
    config,
    registeredTools: [],
    activeConnections: 0,
    totalRequests: 0,
    startedAt: new Date().toISOString(),
  };
}

// -- Request parsing --------------------------------------------------------

export function parseRequest(raw: string): McpRequest | McpError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { code: MCP_ERRORS.PARSE_ERROR, message: 'Invalid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { code: MCP_ERRORS.INVALID_REQUEST, message: 'Request must be a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj['jsonrpc'] !== '2.0') {
    return { code: MCP_ERRORS.INVALID_REQUEST, message: 'Missing or invalid jsonrpc field' };
  }
  if (typeof obj['id'] !== 'string' && typeof obj['id'] !== 'number') {
    return { code: MCP_ERRORS.INVALID_REQUEST, message: 'Missing or invalid id field' };
  }
  if (typeof obj['method'] !== 'string') {
    return { code: MCP_ERRORS.INVALID_REQUEST, message: 'Missing or invalid method field' };
  }

  const params = obj['params'] === undefined ? null : obj['params'];
  if (params !== null && (typeof params !== 'object' || Array.isArray(params))) {
    return { code: MCP_ERRORS.INVALID_PARAMS, message: 'Params must be an object or null' };
  }

  return {
    jsonrpc: '2.0',
    id: obj['id'] as string | number,
    method: obj['method'] as string,
    params: params as Readonly<Record<string, unknown>> | null,
  };
}

// -- Response builders ------------------------------------------------------

export function buildResponse(id: string | number, result: unknown): McpResponse {
  return { jsonrpc: '2.0', id, result };
}

export function buildErrorResponse(id: string | number, error: McpError): McpResponse {
  return { jsonrpc: '2.0', id, error };
}

export function buildNotification(
  method: string,
  params: Readonly<Record<string, unknown>>,
): McpNotification {
  return { jsonrpc: '2.0', method, params };
}

// -- Handlers ---------------------------------------------------------------

export function handleInitialize(request: McpRequest, state: McpServerState): McpResponse {
  return buildResponse(request.id, {
    protocolVersion: '2024-11-05',
    serverInfo: {
      name: state.config.name,
      version: state.config.version,
    },
    capabilities: {
      tools: { listChanged: true },
    },
  });
}

export function handleListTools(state: McpServerState): McpResponse {
  return buildResponse(0, { tools: state.registeredTools });
}

export function handleCallTool(request: McpRequest, state: McpServerState): McpResponse {
  const toolName = request.params?.['name'] as string | undefined;
  if (!toolName) {
    return buildErrorResponse(request.id, {
      code: MCP_ERRORS.INVALID_PARAMS,
      message: 'Missing required param: name',
    });
  }

  const tool = state.registeredTools.find((t) => t.name === toolName);
  if (!tool) {
    return buildErrorResponse(request.id, {
      code: MCP_ERRORS.TOOL_NOT_FOUND,
      message: `Tool not found: ${toolName}`,
    });
  }

  const args = (request.params?.['arguments'] ?? {}) as Readonly<Record<string, unknown>>;
  const missingParams = tool.inputSchema.required.filter((key) => args[key] === undefined);
  if (missingParams.length > 0) {
    return buildErrorResponse(request.id, {
      code: MCP_ERRORS.INVALID_PARAMS,
      message: `Missing required arguments: ${missingParams.join(', ')}`,
    });
  }

  return buildResponse(request.id, {
    content: [{ type: 'text', text: `Mock result for ${toolName}` }],
  });
}

// -- Router -----------------------------------------------------------------

export function routeRequest(request: McpRequest, state: McpServerState): McpResponse {
  switch (request.method) {
    case 'initialize':
      return handleInitialize(request, state);
    case 'tools/list':
      return handleListTools(state);
    case 'tools/call':
      return handleCallTool(request, state);
    default:
      return buildErrorResponse(request.id, {
        code: MCP_ERRORS.METHOD_NOT_FOUND,
        message: `Unknown method: ${request.method}`,
      });
  }
}

// -- Tool registration ------------------------------------------------------

interface RegistryToolInput {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, {
    readonly type: string;
    readonly required: boolean;
    readonly description: string;
  }>>;
}

export function registerToolsFromRegistry(
  state: McpServerState,
  tools: readonly RegistryToolInput[],
): McpServerState {
  const converted: readonly McpToolSchema[] = tools.map((tool) => {
    const properties: Record<string, { readonly type: string; readonly description: string }> = {};
    const required: string[] = [];

    for (const [key, param] of Object.entries(tool.inputSchema)) {
      properties[key] = { type: param.type, description: param.description };
      if (param.required) {
        required.push(key);
      }
    }

    return {
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object' as const, properties, required },
    };
  });

  return {
    ...state,
    registeredTools: [...state.registeredTools, ...converted],
  };
}

// -- State helpers ----------------------------------------------------------

export function incrementRequestCount(state: McpServerState): McpServerState {
  return { ...state, totalRequests: state.totalRequests + 1 };
}

// -- Formatting & serialization ---------------------------------------------

export function formatServerStatus(state: McpServerState): string {
  const lines = [
    `# ${state.config.name} Status`,
    '',
    `- **Version:** ${state.config.version}`,
    `- **Transport:** ${state.config.transport}`,
    `- **Tools registered:** ${state.registeredTools.length}`,
    `- **Active connections:** ${state.activeConnections}`,
    `- **Total requests:** ${state.totalRequests}`,
    `- **Started at:** ${state.startedAt}`,
  ];
  return lines.join('\n');
}

export function serializeResponse(response: McpResponse): string {
  return JSON.stringify(response);
}
