/**
 * Self-contained graph HTML renderer (v0.1.33)
 *
 * Replaces the `graphify[viz]` dependency for in-app graph viewing.
 *
 * Background: graphify is not on PyPI — operators install it manually from
 * a private source, and the optional `viz` submodule frequently isn't in
 * the copy they have. When `graphify.viz` is missing the Python pipeline
 * still writes `graph.json` (the actual data) but never writes
 * `graph.html` — the in-app viewer then loads a dead file:// URL and
 * shows a black panel.
 *
 * Fix: render our OWN graph.html from graph.json after the Python step
 * finishes. The data is inlined into a <script> block (we can't fetch
 * from inside a file:// iframe — Chromium blocks it) and rendered with
 * vis-network from CDN, themed to match KageOps surfaces. No Python
 * dependency for visualisation. Works whether or not graphify.viz exists.
 */

// ── Types ────────────────────────────────────────────

/** What we expect inside a graphify-produced graph.json. Both legacy
 *  (`links`) and current (`edges`) keys are tolerated. */
interface GraphJson {
    readonly nodes?: readonly RawNode[];
    readonly edges?: readonly RawEdge[];
    readonly links?: readonly RawEdge[];
}

interface RawNode {
    readonly id: string | number;
    readonly label?: string;
    readonly name?: string;
    readonly kind?: string;
    readonly community?: number | string;
    readonly file?: string;
    readonly path?: string;
}

interface RawEdge {
    readonly source?: string | number;
    readonly target?: string | number;
    readonly from?: string | number;
    readonly to?: string | number;
    readonly kind?: string;
}

// ── Public API ───────────────────────────────────────

/**
 * Parse a graphify graph.json string and produce a self-contained HTML
 * viewer page. The data is inlined into the page so it can be opened via
 * a file:// URL without any cross-origin fetch (which Chromium blocks
 * for local files).
 *
 * Returns `null` if the JSON is unparseable — callers should fall back
 * to the panel's "missing / unreadable" hint in that case rather than
 * shipping a half-built page that throws at runtime.
 */
export function renderGraphHtmlFromJson(jsonText: string, title: string): string | null {
    let parsed: GraphJson;
    try {
        parsed = JSON.parse(jsonText) as GraphJson;
    } catch {
        return null;
    }
    return renderGraphHtmlFromData(parsed, title);
}

/**
 * Same as `renderGraphHtmlFromJson` but takes the already-parsed object.
 * Exposed for tests so we don't have to stringify/re-parse fixtures.
 */
export function renderGraphHtmlFromData(graph: GraphJson, title: string): string {
    const rawNodes = graph.nodes ?? [];
    const rawEdges = graph.edges ?? graph.links ?? [];

    // Normalise into the shape vis-network expects. Keep the payload
    // small — we don't ship every original property, just what the
    // viewer actually uses (id, label, tooltip, group for colouring).
    const visNodes = rawNodes.map((n) => {
        const id = String(n.id);
        const label = n.label ?? n.name ?? deriveLabelFromId(id);
        const group = n.community !== undefined && n.community !== null
            ? `c${String(n.community)}`
            : (n.kind ?? 'default');
        // v0.1.34: pass through file/kind so the parent panel can open the
        // underlying source file when a node is clicked. graphify stores
        // file paths under either `file` or `path` depending on version.
        const file = n.file ?? n.path ?? deriveFileFromId(id);
        const kind = n.kind ?? null;
        return { id, label, title: id, group, file, kind };
    });

    const visEdges = rawEdges
        .map((e) => {
            const from = e.from ?? e.source;
            const to = e.to ?? e.target;
            if (from === undefined || to === undefined) return null;
            return { from: String(from), to: String(to) };
        })
        .filter((e): e is { from: string; to: string } => e !== null);

    const payload = { nodes: visNodes, edges: visEdges };

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} — Knowledge Graph</title>
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<style>
:root {
    --bg: #141414;
    --surface: #1e1e1e;
    --border: rgba(255,255,255,0.10);
    --text: #d4d4d4;
    --text-muted: #9d9d9d;
    --text-faint: #6e6e6e;
    --moss: #5BB377;
    --error: #f14c4c;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--text); font-family: "Inter", -apple-system, "Segoe UI", system-ui, sans-serif; font-size: 13px; overflow: hidden; }
#graph { position: absolute; inset: 0; }
#hud {
    position: absolute; top: 12px; left: 12px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 10px 14px; display: flex; gap: 18px; align-items: center;
    box-shadow: 0 2px 10px rgba(0,0,0,0.3);
    font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 11px;
    color: var(--text-muted); letter-spacing: 0.05em;
}
#hud strong { color: var(--text); font-weight: 500; }
#err {
    position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    flex-direction: column; padding: 32px; text-align: center;
}
#err.show { display: flex; }
#err h2 { margin: 0 0 12px; color: var(--error); font-weight: 500; }
#err p  { margin: 4px 0; color: var(--text-muted); max-width: 50ch; line-height: 1.5; }
</style>
</head>
<body>
<div id="graph"></div>
<div id="hud">
    <span><strong>${visNodes.length}</strong> nodes</span>
    <span><strong>${visEdges.length}</strong> edges</span>
    <span>${escapeHtml(title)}</span>
