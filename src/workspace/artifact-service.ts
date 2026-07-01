/**
 * ArtifactService — read-only browser for project workspaces.
 *
 * All filesystem access is sandboxed against `project.repo_path` — the
 * `resolveSafe` helper rejects any resolved path that escapes the project
 * root. Used by the Command Center Artifact Browser (v2.4).
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { getOne, getMany } from '../db/client';
import { createLogger } from '../shared/logger';

const log = createLogger('artifact-service');

export interface ArtifactNode {
    readonly name: string;
    readonly relPath: string;
    readonly type: 'file' | 'dir';
    readonly size?: number;
    readonly mtime?: number;
    readonly producedBy?: {
        readonly agent: string;
        readonly taskId: string;
    };
}

/**
 * Recursive tree node — used by the Artifact Browser file-tree panel
 * (B-420). `children` is present only on directories (never on files).
 */
export interface FileProducer {
    readonly agent: string;
    readonly taskId: string;
}

export interface FileNode {
    readonly name: string;
    readonly path: string;   // POSIX relative path from project root
    readonly type: 'file' | 'dir';
    readonly size?: number;
    readonly mtime?: number;
    readonly children?: readonly FileNode[];
    readonly producedBy?: FileProducer;
}

/**
 * Raw file read result for the preview pipeline (B-421). Binary files
 * return metadata only (no `content`) — the renderer decides what to do
 * with a binary stub.
 */
export interface FileReadResult {
    readonly content: string | null;
    readonly encoding: 'utf8' | 'base64';
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly mtimeIso: string;
    readonly isBinary: boolean;
}

/** Maximum depth the tree walker recurses (defence against symlinked cycles). */
export const TREE_MAX_DEPTH_DEFAULT = 8;

/** Cap on bytes returned by `readFile` — keeps IPC messages bounded. */
const READ_FILE_SIZE_CAP = 2_000_000;

export type PreviewKind = 'text' | 'markdown' | 'code' | 'html' | 'image' | 'binary';

export interface ArtifactPreview {
    readonly kind: PreviewKind;
    readonly language?: string;
    readonly text?: string;
    readonly dataUrl?: string;
    readonly sizeBytes: number;
    readonly truncated: boolean;
    readonly mimeType: string;
}

// Hard excludes — never shown in tree, never previewable.
export const EXCLUDE_DIRS: ReadonlySet<string> = new Set([
    '.git', 'node_modules', '.autonauts', '.next', '.nuxt',
    'dist', 'build', '.turbo', '.cache', '.venv', '__pycache__',
]);
export const EXCLUDE_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db']);

const PREVIEW_SIZE_CAP = 1_000_000; // 1 MB — text/markdown/code read cap
const IMAGE_SIZE_CAP = 5_000_000;   // 5 MB — base64 image cap

const CODE_EXT_TO_LANG: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cs': 'csharp',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
    '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
    '.sql': 'sql', '.xml': 'xml',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);

/**
 * Resolve a user-supplied relative path against the project root.
 * Returns the absolute path or throws if traversal is detected.
 * Exported so the `kageops-artifact://` protocol handler and other
 * main-process consumers can reuse the same guard.
 */
