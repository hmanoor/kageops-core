/**
 * artifact-browser-tree — pure helpers (B-428 support).
 *
 * `ArtifactTreeView` itself is DOM-backed, but `findNodeInTree` is pure
 * and drives the panel's producer lookup. Exercised here directly so the
 * preview pane can trust the contract without a jsdom dependency.
 */

import { describe, it, expect } from 'vitest';
import {
    findNodeInTree,
    type FileNode,
} from '../../src/renderer/command-center/artifact-browser-tree';

function makeTree(): readonly FileNode[] {
    return [
        {
            name: 'src',
            path: 'src',
            type: 'dir',
            children: [
                {
                    name: 'app.ts',
                    path: 'src/app.ts',
                    type: 'file',
                    size: 42,
                    producedBy: { agent: 'forge', taskId: 'task-1' },
                },
                {
                    name: 'nested',
                    path: 'src/nested',
                    type: 'dir',
                    children: [
                        {
                            name: 'deep.ts',
                            path: 'src/nested/deep.ts',
                            type: 'file',
                            size: 7,
                        },
                    ],
                },
            ],
        },
        { name: 'README.md', path: 'README.md', type: 'file', size: 100 },
    ];
}

describe('findNodeInTree', () => {
    it('returns a top-level file node by path', () => {
        const hit = findNodeInTree(makeTree(), 'README.md');
        expect(hit?.name).toBe('README.md');
        expect(hit?.type).toBe('file');
    });

    it('returns a nested file node by path', () => {
        const hit = findNodeInTree(makeTree(), 'src/app.ts');
        expect(hit?.producedBy?.agent).toBe('forge');
        expect(hit?.producedBy?.taskId).toBe('task-1');
    });

    it('descends into deeply nested directories', () => {
        const hit = findNodeInTree(makeTree(), 'src/nested/deep.ts');
        expect(hit?.size).toBe(7);
    });

    it('returns a directory node when the path matches a dir', () => {
        const hit = findNodeInTree(makeTree(), 'src');
        expect(hit?.type).toBe('dir');
    });

    it('returns null when the path is missing', () => {
        expect(findNodeInTree(makeTree(), 'nope.ts')).toBeNull();
        expect(findNodeInTree(makeTree(), 'src/missing.ts')).toBeNull();
    });

    it('returns null for an empty tree', () => {
        expect(findNodeInTree([], 'anything')).toBeNull();
    });
});
