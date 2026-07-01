/**
 * Artifact Browser — file tree view (B-420).
 *
 * Takes a recursive `FileNode` tree and renders a flat, virtualized list
 * of visible rows (expanded directories reveal their children). Keeps
 * the expanded-set in memory — collapsing and re-expanding a directory
 * is cheap; no network round-trip.
 *
 * Virtualization is a simple fixed-row-height windowing strategy: we
 * compute how many rows fit in the viewport + a buffer, then only
 * render those. Good enough for tens of thousands of files without
 * pulling in a list-virtualization library.
 */

import { escapeHtml } from './artifact-browser-highlight';

export interface FileProducer {
    readonly agent: string;
    readonly taskId: string;
}

export interface FileNode {
    readonly name: string;
    readonly path: string;
    readonly type: 'file' | 'dir';
    readonly size?: number;
    readonly mtime?: number;
    readonly children?: readonly FileNode[];
    readonly producedBy?: FileProducer;
}

interface VisibleRow {
    readonly node: FileNode;
    readonly depth: number;
}

export interface TreeCallbacks {
    readonly onFileClick: (relPath: string) => void;
    /** Optional — fired when the per-row trash icon is clicked (B-426). */
    readonly onDeleteClick?: (relPath: string, isDir: boolean) => void;
}

const ROW_HEIGHT_PX = 22;
const BUFFER_ROWS = 6;

export class ArtifactTreeView {
    private readonly container: HTMLElement;
    private readonly viewport: HTMLElement;
    private readonly spacer: HTMLElement;
    private readonly rowHost: HTMLElement;
    private readonly callbacks: TreeCallbacks;
    private readonly expanded = new Set<string>();

    private tree: readonly FileNode[] = [];
    private flat: readonly VisibleRow[] = [];
    private selectedPath: string | null = null;

    constructor(container: HTMLElement, callbacks: TreeCallbacks) {
        this.container = container;
        this.callbacks = callbacks;

        container.innerHTML = `
            <div class="artifact-tree-viewport" data-role="viewport">
                <div class="artifact-tree-spacer" data-role="spacer"></div>
                <div class="artifact-tree-rows" data-role="rows"></div>
            </div>
        `;
        const viewport = container.querySelector<HTMLElement>('[data-role="viewport"]');
        const spacer = container.querySelector<HTMLElement>('[data-role="spacer"]');
        const rowHost = container.querySelector<HTMLElement>('[data-role="rows"]');
        if (viewport === null || spacer === null || rowHost === null) {
            throw new Error('artifact-browser-tree: internal DOM scaffold missing');
        }
        this.viewport = viewport;
        this.spacer = spacer;
        this.rowHost = rowHost;

        this.viewport.addEventListener('scroll', () => this.renderWindow());
        this.rowHost.addEventListener('click', (e) => this.handleClick(e));
    }

    setTree(nodes: readonly FileNode[]): void {
        this.tree = nodes;
        this.rebuildFlat();
        this.renderWindow();
    }

    setSelected(relPath: string | null): void {
        this.selectedPath = relPath;
        this.renderWindow();
    }

    /** Expand all ancestor directories of relPath, select it, and scroll it into view. */
    revealPath(relPath: string): void {
        const parts = relPath.split('/');
        for (let i = 1; i < parts.length; i++) {
            this.expanded.add(parts.slice(0, i).join('/'));
        }
        this.selectedPath = relPath;
        this.rebuildFlat();
        this.renderWindow();
        const idx = this.flat.findIndex((r) => r.node.path === relPath);
        if (idx >= 0) {
            this.viewport.scrollTop = Math.max(0, idx * ROW_HEIGHT_PX - this.viewport.clientHeight / 2);
        }
    }

    isEmpty(): boolean {
        return this.flat.length === 0;
    }

    /**
     * Find a node by POSIX relative path. Used by the preview pane to pull
     * producer attribution out of the tree without re-querying the DB.
     */
    findNode(relPath: string): FileNode | null {
        return findNodeInTree(this.tree, relPath);
    }

    private rebuildFlat(): void {
        const out: VisibleRow[] = [];
        const walk = (nodes: readonly FileNode[], depth: number): void => {
            for (const n of nodes) {
                out.push({ node: n, depth });
                if (n.type === 'dir' && this.expanded.has(n.path) && n.children !== undefined) {
                    walk(n.children, depth + 1);
                }
            }
        };
        walk(this.tree, 0);
        this.flat = out;
        this.spacer.style.height = `${this.flat.length * ROW_HEIGHT_PX}px`;
    }

