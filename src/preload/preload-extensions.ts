/**
 * Preload API extensions for KageOps v1.3+ modules.
 *
 * Builds a typed API object that maps method calls to ipcRenderer.invoke.
 */

import {
  TRACE_CHANNELS,
  ALERT_CHANNELS,
  RECIPE_CHANNELS,
  PROMPT_CHANNELS,
  SECURITY_CHANNELS,
} from '../main/ipc-extensions';

// ── Types ────────────────────────────────────────────────────────

export interface TraceApi {
  readonly getSession: (sessionId: string) => Promise<unknown>;
  readonly listSessions: (filters?: unknown) => Promise<unknown>;
  readonly getTree: (sessionId: string) => Promise<unknown>;
  readonly exportTrace: (sessionId: string, format?: string) => Promise<unknown>;
  readonly getDetail: (spanId: string) => Promise<unknown>;
}

export interface AlertApi {
  readonly getState: () => Promise<unknown>;
  readonly checkThresholds: () => Promise<unknown>;
  readonly resolve: (alertId: string) => Promise<unknown>;
  readonly getConfig: () => Promise<unknown>;
  readonly updateConfig: (config: unknown) => Promise<unknown>;
  readonly getHealth: () => Promise<unknown>;
}

export interface RecipeApi {
  readonly list: (filters?: unknown) => Promise<unknown>;
  readonly get: (recipeId: string) => Promise<unknown>;
  readonly validate: (recipeId: string, params: unknown) => Promise<unknown>;
  readonly instantiate: (recipeId: string, params: unknown) => Promise<unknown>;
  readonly searchMarketplace: (query: string) => Promise<unknown>;
}

export interface PromptApi {
  readonly listTemplates: (filters?: unknown) => Promise<unknown>;
  readonly runPlayground: (templateId: string, variables: unknown) => Promise<unknown>;
  readonly getVersions: (templateId: string) => Promise<unknown>;
  readonly promote: (templateId: string, versionId: string) => Promise<unknown>;
  readonly getCost: (templateId: string, variables: unknown) => Promise<unknown>;
}

export interface SecurityApi {
  readonly scanContent: (content: string) => Promise<unknown>;
  readonly reviewAction: (action: unknown) => Promise<unknown>;
  readonly getConfig: () => Promise<unknown>;
}

export interface PreloadApi {
  readonly trace: TraceApi;
  readonly alerts: AlertApi;
  readonly recipes: RecipeApi;
  readonly prompts: PromptApi;
  readonly security: SecurityApi;
}

// ── IPC Renderer Interface ───────────────────────────────────────

interface IpcRendererLike {
  readonly invoke: (channel: string, ...args: readonly unknown[]) => Promise<unknown>;
}

// ── API Builder ──────────────────────────────────────────────────

