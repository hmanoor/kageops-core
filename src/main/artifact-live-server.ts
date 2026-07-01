/**
 * Artifact Live Preview server (B-425).
 *
 * Spawns a minimal HTTP server bound to 127.0.0.1 on a random port so the
 * renderer can open `http://127.0.0.1:<port>/` in a browser and see the
 * project's static site rendered exactly as it will deploy. The server is
 * strictly read-only, strictly local (no 0.0.0.0), and refuses any path
 * that resolves outside the project root.
 *
 * Scope is deliberately small: GET only, no WebSockets, no hot-reload.
 * The intended use case is "open index.html and poke it" — a user who
 * wants HMR should run the project's real dev command. Lifecycle is
 * caller-owned: `start` returns a `stop()` handle that must be invoked
 * when the browser panel closes.
 */

import * as http from 'http';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { createLogger } from '../shared/logger';
import { resolveSafeWorkspacePath } from '../workspace/artifact-service';

const log = createLogger('ArtifactLiveServer');

export interface LiveServerHandle {
    readonly url: string;
    readonly port: number;
    readonly stop: () => Promise<void>;
}

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
});

/**
 * Start an HTTP server rooted at `repoRoot`. Returns once the server is
 * listening — the `url` field is the origin the renderer should navigate to.
 */
export async function startLiveServer(repoRoot: string): Promise<LiveServerHandle> {
    const server = http.createServer((req, res) => {
        void handleRequest(repoRoot, req, res);
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        // Port 0 → OS picks a free port. Host 127.0.0.1 keeps it off the network.
        server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw new Error('Live server failed to bind a port');
    }

    const port = address.port;
    const url = `http://127.0.0.1:${port}/`;
    log.info({ repoRoot, port }, 'live preview server listening');

    const stop = async (): Promise<void> => {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
        log.info({ port }, 'live preview server stopped');
    };

    return { url, port, stop };
}

/**
 * Resolve the request URL to an absolute file path inside `repoRoot`.
 * Returns null if the URL is malformed or would escape the root.
 */
export function resolveRequestPath(repoRoot: string, reqUrl: string): string | null {
    // Strip query string + fragment; default root to index.html.
    const qIdx = reqUrl.search(/[?#]/);
    const cleaned = qIdx === -1 ? reqUrl : reqUrl.slice(0, qIdx);
    if (!cleaned.startsWith('/')) return null;

    let relative = decodeURIComponent(cleaned.slice(1));
    if (relative === '' || relative.endsWith('/')) {
        relative = `${relative}index.html`;
    }
    // Normalize the URL-style path against the root.
    try {
        return resolveSafeWorkspacePath(repoRoot, relative);
    } catch {
        return null;
    }
}

async function handleRequest(
    repoRoot: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD');
        res.end('Method Not Allowed');
        return;
    }
    if (req.url === undefined) {
        res.statusCode = 400;
        res.end('Bad Request');
        return;
    }

    const absPath = resolveRequestPath(repoRoot, req.url);
    if (absPath === null) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
    }

    let buf: Buffer;
    try {
        const stat = await fsp.stat(absPath);
        if (!stat.isFile()) {
            res.statusCode = 404;
            res.end('Not Found');
            return;
        }
        buf = await fsp.readFile(absPath);
    } catch {
        res.statusCode = 404;
        res.end('Not Found');
        return;
    }

    const ext = path.extname(absPath).toLowerCase();
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    // Local-only security posture: no cross-origin, no framing from elsewhere.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') {
        res.setHeader('Content-Length', buf.byteLength);
        res.end();
        return;
    }
    res.end(buf);
}
