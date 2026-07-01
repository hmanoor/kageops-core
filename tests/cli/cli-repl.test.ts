import { describe, it, expect } from 'vitest';
import {
  parseCommand,
  validateArgs,
  formatOutput,
  formatTable,
  createContext,
  addToHistory,
  BUILT_IN_COMMANDS,
  formatHelp,
  formatCommandHelp,
  matchCommand,
  WEB_ROUTES,
  DASHBOARD_PAGES,
  createDashboardConfig,
  formatRouteTable,
  type CliCommand,
} from '../../src/cli/cli-repl';

// ─── parseCommand ────────────────────────────────────────────────────

describe('parseCommand', () => {
  it('returns null for empty input', () => {
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('   ')).toBeNull();
  });

  it.each([
    ['status', 'status', {}, []],
    ['help agents', 'help', { _0: 'agents' }, []],
    ['logs --lines=50', 'logs', { lines: '50' }, []],
    ['start --name=foo --verbose', 'start', { name: 'foo' }, ['verbose']],
    ['tasks -v', 'tasks', {}, ['v']],
    ['config --key=db.host --format=json', 'config', { key: 'db.host', format: 'json' }, []],
  ] as const)('parses "%s"', (input, cmd, args, flags) => {
    const result = parseCommand(input);
    expect(result).not.toBeNull();
    expect(result!.command).toBe(cmd);
    expect(result!.args).toEqual(args);
    expect(result!.flags).toEqual(flags);
  });

  it('handles quoted strings', () => {
    const result = parseCommand('start --name="my project"');
    expect(result!.args).toEqual({ name: 'my project' });
  });

  it('handles single-quoted strings', () => {
    const result = parseCommand("start --name='my project'");
    expect(result!.args).toEqual({ name: 'my project' });
  });

  it('preserves raw input', () => {
    const result = parseCommand('  help  agents ');
    expect(result!.raw).toBe('help  agents');
  });

  it('handles multiple positional args', () => {
    const result = parseCommand('cmd foo bar baz');
    expect(result!.args).toEqual({ _0: 'foo', _1: 'bar', _2: 'baz' });
  });
});

// ─── validateArgs ────────────────────────────────────────────────────

describe('validateArgs', () => {
  const cmd: CliCommand = {
    name: 'test',
    description: 'test',
    aliases: [],
    args: [
      { name: 'name', type: 'string', required: true, description: '', defaultValue: null },
      { name: 'count', type: 'number', required: false, description: '', defaultValue: 10 },
    ],
    handler: 'h',
  };

  it('catches missing required args', () => {
    const parsed = parseCommand('test')!;
    const errors = validateArgs(parsed, cmd);
    expect(errors).toContain('Missing required argument: name');
  });

  it('passes when required args present', () => {
    const parsed = parseCommand('test --name=foo')!;
    expect(validateArgs(parsed, cmd)).toHaveLength(0);
  });

  it('catches invalid number type', () => {
    const parsed = parseCommand('test --name=foo --count=abc')!;
    const errors = validateArgs(parsed, cmd);
    expect(errors).toContain("Argument 'count' must be a number");
  });

  it('accepts valid number', () => {
    const parsed = parseCommand('test --name=foo --count=42')!;
    expect(validateArgs(parsed, cmd)).toHaveLength(0);
  });
});

// ─── formatOutput ────────────────────────────────────────────────────