</div>
<div id="err">
    <h2>Could not render graph</h2>
    <p>vis-network failed to load. This usually means the viewer was opened without an internet connection — vis-network ships from a CDN.</p>
    <p>The underlying <code>graph.json</code> is still on disk and can be opened in any external graph tool.</p>
</div>
<script>
(function () {
    var data = ${JSON.stringify(payload)};
    if (typeof vis === 'undefined') {
        document.getElementById('err').classList.add('show');
        return;
    }
    var container = document.getElementById('graph');
    var nodes = new vis.DataSet(data.nodes);
    var edges = new vis.DataSet(data.edges);
    var network = new vis.Network(container, { nodes: nodes, edges: edges }, {
        nodes: {
            shape: 'dot', size: 14, borderWidth: 1.5,
            font: { color: '#d4d4d4', size: 11, face: 'Inter', strokeWidth: 0 },
            color: { border: 'rgba(91,179,119,0.6)', background: '#1e1e1e',
                     highlight: { border: '#5BB377', background: '#262626' } },
        },
        edges: {
            color: { color: 'rgba(255,255,255,0.18)', highlight: '#5BB377' },
            width: 1, smooth: { enabled: true, type: 'continuous', roundness: 0.5 },
            arrows: { to: { enabled: true, scaleFactor: 0.4 } },
        },
        physics: {
            stabilization: { iterations: 200, fit: true },
            barnesHut: { gravitationalConstant: -3000, centralGravity: 0.2, springLength: 90,
                         springConstant: 0.04, damping: 0.4 },
        },
        interaction: { hover: true, zoomView: true, dragView: true, tooltipDelay: 200 },
        groups: {
            useDefaultGroups: false,
            default: { color: { background: '#1e1e1e', border: '#5BB377' } },
        },
    });
    // Resize forwarder — Command Center sends 'kageops:resize' on window resize.
    window.addEventListener('message', function (e) {
        if (e.data === 'kageops:resize') {
            try { network.redraw(); network.fit({ animation: false }); } catch (_) { /* noop */ }
        }
    });
    // v0.1.34 — click forwarder. When a node is clicked, post its full
    // payload to the parent window so the Command Center can open the
    // underlying source file in the side pane. Posting * for targetOrigin
    // because file:// iframes have a null origin.
    var nodeIndex = {};
    data.nodes.forEach(function (n) { nodeIndex[n.id] = n; });
    network.on('selectNode', function (params) {
        var nodeId = params.nodes && params.nodes[0];
        if (nodeId === undefined) return;
        var meta = nodeIndex[nodeId] || { id: nodeId };
        try {
            window.parent.postMessage({
                type: 'kageops:node-click',
                node: {
                    id: meta.id,
                    label: meta.label,
                    file: meta.file || null,
                    kind: meta.kind || null,
                    group: meta.group || null,
                },
            }, '*');
        } catch (_) { /* sandbox blocked the post — non-fatal */ }
    });
    network.on('deselectNode', function () {
        try { window.parent.postMessage({ type: 'kageops:node-deselect' }, '*'); } catch (_) { /* */ }
    });
})();
</script>
</body>
</html>`;
}

// ── Helpers ──────────────────────────────────────────

function escapeHtml(s: string): string {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
    ));
}

/** Derive a readable label from a node id that looks like a path or
 *  dotted symbol — `src/foo/bar.ts::Baz` → `Baz`, `pkg.module.fn` → `fn`. */
function deriveLabelFromId(id: string): string {
    const afterDoubleColon = id.includes('::') ? id.split('::').pop()! : id;
    const afterSlash = afterDoubleColon.includes('/') ? afterDoubleColon.split('/').pop()! : afterDoubleColon;
    const afterBackslash = afterSlash.includes('\\') ? afterSlash.split('\\').pop()! : afterSlash;
    const afterDot = afterBackslash.includes('.') ? afterBackslash.split('.').pop()! : afterBackslash;
    return afterDot.length > 0 ? afterDot : id;
}

/** Try to extract the source file path from a graphify node id. Common
 *  shapes: `src/foo.ts`, `src/foo.ts::Bar`, `src/foo.ts:Bar`. Returns
 *  `null` if the id contains no recognisable file segment so the caller
 *  can fall back to showing a "no source available" hint. */
function deriveFileFromId(id: string): string | null {
    // Split on the first `::` (graphify) or `:` followed by a non-digit
    // (avoids breaking on Windows drive letters and line numbers).
    const beforeSymbol = id.split('::')[0]!;
    // Require something that looks like a file with an extension —
    // bare symbol ids like `MyClass` shouldn't be guessed as files.
    if (/\.[a-z0-9]{1,8}(?:[\\/].*)?$/i.test(beforeSymbol)) return beforeSymbol;
    if (/[\\/]/.test(beforeSymbol) && /\.[a-z0-9]{1,8}$/i.test(beforeSymbol)) return beforeSymbol;
    return null;
}
