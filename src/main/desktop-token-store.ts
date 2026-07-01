import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Persistent storage for the desktop session JWT issued by the Worker.
 *
 * Encryption: Electron's `safeStorage` API uses the OS keychain on each
 * platform — DPAPI (Windows), Keychain (macOS), libsecret/kwallet (Linux).
 * The encrypted blob is stored on disk under userData/desktop-session.bin
 * but can ONLY be decrypted from the same OS user account on the same
 * machine. If another user copies the file, decryption fails.
 *
 * Companion device_id is persisted unencrypted under userData/device-id.txt
 * — it's not a secret, just a stable per-install identifier used to bind
 * sessions to this specific machine on the Worker side.
 */

interface StoredSession {
    readonly token: string;
    readonly user_id: string;
    readonly expires_at: number;
    readonly issued_at: number;
}

const TOKEN_FILE = 'desktop-session.bin';
const DEVICE_ID_FILE = 'device-id.txt';

function tokenPath(): string {
    return path.join(app.getPath('userData'), TOKEN_FILE);
}

function deviceIdPath(): string {
    return path.join(app.getPath('userData'), DEVICE_ID_FILE);
}

/**
 * Load (and lazily generate) the per-install device id. Stable across
 * launches but unique to this machine + OS user. Used by the Worker to
 * bind login codes to the device that initiated them.
 */
export function getOrCreateDeviceId(): string {
    const filePath = deviceIdPath();
    try {
        if (fs.existsSync(filePath)) {
            const existing = fs.readFileSync(filePath, 'utf-8').trim();
            if (existing.length >= 8) return existing;
        }
    } catch {
        // fall through to regenerate
    }
    const newId = crypto.randomBytes(16).toString('hex');
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, newId, { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
        console.warn('[TokenStore] failed to persist device_id:', err instanceof Error ? err.message : err);
    }
    return newId;
}

/**
 * Generate a per-flow random state token. NOT persisted — only lives in
 * the auth-flow orchestrator's memory between init and callback.
 */
export function newStateToken(): string {
    return crypto.randomBytes(24).toString('hex');
}

export function saveSession(session: { token: string; user_id: string; expires_at: number }): void {
    if (!safeStorage.isEncryptionAvailable()) {
        console.warn('[TokenStore] OS encryption unavailable — refusing to write plaintext token to disk');
        return;
    }
    const record: StoredSession = {
        token: session.token,
        user_id: session.user_id,
        expires_at: session.expires_at,
        issued_at: Math.floor(Date.now() / 1000),
    };
    const encrypted = safeStorage.encryptString(JSON.stringify(record));
    const filePath = tokenPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, encrypted, { mode: 0o600 });
}

export function loadSession(): StoredSession | null {
    const filePath = tokenPath();
    if (!fs.existsSync(filePath)) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
        const encrypted = fs.readFileSync(filePath);
        const decrypted = safeStorage.decryptString(encrypted);
        const parsed = JSON.parse(decrypted) as StoredSession;
        if (typeof parsed.token !== 'string'
            || typeof parsed.user_id !== 'string'
            || typeof parsed.expires_at !== 'number') {
            return null;
        }
        // Treat expired tokens as missing — caller will trigger re-auth
        const now = Math.floor(Date.now() / 1000);
        if (parsed.expires_at <= now) return null;
        return parsed;
    } catch (err) {
        console.warn('[TokenStore] failed to decrypt session:', err instanceof Error ? err.message : err);
        return null;
    }
}

export function clearSession(): void {
    const filePath = tokenPath();
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
        console.warn('[TokenStore] failed to delete session:', err instanceof Error ? err.message : err);
    }
}
