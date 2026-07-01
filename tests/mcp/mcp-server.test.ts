import { describe, it, expect } from 'vitest';
import {
  MCP_ERRORS,
  createServerConfig,
  createServerState,
  parseRequest,
  buildResponse,
  buildErrorResponse,
  buildNotification,
  handleInitialize,
  handleListTools,
  handleCallTool,
  routeRequest,
  registerToolsFromRegistry,
  incrementRequestCount,
  formatServerStatus,
  serializeResponse,
  type McpRequest,
  type McpError,
  type McpServerState,
} from '../../src/mcp/mcp-server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<McpRequest> = {}): McpRequest {
  return {
    jsonrpc: '2.0',
    id: 'test-1',
    method: 'initialize',
    params: null,
    ...overrides,
  };
}

function makeStateWithTools(): McpServerState {
  const config = createServerConfig('test-server');
  const state = createServerState(config);
  return registerToolsFromRegistry(state, [
    {
      name: 'get-file-summary',
      description: 'Summarise a file',
      inputSchema: {
        filePath: { type: 'string', required: true, description: 'File path' },
      },
    },
    {
      name: 'get-communities',
      description: 'Detect communities',
      inputSchema: {
        includeTests: { type: 'boolean', required: false, description: 'Include tests' },
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// MCP_ERRORS
// ---------------------------------------------------------------------------

describe('MCP_ERRORS', () => {
  it.each([
    ['PARSE_ERROR', -32700],
    ['INVALID_REQUEST', -32600],
    ['METHOD_NOT_FOUND', -32601],
    ['INVALID_PARAMS', -32602],
    ['INTERNAL_ERROR', -32603],
    ['TOOL_NOT_FOUND', -32001],
    ['TOOL_EXECUTION_FAILED', -32002],
  ] as const)('has correct code for %s', (key, expected) => {
    expect(MCP_ERRORS[key]).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// createServerConfig / createServerState
// ---------------------------------------------------------------------------

describe('createServerConfig', () => {
  it('creates config with defaults', () => {
    const cfg = createServerConfig('kageops');
    expect(cfg.name).toBe('kageops');
    expect(cfg.version).toBe('1.0.0');
    expect(cfg.transport).toBe('stdio');
    expect(cfg.port).toBeNull();
    expect(cfg.capabilities).toContain('tools');
  });

  it('applies overrides', () => {
    const cfg = createServerConfig('kageops', { version: '2.0.0', transport: 'http', port: 3000 });
    expect(cfg.version).toBe('2.0.0');
    expect(cfg.transport).toBe('http');
    expect(cfg.port).toBe(3000);
  });
});

describe('createServerState', () => {
  it('initializes with zero counters', () => {
    const state = createServerState(createServerConfig('test'));
    expect(state.registeredTools).toHaveLength(0);
    expect(state.activeConnections).toBe(0);
    expect(state.totalRequests).toBe(0);
    expect(state.startedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// parseRequest
// ---------------------------------------------------------------------------

describe('parseRequest', () => {
  it('parses a valid request', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: null });
    const result = parseRequest(raw);
    expect('method' in result).toBe(true);
    expect((result as McpRequest).method).toBe('initialize');
  });

  it('returns PARSE_ERROR for invalid JSON', () => {
    const result = parseRequest('not json{');
    expect('code' in result).toBe(true);
    expect((result as McpError).code).toBe(MCP_ERRORS.PARSE_ERROR);
  });

  it('returns INVALID_REQUEST for non-object', () => {
    const result = parseRequest('"hello"');
    expect((result as McpError).code).toBe(MCP_ERRORS.INVALID_REQUEST);
  });

  it('returns INVALID_REQUEST for array', () => {
    const result = parseRequest('[]');
    expect((result as McpError).code).toBe(MCP_ERRORS.INVALID_REQUEST);
  });

  it('returns INVALID_REQUEST when jsonrpc is missing', () => {
    const result = parseRequest(JSON.stringify({ id: 1, method: 'foo' }));
    expect((result as McpError).code).toBe(MCP_ERRORS.INVALID_REQUEST);
  });

  it('returns INVALID_REQUEST when id is missing', () => {
    const result = parseRequest(JSON.stringify({ jsonrpc: '2.0', method: 'foo' }));
    expect((result as McpError).code).toBe(MCP_ERRORS.INVALID_REQUEST);
  });

  it('returns INVALID_REQUEST when method is missing', () => {
    const result = parseRequest(JSON.stringify({ jsonrpc: '2.0', id: 1 }));
    expect((result as McpError).code).toBe(MCP_ERRORS.INVALID_REQUEST);
  });

  it('returns INVALID_PARAMS when params is an array', () => {
    const result = parseRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'foo', params: [1] }));
    expect((result as McpError).code).toBe(MCP_ERRORS.INVALID_PARAMS);
  });

  it('accepts params as object', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'test', params: { key: 'val' } });
    const result = parseRequest(raw) as McpRequest;
    expect(result.params).toEqual({ key: 'val' });
  });

  it('defaults params to null when omitted', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test' });
    const result = parseRequest(raw) as McpRequest;
    expect(result.params).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildResponse / buildErrorResponse
// ---------------------------------------------------------------------------

describe('buildResponse', () => {
  it('produces valid JSON-RPC response', () => {
    const resp = buildResponse('r1', { data: 42 });
    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBe('r1');
    expect(resp.result).toEqual({ data: 42 });
    expect(resp.error).toBeUndefined();
  });
});

describe('buildErrorResponse', () => {
  it('produces valid JSON-RPC error response', () => {
    const resp = buildErrorResponse(2, { code: -32600, message: 'bad' });
    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBe(2);
    expect(resp.error?.code).toBe(-32600);
    expect(resp.result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildNotification
// ---------------------------------------------------------------------------

describe('buildNotification', () => {
  it('builds a notification without id', () => {
    const n = buildNotification('tools/listChanged', { reason: 'added' });
    expect(n.jsonrpc).toBe('2.0');
    expect(n.method).toBe('tools/listChanged');
    expect(n.params).toEqual({ reason: 'added' });
    expect('id' in n).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleInitialize
// ---------------------------------------------------------------------------

describe('handleInitialize', () => {
  it('returns server capabilities', () => {
    const state = createServerState(createServerConfig('kageops', { version: '0.3.0' }));
    const resp = handleInitialize(makeRequest(), state);
    const result = resp.result as Record<string, unknown>;
    expect(result['protocolVersion']).toBe('2024-11-05');
    expect((result['serverInfo'] as Record<string, string>)['name']).toBe('kageops');
    expect(result['capabilities']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// handleListTools
// ---------------------------------------------------------------------------

describe('handleListTools', () => {
  it('returns all registered tools', () => {
    const state = makeStateWithTools();
    const resp = handleListTools(state);
    const result = resp.result as { tools: unknown[] };
    expect(result.tools).toHaveLength(2);
  });

  it('returns empty array when no tools registered', () => {
    const state = createServerState(createServerConfig('empty'));
    const resp = handleListTools(state);
    const result = resp.result as { tools: unknown[] };
    expect(result.tools).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleCallTool
// ---------------------------------------------------------------------------

describe('handleCallTool', () => {
  it('returns mock result for valid tool call', () => {
    const state = makeStateWithTools();
    const req = makeRequest({ method: 'tools/call', params: { name: 'get-file-summary', arguments: { filePath: 'src/main.ts' } } });
    const resp = handleCallTool(req, state);
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();
  });

  it('returns INVALID_PARAMS when tool name missing', () => {
    const state = makeStateWithTools();
    const req = makeRequest({ method: 'tools/call', params: {} });
    const resp = handleCallTool(req, state);
    expect(resp.error?.code).toBe(MCP_ERRORS.INVALID_PARAMS);
  });

  it('returns TOOL_NOT_FOUND for unknown tool', () => {
    const state = makeStateWithTools();
    const req = makeRequest({ method: 'tools/call', params: { name: 'nonexistent' } });
    const resp = handleCallTool(req, state);
    expect(resp.error?.code).toBe(MCP_ERRORS.TOOL_NOT_FOUND);
  });

  it('returns INVALID_PARAMS when required args missing', () => {
    const state = makeStateWithTools();
    const req = makeRequest({ method: 'tools/call', params: { name: 'get-file-summary', arguments: {} } });
    const resp = handleCallTool(req, state);
    expect(resp.error?.code).toBe(MCP_ERRORS.INVALID_PARAMS);
    expect(resp.error?.message).toContain('filePath');
  });

  it('succeeds when optional params are omitted', () => {
    const state = makeStateWithTools();
    const req = makeRequest({ method: 'tools/call', params: { name: 'get-communities' } });
    const resp = handleCallTool(req, state);
    expect(resp.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// routeRequest
// ---------------------------------------------------------------------------

describe('routeRequest', () => {
  const state = makeStateWithTools();

  it.each([
    ['initialize', 'protocolVersion'],
    ['tools/list', 'tools'],
    ['tools/call', 'content'],
  ])('routes %s correctly', (method, resultKey) => {
    const params = method === 'tools/call'
      ? { name: 'get-communities' }
      : null;
    const req = makeRequest({ method, params });
    const resp = routeRequest(req, state);
    const result = resp.result as Record<string, unknown> | undefined;
    if (method === 'tools/call') {
      // tools/call returns content array
      expect(result).toBeDefined();
    } else {
      expect(result?.[resultKey]).toBeDefined();
    }
  });

  it('returns METHOD_NOT_FOUND for unknown method', () => {
    const req = makeRequest({ method: 'unknown/method' });
    const resp = routeRequest(req, state);
    expect(resp.error?.code).toBe(MCP_ERRORS.METHOD_NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// registerToolsFromRegistry
// ---------------------------------------------------------------------------

describe('registerToolsFromRegistry', () => {
  it('converts code-graph tool format to MCP schema', () => {
    const state = makeStateWithTools();
    const tool = state.registeredTools[0];
    expect(tool.name).toBe('get-file-summary');
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.properties['filePath']).toBeDefined();
    expect(tool.inputSchema.required).toContain('filePath');
  });

  it('marks optional params as not required', () => {
    const state = makeStateWithTools();
    const tool = state.registeredTools[1];
    expect(tool.inputSchema.required).not.toContain('includeTests');
  });

  it('does not mutate original state', () => {
    const original = createServerState(createServerConfig('test'));
    const updated = registerToolsFromRegistry(original, [
      { name: 'tool-a', description: 'A', inputSchema: {} },
    ]);
    expect(original.registeredTools).toHaveLength(0);
    expect(updated.registeredTools).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// incrementRequestCount
// ---------------------------------------------------------------------------

describe('incrementRequestCount', () => {
  it('returns new state with incremented count', () => {
    const state = createServerState(createServerConfig('test'));
    const next = incrementRequestCount(state);
    expect(next.totalRequests).toBe(1);
    expect(state.totalRequests).toBe(0); // immutable
  });
});

// ---------------------------------------------------------------------------
// serializeResponse
// ---------------------------------------------------------------------------

describe('serializeResponse', () => {
  it('produces valid JSON', () => {
    const resp = buildResponse(1, { ok: true });
    const json = serializeResponse(resp);
    const parsed = JSON.parse(json);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.result.ok).toBe(true);
  });

  it('serializes error responses', () => {
    const resp = buildErrorResponse(2, { code: -32600, message: 'bad' });
    const json = serializeResponse(resp);
    const parsed = JSON.parse(json);
    expect(parsed.error.code).toBe(-32600);
  });
});

// ---------------------------------------------------------------------------
// formatServerStatus
// ---------------------------------------------------------------------------

describe('formatServerStatus', () => {
  it('returns markdown with server info', () => {
    const state = makeStateWithTools();
    const status = formatServerStatus(state);
    expect(status).toContain('# test-server Status');
    expect(status).toContain('Tools registered:** 2');
    expect(status).toContain('Transport:** stdio');
  });
});
