/**
 * IPC Extension Channels for KageOps v1.3+ modules.
 *
 * Registers handlers for trace panels, alert dashboard, recipe UI,
 * prompt playground, and security scanning.
 */

// ── Types ────────────────────────────────────────────────────────

export interface IpcChannelDef {
  readonly channel: string;
  readonly direction: 'main-to-renderer' | 'renderer-to-main' | 'bidirectional';
  readonly description: string;
  readonly payloadType: string;
}

export interface IpcRegistration {
  readonly channel: string;
  readonly registered: boolean;
  readonly handler: string;
}

interface IpcMainLike {
  readonly handle: (channel: string, handler: string) => void;
}

// ── Channel Constants ────────────────────────────────────────────

export const TRACE_CHANNELS = {
  GET_SESSION: 'trace:get-session',
  LIST_SESSIONS: 'trace:list-sessions',
  GET_TREE: 'trace:get-tree',
  EXPORT: 'trace:export',
  GET_DETAIL: 'trace:get-detail',
} as const;

export const ALERT_CHANNELS = {
  GET_STATE: 'alert:get-state',
  CHECK_THRESHOLDS: 'alert:check-thresholds',
  RESOLVE: 'alert:resolve',
  GET_CONFIG: 'alert:get-config',
  UPDATE_CONFIG: 'alert:update-config',
  GET_HEALTH: 'alert:get-health',
} as const;

export const RECIPE_CHANNELS = {
  LIST: 'recipe:list',
  GET: 'recipe:get',
  VALIDATE: 'recipe:validate',
  INSTANTIATE: 'recipe:instantiate',
  SEARCH_MARKETPLACE: 'recipe:search-marketplace',
} as const;

export const PROMPT_CHANNELS = {
  LIST_TEMPLATES: 'prompt:list-templates',
  RUN_PLAYGROUND: 'prompt:run-playground',
  GET_VERSIONS: 'prompt:get-versions',
  PROMOTE: 'prompt:promote',
  GET_COST: 'prompt:get-cost',
} as const;

export const SECURITY_CHANNELS = {
  SCAN_CONTENT: 'security:scan-content',
  REVIEW_ACTION: 'security:review-action',
  GET_CONFIG: 'security:get-config',
} as const;

// ── Channel Definitions ──────────────────────────────────────────

function defChannels(
  channels: Record<string, string>,
  domain: string,
  direction: IpcChannelDef['direction'],
  descriptions: Record<string, string>,
  payloadTypes: Record<string, string>,
): readonly IpcChannelDef[] {
  return Object.freeze(
    Object.entries(channels).map(([key, channel]) => Object.freeze({
      channel,
      direction,
      description: descriptions[key] ?? `${domain} ${key}`,
      payloadType: payloadTypes[key] ?? 'unknown',
    })),
  );
}

const traceChannelDefs: readonly IpcChannelDef[] = defChannels(
  TRACE_CHANNELS, 'trace', 'renderer-to-main',
  {
    GET_SESSION: 'Fetch a single trace session by ID',
    LIST_SESSIONS: 'List all trace sessions with optional filters',
    GET_TREE: 'Get the span tree for a trace session',
    EXPORT: 'Export trace data in a specified format',
    GET_DETAIL: 'Get detailed span information',
  },
  {
    GET_SESSION: 'TraceSession',
    LIST_SESSIONS: 'TraceSession[]',
    GET_TREE: 'SpanTree',
    EXPORT: 'string',
    GET_DETAIL: 'SpanDetail',
  },
);

const alertChannelDefs: readonly IpcChannelDef[] = defChannels(
  ALERT_CHANNELS, 'alert', 'bidirectional',
  {
    GET_STATE: 'Get current alert state summary',
    CHECK_THRESHOLDS: 'Evaluate thresholds and return triggered alerts',
    RESOLVE: 'Mark an alert as resolved',
    GET_CONFIG: 'Get alert configuration',
    UPDATE_CONFIG: 'Update alert thresholds and rules',
    GET_HEALTH: 'Get system health metrics for alert evaluation',
  },
  {
    GET_STATE: 'AlertState',
    CHECK_THRESHOLDS: 'AlertCheckResult[]',
    RESOLVE: 'void',
    GET_CONFIG: 'AlertConfig',
    UPDATE_CONFIG: 'AlertConfig',
    GET_HEALTH: 'HealthMetrics',
  },
);

