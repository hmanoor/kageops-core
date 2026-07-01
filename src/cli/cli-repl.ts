/**
 * CLI REPL Interface (B-170) & Web Dashboard config (B-171)
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface CliArg {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'flag';
  readonly required: boolean;
  readonly description: string;
  readonly defaultValue: string | number | boolean | null;
}

export interface CliCommand {
  readonly name: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly args: readonly CliArg[];
  readonly handler: string;
}

export interface CliContext {
  readonly projectId: string | null;
  readonly workingDir: string;
  readonly verbose: boolean;
  readonly outputFormat: 'text' | 'json' | 'table';
  readonly history: readonly string[];
}

export interface CliResult {
  readonly success: boolean;
  readonly output: string;
  readonly exitCode: number;
  readonly duration: number;
}

export interface ParsedCommand {
  readonly command: string;
  readonly args: Readonly<Record<string, string | number | boolean>>;
  readonly flags: readonly string[];
  readonly raw: string;
}

export interface WebRoute {
  readonly path: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly handler: string;
  readonly description: string;
  readonly auth: boolean;
}

export interface DashboardConfig {
  readonly port: number;
  readonly host: string;
  readonly apiPrefix: string;
  readonly corsOrigins: readonly string[];
  readonly authEnabled: boolean;
}

export interface DashboardPage {
  readonly path: string;
  readonly title: string;
  readonly component: string;
  readonly icon: string;
  readonly requiresAuth: boolean;
}

// ─── Command parsing ─────────────────────────────────────────────────

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const tokens: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; } else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ') {
      if (current.length > 0) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  if (tokens.length === 0) return null;

  const command = tokens[0];
  const args: Record<string, string | number | boolean> = {};
  const flags: string[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eqIdx = body.indexOf('=');
      if (eqIdx !== -1) {
        args[body.slice(0, eqIdx)] = body.slice(eqIdx + 1);
      } else {
        flags.push(body);
      }
    } else if (token.startsWith('-') && token.length === 2) {
      flags.push(token.slice(1));
    } else {
      args[`_${Object.keys(args).filter(k => k.startsWith('_')).length}`] = token;
    }
  }

  return { command, args, flags, raw: trimmed };
}

export function validateArgs(
  parsed: ParsedCommand,
  command: CliCommand,
): readonly string[] {
  const errors: string[] = [];
  for (const arg of command.args) {
    if (arg.required && !(arg.name in parsed.args) && !parsed.flags.includes(arg.name)) {
      errors.push(`Missing required argument: ${arg.name}`);
    }
    if (arg.name in parsed.args && arg.type === 'number') {
      if (Number.isNaN(Number(parsed.args[arg.name]))) {
        errors.push(`Argument '${arg.name}' must be a number`);
      }
    }
  }
  return errors;
}

// ─── Output formatting ───────────────────────────────────────────────

export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)),
  );
  const sep = widths.map(w => '-'.repeat(w + 2)).join('+');
  const fmtRow = (r: readonly string[]): string =>
    r.map((c, i) => ` ${(c ?? '').padEnd(widths[i])} `).join('|');

  return [fmtRow(headers), sep, ...rows.map(fmtRow)].join('\n');
}

export function formatOutput(
  data: unknown,
  format: 'text' | 'json' | 'table',
): string {
  if (format === 'json') return JSON.stringify(data, null, 2);
  if (format === 'table' && Array.isArray(data) && data.length > 0) {
    const keys = Object.keys(data[0] as Record<string, unknown>);
    const rows = data.map(item => keys.map(k => String((item as Record<string, unknown>)[k] ?? '')));
    return formatTable(keys, rows);
  }
  return String(data);
}

// ─── Context helpers ─────────────────────────────────────────────────

export function createContext(overrides?: Partial<CliContext>): CliContext {
  return {
    projectId: null,
    workingDir: process.cwd(),
    verbose: false,
    outputFormat: 'text',
    history: [],
    ...overrides,
  };
}

export function addToHistory(context: CliContext, command: string): CliContext {
  return { ...context, history: [...context.history, command] };
}

// ─── Built-in commands ───────────────────────────────────────────────

export const BUILT_IN_COMMANDS: readonly CliCommand[] = [
  { name: 'start', description: 'Start a new project', aliases: ['new', 'init'], args: [{ name: 'name', type: 'string', required: true, description: 'Project name', defaultValue: null }], handler: 'handleStart' },
  { name: 'status', description: 'Show project status', aliases: ['st'], args: [], handler: 'handleStatus' },
  { name: 'agents', description: 'List available agents', aliases: ['ag'], args: [{ name: 'verbose', type: 'flag', required: false, description: 'Show details', defaultValue: false }], handler: 'handleAgents' },
  { name: 'tasks', description: 'List or manage tasks', aliases: ['t'], args: [{ name: 'filter', type: 'string', required: false, description: 'Filter by status', defaultValue: null }], handler: 'handleTasks' },
  { name: 'approve', description: 'Approve a phase gate', aliases: ['ok'], args: [{ name: 'taskId', type: 'string', required: true, description: 'Task ID', defaultValue: null }], handler: 'handleApprove' },
  { name: 'logs', description: 'View agent logs', aliases: ['log', 'l'], args: [{ name: 'lines', type: 'number', required: false, description: 'Number of lines', defaultValue: 50 }], handler: 'handleLogs' },
  { name: 'config', description: 'View or set configuration', aliases: ['cfg'], args: [{ name: 'key', type: 'string', required: false, description: 'Config key', defaultValue: null }], handler: 'handleConfig' },
  { name: 'help', description: 'Show help', aliases: ['h', '?'], args: [{ name: 'command', type: 'string', required: false, description: 'Command name', defaultValue: null }], handler: 'handleHelp' },
  { name: 'version', description: 'Show version', aliases: ['v'], args: [], handler: 'handleVersion' },
  { name: 'quit', description: 'Exit the REPL', aliases: ['exit', 'q'], args: [], handler: 'handleQuit' },
] as const;

// ─── Help formatting ─────────────────────────────────────────────────

export function formatHelp(commands: readonly CliCommand[]): string {
  const lines = ['KageOps CLI — Available Commands:', ''];
  for (const cmd of commands) {
    const aliases = cmd.aliases.length > 0 ? ` (${cmd.aliases.join(', ')})` : '';
    lines.push(`  ${cmd.name.padEnd(12)} ${cmd.description}${aliases}`);
  }
  return lines.join('\n');
}

export function formatCommandHelp(command: CliCommand): string {
  const lines = [`${command.name} — ${command.description}`, ''];
  if (command.aliases.length > 0) lines.push(`Aliases: ${command.aliases.join(', ')}`);
  if (command.args.length > 0) {
    lines.push('', 'Arguments:');
    for (const arg of command.args) {
      const req = arg.required ? '(required)' : `(default: ${arg.defaultValue})`;
      lines.push(`  --${arg.name.padEnd(14)} ${arg.description} ${req}`);
    }
  }
  return lines.join('\n');
}

export function matchCommand(
  input: string,
  commands: readonly CliCommand[],
): CliCommand | null {
  const lower = input.toLowerCase();
  return commands.find(c => c.name === lower || c.aliases.includes(lower)) ?? null;
}

// ─── Web Dashboard (B-171) ──────────────────────────────────────────

export const WEB_ROUTES: readonly WebRoute[] = [
  { path: '/projects', method: 'GET', handler: 'listProjects', description: 'List all projects', auth: true },
  { path: '/projects', method: 'POST', handler: 'createProject', description: 'Create a project', auth: true },
  { path: '/projects/:id', method: 'GET', handler: 'getProject', description: 'Get project details', auth: true },
  { path: '/projects/:id', method: 'PUT', handler: 'updateProject', description: 'Update a project', auth: true },
  { path: '/projects/:id', method: 'DELETE', handler: 'deleteProject', description: 'Delete a project', auth: true },
  { path: '/agents', method: 'GET', handler: 'listAgents', description: 'List all agents', auth: true },
  { path: '/agents/:id/status', method: 'GET', handler: 'getAgentStatus', description: 'Get agent status', auth: true },
  { path: '/tasks', method: 'GET', handler: 'listTasks', description: 'List tasks', auth: true },
  { path: '/tasks/:id/approve', method: 'POST', handler: 'approveTask', description: 'Approve a task', auth: true },
  { path: '/logs', method: 'GET', handler: 'getLogs', description: 'Query logs', auth: true },
  { path: '/config', method: 'GET', handler: 'getConfig', description: 'Get configuration', auth: true },
  { path: '/health', method: 'GET', handler: 'healthCheck', description: 'Health check', auth: false },
] as const;

export const DASHBOARD_PAGES: readonly DashboardPage[] = [
  { path: '/', title: 'Overview', component: 'OverviewPage', icon: 'dashboard', requiresAuth: true },
  { path: '/projects', title: 'Projects', component: 'ProjectsPage', icon: 'folder', requiresAuth: true },
  { path: '/agents', title: 'Agents', component: 'AgentsPage', icon: 'smart_toy', requiresAuth: true },
  { path: '/tasks', title: 'Tasks', component: 'TasksPage', icon: 'task', requiresAuth: true },
  { path: '/traces', title: 'Traces', component: 'TracesPage', icon: 'timeline', requiresAuth: true },
  { path: '/alerts', title: 'Alerts', component: 'AlertsPage', icon: 'notifications', requiresAuth: true },
  { path: '/prompts', title: 'Prompts', component: 'PromptsPage', icon: 'chat', requiresAuth: true },
  { path: '/settings', title: 'Settings', component: 'SettingsPage', icon: 'settings', requiresAuth: true },
] as const;

export function createDashboardConfig(overrides?: Partial<DashboardConfig>): DashboardConfig {
  return {
    port: 3000,
    host: 'localhost',
    apiPrefix: '/api/v1',
    corsOrigins: ['http://localhost:3000'],
    authEnabled: true,
    ...overrides,
  };
}

export function formatRouteTable(routes: readonly WebRoute[]): string {
  const headers = ['Method', 'Path', 'Handler', 'Description', 'Auth'];
  const rows = routes.map(r => [r.method, r.path, r.handler, r.description, r.auth ? 'Yes' : 'No']);
  return formatTable(headers, rows);
}
