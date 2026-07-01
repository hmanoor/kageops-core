import { describe, it, expect } from 'vitest';
import {
    buildTraceViewModel,
    buildNodeHierarchy,
    renderTraceTreeHtml,
    renderNodeHtml,
    getRunTypeIcon,
    getStatusIcon,
    formatDuration,
    formatCost,
    renderTraceTreeCss,
    DEFAULT_RENDER_OPTIONS,
    type TraceNode,
} from '../../src/renderer/command-center/trace-tree-panel';

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<TraceNode> = {}): TraceNode {
    return {
        id: 'node-1',
        parentId: null,
        operationName: 'sensei.orchestrate',
        agentName: 'Sensei',
        runType: 'orchestrate',
        startTime: 1000,
        endTime: 2234,
        durationMs: 1234,
        status: 'completed',
        tokenCount: 500,
        cost: 0.032,
        error: null,
        depth: 0,
        ...overrides,
    };
}

const rootNode = makeNode({ id: 'root', parentId: null, startTime: 1000, endTime: 5000, durationMs: 4000 });
const childNode = makeNode({ id: 'child-1', parentId: 'root', runType: 'llm', agentName: 'Forge', operationName: 'forge.generate', startTime: 1100, endTime: 3000, durationMs: 1900, tokenCount: 1200, cost: 0.012, depth: 1 });
const grandchildNode = makeNode({ id: 'gc-1', parentId: 'child-1', runType: 'tool', agentName: 'Forge', operationName: 'tool.readFile', startTime: 1200, endTime: 1500, durationMs: 300, tokenCount: 50, cost: 0.001, depth: 2 });

const flatNodes: readonly TraceNode[] = [rootNode, childNode, grandchildNode];

// ── Tests ─────────────────────────────────────────────────────────────────

describe('buildTraceViewModel', () => {
    it('finds root node (parentId === null)', () => {
        const vm = buildTraceViewModel(flatNodes);
        expect(vm).not.toBeNull();
        expect(vm!.rootNode.id).toBe('root');
    });

    it('calculates totals correctly', () => {
        const vm = buildTraceViewModel(flatNodes);
        expect(vm).not.toBeNull();
        expect(vm!.totalTokens).toBe(500 + 1200 + 50);
        expect(vm!.totalCost).toBeCloseTo(0.032 + 0.012 + 0.001);
        expect(vm!.nodeCount).toBe(3);
    });

    it('returns null for empty input', () => {
        const vm = buildTraceViewModel([]);
        expect(vm).toBeNull();
    });
});

describe('buildNodeHierarchy', () => {
    it('sorts nodes depth-first (root → child → grandchild)', () => {
        const ordered = buildNodeHierarchy(flatNodes);
        const ids = ordered.map(n => n.id);
        expect(ids).toEqual(['root', 'child-1', 'gc-1']);
    });

    it('sets correct depth on each node', () => {
        const ordered = buildNodeHierarchy(flatNodes);
        expect(ordered[0]!.depth).toBe(0);
        expect(ordered[1]!.depth).toBe(1);
        expect(ordered[2]!.depth).toBe(2);
    });
});

describe('renderTraceTreeHtml', () => {
    it('includes all nodes in output', () => {
        const vm = buildTraceViewModel(flatNodes)!;
        const html = renderTraceTreeHtml(vm);
        expect(html).toContain('sensei.orchestrate');
        expect(html).toContain('forge.generate');
        expect(html).toContain('tool.readFile');
    });

    it('applies depth classes to nodes', () => {
        const vm = buildTraceViewModel(flatNodes)!;
        const html = renderTraceTreeHtml(vm);
        expect(html).toContain('depth-0');
        expect(html).toContain('depth-1');
        expect(html).toContain('depth-2');
    });
});

describe('renderNodeHtml', () => {
    it('includes operation name in output', () => {
        const node = makeNode({ operationName: 'scout.research' });
        const html = renderNodeHtml(node, DEFAULT_RENDER_OPTIONS);
        expect(html).toContain('scout.research');
    });

    it('shows error message for failed nodes', () => {
        const node = makeNode({ status: 'failed', error: 'Connection timeout' });
        const html = renderNodeHtml(node, DEFAULT_RENDER_OPTIONS);
        expect(html).toContain('Connection timeout');
        expect(html).toContain('has-error');
    });
});

describe('getRunTypeIcon', () => {
    it('maps all known run types to icon names', () => {
        expect(getRunTypeIcon('orchestrate')).toBe('target');
        expect(getRunTypeIcon('llm')).toBe('bot');
        expect(getRunTypeIcon('tool')).toBe('wrench');
        expect(getRunTypeIcon('review')).toBe('search');
        expect(getRunTypeIcon('deploy')).toBe('rocket');
        expect(getRunTypeIcon('file-io')).toBe('folder');
        expect(getRunTypeIcon('db')).toBe('database');
        expect(getRunTypeIcon('event')).toBe('zap');
        expect(getRunTypeIcon('security')).toBe('shield');
        expect(getRunTypeIcon('test')).toBe('check-circle');
    });

    it('falls back to chevron-right for unknown types', () => {
        expect(getRunTypeIcon('unknown')).toBe('chevron-right');
    });
});

describe('getStatusIcon', () => {
    it('maps all statuses to icon names', () => {
        expect(getStatusIcon('running')).toBe('hourglass');
        expect(getStatusIcon('completed')).toBe('check-circle');
        expect(getStatusIcon('failed')).toBe('x-circle');
    });

    it('falls back to help-circle for unknown statuses', () => {
        expect(getStatusIcon('weird')).toBe('help-circle');
    });
});

describe('formatDuration', () => {
    it('formats milliseconds for values under 1000ms', () => {
        expect(formatDuration(123)).toBe('123ms');
        expect(formatDuration(0)).toBe('0ms');
        expect(formatDuration(999)).toBe('999ms');
    });

    it('formats seconds for values 1000ms–59999ms', () => {
        expect(formatDuration(1000)).toBe('1.0s');
        expect(formatDuration(1234)).toBe('1.2s');
        expect(formatDuration(59999)).toBe('60.0s');
    });

    it('formats minutes for values >= 60000ms', () => {
        expect(formatDuration(60000)).toBe('1m 0s');
        expect(formatDuration(83000)).toBe('1m 23s');
    });

    it('returns dash for null', () => {
        expect(formatDuration(null)).toBe('—');
    });
});

describe('formatCost', () => {
    it('formats small amounts with 3 decimal places', () => {
        expect(formatCost(0.032)).toBe('$0.032');
        expect(formatCost(0.001)).toBe('$0.001');
        expect(formatCost(1.234)).toBe('$1.234');
    });
});

describe('renderTraceTreeCss', () => {
    it('includes depth indentation rules', () => {
        const css = renderTraceTreeCss();
        expect(css).toContain('depth-0');
        expect(css).toContain('depth-1');
        expect(css).toContain('depth-2');
        expect(css).toContain('padding-left');
    });
});

describe('DEFAULT_RENDER_OPTIONS', () => {
    it('has expected default values', () => {
        expect(DEFAULT_RENDER_OPTIONS.showCost).toBe(true);
        expect(DEFAULT_RENDER_OPTIONS.showTokens).toBe(true);
        expect(DEFAULT_RENDER_OPTIONS.showDuration).toBe(true);
        expect(DEFAULT_RENDER_OPTIONS.collapsedDepth).toBe(3);
        expect(DEFAULT_RENDER_OPTIONS.highlightErrors).toBe(true);
    });
});
