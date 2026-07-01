/**
 * GraphifyBridge unit tests
 *
 * Tests the file-based knowledge graph bridge: loading, querying,
 * god nodes, shortest path, and community lookup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { GraphifyBridge, resetGraphifyBridgeForTesting } from '../../src/workspace/graphify-bridge';
import type { GraphifyGraph } from '../../src/workspace/graphify-bridge';

// ── Mock logger ────────────────────────────────────────

vi.mock('../../src/shared/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

// ── Test data ──────────────────────────────────────────

const MOCK_GRAPH: GraphifyGraph = {
    nodes: [
        { id: 'n1', label: 'EventBus', source_file: 'src/event-bus.ts', file_type: 'class', community: 0 },
        { id: 'n2', label: 'Sensei', source_file: 'src/sensei.ts', file_type: 'class', community: 0 },
        { id: 'n3', label: 'Forge', source_file: 'src/forge.ts', file_type: 'class', community: 1 },
        { id: 'n4', label: 'Database', source_file: 'src/db/client.ts', file_type: 'module', community: 2 },
        { id: 'n5', label: 'TaskRouter', source_file: 'src/task-router.ts', file_type: 'class', community: 0 },
        { id: 'n6', label: 'AiAdapter', source_file: 'src/ai-adapter.ts', file_type: 'module', community: 1 },
    ],
    links: [
        { source: 'n1', target: 'n2', relation: 'imports', confidence: 'EXTRACTED' },
        { source: 'n2', target: 'n3', relation: 'orchestrates', confidence: 'INFERRED' },
        { source: 'n2', target: 'n5', relation: 'uses', confidence: 'EXTRACTED' },
        { source: 'n3', target: 'n6', relation: 'calls', confidence: 'EXTRACTED' },
        { source: 'n3', target: 'n4', relation: 'queries', confidence: 'EXTRACTED' },
        { source: 'n1', target: 'n4', relation: 'publishes_to', confidence: 'INFERRED' },
        { source: 'n5', target: 'n3', relation: 'routes_to', confidence: 'EXTRACTED' },
    ],
};

const MOCK_REPORT = `# Knowledge Graph Report\n\n## God Nodes\n- EventBus (degree 3)\n- Sensei (degree 3)\n`;

// ── Tests ──────────────────────────────────────────────

describe('GraphifyBridge', () => {
    let bridge: GraphifyBridge;
    let tmpDir: string;

    beforeEach(() => {
        resetGraphifyBridgeForTesting();
        bridge = new GraphifyBridge();
        tmpDir = path.join(process.env.TEMP ?? '/tmp', `graphify-test-${Date.now()}`);
        fs.mkdirSync(path.join(tmpDir, 'graphify-out'), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeGraph(graph: GraphifyGraph = MOCK_GRAPH): void {
        fs.writeFileSync(
            path.join(tmpDir, 'graphify-out', 'graph.json'),
            JSON.stringify(graph),
            'utf-8'
        );
    }

    function writeReport(text: string = MOCK_REPORT): void {
        fs.writeFileSync(
            path.join(tmpDir, 'graphify-out', 'GRAPH_REPORT.md'),
            text,
            'utf-8'
        );
    }

    // ── getStatus ─────────────────────────────────────

    describe('getStatus()', () => {
        it('reports no graph when directory is empty', () => {
            const status = bridge.getStatus(tmpDir);
            expect(status.hasGraph).toBe(false);
            expect(status.nodeCount).toBe(0);
        });

        it('reports graph when graph.json exists', () => {
            writeGraph();
            const status = bridge.getStatus(tmpDir);
            expect(status.hasGraph).toBe(true);
            expect(status.nodeCount).toBe(6);
            expect(status.edgeCount).toBe(7);
            expect(status.communityCount).toBe(3);
        });

        it('reports wiki when wiki/index.md exists', () => {
            writeGraph();
            fs.mkdirSync(path.join(tmpDir, 'graphify-out', 'wiki'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'graphify-out', 'wiki', 'index.md'), '# Wiki', 'utf-8');
            const status = bridge.getStatus(tmpDir);
            expect(status.hasWiki).toBe(true);
        });
    });

    // ── getGodNodes ───────────────────────────────────

    describe('getGodNodes()', () => {
        it('returns top nodes by degree', () => {
            writeGraph();
            const gods = bridge.getGodNodes(tmpDir, 3);
            expect(gods.length).toBe(3);
            // n2 (Sensei) and n3 (Forge) have the most connections
            expect(gods.map((g) => g.label)).toContain('Sensei');
            expect(gods.map((g) => g.label)).toContain('Forge');
        });

        it('returns empty array when no graph', () => {
            const gods = bridge.getGodNodes(tmpDir);
            expect(gods).toHaveLength(0);
        });
    });

    // ── getCommunity ──────────────────────────────────

    describe('getCommunity()', () => {
        it('returns all nodes in community 0', () => {
            writeGraph();
            const nodes = bridge.getCommunity(tmpDir, 0);
            expect(nodes.length).toBe(3); // EventBus, Sensei, TaskRouter
            expect(nodes.map((n) => n.label)).toContain('EventBus');
            expect(nodes.map((n) => n.label)).toContain('Sensei');
        });

        it('returns empty for non-existent community', () => {
            writeGraph();
            const nodes = bridge.getCommunity(tmpDir, 99);
            expect(nodes).toHaveLength(0);
        });
    });

    // ── getNeighbors ──────────────────────────────────

    describe('getNeighbors()', () => {
        it('returns direct neighbors of a node', () => {
            writeGraph();
            const result = bridge.getNeighbors(tmpDir, 'Sensei');
            expect(result.nodes.length).toBeGreaterThan(1); // Sensei + neighbors
            expect(result.edges.length).toBeGreaterThan(0);
            expect(result.summary).toContain('Sensei');
        });

        it('handles case-insensitive lookup', () => {
            writeGraph();
            const result = bridge.getNeighbors(tmpDir, 'sensei');
            expect(result.nodes.length).toBeGreaterThan(0);
        });

        it('returns empty for unknown node', () => {
            writeGraph();
            const result = bridge.getNeighbors(tmpDir, 'NonExistent');
            expect(result.nodes).toHaveLength(0);
            expect(result.summary).toContain('not found');
        });
    });

    // ── queryGraph ────────────────────────────────────

    describe('queryGraph()', () => {
        it('finds nodes matching keywords', () => {
            writeGraph();
            const result = bridge.queryGraph(tmpDir, 'event bus database');
            expect(result.nodes.length).toBeGreaterThan(0);
            expect(result.nodes.map((n) => n.label)).toContain('EventBus');
        });

        it('respects token budget', () => {
            writeGraph();
            const small = bridge.queryGraph(tmpDir, 'forge adapter', 100);
            const large = bridge.queryGraph(tmpDir, 'forge adapter', 5000);
            expect(large.nodes.length).toBeGreaterThanOrEqual(small.nodes.length);
        });

        it('returns empty for no matches', () => {
            writeGraph();
            const result = bridge.queryGraph(tmpDir, 'xyznonexistent');
            expect(result.nodes).toHaveLength(0);
        });
    });

    // ── shortestPath ──────────────────────────────────

    describe('shortestPath()', () => {
        it('finds path between connected nodes', () => {
            writeGraph();
            const result = bridge.shortestPath(tmpDir, 'EventBus', 'Forge');
            expect(result).not.toBeNull();
            expect(result!.path.length).toBeGreaterThanOrEqual(2);
            expect(result!.path[0]).toBe('EventBus');
            expect(result!.path[result!.path.length - 1]).toBe('Forge');
        });

        it('returns null for disconnected nodes', () => {
            const disconnected: GraphifyGraph = {
                nodes: [
                    { id: 'a', label: 'A' },
                    { id: 'b', label: 'B' },
                ],
                links: [], // no edges
            };
            writeGraph(disconnected);
            const result = bridge.shortestPath(tmpDir, 'A', 'B');
            expect(result).toBeNull();
        });

        it('returns null for unknown nodes', () => {
            writeGraph();
            const result = bridge.shortestPath(tmpDir, 'EventBus', 'Ghost');
            expect(result).toBeNull();
        });
    });

    // ── getReport ─────────────────────────────────────

    describe('getReport()', () => {
        it('returns report content when it exists', () => {
            writeReport();
            const report = bridge.getReport(tmpDir);
            expect(report).not.toBeNull();
            expect(report).toContain('God Nodes');
        });

        it('returns null when no report', () => {
            const report = bridge.getReport(tmpDir);
            expect(report).toBeNull();
        });
    });

    // ── getStats ──────────────────────────────────────

    describe('getStats()', () => {
        it('returns stats with confidence breakdown', () => {
            writeGraph();
            const stats = bridge.getStats(tmpDir);
            expect(stats).not.toBeNull();
            expect(stats!.nodeCount).toBe(6);
            expect(stats!.edgeCount).toBe(7);
            expect(stats!.communityCount).toBe(3);
            expect(stats!.confidenceBreakdown['EXTRACTED']).toBeGreaterThan(0);
            expect(stats!.confidenceBreakdown['INFERRED']).toBeGreaterThan(0);
        });

        it('returns null when no graph', () => {
            const stats = bridge.getStats(tmpDir);
            expect(stats).toBeNull();
        });
    });
});
