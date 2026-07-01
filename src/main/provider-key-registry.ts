/**
 * KageOps Provider Key Registry
 *
 * Manages multiple named API keys per provider. Keys are stored in OS Keychain
 * (via secret-store) with metadata (label, provider, project scope) in Postgres.
 * Supports per-agent and per-project key selection.
 */

import { query, getOne, getMany } from '../db/client';
import { getSecret, setSecret, deleteSecret } from './secret-store';
import { createLogger } from '../shared/logger';

const log = createLogger('ProviderKeyRegistry');

// ── Types ────────────────────────────────────────────

export interface ProviderKeyRecord {
    readonly id: string;
    readonly provider: string;
    readonly label: string;
    readonly keychainAccount: string;
    readonly projectId: string | null;
    readonly isDefault: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface ProviderKeyInput {
    readonly provider: string;
    readonly label: string;
    readonly apiKey: string;
    readonly projectId?: string | null;
    readonly isDefault?: boolean;
}

export interface ProviderKeySummary {
    readonly id: string;
    readonly provider: string;
    readonly label: string;
    readonly projectId: string | null;
    readonly isDefault: boolean;
    readonly hasKey: boolean;
    readonly createdAt: string;
}

// ── Constants ────────────────────────────────────────

const SERVICE_NAME = 'kageops';

/** Build a unique keychain account name from provider + key ID */
function keychainAccount(provider: string, keyId: string): string {
    return `provider-key-${provider}-${keyId}`;
}

// ── CRUD Operations ─────────────────────────────────

/**
 * Add a new named API key for a provider.
 * Stores the actual key in OS Keychain, metadata in Postgres.
 */
export async function addProviderKey(input: ProviderKeyInput): Promise<ProviderKeySummary> {
    const { provider, label, apiKey, projectId, isDefault } = input;

    if (provider.trim() === '') throw new Error('Provider is required');
    if (label.trim() === '') throw new Error('Label is required');
    if (apiKey.trim() === '') throw new Error('API key is required');

    // If this is set as default, unset any existing default for this provider+scope
    if (isDefault === true) {
        await unsetDefaultForProvider(provider, projectId ?? null);
    }

    // Insert metadata row
    const row = await getOne<{ id: string; created_at: string; updated_at: string }>(
        `INSERT INTO provider_keys (provider, label, project_id, is_default)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at, updated_at`,
        [provider.trim(), label.trim(), projectId ?? null, isDefault ?? false]
    );

    if (row === null) throw new Error('Failed to insert provider key record');

    // Store actual key in OS Keychain
    const account = keychainAccount(provider, row.id);
    await setSecret(SERVICE_NAME, account, apiKey.trim());

    // Update the keychain_account column
    await query(
        `UPDATE provider_keys SET keychain_account = $1 WHERE id = $2`,
        [account, row.id]
    );

    log.info({ provider, label: label.trim(), id: row.id }, 'Added provider key');

    return {
        id: row.id,
        provider: provider.trim(),
        label: label.trim(),
        projectId: projectId ?? null,
        isDefault: isDefault ?? false,
        hasKey: true,
        createdAt: row.created_at,
    };
}

/**
 * List all keys for a provider (optionally scoped to a project).
 * Does NOT return the actual secret — only metadata + hasKey flag.
 */
export async function listProviderKeys(
    provider?: string,
    projectId?: string | null
): Promise<readonly ProviderKeySummary[]> {
    let sql = `SELECT id, provider, label, keychain_account, project_id, is_default, created_at
               FROM provider_keys`;
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (provider !== undefined) {
        conditions.push(`provider = $${params.length + 1}`);
        params.push(provider);
    }
    if (projectId !== undefined) {
        if (projectId === null) {
            conditions.push('project_id IS NULL');
        } else {
            conditions.push(`project_id = $${params.length + 1}`);
            params.push(projectId);
        }
    }

    if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ' ORDER BY is_default DESC, created_at ASC';

    const rows = await getMany<{
        id: string;
        provider: string;
        label: string;
        keychain_account: string | null;
        project_id: string | null;
        is_default: boolean;
        created_at: string;
    }>(sql, params);

    const summaries: ProviderKeySummary[] = [];
    for (const row of rows) {
        let hasKey = false;
        if (row.keychain_account !== null && row.keychain_account !== '') {
            const secret = await getSecret(SERVICE_NAME, row.keychain_account).catch(() => null);
            hasKey = secret !== null && secret !== '';
        }
        summaries.push({
            id: row.id,
            provider: row.provider,
            label: row.label,
            projectId: row.project_id,
            isDefault: row.is_default,
            hasKey,
            createdAt: row.created_at,
        });
    }

    return Object.freeze(summaries);
}

/**
 * Get a specific key record by ID (without the secret).
 */
export async function getProviderKey(keyId: string): Promise<ProviderKeySummary | null> {
    const row = await getOne<{
        id: string;
        provider: string;
        label: string;
        keychain_account: string | null;
        project_id: string | null;
        is_default: boolean;
        created_at: string;
    }>(
        `SELECT id, provider, label, keychain_account, project_id, is_default, created_at
         FROM provider_keys WHERE id = $1`,
        [keyId]
    );

    if (row === null) return null;

    let hasKey = false;
    if (row.keychain_account !== null && row.keychain_account !== '') {
        const secret = await getSecret(SERVICE_NAME, row.keychain_account).catch(() => null);
        hasKey = secret !== null && secret !== '';
    }

    return {
        id: row.id,
        provider: row.provider,
        label: row.label,
        projectId: row.project_id,
        isDefault: row.is_default,
        hasKey,
        createdAt: row.created_at,
    };
}

/**
 * Resolve the actual API key string for a given key ID.
 * Used internally when an agent needs the key to make an API call.
 */
export async function resolveKeySecret(keyId: string): Promise<string | null> {
    const row = await getOne<{ keychain_account: string | null }>(
        `SELECT keychain_account FROM provider_keys WHERE id = $1`,
        [keyId]
    );
    if (row === null || row.keychain_account === null) return null;
    return getSecret(SERVICE_NAME, row.keychain_account);
}

/**
 * Resolve the default key for a provider, optionally scoped to a project.
 * Falls back to the global default if no project-scoped default exists.
 */
export async function resolveDefaultKey(
    provider: string,
    projectId?: string | null
): Promise<string | null> {
    // Try project-scoped default first
    if (projectId !== undefined && projectId !== null) {
        const projectKey = await getOne<{ keychain_account: string | null }>(
            `SELECT keychain_account FROM provider_keys
             WHERE provider = $1 AND project_id = $2 AND is_default = true
             LIMIT 1`,
            [provider, projectId]
        );
        if (projectKey?.keychain_account !== null && projectKey?.keychain_account !== undefined) {
            const secret = await getSecret(SERVICE_NAME, projectKey.keychain_account);
            if (secret !== null && secret !== '') return secret;
        }
    }

    // Fall back to global default
    const globalKey = await getOne<{ keychain_account: string | null }>(
        `SELECT keychain_account FROM provider_keys
         WHERE provider = $1 AND project_id IS NULL AND is_default = true
         LIMIT 1`,
        [provider]
    );
    if (globalKey?.keychain_account !== null && globalKey?.keychain_account !== undefined) {
        return getSecret(SERVICE_NAME, globalKey.keychain_account);
    }

    return null;
}

/**
 * Update a key's label, default status, or project scope.
 * To update the actual API key, pass a new apiKey value.
 */
export async function updateProviderKey(
    keyId: string,
    updates: {
        readonly label?: string;
        readonly isDefault?: boolean;
        readonly projectId?: string | null;
        readonly apiKey?: string;
    }
): Promise<{ readonly success: boolean; readonly error?: string }> {
    const existing = await getOne<{ provider: string; keychain_account: string | null }>(
        `SELECT provider, keychain_account FROM provider_keys WHERE id = $1`,
        [keyId]
    );
    if (existing === null) return { success: false, error: 'Key not found' };

    // If setting as default, unset existing defaults
    if (updates.isDefault === true) {
        const projectId = updates.projectId !== undefined ? updates.projectId : null;
        await unsetDefaultForProvider(existing.provider, projectId);
    }

    // Build UPDATE dynamically
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (updates.label !== undefined) {
        setClauses.push(`label = $${paramIdx++}`);
        params.push(updates.label.trim());
    }
    if (updates.isDefault !== undefined) {
        setClauses.push(`is_default = $${paramIdx++}`);
        params.push(updates.isDefault);
    }
    if (updates.projectId !== undefined) {
        setClauses.push(`project_id = $${paramIdx++}`);
        params.push(updates.projectId);
    }

    if (setClauses.length > 0) {
        params.push(keyId);
        await query(
            `UPDATE provider_keys SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
            params
        );
    }

    // Update keychain secret if new API key provided
    if (updates.apiKey !== undefined && updates.apiKey.trim() !== '') {
        const account = existing.keychain_account ?? keychainAccount(existing.provider, keyId);
        await setSecret(SERVICE_NAME, account, updates.apiKey.trim());
        if (existing.keychain_account === null) {
            await query(`UPDATE provider_keys SET keychain_account = $1 WHERE id = $2`, [account, keyId]);
        }
    }

    log.info({ keyId }, 'Updated provider key');
    return { success: true };
}

/**
 * Delete a provider key — removes from both DB and Keychain.
 */
export async function deleteProviderKey(
    keyId: string
): Promise<{ readonly success: boolean; readonly error?: string }> {
    const existing = await getOne<{ keychain_account: string | null }>(
        `SELECT keychain_account FROM provider_keys WHERE id = $1`,
        [keyId]
    );
    if (existing === null) return { success: false, error: 'Key not found' };

    // Remove from Keychain
    if (existing.keychain_account !== null && existing.keychain_account !== '') {
        await deleteSecret(SERVICE_NAME, existing.keychain_account).catch(() => { /* ignore */ });
    }

    // Remove from DB
    await query(`DELETE FROM provider_keys WHERE id = $1`, [keyId]);

    log.info({ keyId }, 'Deleted provider key');
    return { success: true };
}

// ── Helpers ─────────────────────────────────────────

async function unsetDefaultForProvider(provider: string, projectId: string | null): Promise<void> {
    if (projectId !== null) {
        await query(
            `UPDATE provider_keys SET is_default = false
             WHERE provider = $1 AND project_id = $2 AND is_default = true`,
            [provider, projectId]
        );
    } else {
        await query(
            `UPDATE provider_keys SET is_default = false
             WHERE provider = $1 AND project_id IS NULL AND is_default = true`,
            [provider]
        );
    }
}
