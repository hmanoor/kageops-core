import { describe, it, expect } from 'vitest';
import {
  MCP_TOOL_REGISTRY,
  TOOL_CATEGORIES,
  getToolByName,
  getToolsByCategory,
  validateToolArgs,
  createInvocation,
  createDefaultConfig,
  isToolEnabled,
  enableTool,
  disableTool,
  formatToolCatalog,
  getAgentRecommendedTools,
  type McpToolDefinition,
  type CodeGraphConfig,
} from '../../src/agents/code-graph-tools';

// ---------------------------------------------------------------------------
// Registry completeness
// ---------------------------------------------------------------------------

describe('MCP_TOOL_REGISTRY', () => {
  it('contains exactly 24 tools', () => {
    expect(MCP_TOOL_REGISTRY).toHaveLength(24);
  });

  it('has unique tool names', () => {
    const names = MCP_TOOL_REGISTRY.map((t) => t.name);
    expect(new Set(names).size).toBe(24);
  });

  it('every tool has a non-empty description and outputType', () => {
    for (const tool of MCP_TOOL_REGISTRY) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.outputType.length).toBeGreaterThan(0);
    }
  });

  it('every tool has at least one input parameter', () => {
    for (const tool of MCP_TOOL_REGISTRY) {
      expect(Object.keys(tool.inputSchema).length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['analysis', 6],
    ['flows', 3],
    ['communities', 3],
    ['refactoring', 3],
    ['wiki', 3],
    ['registry', 3],
    ['search', 2],
    ['metrics', 1],
  ])('has %i tools in category "%s"', (category, count) => {
    expect(MCP_TOOL_REGISTRY.filter((t) => t.category === category)).toHaveLength(count);
  });
});

// ---------------------------------------------------------------------------
// TOOL_CATEGORIES
// ---------------------------------------------------------------------------

describe('TOOL_CATEGORIES', () => {
  it('contains 8 categories', () => {
    expect(TOOL_CATEGORIES).toHaveLength(8);
  });

  it('category tool lists match registry', () => {
    for (const cat of TOOL_CATEGORIES) {
      const fromRegistry = MCP_TOOL_REGISTRY.filter((t) => t.category === cat.name).map((t) => t.name);
      expect([...cat.tools].sort()).toEqual([...fromRegistry].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// getToolByName
// ---------------------------------------------------------------------------

describe('getToolByName', () => {
  it('returns tool for valid name', () => {
    const tool = getToolByName('semantic-search');
    expect(tool).not.toBeNull();
    expect(tool!.category).toBe('search');
  });

  it('returns null for unknown name', () => {
    expect(getToolByName('nonexistent-tool')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getToolsByCategory
// ---------------------------------------------------------------------------

describe('getToolsByCategory', () => {
  it('returns tools for a valid category', () => {
    const tools = getToolsByCategory('flows');
    expect(tools).toHaveLength(3);
    expect(tools.every((t) => t.category === 'flows')).toBe(true);
  });

  it('returns empty for unknown category', () => {
    expect(getToolsByCategory('bogus')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateToolArgs
// ---------------------------------------------------------------------------

describe('validateToolArgs', () => {
  const tool = getToolByName('get-file-summary') as McpToolDefinition;

  it('returns no errors for valid args', () => {
    expect(validateToolArgs(tool, { filePath: 'src/main.ts' })).toHaveLength(0);
  });

  it('catches missing required argument', () => {
    const errors = validateToolArgs(tool, {});
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Missing required');
  });

  it('catches wrong type', () => {
    const errors = validateToolArgs(tool, { filePath: 42 as unknown as string });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('expected string');
  });

  it('allows optional args to be omitted', () => {
    const depTool = getToolByName('get-dependency-graph') as McpToolDefinition;
    expect(validateToolArgs(depTool, { filePath: 'x.ts' })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createInvocation
// ---------------------------------------------------------------------------

describe('createInvocation', () => {
  it('creates a valid invocation with ISO timestamp', () => {
    const inv = createInvocation('semantic-search', { query: 'auth' }, 'Scout');
    expect(inv.toolName).toBe('semantic-search');
    expect(inv.invokedBy).toBe('Scout');
    expect(inv.args).toEqual({ query: 'auth' });
    expect(() => new Date(inv.timestamp)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

describe('createDefaultConfig', () => {
  it('enables all 24 tools by default', () => {
    const cfg = createDefaultConfig('http://localhost:9000');
    expect(cfg.enabledTools).toHaveLength(24);
    expect(cfg.enabled).toBe(true);
    expect(cfg.serverUrl).toBe('http://localhost:9000');
  });
});

describe('isToolEnabled', () => {
  const cfg = createDefaultConfig('http://localhost:9000');

  it('returns true for an enabled tool', () => {
    expect(isToolEnabled('semantic-search', cfg)).toBe(true);
  });

  it('returns false for a disabled tool', () => {
    const disabled = disableTool(cfg, 'semantic-search');
    expect(isToolEnabled('semantic-search', disabled)).toBe(false);
  });
});

describe('enableTool / disableTool', () => {
  const cfg = createDefaultConfig('http://localhost:9000');

  it('disableTool removes a tool immutably', () => {
    const updated = disableTool(cfg, 'find-dead-code');
    expect(updated.enabledTools).not.toContain('find-dead-code');
    expect(cfg.enabledTools).toContain('find-dead-code'); // original unchanged
  });

  it('enableTool adds a tool immutably', () => {
    const without = disableTool(cfg, 'find-dead-code');
    const restored = enableTool(without, 'find-dead-code');
    expect(restored.enabledTools).toContain('find-dead-code');
    expect(without.enabledTools).not.toContain('find-dead-code'); // original unchanged
  });

  it('enableTool is a no-op when already enabled', () => {
    const same = enableTool(cfg, 'semantic-search');
    expect(same).toBe(cfg); // same reference
  });

  it('disableTool is a no-op when already disabled', () => {
    const without = disableTool(cfg, 'find-dead-code');
    const same = disableTool(without, 'find-dead-code');
    expect(same).toBe(without);
  });
});

// ---------------------------------------------------------------------------
// formatToolCatalog
// ---------------------------------------------------------------------------

describe('formatToolCatalog', () => {
  it('produces markdown with all category headings', () => {
    const md = formatToolCatalog(MCP_TOOL_REGISTRY);
    expect(md).toContain('# MCP Tool Catalog');
    for (const cat of TOOL_CATEGORIES) {
      expect(md).toContain(`## ${cat.name}`);
    }
  });

  it('lists every tool name', () => {
    const md = formatToolCatalog(MCP_TOOL_REGISTRY);
    for (const tool of MCP_TOOL_REGISTRY) {
      expect(md).toContain(tool.name);
    }
  });
});

// ---------------------------------------------------------------------------
// getAgentRecommendedTools
// ---------------------------------------------------------------------------

describe('getAgentRecommendedTools', () => {
  it.each([
    ['Vigil', 'get-codebase-health-score'],
    ['Blueprint', 'get-communities'],
    ['Forge', 'suggest-extract-method'],
    ['Scout', 'semantic-search'],
    ['Aegis', 'get-dependency-graph'],
    ['Herald', 'generate-module-wiki'],
    ['Cipher', 'get-data-flows'],
    ['Pixel', 'generate-architecture-diagram'],
  ])('recommends tools for %s (includes %s)', (role, expectedTool) => {
    const tools = getAgentRecommendedTools(role);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).toContain(expectedTool);
  });

  it('returns empty for unknown role', () => {
    expect(getAgentRecommendedTools('unknown-agent')).toHaveLength(0);
  });
});