export function buildPreloadApi(ipcRenderer: IpcRendererLike): PreloadApi {
  const trace: TraceApi = Object.freeze({
    getSession: (sessionId: string) =>
      ipcRenderer.invoke(TRACE_CHANNELS.GET_SESSION, sessionId),
    listSessions: (filters?: unknown) =>
      ipcRenderer.invoke(TRACE_CHANNELS.LIST_SESSIONS, filters),
    getTree: (sessionId: string) =>
      ipcRenderer.invoke(TRACE_CHANNELS.GET_TREE, sessionId),
    exportTrace: (sessionId: string, format?: string) =>
      ipcRenderer.invoke(TRACE_CHANNELS.EXPORT, sessionId, format),
    getDetail: (spanId: string) =>
      ipcRenderer.invoke(TRACE_CHANNELS.GET_DETAIL, spanId),
  });

  const alerts: AlertApi = Object.freeze({
    getState: () =>
      ipcRenderer.invoke(ALERT_CHANNELS.GET_STATE),
    checkThresholds: () =>
      ipcRenderer.invoke(ALERT_CHANNELS.CHECK_THRESHOLDS),
    resolve: (alertId: string) =>
      ipcRenderer.invoke(ALERT_CHANNELS.RESOLVE, alertId),
    getConfig: () =>
      ipcRenderer.invoke(ALERT_CHANNELS.GET_CONFIG),
    updateConfig: (config: unknown) =>
      ipcRenderer.invoke(ALERT_CHANNELS.UPDATE_CONFIG, config),
    getHealth: () =>
      ipcRenderer.invoke(ALERT_CHANNELS.GET_HEALTH),
  });

  const recipes: RecipeApi = Object.freeze({
    list: (filters?: unknown) =>
      ipcRenderer.invoke(RECIPE_CHANNELS.LIST, filters),
    get: (recipeId: string) =>
      ipcRenderer.invoke(RECIPE_CHANNELS.GET, recipeId),
    validate: (recipeId: string, params: unknown) =>
      ipcRenderer.invoke(RECIPE_CHANNELS.VALIDATE, recipeId, params),
    instantiate: (recipeId: string, params: unknown) =>
      ipcRenderer.invoke(RECIPE_CHANNELS.INSTANTIATE, recipeId, params),
    searchMarketplace: (query: string) =>
      ipcRenderer.invoke(RECIPE_CHANNELS.SEARCH_MARKETPLACE, query),
  });

  const prompts: PromptApi = Object.freeze({
    listTemplates: (filters?: unknown) =>
      ipcRenderer.invoke(PROMPT_CHANNELS.LIST_TEMPLATES, filters),
    runPlayground: (templateId: string, variables: unknown) =>
      ipcRenderer.invoke(PROMPT_CHANNELS.RUN_PLAYGROUND, templateId, variables),
    getVersions: (templateId: string) =>
      ipcRenderer.invoke(PROMPT_CHANNELS.GET_VERSIONS, templateId),
    promote: (templateId: string, versionId: string) =>
      ipcRenderer.invoke(PROMPT_CHANNELS.PROMOTE, templateId, versionId),
    getCost: (templateId: string, variables: unknown) =>
      ipcRenderer.invoke(PROMPT_CHANNELS.GET_COST, templateId, variables),
  });

  const security: SecurityApi = Object.freeze({
    scanContent: (content: string) =>
      ipcRenderer.invoke(SECURITY_CHANNELS.SCAN_CONTENT, content),
    reviewAction: (action: unknown) =>
      ipcRenderer.invoke(SECURITY_CHANNELS.REVIEW_ACTION, action),
    getConfig: () =>
      ipcRenderer.invoke(SECURITY_CHANNELS.GET_CONFIG),
  });

  return Object.freeze({ trace, alerts, recipes, prompts, security });
}

// ── Utilities ────────────────────────────────────────────────────

export function getExposedChannels(): readonly string[] {
  return Object.freeze([
    ...Object.values(TRACE_CHANNELS),
    ...Object.values(ALERT_CHANNELS),
    ...Object.values(RECIPE_CHANNELS),
    ...Object.values(PROMPT_CHANNELS),
    ...Object.values(SECURITY_CHANNELS),
  ]);
}

export function formatPreloadApiDocs(api: PreloadApi): string {
  const sections: readonly string[] = [
    '# Preload Extension API',
    '',
    '## trace',
    ...Object.keys(api.trace).map(k => `- \`trace.${k}()\``),
    '',
    '## alerts',
    ...Object.keys(api.alerts).map(k => `- \`alerts.${k}()\``),
    '',
    '## recipes',
    ...Object.keys(api.recipes).map(k => `- \`recipes.${k}()\``),
    '',
    '## prompts',
    ...Object.keys(api.prompts).map(k => `- \`prompts.${k}()\``),
    '',
    '## security',
    ...Object.keys(api.security).map(k => `- \`security.${k}()\``),
  ];

  return sections.join('\n');
}
