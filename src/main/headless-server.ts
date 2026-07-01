/**
 * KageOps Headless HTTP Control Plane
 *
 * A lightweight Node http server exposed when the app runs with --headless.
 * Routes:
 *   GET  /health           — liveness probe
 *   GET  /projects         — list active projects
 *   POST /projects         — start a new project  { name, description }
 *   GET  /agents           — list agents + status
 *   GET  /events/stream    — SSE stream of activity events
 */

import * as http from 'http';
import { createLogger } from '../shared/logger';
import type { OrchestratorHandles } from './orchestrator-bootstrap';

const log = createLogger('HeadlessServer');

const DEFAULT_PORT = parseInt(process.env['KAGEOPS_PORT'] ?? '8080', 10);

export { DEFAULT_PORT };

// SSE client list
const sseClients = new Set<http.ServerResponse>();

/** Broadcast an event to all connected SSE clients. */
export function broadcastEvent(eventType: string, data: unknown): void {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(payload);
        } catch {
            sseClients.delete(client);
        }
    }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

export function createHeadlessServer(orchestrator: OrchestratorHandles | null, port = DEFAULT_PORT): http.Server {
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const method = req.method ?? 'GET';

        // CORS headers for local tooling
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        try {
            // GET /health
            if (method === 'GET' && url === '/health') {
                sendJson(res, 200, {
                    status: 'ok',
                    orchestrator: orchestrator !== null ? 'running' : 'unavailable',
                    timestamp: new Date().toISOString(),
                });
                return;
            }

            // GET /projects
            if (method === 'GET' && url === '/projects') {
                const projects = orchestrator !== null
                    ? await orchestrator.sensei.getAllProjectsStatus()
                    : [];
                sendJson(res, 200, projects);
                return;
            }

            // POST /projects
            if (method === 'POST' && url === '/projects') {
                const raw = await readBody(req);
                let body: { name?: unknown; description?: unknown };
                try {
                    body = JSON.parse(raw) as { name?: unknown; description?: unknown };
                } catch {
                    sendJson(res, 400, { error: 'Invalid JSON body' });
                    return;
                }

                const name = typeof body.name === 'string' ? body.name.trim() : '';
                const description = typeof body.description === 'string' ? body.description.trim() : '';

                if (!name) {
                    sendJson(res, 400, { error: 'name is required' });
                    return;
                }

                if (orchestrator === null) {
                    sendJson(res, 503, { error: 'Orchestrator unavailable' });
                    return;
                }

                const projectId = await orchestrator.sensei.startProject(name, description, 'low');
                sendJson(res, 201, { projectId });
                return;
            }

            // GET /agents
            if (method === 'GET' && url === '/agents') {
                const agents = orchestrator !== null
                    ? orchestrator.agentRegistry.getAllAgents()
                    : [];
                sendJson(res, 200, agents);
                return;
            }

            // GET /events/stream  — SSE
            if (method === 'GET' && url === '/events/stream') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                });
                res.write('event: connected\ndata: {"message":"KageOps event stream connected"}\n\n');

                sseClients.add(res);
                req.on('close', () => sseClients.delete(res));
                return;
            }

            sendJson(res, 404, { error: 'Not found' });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err: msg, url, method }, 'Headless server request error');
            sendJson(res, 500, { error: 'Internal server error' });
        }
    });

    server.listen(port, () => {
        log.info({ port }, 'KageOps headless control plane listening');
    });

    return server;
}
