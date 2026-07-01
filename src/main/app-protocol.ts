/**
 * Core `kageops://` custom-scheme registration.
 *
 * OSS-split fix: the splash + welcome windows are OPEN features but their
 * `kageops://` protocol handler used to live only in the commercial
 * `auth-window.ts`. In the open build (auth-window absent) there was no
 * in-process handler, so `loadURL('kageops://splash/...')` fell through to the
 * OS-registered `kageops://` app — spawning a second, unrelated instance.
 *
 * This module registers the scheme + a handler that serves splash/welcome from
 * disk in EVERY build. The commercial layer (auth-window) still owns the richer
 * router (auth + plan + splash + welcome) in the paid build; `main.ts` picks the
 * commercial router when present and this core one otherwise. Either way exactly
 * one `protocol.handle('kageops', …)` is registered.
 */
import { protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../shared/logger';

const log = createLogger('AppProtocol');

function getMimeType(filename: string): string {
    if (filename.endsWith('.html')) return 'text/html; charset=utf-8';
    if (filename.endsWith('.js') || filename.endsWith('.mjs')) return 'application/javascript; charset=utf-8';
    if (filename.endsWith('.css')) return 'text/css; charset=utf-8';
    if (filename.endsWith('.png')) return 'image/png';
    if (filename.endsWith('.svg')) return 'image/svg+xml';
    if (filename.endsWith('.woff2')) return 'font/woff2';
    if (filename.endsWith('.woff')) return 'font/woff';
    if (filename.endsWith('.ico')) return 'image/x-icon';
    return 'application/octet-stream';
}

function serveFromDir(dir: string, prefix: string, url: string, label: string): Response {
    const filePart = url.replace(prefix, '').split('?')[0] ?? '';
    const assetPath = path.join(dir, filePart);
    try {
        const content = fs.readFileSync(assetPath);
        return new Response(new Uint8Array(content), {
            headers: { 'Content-Type': getMimeType(filePart) },
        });
    } catch {
        log.warn({ label, filePart }, `${label} asset not found (404)`);
        return new Response(null, { status: 404 });
    }
}

/**
 * Register the `kageops://` scheme as privileged. MUST be called before the
 * app `ready` event (Electron requirement). Safe to call in every build.
 */
export function registerAppScheme(): void {
    protocol.registerSchemesAsPrivileged([
        { scheme: 'kageops', privileges: { secure: true, standard: true } },
    ]);
}

/**
 * Register the core `kageops://` request handler serving splash + welcome
 * assets from disk. Call AFTER the app is ready. Used by the open build; the
 * commercial build registers its own richer handler instead (auth-window).
 */
export function registerAppProtocol(): void {
    const splashDir = path.join(__dirname, '..', 'renderer', 'splash');
    const welcomeDir = path.join(__dirname, '..', 'renderer', 'welcome');

    protocol.handle('kageops', (request) => {
        const url = request.url;
        if (url.startsWith('kageops://splash/')) {
            return serveFromDir(splashDir, 'kageops://splash/', url, 'splash');
        }
        if (url.startsWith('kageops://welcome/')) {
            return serveFromDir(welcomeDir, 'kageops://welcome/', url, 'welcome');
        }
        // auth:// and plan:// routes only exist in the commercial build, which
        // registers its own handler. In the open build they have no meaning.
        return new Response(null, { status: 404 });
    });
}
