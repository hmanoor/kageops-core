/**
 * Core deploy-key IPC handlers — OS-keychain-backed Vercel token + vendor links.
 *
 * OSS fix: these previously lived inside the commercial deployment-config
 * handlers, but they only use the OS keychain (secret-store) and
 * `shell.openExternal` — both open. The open build needs them so the New Project
 * modal's deployment section (Vercel token field + "Get token ↗" links) works
 * without the commercial layer, letting an OSS user configure a Vercel deploy in
 * the UI (saved to the OS keychain, the "key register") instead of env vars.
 *
 * Registered unconditionally in main.ts. The commercial ENCRYPTED
 * `deployment_config` app-secret store stays in the commercial handlers.
 */
import { ipcMain } from 'electron';
import { IPC } from '../shared/ipc-channels';
import { createLogger } from '../shared/logger';

const log = createLogger('DeployKeys');

export function registerDeployKeyHandlers(): void {
  ipcMain.handle(IPC.DEPLOYMENT_CONFIG_GET_VERCEL_TOKEN_STATUS, async () => {
    try {
      const { getSecret } = await import('./secret-store');
      const token = await getSecret('kageops', 'vercel-token');
      return {
        success: true,
        present: typeof token === 'string' && token.length > 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'deploy-keys: vercel token status check failed');
      return { success: false, error: msg, present: false };
    }
  });

  ipcMain.handle(IPC.DEPLOYMENT_CONFIG_SAVE_VERCEL_TOKEN, async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) {
      return { success: false, error: 'Invalid args' };
    }
    const token = (args as Record<string, unknown>)['token'];
    if (typeof token !== 'string' || token.length === 0) {
      return { success: false, error: 'token must be a non-empty string' };
    }
    try {
      const { setSecret } = await import('./secret-store');
      await setSecret('kageops', 'vercel-token', token);
      // Live per-project hosting: a token now exists → enable deploy for this
      // session (unless the operator pinned KAGEOPS_NO_HOSTING explicitly). No
      // restart / global toggle needed.
      const { applyAutoHosting } = await import('../shared/hosting-mode');
      applyAutoHosting(true);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'deploy-keys: vercel token save failed');
      return { success: false, error: msg };
    }
  });

  ipcMain.handle(IPC.DEPLOYMENT_CONFIG_CLEAR_VERCEL_TOKEN, async () => {
    try {
      const { deleteSecret } = await import('./secret-store');
      await deleteSecret('kageops', 'vercel-token');
      // Token gone → fall back to run-locally (unless explicitly pinned).
      const { applyAutoHosting } = await import('../shared/hosting-mode');
      applyAutoHosting(false);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'deploy-keys: vercel token clear failed');
      return { success: false, error: msg };
    }
  });

  // ── Phase 2b: OS-keychain "key register" for app secrets ──
  //
  // The operator ticked "Save to key register" in the deployment section; the
  // renderer sends the project's app-env map here after the project is created.
  // Stored as a JSON blob under `app-env:<projectId>` (open — OS keychain only).
  ipcMain.handle(IPC.DEPLOYMENT_CONFIG_SAVE_APP_ENV, async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) {
      return { success: false, error: 'Invalid args' };
    }
    const rec = args as Record<string, unknown>;
    const projectId = rec['projectId'];
    const values = rec['values'];
    if (typeof projectId !== 'string' || projectId.length === 0) {
      return { success: false, error: 'projectId must be a non-empty string' };
    }
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      return { success: false, error: 'values must be an object' };
    }
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      if (typeof v === 'string') clean[k] = v;
    }
    try {
      const { saveAppEnv } = await import('./app-env-keychain');
      await saveAppEnv(projectId, clean);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'deploy-keys: save app-env failed');
      return { success: false, error: msg };
    }
  });

  ipcMain.handle(IPC.DEPLOYMENT_CONFIG_APP_ENV_STATUS, async (_event, args: unknown) => {
    const projectId = (typeof args === 'object' && args !== null)
      ? (args as Record<string, unknown>)['projectId']
      : undefined;
    if (typeof projectId !== 'string' || projectId.length === 0) {
      return { success: false, error: 'projectId required', present: false };
    }
    try {
      const { hasAppEnv } = await import('./app-env-keychain');
      return { success: true, present: await hasAppEnv(projectId) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'deploy-keys: app-env status failed');
      return { success: false, error: msg, present: false };
    }
  });

  ipcMain.handle(IPC.DEPLOYMENT_CONFIG_CLEAR_APP_ENV, async (_event, args: unknown) => {
    const projectId = (typeof args === 'object' && args !== null)
      ? (args as Record<string, unknown>)['projectId']
      : undefined;
    if (typeof projectId !== 'string' || projectId.length === 0) {
      return { success: false, error: 'projectId required' };
    }
    try {
      const { clearAppEnv } = await import('./app-env-keychain');
      await clearAppEnv(projectId);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'deploy-keys: clear app-env failed');
      return { success: false, error: msg };
    }
  });

  // Vendor "Get this →" / "Docs ↗" deep links. Renderer hands us the URL from
  // bundle.yaml; we whitelist scheme=https and open via shell.openExternal.
  ipcMain.handle(IPC.DEPLOYMENT_CONFIG_OPEN_VENDOR_URL, async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) {
      return { success: false, error: 'Invalid args' };
    }
    const url = (args as Record<string, unknown>)['url'];
    if (typeof url !== 'string' || url.length === 0) {
      return { success: false, error: 'url required' };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { success: false, error: 'not a valid URL' };
    }
    if (parsed.protocol !== 'https:') {
      return { success: false, error: 'only https:// URLs allowed' };
    }
    try {
      const { shell } = await import('electron');
      await shell.openExternal(parsed.toString());
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'deploy-keys: open vendor url failed');
      return { success: false, error: msg };
    }
  });
}
