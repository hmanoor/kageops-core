import { describe, it, expect, vi } from 'vitest';
import {
  buildPreloadApi,
  getExposedChannels,
  formatPreloadApiDocs,
  type PreloadApi,
} from '../../src/preload/preload-extensions';

function mockIpcRenderer() {
  return { invoke: vi.fn().mockResolvedValue('mock-result') };
}

function buildApi() {
  const ipc = mockIpcRenderer();
  const api = buildPreloadApi(ipc);
  return { ipc, api };
}

// ── buildPreloadApi ──────────────────────────────────────────────

describe('buildPreloadApi', () => {
  it('returns frozen object with 5 domains', () => {
    const { api } = buildApi();
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api)).toEqual(['trace', 'alerts', 'recipes', 'prompts', 'security']);
  });

  it('trace.getSession invokes correct channel', async () => {
    const { ipc, api } = buildApi();
    await api.trace.getSession('s1');
    expect(ipc.invoke).toHaveBeenCalledWith('trace:get-session', 's1');
  });

  it('trace.listSessions passes filters', async () => {
    const { ipc, api } = buildApi();
    await api.trace.listSessions({ limit: 10 });
    expect(ipc.invoke).toHaveBeenCalledWith('trace:list-sessions', { limit: 10 });
  });

  it('trace.exportTrace passes sessionId and format', async () => {
    const { ipc, api } = buildApi();
    await api.trace.exportTrace('s1', 'json');
    expect(ipc.invoke).toHaveBeenCalledWith('trace:export', 's1', 'json');
  });

  it('alerts.resolve invokes alert:resolve', async () => {
    const { ipc, api } = buildApi();
    await api.alerts.resolve('a1');
    expect(ipc.invoke).toHaveBeenCalledWith('alert:resolve', 'a1');
  });

  it('alerts.updateConfig passes config object', async () => {
    const { ipc, api } = buildApi();
    const cfg = { threshold: 90 };
    await api.alerts.updateConfig(cfg);
    expect(ipc.invoke).toHaveBeenCalledWith('alert:update-config', cfg);
  });

  it('recipes.instantiate passes recipeId and params', async () => {
    const { ipc, api } = buildApi();
    await api.recipes.instantiate('r1', { name: 'proj' });
    expect(ipc.invoke).toHaveBeenCalledWith('recipe:instantiate', 'r1', { name: 'proj' });
  });

  it('recipes.searchMarketplace passes query', async () => {
    const { ipc, api } = buildApi();
    await api.recipes.searchMarketplace('web app');
    expect(ipc.invoke).toHaveBeenCalledWith('recipe:search-marketplace', 'web app');
  });

  it('prompts.runPlayground passes templateId and variables', async () => {
    const { ipc, api } = buildApi();
    await api.prompts.runPlayground('t1', { input: 'hello' });
    expect(ipc.invoke).toHaveBeenCalledWith('prompt:run-playground', 't1', { input: 'hello' });
  });

  it('prompts.promote passes templateId and versionId', async () => {
    const { ipc, api } = buildApi();
    await api.prompts.promote('t1', 'v2');
    expect(ipc.invoke).toHaveBeenCalledWith('prompt:promote', 't1', 'v2');
  });

  it('security.scanContent passes content string', async () => {
    const { ipc, api } = buildApi();
    await api.security.scanContent('secret-data');
    expect(ipc.invoke).toHaveBeenCalledWith('security:scan-content', 'secret-data');
  });

  it('security.getConfig invokes with no args', async () => {
    const { ipc, api } = buildApi();
    await api.security.getConfig();
    expect(ipc.invoke).toHaveBeenCalledWith('security:get-config');
  });

  it('all methods return promises', async () => {
    const { api } = buildApi();
    const result = await api.trace.getSession('s1');
    expect(result).toBe('mock-result');
  });
});

// ── getExposedChannels ───────────────────────────────────────────

describe('getExposedChannels', () => {
  it('returns 24 channel strings', () => {
    const channels = getExposedChannels();
    expect(channels).toHaveLength(24);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(getExposedChannels())).toBe(true);
  });

  it('contains channels from all domains', () => {
    const channels = getExposedChannels();
    expect(channels.some(c => c.startsWith('trace:'))).toBe(true);
    expect(channels.some(c => c.startsWith('alert:'))).toBe(true);
    expect(channels.some(c => c.startsWith('recipe:'))).toBe(true);
    expect(channels.some(c => c.startsWith('prompt:'))).toBe(true);
    expect(channels.some(c => c.startsWith('security:'))).toBe(true);
  });
});

// ── formatPreloadApiDocs ─────────────────────────────────────────

describe('formatPreloadApiDocs', () => {
  it('produces markdown with all section headers', () => {
    const { api } = buildApi();
    const docs = formatPreloadApiDocs(api);
    expect(docs).toContain('# Preload Extension API');
    expect(docs).toContain('## trace');
    expect(docs).toContain('## alerts');
    expect(docs).toContain('## recipes');
    expect(docs).toContain('## prompts');
    expect(docs).toContain('## security');
  });

  it('lists method names in backtick format', () => {
    const { api } = buildApi();
    const docs = formatPreloadApiDocs(api);
    expect(docs).toContain('`trace.getSession()`');
    expect(docs).toContain('`alerts.resolve()`');
    expect(docs).toContain('`recipes.instantiate()`');
  });
});