const recipeChannelDefs: readonly IpcChannelDef[] = defChannels(
  RECIPE_CHANNELS, 'recipe', 'renderer-to-main',
  {
    LIST: 'List available recipe templates',
    GET: 'Get a single recipe by ID',
    VALIDATE: 'Validate recipe parameters before instantiation',
    INSTANTIATE: 'Create a project from a recipe template',
    SEARCH_MARKETPLACE: 'Search the recipe marketplace',
  },
  {
    LIST: 'RecipeSummary[]',
    GET: 'Recipe',
    VALIDATE: 'ValidationResult',
    INSTANTIATE: 'Project',
    SEARCH_MARKETPLACE: 'MarketplaceResult[]',
  },
);

const promptChannelDefs: readonly IpcChannelDef[] = defChannels(
  PROMPT_CHANNELS, 'prompt', 'renderer-to-main',
  {
    LIST_TEMPLATES: 'List prompt templates',
    RUN_PLAYGROUND: 'Execute a prompt in the playground',
    GET_VERSIONS: 'Get version history for a prompt template',
    PROMOTE: 'Promote a prompt version to production',
    GET_COST: 'Estimate cost for a prompt execution',
  },
  {
    LIST_TEMPLATES: 'PromptTemplate[]',
    RUN_PLAYGROUND: 'PlaygroundResult',
    GET_VERSIONS: 'PromptVersion[]',
    PROMOTE: 'PromptVersion',
    GET_COST: 'CostEstimate',
  },
);

const securityChannelDefs: readonly IpcChannelDef[] = defChannels(
  SECURITY_CHANNELS, 'security', 'renderer-to-main',
  {
    SCAN_CONTENT: 'Scan content for security issues',
    REVIEW_ACTION: 'Review a proposed agent action for safety',
    GET_CONFIG: 'Get security scanning configuration',
  },
  {
    SCAN_CONTENT: 'ScanResult',
    REVIEW_ACTION: 'ReviewResult',
    GET_CONFIG: 'SecurityConfig',
  },
);

export const ALL_EXTENSION_CHANNELS: readonly IpcChannelDef[] = Object.freeze([
  ...traceChannelDefs,
  ...alertChannelDefs,
  ...recipeChannelDefs,
  ...promptChannelDefs,
  ...securityChannelDefs,
]);

// ── Registration Helpers ─────────────────────────────────────────

function registerHandlers(
  ipcMain: IpcMainLike,
  channels: Record<string, string>,
  domain: string,
): readonly IpcRegistration[] {
  return Object.freeze(
    Object.entries(channels).map(([key, channel]) => {
      const handler = `${domain}:handle-${key.toLowerCase().replace(/_/g, '-')}`;
      try {
        ipcMain.handle(channel, handler);
        return Object.freeze({ channel, registered: true, handler });
      } catch {
        return Object.freeze({ channel, registered: false, handler });
      }
    }),
  );
}

export function registerTraceHandlers(ipcMain: IpcMainLike): readonly IpcRegistration[] {
  return registerHandlers(ipcMain, TRACE_CHANNELS, 'trace');
}

export function registerAlertHandlers(ipcMain: IpcMainLike): readonly IpcRegistration[] {
  return registerHandlers(ipcMain, ALERT_CHANNELS, 'alert');
}

export function registerRecipeHandlers(ipcMain: IpcMainLike): readonly IpcRegistration[] {
  return registerHandlers(ipcMain, RECIPE_CHANNELS, 'recipe');
}

export function registerPromptHandlers(ipcMain: IpcMainLike): readonly IpcRegistration[] {
  return registerHandlers(ipcMain, PROMPT_CHANNELS, 'prompt');
}

export function registerSecurityHandlers(ipcMain: IpcMainLike): readonly IpcRegistration[] {
  return registerHandlers(ipcMain, SECURITY_CHANNELS, 'security');
}

export function registerAllExtensionHandlers(ipcMain: IpcMainLike): readonly IpcRegistration[] {
  return Object.freeze([
    ...registerTraceHandlers(ipcMain),
    ...registerAlertHandlers(ipcMain),
    ...registerRecipeHandlers(ipcMain),
    ...registerPromptHandlers(ipcMain),
    ...registerSecurityHandlers(ipcMain),
  ]);
}

// ── Reporting ────────────────────────────────────────────────────

export function formatRegistrationReport(registrations: readonly IpcRegistration[]): string {
  const successful = registrations.filter(r => r.registered);
  const failed = registrations.filter(r => !r.registered);

  const lines: readonly string[] = [
    '# IPC Extension Registration Report',
    '',
    `**Total:** ${registrations.length} | **Registered:** ${successful.length} | **Failed:** ${failed.length}`,
    '',
    '| Channel | Status | Handler |',
    '|---------|--------|---------|',
    ...registrations.map(r =>
      `| ${r.channel} | ${r.registered ? 'OK' : 'FAILED'} | ${r.handler} |`,
    ),
  ];

  return lines.join('\n');
}