export function resolveSafeWorkspacePath(projectRoot: string, userRel: string): string {
    const normalizedRoot = path.resolve(projectRoot);
    const candidate = path.resolve(normalizedRoot, userRel);
    const rel = path.relative(normalizedRoot, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Path traversal rejected: ${userRel}`);
    }
    return candidate;
}

export class ArtifactService {
    /**
     * @deprecated use the exported `resolveSafeWorkspacePath` helper.
     * Retained as a private alias for backward-compat within the class.
     */
    private static resolveSafe(projectRoot: string, userRel: string): string {
        return resolveSafeWorkspacePath(projectRoot, userRel);
    }

    private async getProjectRoot(projectId: string): Promise<string | null> {
        const row = await getOne<{ repo_path: string | null }>(
            'SELECT repo_path FROM projects WHERE id = $1',
            [projectId],
        );
        return row?.repo_path ?? null;
    }

    /** Public accessor — used by IPC handlers that need the project's root. */
    async getProjectRootPublic(projectId: string): Promise<string | null> {
        return this.getProjectRoot(projectId);
    }

    async listFiles(projectId: string, subPath: string = ''): Promise<readonly ArtifactNode[]> {
        const root = await this.getProjectRoot(projectId);
        if (root === null) return [];

        const absDir = ArtifactService.resolveSafe(root, subPath);
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(absDir, { withFileTypes: true });
        } catch (err) {
            log.warn({ err: errMsg(err), absDir }, 'readdir failed');
            return [];
        }

        // One query to pull all agent attributions for this project.
        const taskRows = await getMany<{ id: string; assigned_agent: string | null; output_path: string | null }>(
            'SELECT id, assigned_agent, output_path FROM tasks WHERE project_id = $1 AND output_path IS NOT NULL',
            [projectId],
        );
        const producerByRel = new Map<string, { agent: string; taskId: string }>();
        for (const t of taskRows) {
            if (t.output_path === null || t.assigned_agent === null) continue;
            producerByRel.set(normalizeRel(t.output_path), {
                agent: t.assigned_agent,
                taskId: t.id,
            });
        }

        const nodes: ArtifactNode[] = [];
        for (const e of entries) {
            if (e.isDirectory() && EXCLUDE_DIRS.has(e.name)) continue;
            if (e.isFile() && EXCLUDE_FILES.has(e.name)) continue;

            const rel = path.posix.join(subPath.replace(/\\/g, '/'), e.name);
            const abs = path.join(absDir, e.name);

            if (e.isDirectory()) {
                nodes.push({ name: e.name, relPath: rel, type: 'dir' });
                continue;
            }
            if (!e.isFile()) continue;

            let stat: fs.Stats | null = null;
            try {
                stat = await fsp.stat(abs);
            } catch {
                stat = null;
            }

            nodes.push({
                name: e.name,
                relPath: rel,
                type: 'file',
                size: stat?.size,
                mtime: stat?.mtimeMs,
                producedBy: producerByRel.get(normalizeRel(rel)),
            });
        }

        nodes.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        return nodes;
    }

    async readPreview(projectId: string, relPath: string): Promise<ArtifactPreview> {
        const root = await this.getProjectRoot(projectId);
        if (root === null) {
            return emptyPreview('Project not found');
        }
        const abs = ArtifactService.resolveSafe(root, relPath);

        const stat = await fsp.stat(abs);
        if (!stat.isFile()) {
            return emptyPreview('Not a file');
        }

        const ext = path.extname(relPath).toLowerCase();
        const mimeType = guessMime(relPath);

        if (IMAGE_EXTS.has(ext)) {
            if (stat.size > IMAGE_SIZE_CAP) {
                return {
                    kind: 'binary',
                    sizeBytes: stat.size,
                    truncated: false,
                    mimeType,
                };
            }
            const buf = await fsp.readFile(abs);
            const dataUrl = `data:${mimeType};base64,${buf.toString('base64')}`;
            return { kind: 'image', dataUrl, sizeBytes: stat.size, truncated: false, mimeType };
        }

        if (ext === '.html' || ext === '.htm') {
            const truncated = stat.size > PREVIEW_SIZE_CAP;
            const buf = await fsp.readFile(abs, { encoding: 'utf8' });
            const text = truncated ? buf.slice(0, PREVIEW_SIZE_CAP) : buf;
            return { kind: 'html', text, sizeBytes: stat.size, truncated, mimeType };
        }

        if (ext === '.md' || ext === '.markdown') {
            const truncated = stat.size > PREVIEW_SIZE_CAP;
            const buf = await fsp.readFile(abs, { encoding: 'utf8' });
            const text = truncated ? buf.slice(0, PREVIEW_SIZE_CAP) : buf;
            return { kind: 'markdown', text, sizeBytes: stat.size, truncated, mimeType };
        }

        if (CODE_EXT_TO_LANG[ext] !== undefined) {
            const truncated = stat.size > PREVIEW_SIZE_CAP;
            const buf = await fsp.readFile(abs, { encoding: 'utf8' });
            const text = truncated ? buf.slice(0, PREVIEW_SIZE_CAP) : buf;
            return {
                kind: 'code',
                language: CODE_EXT_TO_LANG[ext],
                text,
                sizeBytes: stat.size,
                truncated,
                mimeType,
            };
        }

        // Heuristic: if file looks like text (no NUL bytes in first 512 bytes), treat as text.
        const fd = await fsp.open(abs, 'r');
        try {
            const head = Buffer.alloc(Math.min(512, stat.size));
            await fd.read(head, 0, head.length, 0);
            if (!head.includes(0)) {
                const truncated = stat.size > PREVIEW_SIZE_CAP;
                const buf = await fsp.readFile(abs, { encoding: 'utf8' });
                const text = truncated ? buf.slice(0, PREVIEW_SIZE_CAP) : buf;
                return { kind: 'text', text, sizeBytes: stat.size, truncated, mimeType };
            }
        } finally {
            await fd.close();
        }

        return { kind: 'binary', sizeBytes: stat.size, truncated: false, mimeType };
    }

    /**
     * Walk the full project tree, skipping excluded directories. Returns a
     * nested structure the renderer can flatten for virtualization (B-420).
     *
     * `maxDepth` bounds recursion so a pathological symlink cycle can't
     * blow the stack. When exceeded the offending directory is returned
     * without children.
     */
    async listTree(
        projectId: string,
        maxDepth: number = TREE_MAX_DEPTH_DEFAULT,
    ): Promise<readonly FileNode[]> {
        const root = await this.getProjectRoot(projectId);
        if (root === null) return [];
        const producers = await this.loadProducerMap(projectId);
        return listTreeFromRoot(root, maxDepth, producers);
    }

    /**
     * Build a `{ relPath → { agent, taskId } }` map from `tasks.output_path`
     * so the tree walker can annotate each file with its producing agent
     * without re-querying per node.
     */
    private async loadProducerMap(projectId: string): Promise<ReadonlyMap<string, FileProducer>> {
        const rows = await getMany<{ id: string; assigned_agent: string | null; output_path: string | null }>(
            'SELECT id, assigned_agent, output_path FROM tasks WHERE project_id = $1 AND output_path IS NOT NULL',
            [projectId],
        );
        const map = new Map<string, FileProducer>();
        for (const r of rows) {
            if (r.output_path === null || r.assigned_agent === null) continue;
            map.set(normalizeRel(r.output_path), { agent: r.assigned_agent, taskId: r.id });
        }
        return map;
    }

    /**
     * Read a single file for preview (B-421). UTF-8 text files return
     * `content` as the decoded string. Binaries return metadata only with
     * `content = null, isBinary = true`.
     *
     * Images are returned as base64 so the renderer can build a
     * `data:${mime};base64,...` URL (allowed by our CSP img-src 'self' data:).
     */
    async readFile(projectId: string, userRel: string): Promise<FileReadResult> {
        const root = await this.getProjectRoot(projectId);
        if (root === null) {
            throw new Error('Project not found');
        }
        const abs = resolveSafeWorkspacePath(root, userRel);
        const stat = await fsp.stat(abs);
        if (!stat.isFile()) {
            throw new Error('Not a file');
        }

        const mimeType = guessMime(userRel);
        const ext = path.extname(userRel).toLowerCase();
        const mtimeIso = new Date(stat.mtimeMs).toISOString();

        // Images — always base64 (keeps the renderer simple; CSP allows data: URIs).
        if (IMAGE_EXTS.has(ext)) {
            if (stat.size > IMAGE_SIZE_CAP) {
                return {
                    content: null,
                    encoding: 'base64',
                    mimeType,
                    sizeBytes: stat.size,
                    mtimeIso,
                    isBinary: true,
                };
            }
            const buf = await fsp.readFile(abs);
            return {
                content: buf.toString('base64'),
                encoding: 'base64',
                mimeType,
                sizeBytes: stat.size,
                mtimeIso,
                isBinary: false,
            };
        }

        // Binary sniff — peek at up to 512 bytes for NUL or high non-UTF8 density.
        const looksBinary = await sniffBinary(abs, stat.size);
        if (looksBinary) {
            return {
                content: null,
                encoding: 'utf8',
                mimeType,
                sizeBytes: stat.size,
                mtimeIso,
                isBinary: true,
            };
        }

        const readCap = Math.min(stat.size, READ_FILE_SIZE_CAP);
        const buf = await fsp.readFile(abs, { encoding: 'utf8' });
        const text = readCap < stat.size ? buf.slice(0, readCap) : buf;
        return {
            content: text,
            encoding: 'utf8',
            mimeType,
            sizeBytes: stat.size,
            mtimeIso,
            isBinary: false,
        };
    }

    /**
     * Delete a file or directory inside the project workspace (B-426).
     *
     * Guard rails:
     *   • path is resolved via `resolveSafeWorkspacePath` → no traversal
     *   • empty / `.` / `/` rejected so the project root can't be nuked
     *   • directory deletions only succeed when `recursive: true` is opted-in
     *   • symlinks are removed, not followed
     *
     * Returns `{ deleted: true, kind: 'file' | 'dir' }` on success; throws
     * with an `ENOENT`-flagged message when the path does not exist.
     */
    async deletePath(
        projectId: string,
        userRel: string,
        opts: { recursive?: boolean } = {},
    ): Promise<{ readonly deleted: true; readonly kind: 'file' | 'dir' }> {
        const root = await this.getProjectRoot(projectId);
        if (root === null) throw new Error('Project not found');
        const trimmed = userRel.trim();
        if (trimmed === '' || trimmed === '.' || trimmed === '/' || trimmed === './') {
            throw new Error('Refusing to delete project root');
        }
        const abs = resolveSafeWorkspacePath(root, trimmed);
        if (abs === path.resolve(root)) {
            throw new Error('Refusing to delete project root');
        }
        const stat = await fsp.lstat(abs);
        if (stat.isDirectory()) {
            if (opts.recursive !== true) {
                throw new Error('Directory delete requires recursive:true');
            }
            await fsp.rm(abs, { recursive: true, force: false });
            return { deleted: true, kind: 'dir' };
        }
        await fsp.rm(abs, { force: false });
        return { deleted: true, kind: 'file' };
    }

    /**
     * Zip the project workspace (respecting exclude list) into a tmp file.
     * Returns the absolute tmp path — caller should stream it to user then delete.
     */
    async downloadZip(projectId: string): Promise<string> {
        const root = await this.getProjectRoot(projectId);
        if (root === null) throw new Error('Project not found');

        const os = await import('os');
        // archiver has no @types bundled; use runtime require with a typed signature.
        type ArchiverFn = (format: string, opts?: { zlib?: { level: number } }) => {
            pipe: (s: NodeJS.WritableStream) => void;
            file: (p: string, opts: { name: string }) => void;
            finalize: () => Promise<void>;
            on: (ev: string, cb: (e: Error) => void) => void;
        };
        const archiver = (require('archiver') as ArchiverFn);
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kageops-zip-'));
        const outPath = path.join(tmpDir, `${path.basename(root)}.zip`);

        await new Promise<void>((resolve, reject) => {
            const output = fs.createWriteStream(outPath);
            const archive = archiver('zip', { zlib: { level: 6 } });
            output.on('close', () => resolve());
            output.on('error', reject);
            archive.on('error', reject);
            archive.pipe(output);

            // Walk, skipping excluded dirs/files.
            const walk = (dir: string, rel: string): void => {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const e of entries) {
                    if (e.isDirectory()) {
                        if (EXCLUDE_DIRS.has(e.name)) continue;
                        walk(path.join(dir, e.name), path.posix.join(rel, e.name));
                    } else if (e.isFile()) {
                        if (EXCLUDE_FILES.has(e.name)) continue;
                        archive.file(path.join(dir, e.name), { name: path.posix.join(rel, e.name) });
                    }
                }
            };
            walk(root, '');
            void archive.finalize();
        });

        return outPath;
    }
}

function emptyPreview(reason: string): ArtifactPreview {
    return {
        kind: 'text',
        text: reason,
        sizeBytes: 0,
        truncated: false,
        mimeType: 'text/plain',
    };
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function normalizeRel(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Recursively walk `absRoot`, returning a tree of `FileNode` with hidden
 * / dependency directories pruned. Depth limited by `maxDepth`. Exposed
 * for test isolation — tests can exercise the walker without a database.
 */
export async function listTreeFromRoot(
    absRoot: string,
    maxDepth: number,
    producers: ReadonlyMap<string, FileProducer> = new Map(),
): Promise<readonly FileNode[]> {
    return walkDir(absRoot, absRoot, 0, Math.max(0, maxDepth), producers);
}

async function walkDir(
    root: string,
    absDir: string,
    depth: number,
    maxDepth: number,
    producers: ReadonlyMap<string, FileProducer>,
): Promise<readonly FileNode[]> {
    let entries: fs.Dirent[];
    try {
        entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
        log.warn({ err: errMsg(err), absDir }, 'walkDir readdir failed');
        return [];
    }

    const nodes: FileNode[] = [];
    for (const e of entries) {
        if (e.isDirectory() && EXCLUDE_DIRS.has(e.name)) continue;
        if (e.isFile() && EXCLUDE_FILES.has(e.name)) continue;
        if (!(e.isFile() || e.isDirectory())) continue;

        const abs = path.join(absDir, e.name);
        const rel = path.relative(root, abs).split(path.sep).join('/');

        if (e.isDirectory()) {
            if (depth >= maxDepth) {
                nodes.push({ name: e.name, path: rel, type: 'dir' });
                continue;
            }
            const children = await walkDir(root, abs, depth + 1, maxDepth, producers);
            nodes.push({ name: e.name, path: rel, type: 'dir', children });
            continue;
        }

        let stat: fs.Stats | null = null;
        try {
            stat = await fsp.stat(abs);
        } catch {
            stat = null;
        }
        const producer = producers.get(rel);
        nodes.push({
            name: e.name,
            path: rel,
            type: 'file',
            size: stat?.size,
            mtime: stat?.mtimeMs,
            ...(producer !== undefined ? { producedBy: producer } : {}),
        });
    }

    // Directories first, then files — both alphabetic.
    nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return nodes;
}

/**
 * Heuristic binary sniffer — reads up to 512 bytes and flags NUL or a
 * high density of non-printable bytes. Files with a known-text extension
 * are treated as text even if the sniff is borderline.
 */
export async function sniffBinary(abs: string, size: number): Promise<boolean> {
    const sampleSize = Math.min(512, size);
    if (sampleSize === 0) return false;
    const fd = await fsp.open(abs, 'r');
    try {
        const head = Buffer.alloc(sampleSize);
        await fd.read(head, 0, sampleSize, 0);
        if (head.includes(0)) return true;
        // Count bytes outside printable ASCII / common whitespace (tab/LF/CR).
        let nonPrintable = 0;
        for (let i = 0; i < head.length; i++) {
            const c = head[i] ?? 0;
            const isPrintable = (c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d;
            const isUtf8High = c >= 0x80;
            if (!isPrintable && !isUtf8High) nonPrintable++;
        }
        return nonPrintable / head.length > 0.3;
    } finally {
        await fd.close();
    }
}

function guessMime(relPath: string): string {
    const ext = path.extname(relPath).toLowerCase();
    if (ext === '.md' || ext === '.markdown' || ext === '.mdx') return 'text/markdown';
    if (ext === '.html' || ext === '.htm') return 'text/html';
    if (ext === '.css') return 'text/css';
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'application/javascript';
    if (ext === '.json') return 'application/json';
    if (ext === '.svg') return 'image/svg+xml';
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.ico') return 'image/x-icon';
    if (ext === '.bmp') return 'image/bmp';
    if (CODE_EXT_TO_LANG[ext] !== undefined) return 'text/plain';
    return 'application/octet-stream';
}
