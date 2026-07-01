/**
 * artifact-live-server tests (B-425).
 *
 * Pins the contract:
 *   - server binds 127.0.0.1 on a free port
 *   - `/` serves index.html; missing paths → 404
 *   - traversal (`/../etc/passwd`) → 403
 *   - non-GET methods → 405
 *   - stop() releases the port cleanly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as net from 'net';
import {
    startLiveServer,
    resolveRequestPath,
    type LiveServerHandle,
} from '../../src/main/artifact-live-server';

// ── Helpers ──────────────────────────────────────────

async function makeSite(): Promise<string> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kageops-live-'));
    await fsp.writeFile(path.join(root, 'index.html'), '<!doctype html><h1>root</h1>');
    await fsp.mkdir(path.join(root, 'assets'));
    await fsp.writeFile(path.join(root, 'assets', 'app.js'), 'console.log(1);');
    await fsp.writeFile(path.join(root, 'assets', 'styles.css'), 'body{color:red}');
    return root;
}

interface FetchResult {
    readonly statusCode: number;
    readonly headers: http.IncomingHttpHeaders;
    readonly body: string;
}

function rawRequest(port: number, request: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
            socket.write(request);
        });
        let data = '';
        socket.on('data', (chunk) => {
            data += chunk.toString('utf8');
        });
        socket.on('end', () => {
            const match = /^HTTP\/1\.[01] (\d{3})/.exec(data);
            resolve(match !== null ? Number.parseInt(match[1] ?? '0', 10) : 0);
        });
        socket.on('error', reject);
    });
}

function fetchRaw(
    url: string,
    opts: { method?: string } = {},
): Promise<FetchResult> {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method: opts.method ?? 'GET' }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode ?? 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ── resolveRequestPath ───────────────────────────────

describe('resolveRequestPath', () => {
    const root = '/tmp/some-project';

    it('resolves root URL to index.html', () => {
        expect(resolveRequestPath(root, '/')).toBe(path.resolve(root, 'index.html'));
    });

    it('resolves directory URLs to their index.html', () => {
        expect(resolveRequestPath(root, '/sub/')).toBe(path.resolve(root, 'sub/index.html'));
    });

    it('decodes percent-encoded segments', () => {
        expect(resolveRequestPath(root, '/a%20b/c.css'))
            .toBe(path.resolve(root, 'a b/c.css'));
    });

    it('strips query strings', () => {
        expect(resolveRequestPath(root, '/index.html?v=2'))
            .toBe(path.resolve(root, 'index.html'));
    });

    it('returns null for parent traversal', () => {
        expect(resolveRequestPath(root, '/../etc/passwd')).toBeNull();
        expect(resolveRequestPath(root, '/a/../../../secret')).toBeNull();
    });

    it('returns null for URLs that do not start with /', () => {
        expect(resolveRequestPath(root, 'not-a-path')).toBeNull();
    });
});

// ── startLiveServer (real socket) ────────────────────

describe('startLiveServer', () => {
    let root: string;
    let handle: LiveServerHandle;

    beforeEach(async () => {
        root = await makeSite();
        handle = await startLiveServer(root);
    });

    afterEach(async () => {
        await handle.stop();
        await fsp.rm(root, { recursive: true, force: true });
    });

    it('binds to 127.0.0.1 on a positive port', () => {
        expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        expect(handle.port).toBeGreaterThan(0);
    });

    it('serves index.html at /', async () => {
        const res = await fetchRaw(handle.url);
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('<h1>root</h1>');
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.headers['cache-control']).toBe('no-store');
    });

    it('serves nested assets with the right mime type', async () => {
        const js = await fetchRaw(`${handle.url}assets/app.js`);
        expect(js.statusCode).toBe(200);
        expect(js.body).toContain('console.log(1);');
        expect(js.headers['content-type']).toContain('application/javascript');

        const css = await fetchRaw(`${handle.url}assets/styles.css`);
        expect(css.statusCode).toBe(200);
        expect(css.headers['content-type']).toContain('text/css');
    });

    it('returns 404 for missing files', async () => {
        const res = await fetchRaw(`${handle.url}missing.txt`);
        expect(res.statusCode).toBe(404);
    });

    it('returns 403 for traversal attempts (raw request bypasses URL normalization)', async () => {
        // Node's http.request normalizes '../..' out of the request-target
        // before it goes on the wire. Use a raw TCP socket so the server
        // sees the literal traversal path and we can assert the guard fires.
        const status = await rawRequest(handle.port, 'GET /../../etc/passwd HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
        expect(status).toBe(403);
    });

    it('rejects non-GET methods with 405', async () => {
        const res = await fetchRaw(handle.url, { method: 'POST' });
        expect(res.statusCode).toBe(405);
        expect(res.headers['allow']).toContain('GET');
    });

    it('serves HEAD without a body', async () => {
        const res = await fetchRaw(`${handle.url}index.html`, { method: 'HEAD' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe('');
    });

    it('stop() releases the port so subsequent connects fail', async () => {
        const port = handle.port;
        await handle.stop();
        // Replace handle so afterEach does not try to stop twice.
        handle = { url: handle.url, port, stop: async () => undefined };
        await expect(fetchRaw(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    });
});
