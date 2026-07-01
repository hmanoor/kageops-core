/**
 * Phase 2b — the OS-keychain "key register" for app secrets.
 *
 * When the operator ticks "Save to key register" in the New-Project deployment
 * section, that project's app secrets (DATABASE_URL, CLERK_SECRET_KEY, …) are
 * stored as a single JSON blob in the OS keychain under the account
 * `app-env:<projectId>` (service `kageops`).
 *
 * This is purely open — it uses only the OS keychain (secret-store), so it
 * ships in kageops-core. In the OPEN build it is the ONLY persistent
 * app-secret store, since the encrypted `deployment_config` reader is
 * commercial (null in core). A subsequent run of the same project picks the
 * secrets back up through materialize's keychain reader, which is installed at
 * bootstrap via {@link installAppEnvKeychainReader}.
 *
 * Resolution order for app env (see materialize-deployment-env.ts):
 *   1. KAGEOPS_APP_ENV_FILE  (headless self-deploy dotenv, BPF-35)
 *   2. encrypted deployment_config  (commercial; null in core)
 *   3. THIS keychain register  (open; primary store in the open build)
 */
import { createLogger } from '../shared/logger';

const log = createLogger('AppEnvKeychain');

const SERVICE_NAME = 'kageops';

/** Keychain account under which a project's app-env blob is stored. */
export function appEnvAccount(projectId: string): string {
    return `app-env:${projectId}`;
}

function isStringMap(value: unknown): value is Record<string, string> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

/**
 * Persist a project's app-env map to the OS keychain. Throws only when the
 * keychain surface itself is unavailable (setSecret's own contract) — callers
 * in the IPC layer convert that to a `{ success: false }` envelope.
 */
export async function saveAppEnv(
    projectId: string,
    values: Readonly<Record<string, string>>
): Promise<void> {
    if (projectId.length === 0) {
        throw new Error('projectId must be a non-empty string');
    }
    const { setSecret } = await import('./secret-store');
    await setSecret(SERVICE_NAME, appEnvAccount(projectId), JSON.stringify(values));
    log.info({ projectId, varCount: Object.keys(values).length }, 'saved app-env to key register');
}

/**
 * Read a project's app-env map back from the OS keychain. Returns null when
 * nothing is stored, the keychain is unavailable, or the stored blob is not a
 * valid string→string JSON map (corruption / manual edit) — never throws.
 */
export async function loadAppEnv(
    projectId: string
): Promise<Readonly<Record<string, string>> | null> {
    if (projectId.length === 0) {
        return null;
    }
    const { getSecret } = await import('./secret-store');
    const raw = await getSecret(SERVICE_NAME, appEnvAccount(projectId));
    if (raw === null || raw.length === 0) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!isStringMap(parsed)) {
            log.warn({ projectId }, 'app-env blob is not a string map — ignoring');
            return null;
        }
        return parsed;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ projectId, err: msg }, 'failed to parse app-env blob — ignoring');
        return null;
    }
}

/** Delete a project's app-env blob from the key register. Never throws. */
export async function clearAppEnv(projectId: string): Promise<void> {
    if (projectId.length === 0) {
        return;
    }
    const { deleteSecret } = await import('./secret-store');
    await deleteSecret(SERVICE_NAME, appEnvAccount(projectId));
    log.info({ projectId }, 'cleared app-env from key register');
}

/** True when a non-empty app-env blob is stored for the project. */
export async function hasAppEnv(projectId: string): Promise<boolean> {
    return (await loadAppEnv(projectId)) !== null;
}

/**
 * Wire the keychain register into materialize as the app-env fallback reader.
 * Called once at orchestrator bootstrap (unconditionally — open feature). Safe
 * to import lazily; materialize keeps the reader null until this runs.
 */
export async function installAppEnvKeychainReader(): Promise<void> {
    const { setAppEnvKeychainReader } = await import('../orchestrator/materialize-deployment-env');
    setAppEnvKeychainReader((projectId) => loadAppEnv(projectId));
}