describe('formatOutput', () => {
  it('formats text as string', () => {
    expect(formatOutput('hello', 'text')).toBe('hello');
  });

  it('formats json', () => {
    const result = formatOutput({ a: 1 }, 'json');
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  it('formats array as table', () => {
    const data = [{ name: 'a', val: '1' }, { name: 'bb', val: '22' }];
    const result = formatOutput(data, 'table');
    expect(result).toContain('name');
    expect(result).toContain('val');
    expect(result).toContain('bb');
  });

  it('falls back to string for non-array table format', () => {
    expect(formatOutput('plain', 'table')).toBe('plain');
  });
});

// ─── formatTable ─────────────────────────────────────────────────────

describe('formatTable', () => {
  it('produces aligned ASCII table', () => {
    const result = formatTable(['A', 'BB'], [['1', '22'], ['333', '4']]);
    const lines = result.split('\n');
    expect(lines).toHaveLength(4); // header + sep + 2 rows
    expect(lines[1]).toMatch(/^-+\+-+$/);
  });
});

// ─── Context ─────────────────────────────────────────────────────────

describe('createContext', () => {
  it('creates default context', () => {
    const ctx = createContext();
    expect(ctx.projectId).toBeNull();
    expect(ctx.verbose).toBe(false);
    expect(ctx.outputFormat).toBe('text');
    expect(ctx.history).toEqual([]);
  });

  it('applies overrides', () => {
    const ctx = createContext({ verbose: true, projectId: 'p1' });
    expect(ctx.verbose).toBe(true);
    expect(ctx.projectId).toBe('p1');
  });
});

describe('addToHistory', () => {
  it('appends immutably', () => {
    const ctx = createContext();
    const updated = addToHistory(ctx, 'status');
    expect(updated.history).toEqual(['status']);
    expect(ctx.history).toEqual([]); // original unchanged
  });
});

// ─── matchCommand ────────────────────────────────────────────────────

describe('matchCommand', () => {
  it('matches by name', () => {
    expect(matchCommand('status', BUILT_IN_COMMANDS)!.name).toBe('status');
  });

  it('matches by alias', () => {
    expect(matchCommand('st', BUILT_IN_COMMANDS)!.name).toBe('status');
    expect(matchCommand('q', BUILT_IN_COMMANDS)!.name).toBe('quit');
  });

  it('returns null for unknown', () => {
    expect(matchCommand('foobar', BUILT_IN_COMMANDS)).toBeNull();
  });
});

// ─── Help formatting ─────────────────────────────────────────────────

describe('formatHelp', () => {
  it('lists all commands', () => {
    const help = formatHelp(BUILT_IN_COMMANDS);
    for (const cmd of BUILT_IN_COMMANDS) {
      expect(help).toContain(cmd.name);
    }
  });
});

describe('formatCommandHelp', () => {
  it('shows command details', () => {
    const cmd = BUILT_IN_COMMANDS.find(c => c.name === 'start')!;
    const help = formatCommandHelp(cmd);
    expect(help).toContain('start');
    expect(help).toContain('name');
    expect(help).toContain('(required)');
  });
});

// ─── BUILT_IN_COMMANDS structure ─────────────────────────────────────

describe('BUILT_IN_COMMANDS', () => {
  it('has 10 commands', () => {
    expect(BUILT_IN_COMMANDS).toHaveLength(10);
  });

  it.each(BUILT_IN_COMMANDS.map(c => [c.name, c]))('"%s" has valid structure', (_name, cmd) => {
    expect(cmd.name).toBeTruthy();
    expect(cmd.description).toBeTruthy();
    expect(cmd.handler).toBeTruthy();
    expect(Array.isArray(cmd.aliases)).toBe(true);
    expect(Array.isArray(cmd.args)).toBe(true);
  });
});

// ─── WEB_ROUTES ──────────────────────────────────────────────────────

describe('WEB_ROUTES', () => {
  it('has 12 routes', () => {
    expect(WEB_ROUTES).toHaveLength(12);
  });

  it.each(WEB_ROUTES.map(r => [r.method + ' ' + r.path, r]))('%s has valid method', (_label, route) => {
    expect(['GET', 'POST', 'PUT', 'DELETE']).toContain(route.method);
    expect(route.path).toMatch(/^\//);
    expect(route.handler).toBeTruthy();
  });
});

// ─── DASHBOARD_PAGES ─────────────────────────────────────────────────

describe('DASHBOARD_PAGES', () => {
  it('has 8 pages', () => {
    expect(DASHBOARD_PAGES).toHaveLength(8);
  });

  it.each(DASHBOARD_PAGES.map(p => [p.title, p]))('%s has required fields', (_title, page) => {
    expect(page.path).toBeTruthy();
    expect(page.title).toBeTruthy();
    expect(page.component).toBeTruthy();
    expect(page.icon).toBeTruthy();
    expect(typeof page.requiresAuth).toBe('boolean');
  });
});

// ─── Dashboard config ────────────────────────────────────────────────

describe('createDashboardConfig', () => {
  it('creates defaults', () => {
    const cfg = createDashboardConfig();
    expect(cfg.port).toBe(3000);
    expect(cfg.host).toBe('localhost');
    expect(cfg.authEnabled).toBe(true);
  });

  it('applies overrides', () => {
    const cfg = createDashboardConfig({ port: 8080, authEnabled: false });
    expect(cfg.port).toBe(8080);
    expect(cfg.authEnabled).toBe(false);
  });
});

describe('formatRouteTable', () => {
  it('formats routes as table', () => {
    const table = formatRouteTable(WEB_ROUTES);
    expect(table).toContain('Method');
    expect(table).toContain('Path');
    expect(table).toContain('/health');
  });
});
