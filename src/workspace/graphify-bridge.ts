/**
 * KageOps Graphify Bridge
 *
 * Reads graphify-out/graph.json and GRAPH_REPORT.md to provide
 * knowledge graph queries for agents. Works file-based (no MCP server
 * needed) with optional MCP server for richer queries.
 *
 * Graphify builds a tree-sitter-based knowledge graph with community
 * clustering, god-node detection, and cross-document surprise edges.
 * This bridge makes that graph queryable from TypeScript.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { createLogger } from '../shared/logger';

const log = createLogger('GraphifyBridge');

// ── Types ────────────────────────────────────────────

export interface GraphifyNode {
    readonly id: string;
    readonly label: string;
    readonly source_file?: string;
    readonly source_location?: string;
    readonly file_type?: string;
    readonly community?: number;
    readonly [key: string]: unknown;
}

export interface GraphifyEdge {
    readonly source: string;
    readonly target: string;
    readonly relation?: string;
    readonly confidence?: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
    readonly confidence_score?: number;
}

export interface GraphifyHyperedge {
    readonly id: string;
    readonly label: string;
    readonly nodes: readonly string[];
}

export interface GraphifyGraph {
    readonly nodes: readonly GraphifyNode[];
    readonly links: readonly GraphifyEdge[];
    readonly hyperedges?: readonly GraphifyHyperedge[];
}

export interface GraphifyStatus {
    readonly repoPath: string;
    readonly hasGraph: boolean;
    readonly hasReport: boolean;
    readonly hasWiki: boolean;
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly communityCount: number;
    readonly lastModified: Date | null;
}

export interface GodNode {
    readonly label: string;
    readonly degree: number;
    readonly community: number | undefined;
    readonly sourceFile: string | undefined;
}

export interface GraphQueryResult {
    readonly nodes: readonly GraphifyNode[];
    readonly edges: readonly GraphifyEdge[];
    readonly summary: string;
    readonly tokenEstimate: number;
}

export interface ShortestPathResult {
    readonly path: readonly string[];
    readonly edges: readonly GraphifyEdge[];
    readonly hops: number;
}

// ── Constants ────────────────────────────────────────

const GRAPH_DIR = 'graphify-out';
const GRAPH_JSON = 'graph.json';
const GRAPH_REPORT = 'GRAPH_REPORT.md';
const WIKI_INDEX = 'wiki/index.md';

// ── GraphifyBridge ───────────────────────────────────

export class GraphifyBridge {
    private readonly graphs = new Map<string, GraphifyGraph>();
    private readonly lastLoaded = new Map<string, number>();
    private readonly CACHE_TTL_MS = 60_000; // 1 minute cache

    // ── Status ───────────────────────────────────────

    getStatus(repoPath: string): GraphifyStatus {
        const base = this.graphifyDir(repoPath);
        const graphPath = path.join(base, GRAPH_JSON);
        const reportPath = path.join(base, GRAPH_REPORT);
        const wikiPath = path.join(base, WIKI_INDEX);

        const hasGraph = fs.existsSync(graphPath);
        const hasReport = fs.existsSync(reportPath);
        const hasWiki = fs.existsSync(wikiPath);

        let nodeCount = 0;
        let edgeCount = 0;
        let communityCount = 0;
        let lastModified: Date | null = null;

        if (hasGraph) {
            try {
                const stat = fs.statSync(graphPath);
                lastModified = stat.mtime;
                const graph = this.loadGraph(repoPath);
                if (graph !== null) {
                    nodeCount = graph.nodes.length;
                    edgeCount = graph.links.length;
                    const communities = new Set(graph.nodes.map((n) => n.community).filter((c) => c !== undefined));
                    communityCount = communities.size;
                }
            } catch {
                // File exists but unreadable
            }
        }

        return { repoPath, hasGraph, hasReport, hasWiki, nodeCount, edgeCount, communityCount, lastModified };
    }

    // ── Build ────────────────────────────────────────

    /**
     * Build the graphify knowledge graph for a repo.
     * Runs `python -m graphify.build <repoPath> --no-viz` as a child process.
     */
    async buildGraph(repoPath: string, options: { readonly update?: boolean; readonly noViz?: boolean } = {}): Promise<{
        readonly success: boolean;
        readonly nodeCount: number;
        readonly edgeCount: number;
        readonly error?: string;
    }> {
        const args = ['-c', this.buildScript(repoPath, options)];

        return new Promise((resolve) => {
            const proc = spawn('python', args, {
                cwd: repoPath,
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 300_000, // 5 minute timeout
                windowsHide: true,
            });

            let stdout = '';
            let stderr = '';

            proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
            proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code === 0) {
                    // Reload the graph
                    this.graphs.delete(repoPath);
                    const graph = this.loadGraph(repoPath);
                    log.info({ repoPath, nodeCount: graph?.nodes.length ?? 0 }, 'Graphify build complete');
                    resolve({
                        success: true,
                        nodeCount: graph?.nodes.length ?? 0,
                        edgeCount: graph?.links.length ?? 0,
                    });
                } else {
                    const error = stderr.trim() || `Process exited with code ${code}`;
                    log.warn({ repoPath, error }, 'Graphify build failed');
                    resolve({ success: false, nodeCount: 0, edgeCount: 0, error });
                }
            });

            proc.on('error', (err) => {
                log.warn({ repoPath, err: err.message }, 'Graphify build process error');
                resolve({ success: false, nodeCount: 0, edgeCount: 0, error: err.message });
            });
        });
    }

    // ── Queries ──────────────────────────────────────

    /**
     * Get the top N most-connected nodes (god nodes).
     */
    getGodNodes(repoPath: string, topN = 10): readonly GodNode[] {
        const graph = this.loadGraph(repoPath);
        if (graph === null) return [];

        // Count degree per node
        const degree = new Map<string, number>();
        for (const edge of graph.links) {
            degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
            degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
        }

        // Build lookup
        const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

        // Sort by degree, take top N
        const sorted = [...degree.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, topN);

        return sorted.map(([id, deg]) => {
            const node = nodeMap.get(id);
            return {
                label: node?.label ?? id,
                degree: deg,
                community: node?.community,
                sourceFile: node?.source_file,
            };
        });
    }

    /**
     * Get all nodes in a community.
     */
    getCommunity(repoPath: string, communityId: number): readonly GraphifyNode[] {
        const graph = this.loadGraph(repoPath);
        if (graph === null) return [];
        return graph.nodes.filter((n) => n.community === communityId);
    }

    /**
     * Get direct neighbors of a node by label.
     */
    getNeighbors(repoPath: string, label: string): GraphQueryResult {
        const graph = this.loadGraph(repoPath);
        if (graph === null) return { nodes: [], edges: [], summary: 'Graph not available', tokenEstimate: 0 };

        const node = graph.nodes.find((n) => n.label.toLowerCase() === label.toLowerCase());
        if (node === undefined) return { nodes: [], edges: [], summary: `Node "${label}" not found`, tokenEstimate: 0 };

        const relatedEdges = graph.links.filter(
            (e) => e.source === node.id || e.target === node.id
        );
        const neighborIds = new Set(
            relatedEdges.flatMap((e) => [e.source, e.target]).filter((id) => id !== node.id)
        );
        const neighborNodes = graph.nodes.filter((n) => neighborIds.has(n.id));

        const summary = `${node.label}: ${neighborNodes.length} neighbors via ${relatedEdges.length} edges`;
        const text = JSON.stringify({ node, neighbors: neighborNodes, edges: relatedEdges });

        return {
            nodes: [node, ...neighborNodes],
            edges: relatedEdges,
            summary,
            tokenEstimate: Math.ceil(text.length / 4),
        };
    }

    /**
     * BFS query — find nodes matching a question and expand outward.
     */
    queryGraph(repoPath: string, question: string, tokenBudget = 2000): GraphQueryResult {
        const graph = this.loadGraph(repoPath);
        if (graph === null) return { nodes: [], edges: [], summary: 'Graph not available', tokenEstimate: 0 };

        // Simple keyword matching to find seed nodes
        const keywords = question.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
        const seedNodes = graph.nodes.filter((n) => {
            const text = `${n.label} ${n.source_file ?? ''} ${n.file_type ?? ''}`.toLowerCase();
            return keywords.some((kw) => text.includes(kw));
        });

        if (seedNodes.length === 0) {
            return { nodes: [], edges: [], summary: `No nodes match query: "${question}"`, tokenEstimate: 0 };
        }

        // BFS from seed nodes
        const visited = new Set<string>();
        const queue = seedNodes.map((n) => n.id);
        const resultNodes: GraphifyNode[] = [];
        const resultEdges: GraphifyEdge[] = [];
        let tokensUsed = 0;
        const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

        while (queue.length > 0 && tokensUsed < tokenBudget) {
            const id = queue.shift()!;
            if (visited.has(id)) continue;
            visited.add(id);

            const node = nodeMap.get(id);
            if (node === undefined) continue;

            resultNodes.push(node);
            tokensUsed += Math.ceil(JSON.stringify(node).length / 4);

            // Expand edges
            const edges = graph.links.filter((e) => e.source === id || e.target === id);
            for (const edge of edges) {
                resultEdges.push(edge);
                const neighbor = edge.source === id ? edge.target : edge.source;
                if (!visited.has(neighbor)) queue.push(neighbor);
            }
        }

        const summary = `Found ${resultNodes.length} nodes, ${resultEdges.length} edges for "${question}"`;
        return { nodes: resultNodes, edges: resultEdges, summary, tokenEstimate: tokensUsed };
    }

    /**
     * Find shortest path between two node labels.
     */
    shortestPath(repoPath: string, sourceLabel: string, targetLabel: string, maxHops = 8): ShortestPathResult | null {
        const graph = this.loadGraph(repoPath);
        if (graph === null) return null;

        const sourceNode = graph.nodes.find((n) => n.label.toLowerCase() === sourceLabel.toLowerCase());
        const targetNode = graph.nodes.find((n) => n.label.toLowerCase() === targetLabel.toLowerCase());
        if (sourceNode === undefined || targetNode === undefined) return null;

        // BFS shortest path
        const visited = new Map<string, string | null>(); // node → parent
        const queue: string[] = [sourceNode.id];
        visited.set(sourceNode.id, null);

        // Build adjacency list
        const adj = new Map<string, string[]>();
        for (const edge of graph.links) {
            const a = adj.get(edge.source) ?? [];
            a.push(edge.target);
            adj.set(edge.source, a);
            const b = adj.get(edge.target) ?? [];
            b.push(edge.source);
            adj.set(edge.target, b);
        }

        let found = false;
        let hops = 0;

        while (queue.length > 0 && hops < maxHops) {
            const batchSize = queue.length;
            for (let i = 0; i < batchSize; i++) {
                const current = queue.shift()!;
                if (current === targetNode.id) {
                    found = true;
                    break;
                }
                for (const neighbor of adj.get(current) ?? []) {
                    if (!visited.has(neighbor)) {
                        visited.set(neighbor, current);
                        queue.push(neighbor);
                    }
                }
            }
            if (found) break;
            hops++;
        }

        if (!found) return null;

        // Reconstruct path
        const pathIds: string[] = [];
        let current: string | null = targetNode.id;
        while (current !== null) {
            pathIds.unshift(current);
            current = visited.get(current) ?? null;
        }

        const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
        const pathLabels = pathIds.map((id) => nodeMap.get(id)?.label ?? id);

        // Collect edges along the path
        const pathEdges: GraphifyEdge[] = [];
        for (let i = 0; i < pathIds.length - 1; i++) {
            const edge = graph.links.find(
                (e) => (e.source === pathIds[i] && e.target === pathIds[i + 1]) ||
                       (e.target === pathIds[i] && e.source === pathIds[i + 1])
            );
            if (edge !== undefined) pathEdges.push(edge);
        }

        return { path: pathLabels, edges: pathEdges, hops: pathLabels.length - 1 };
    }

    /**
     * Get the GRAPH_REPORT.md contents (pre-built summary with god nodes, communities).
     */
    getReport(repoPath: string): string | null {
        const reportPath = path.join(this.graphifyDir(repoPath), GRAPH_REPORT);
        if (!fs.existsSync(reportPath)) return null;
        try {
            return fs.readFileSync(reportPath, 'utf-8');
        } catch {
            return null;
        }
    }

    /**
     * Get graph stats: node count, edge count, community count, confidence breakdown.
     */
    getStats(repoPath: string): {
        readonly nodeCount: number;
        readonly edgeCount: number;
        readonly communityCount: number;
        readonly confidenceBreakdown: Record<string, number>;
    } | null {
        const graph = this.loadGraph(repoPath);
        if (graph === null) return null;

        const communities = new Set(graph.nodes.map((n) => n.community).filter((c) => c !== undefined));
        const confidenceBreakdown: Record<string, number> = {};
        for (const edge of graph.links) {
            const conf = edge.confidence ?? 'UNKNOWN';
            confidenceBreakdown[conf] = (confidenceBreakdown[conf] ?? 0) + 1;
        }

        return {
            nodeCount: graph.nodes.length,
            edgeCount: graph.links.length,
            communityCount: communities.size,
            confidenceBreakdown,
        };
    }

    // ── Private ──────────────────────────────────────

    private graphifyDir(repoPath: string): string {
        return path.join(repoPath, GRAPH_DIR);
    }

    private loadGraph(repoPath: string): GraphifyGraph | null {
        // Check cache
        const cached = this.graphs.get(repoPath);
        const loadedAt = this.lastLoaded.get(repoPath) ?? 0;
        if (cached !== undefined && Date.now() - loadedAt < this.CACHE_TTL_MS) {
            return cached;
        }

        const graphPath = path.join(this.graphifyDir(repoPath), GRAPH_JSON);
        if (!fs.existsSync(graphPath)) return null;

        try {
            const raw = fs.readFileSync(graphPath, 'utf-8');
            const parsed = JSON.parse(raw) as GraphifyGraph;
            this.graphs.set(repoPath, parsed);
            this.lastLoaded.set(repoPath, Date.now());
            return parsed;
        } catch (err) {
            log.warn({ repoPath, err: err instanceof Error ? err.message : String(err) }, 'Failed to load graph.json');
            return null;
        }
    }

    private buildScript(repoPath: string, options: { readonly update?: boolean; readonly noViz?: boolean }): string {
        const flags: string[] = [];
        if (options.update === true) flags.push('--update');
        if (options.noViz !== false) flags.push('--no-viz'); // default to no-viz
        const flagStr = flags.length > 0 ? `, ${flags.map((f) => `'${f}'`).join(', ')}` : '';

        return `
import json
from graphify.detect import detect
from graphify.extract import extract
from graphify.cluster import cluster
from graphify.export import export_all
from graphify.report import write_report
from pathlib import Path

target = Path('${repoPath.replace(/\\/g, '/')}')
detected = detect(target)
if detected.get('total_files', 0) == 0:
    print(json.dumps({"error": "No files found"}))
else:
    extracted = extract(target, detected)
    clustered = cluster(extracted)
    export_all(clustered, target / 'graphify-out'${flagStr})
    write_report(clustered, target / 'graphify-out')
    print(json.dumps({"success": True, "nodes": len(clustered.get('nodes', [])), "edges": len(clustered.get('links', []))}))
`.trim();
    }
}

// ── Singleton ────────────────────────────────────────

let instance: GraphifyBridge | null = null;

export function getGraphifyBridge(): GraphifyBridge {
    if (instance === null) {
        instance = new GraphifyBridge();
    }
    return instance;
}

export function resetGraphifyBridgeForTesting(): void {
    instance = null;
}
