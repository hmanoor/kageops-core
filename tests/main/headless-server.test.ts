/**
 * Tests for headless-server.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';
import { createHeadlessServer } from '../../src/main/headless-server';

vi.mock('../../src/shared/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    }),
}));

// ── Helpers ───────────────────────────────────────────

function makeOrchestrator(overrides: Partial<{
    projects: unknown[];
    agents: unknown[];
    startResult: string;
}> = {}) {
    return {
        sensei: {
            getAllProjectsStatus: vi.fn(async () => overrides.projects ?? []),
            startProject: vi.fn(async () => overrides.startResult ?? 'proj-123'),
        },
        agentRegistry: {
            getAllAgents: vi.fn(() => overrides.agents ?? []),
        },
        eventBus: {
            subscribeAll: vi.fn(),
        },
    } as unknown as Parameters<typeof createHeadlessServer>[0];
}

function getPort(server: http.Server): number {
    return (server.address() as { port: number }).port;
}

function request(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
        const opts: http.RequestOptions = {
            hostname: 'localhost',
            port,
            path,
            method,
            headers: { 'Content-Type': 'application/json' },
        };

        const req = http.request(opts, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode ?? 0, body: data });
                }
            });
        });

        req.on('error', reject);
        if (body !== undefined) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

function startServer(orch: ReturnType<typeof makeOrchestrator> | null): Promise<http.Server> {
    return new Promise((resolve) => {
        // port 0 = OS assigns a free port
        const server = createHeadlessServer(orch, 0);
        server.once('listening', () => resolve(server));
    });
}

// ── Tests ─────────────────────────────────────────────

describe('createHeadlessServer', () => {
    let server: http.Server;
    let orch: ReturnType<typeof makeOrchestrator>;
    let port: number;

    beforeAll(async () => {
        orch = makeOrchestrator({
            projects: [{ id: 'p1', name: 'Test', phase: 'discovery' }],
            agents: [{ name: 'forge', status: 'idle' }],
        });
        server = await startServer(orch);
        port = getPort(server);
    });

    afterAll(() => {
        server.close();
    });

    it('GET /health returns ok with orchestrator status', async () => {
        const { status, body } = await request(port, 'GET', '/health');
        expect(status).toBe(200);
        expect((body as any).status).toBe('ok');
        expect((body as any).orchestrator).toBe('running');
    });

    it('GET /health returns unavailable when orchestrator is null', async () => {
        const s = await startServer(null);
        const { body } = await request(getPort(s), 'GET', '/health');
        expect((body as any).orchestrator).toBe('unavailable');
        s.close();
    });

    it('GET /projects returns projects from orchestrator', async () => {
        const { status, body } = await request(port, 'GET', '/projects');
        expect(status).toBe(200);
        expect(Array.isArray(body)).toBe(true);
        expect((body as any[])[0].name).toBe('Test');
    });

    it('GET /agents returns agents from registry', async () => {
        const { status, body } = await request(port, 'GET', '/agents');
        expect(status).toBe(200);
        expect(Array.isArray(body)).toBe(true);
        expect((body as any[])[0].name).toBe('forge');
    });

    it('POST /projects creates a project and returns projectId', async () => {
        const { status, body } = await request(port, 'POST', '/projects', {
            name: 'New Project',
            description: 'A test project',
        });
        expect(status).toBe(201);
        expect((body as any).projectId).toBe('proj-123');
        expect(orch!.sensei.startProject).toHaveBeenCalledWith('New Project', 'A test project', 'low');
    });

    it('POST /projects returns 400 when name is missing', async () => {
        const { status, body } = await request(port, 'POST', '/projects', { description: 'No name' });
        expect(status).toBe(400);
        expect((body as any).error).toContain('name');
    });

    it('POST /projects returns 400 on invalid JSON', async () => {
        const result = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
            const req = http.request({
                hostname: 'localhost', port,
                path: '/projects', method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.write('not-json{{{');
            req.end();
        });
        expect(result.status).toBe(400);
    });

    it('POST /projects returns 503 when orchestrator is null', async () => {
        const s = await startServer(null);
        const { status } = await request(getPort(s), 'POST', '/projects', { name: 'X', description: 'Y' });
        expect(status).toBe(503);
        s.close();
    });

    it('GET /unknown returns 404', async () => {
        const { status } = await request(port, 'GET', '/unknown');
        expect(status).toBe(404);
    });

    it('OPTIONS returns 204 for CORS preflight', async () => {
        const statusCode = await new Promise<number>((resolve, reject) => {
            const req = http.request({
                hostname: 'localhost', port, path: '/health', method: 'OPTIONS',
            }, (res) => resolve(res.statusCode ?? 0));
            req.on('error', reject);
            req.end();
        });
        expect(statusCode).toBe(204);
    });
});