    private renderWindow(): void {
        if (this.flat.length === 0) {
            this.rowHost.innerHTML = '<div class="empty-state">Empty directory</div>';
            return;
        }
        const scrollTop = this.viewport.scrollTop;
        const viewportH = this.viewport.clientHeight > 0 ? this.viewport.clientHeight : 400;
        const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT_PX) - BUFFER_ROWS);
        const visibleCount = Math.ceil(viewportH / ROW_HEIGHT_PX) + BUFFER_ROWS * 2;
        const endIdx = Math.min(this.flat.length, startIdx + visibleCount);

        const rows: string[] = [];
        for (let i = startIdx; i < endIdx; i++) {
            const row = this.flat[i];
            if (row === undefined) continue;
            rows.push(this.renderRow(row, i));
        }
        this.rowHost.style.transform = `translateY(${startIdx * ROW_HEIGHT_PX}px)`;
        this.rowHost.innerHTML = rows.join('');
    }

    private renderRow(row: VisibleRow, index: number): string {
        const n = row.node;
        const indent = row.depth * 14;
        const isDir = n.type === 'dir';
        const isExpanded = isDir && this.expanded.has(n.path);
        const selected = this.selectedPath === n.path ? ' ab-row--selected' : '';
        const chevron = isDir
            ? `<span class="ab-row-chevron${isExpanded ? ' ab-row-chevron--open' : ''}" aria-hidden="true">&#9654;</span>`
            : '<span class="ab-row-chevron ab-row-chevron--leaf" aria-hidden="true"></span>';
        const iconName = isDir ? 'folder' : iconNameForFile(n.name);
        const badge = n.producedBy !== undefined
            ? ` <span class="ab-row-producer" title="${escapeHtml(`Produced by ${n.producedBy.agent} (task ${n.producedBy.taskId})`)}">${escapeHtml(n.producedBy.agent)}</span>`
            : '';
        const deleteBtn = this.callbacks.onDeleteClick !== undefined
            ? `<button class="ab-row-delete" data-action="delete" title="Delete ${escapeHtml(n.path)}" aria-label="Delete ${escapeHtml(n.name)}">&#10005;</button>`
            : '';
        const titleAttr = n.producedBy !== undefined
            ? `${escapeHtml(n.path)} — produced by ${escapeHtml(n.producedBy.agent)}`
            : escapeHtml(n.path);
        return (
            `<div class="ab-row${selected}" data-idx="${index}" data-path="${escapeHtml(n.path)}" data-type="${n.type}"` +
            ` style="padding-left:${indent}px" title="${titleAttr}">` +
            chevron +
            `<span class="ab-row-icon" data-icon="${iconName}" data-icon-size="14"></span>` +
            `<span class="ab-row-name">${escapeHtml(n.name)}</span>` +
            badge +
            deleteBtn +
            '</div>'
        );
    }

    private handleClick(e: MouseEvent): void {
        const rawTarget = e.target instanceof HTMLElement ? e.target : null;
        if (rawTarget === null) return;
        const row = target_closestRow(rawTarget);
        if (row === null) return;

        // Delete button — stop the chevron-toggle / file-select path.
        if (rawTarget.closest('.ab-row-delete') !== null) {
            e.stopPropagation();
            if (this.callbacks.onDeleteClick !== undefined) {
                const relPath = row.dataset['path'] ?? '';
                const isDir = row.dataset['type'] === 'dir';
                if (relPath !== '') {
                    this.callbacks.onDeleteClick(relPath, isDir);
                }
            }
            return;
        }

        const target = row;
        const relPath = target.dataset['path'] ?? '';
        const type = target.dataset['type'] ?? '';
        if (type === 'dir') {
            if (this.expanded.has(relPath)) {
                this.expanded.delete(relPath);
            } else {
                this.expanded.add(relPath);
            }
            this.rebuildFlat();
            this.renderWindow();
            return;
        }
        if (type === 'file' && relPath !== '') {
            this.selectedPath = relPath;
            this.renderWindow();
            this.callbacks.onFileClick(relPath);
        }
    }
}

/**
 * Depth-first search for a `FileNode` by its POSIX `path`. Exported so
 * tests can exercise the lookup without instantiating the DOM-backed
 * `ArtifactTreeView`.
 */
export function findNodeInTree(
    nodes: readonly FileNode[],
    relPath: string,
): FileNode | null {
    for (const n of nodes) {
        if (n.path === relPath) return n;
        if (n.children !== undefined) {
            const hit = findNodeInTree(n.children, relPath);
            if (hit !== null) return hit;
        }
    }
    return null;
}

function target_closestRow(el: HTMLElement): HTMLElement | null {
    let cur: HTMLElement | null = el;
    while (cur !== null) {
        if (cur.classList.contains('ab-row')) return cur;
        cur = cur.parentElement;
    }
    return null;
}

function iconNameForFile(name: string): string {
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
    if (ext === '.html' || ext === '.htm') return 'eye';
    if (ext === '.md' || ext === '.mdx' || ext === '.markdown') return 'book-open';
    if (ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.toml') return 'settings';
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.svg' || ext === '.webp' || ext === '.gif') {
        return 'palette';
    }
    if (ext === '.sh' || ext === '.bash' || ext === '.zsh') return 'terminal';
    if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') return 'hammer';
    return 'clipboard';
}
