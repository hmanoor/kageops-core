/**
 * ArtifactService unit tests (B-420 / B-421).
 *
 * Covers the tree walker, path-safety guard, and file reader against a
 * real temp directory. db/client is mocked so the service's DB lookups
 * resolve synthetic project rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';

vi.mock('../../src/db/client', () => ({
    getOne: vi.fn(async () => null),
    getMany: vi.fn(async () => []),
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

import { getOne } from '../../src/db/client';
const mockGetOne = vi.mocked(getOne);

import {
    ArtifactService,
    listTreeFromRoot,
    resolveSafeWorkspacePath,
    EXCLUDE_DIRS,
    TREE_MAX_DEPTH_DEFAULT,
    type FileNode,
} from '../../src/workspace/artifact-service';

// ── Helpers ──────────────────────────────────────────

async function makeWorkspace(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kageops-art-svc-'));
    await fsp.mkdir(path.join(dir, 'src'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'src', 'components'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'node_modules', 'foo'), { recursive: true });
    await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'README.md'), '# hi');
    await fsp.writeFile(path.join(dir, 'src', 'index.ts'), 'export {};');
    await fsp.writeFile(path.join(dir, 'src', 'components', 'Button.tsx'), 'export {};');
    await fsp.writeFile(path.join(dir, 'node_modules', 'foo', 'package.json'), '{}');
    await fsp.writeFile(path.join(dir, '.DS_Store'), 'noise');
    await fsp.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');
    return dir;
}

function flatten(nodes: readonly FileNode[]): string[] {
    const out: string[] = [];
    const walk = (ns: readonly FileNode[]): void => {
        for (const n of ns) {
            out.push(n.path);
            if (n.children !== undefined) walk(n.children);
        }
    };
    walk(nodes);
    return out;
}

// ── resolveSafeWorkspacePath ─────────────────────────

describe('resolveSafeWorkspacePath', () => {
    it('resolves a legitimate relative path inside the root', () => {
        const abs = resolveSafeWorkspacePath('/tmp/proj', 'src/index.ts');
        expect(abs).toBe(path.resolve('/tmp/proj', 'src/index.ts'));
    });

    it('collapses . and inner .. that stay inside root', () => {
        const abs = resolveSafeWorkspacePath('/tmp/proj', './src/../pkg/index.ts');
        expect(abs).toBe(path.resolve('/tmp/proj/pkg/index.ts'));
    });

    it('rejects parent traversal', () => {
        expect(() =>
            resolveSafeWorkspacePath('/tmp/proj', '../etc/passwd'),
        ).toThrow(/traversal/i);
    });

    it('rejects deep traversal', () => {
        expect(() =>
            resolveSafeWorkspacePath('/tmp/proj', 'a/b/../../../secret'),
        ).toThrow(/traversal/i);
    });

    it('rejects absolute user input', () => {
        expect(() =>
            resolveSafeWorkspacePath('/tmp/proj', '/etc/passwd'),
        ).toThrow(/traversal/i);
    });
});

// ── listTreeFromRoot ─────────────────────────────────

describe('listTreeFromRoot', () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await makeWorkspace();
    });

    afterEach(async () => {
        await fsp.rm(tmpRoot, { recursive: true, force: true });
    });

    it('walks the project tree', async () => {
        const tree = await listTreeFromRoot(tmpRoot, 8);
        const paths = flatten(tree);
        expect(paths).toContain('README.md');
        expect(paths).toContain('src');
        expect(paths).toContain('src/index.ts');
        expect(paths).toContain('src/components');
        expect(paths).toContain('src/components/Button.tsx');
    });

    it('excludes .git and node_modules', async () => {
        const tree = await listTreeFromRoot(tmpRoot, 8);
        const paths = flatten(tree);
        expect(paths.some((p) => p.startsWith('.git'))).toBe(false);
        expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
    });

    it('excludes .DS_Store file', async () => {
        const tree = await listTreeFromRoot(tmpRoot, 8);
        const paths = flatten(tree);
        expect(paths).not.toContain('.DS_Store');
    });

    it('sorts directories before files', async () => {
        const tree = await listTreeFromRoot(tmpRoot, 8);
        const topLevel = tree.map((n) => ({ name: n.name, type: n.type }));
        const firstFileIdx = topLevel.findIndex((n) => n.type === 'file');
        const lastDirIdx = topLevel.reduce(
            (acc, n, i) => (n.type === 'dir' ? i : acc),
            -1,
        );
        if (firstFileIdx !== -1 && lastDirIdx !== -1) {
            expect(lastDirIdx).toBeLessThan(firstFileIdx);
        }
    });

    it('stops descending at maxDepth', async () => {
        const shallow = await listTreeFromRoot(tmpRoot, 1);
        const src = shallow.find((n) => n.name === 'src');
        expect(src).toBeDefined();
        // src has depth 0 when discovered; at maxDepth=1 its subdirectory
        // 'components' is returned as a dir but without children.
        const components = src?.children?.find((n) => n.name === 'components');
        expect(components).toBeDefined();
        expect(components?.children).toBeUndefined();
    });

    it('attaches size and mtime to files', async () => {
        const tree = await listTreeFromRoot(tmpRoot, 8);
        const readme = tree.find((n) => n.name === 'README.md');
        expect(readme?.type).toBe('file');
        expect(readme?.size).toBeGreaterThan(0);
        expect(readme?.mtime).toBeGreaterThan(0);
    });

    it('returns empty array for a missing directory', async () => {
        const tree = await listTreeFromRoot('/nonexistent-path-xyz', 8);
        expect(tree).toEqual([]);
    });

    it('attaches producedBy from supplied producer map (B-424)', async () => {
        const producers = new Map([
            ['README.md', { agent: 'herald', taskId: 'task-1' }],
            ['src/index.ts', { agent: 'forge', taskId: 'task-2' }],
        ]);
        const tree = await listTreeFromRoot(tmpRoot, 8, producers);
        const readme = tree.find((n) => n.name === 'README.md');
        expect(readme?.producedBy).toEqual({ agent: 'herald', taskId: 'task-1' });
        const src = tree.find((n) => n.name === 'src');
        const idx = src?.children?.find((n) => n.name === 'index.ts');
        expect(idx?.producedBy).toEqual({ agent: 'forge', taskId: 'task-2' });
    });

    it('omits producedBy when the file has no match', async () => {
        const tree = await listTreeFromRoot(tmpRoot, 8);
        const readme = tree.find((n) => n.name === 'README.md');
        expect(readme?.producedBy).toBeUndefined();
    });

    it('EXCLUDE_DIRS contains expected dependency dirs', () => {
        expect(EXCLUDE_DIRS.has('node_modules')).toBe(true);
        expect(EXCLUDE_DIRS.has('.git')).toBe(true);
        expect(EXCLUDE_DIRS.has('dist')).toBe(true);
    });

    it('TREE_MAX_DEPTH_DEFAULT is a sane positive integer', () => {
        expect(TREE_MAX_DEPTH_DEFAULT).toBeGreaterThan(0);
        expect(Number.isInteger(TREE_MAX_DEPTH_DEFAULT)).toBe(true);
    });
});

// ── ArtifactService.readFile ─────────────────────────

describe('ArtifactService.readFile', () => {
    let tmpRoot: string;
    let svc: ArtifactService;

    beforeEach(async () => {
        mockGetOne.mockReset();
        tmpRoot = await makeWorkspace();
        svc = new ArtifactService();
        mockGetOne.mockImplementation(async () => ({ repo_path: tmpRoot }));
    });

    afterEach(async () => {
        await fsp.rm(tmpRoot, { recursive: true, force: true });
    });

    it('reads UTF-8 text content with metadata', async () => {
        const res = await svc.readFile('p1', 'README.md');
        expect(res.content).toBe('# hi');
        expect(res.encoding).toBe('utf8');
        expect(res.isBinary).toBe(false);
        expect(res.mimeType).toBe('text/markdown');
        expect(res.sizeBytes).toBe(4);
        expect(res.mtimeIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns metadata only for binary files', async () => {
        // Write a file with NUL bytes so the sniffer flags it as binary.
        const binPath = path.join(tmpRoot, 'blob.bin');
        await fsp.writeFile(binPath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00]));

        const res = await svc.readFile('p1', 'blob.bin');
        expect(res.isBinary).toBe(true);
        expect(res.content).toBeNull();
        expect(res.sizeBytes).toBe(5);
    });

    it('base64-encodes image content', async () => {
        // 1x1 transparent PNG.
        const png = Buffer.from(
            '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d494441547801636400000000050001' +
            '6d5c6a250000000049454e44ae426082',
            'hex',
        );
        await fsp.writeFile(path.join(tmpRoot, 'pixel.png'), png);
        const res = await svc.readFile('p1', 'pixel.png');
        expect(res.encoding).toBe('base64');
        expect(res.mimeType).toBe('image/png');
        expect(res.isBinary).toBe(false);
        expect(typeof res.content).toBe('string');
        // Round-trip: decoded bytes equal source.
        expect(Buffer.from(res.content ?? '', 'base64').equals(png)).toBe(true);
    });

    it('throws on path traversal', async () => {
        await expect(svc.readFile('p1', '../../etc/passwd')).rejects.toThrow(/traversal/i);
    });

    it('throws when the target is a directory', async () => {
        await expect(svc.readFile('p1', 'src')).rejects.toThrow(/not a file/i);
    });

    it('throws when the project cannot be found', async () => {
        mockGetOne.mockImplementationOnce(async () => null);
        await expect(svc.readFile('ghost', 'README.md')).rejects.toThrow(/project not found/i);
    });
});

// ── ArtifactService.deletePath (B-426) ───────────────

describe('ArtifactService.deletePath', () => {
    let tmpRoot: string;
    let svc: ArtifactService;

    beforeEach(async () => {
        tmpRoot = await makeWorkspace();
        mockGetOne.mockReset();
        mockGetOne.mockImplementation(async () => ({ repo_path: tmpRoot }));
        svc = new ArtifactService();
    });

    afterEach(async () => {
        await fsp.rm(tmpRoot, { recursive: true, force: true });
    });

    it('deletes a file and reports kind=file', async () => {
        const result = await svc.deletePath('p1', 'README.md');
        expect(result).toEqual({ deleted: true, kind: 'file' });
        await expect(fsp.stat(path.join(tmpRoot, 'README.md'))).rejects.toThrow();
    });

    it('deletes a directory when recursive:true is passed', async () => {
        const result = await svc.deletePath('p1', 'src', { recursive: true });
        expect(result).toEqual({ deleted: true, kind: 'dir' });
        await expect(fsp.stat(path.join(tmpRoot, 'src'))).rejects.toThrow();
    });

    it('refuses to delete a directory without recursive:true', async () => {
        await expect(svc.deletePath('p1', 'src')).rejects.toThrow(/recursive/i);
        // Ensure the directory is untouched.
        await fsp.stat(path.join(tmpRoot, 'src'));
    });

    it('rejects empty / root-ish paths', async () => {
        await expect(svc.deletePath('p1', '')).rejects.toThrow(/root/i);
        await expect(svc.deletePath('p1', '.')).rejects.toThrow(/root/i);
        await expect(svc.deletePath('p1', '/')).rejects.toThrow(/root/i);
        await expect(svc.deletePath('p1', './')).rejects.toThrow(/root/i);
    });

    it('rejects path traversal', async () => {
        await expect(svc.deletePath('p1', '../escape.txt')).rejects.toThrow(/traversal/i);
    });

    it('throws ENOENT when the target does not exist', async () => {
        await expect(svc.deletePath('p1', 'nope.txt')).rejects.toThrow();
    });

    it('throws when the project cannot be found', async () => {
        mockGetOne.mockImplementationOnce(async () => null);
        await expect(svc.deletePath('ghost', 'README.md')).rejects.toThrow(/project not found/i);
    });
});
