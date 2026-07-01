/**
 * Help docs indexer — Phase 2 of the Help system.
 *
 * Reads docs/help/*.md, splits each file into H2 chunks, upserts
 * documents + chunks into Postgres. Runs once at orchestrator boot.
 *
 * Hash-gated: if the on-disk content_hash matches what's stored,
 * the chunks are left alone — no work to do. When a doc changes,
 * we DELETE its chunks and re-insert (cheap; corpus is ~7 docs).
 *
 * Pure FTS over heading + content (search_vector lives on
 * help_chunks). Embeddings are deferred — see migration 014.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { getMany, getOne, query } from '../db/client';
import { createLogger } from '../shared/logger';

const log = createLogger('HelpIndexer');

// ── Types ────────────────────────────────────────────

export interface HelpDocSummary {
    readonly slug: string;
    readonly title: string;
    readonly chunkCount: number;
    readonly status: 'inserted' | 'updated' | 'unchanged';
}

interface HelpChunk {
    readonly index: number;
    readonly heading: string;
    readonly content: string;
}

// ── Constants ────────────────────────────────────────

const DOCS_DIR = path.join('docs', 'help');

/**
 * Find docs/help on disk across the three environments this code runs in:
 *
 *   1. Dev (`npm run dev`): cwd is the repo root → `<repo>/docs/help`.
 *   2. Packaged Electron app (NSIS / MSI / .dmg / AppImage): app is
 *      launched from wherever the user clicked, so cwd is essentially
 *      random. The docs are shipped via electron-builder.yml's
 *      `extraResources` to `<install-root>/resources/docs/help` and
 *      `process.resourcesPath` points at the resources dir.
 *   3. Tests / headless CLI: cwd is typically the repo root.
 *
 * Strategy: try the packaged path first (process.resourcesPath is only
 * defined under Electron and is harmless to check); fall back to cwd.
 * Logs which one resolved so a missing-docs bug shows up clearly in
 * pino output.
 */
function resolveDocsRoot(): string {
    const candidates: string[] = [];
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (typeof resourcesPath === 'string' && resourcesPath !== '') {
        candidates.push(path.resolve(resourcesPath, DOCS_DIR));
    }
    candidates.push(path.resolve(process.cwd(), DOCS_DIR));

    for (const candidate of candidates) {
        try {
            // Sync exists check at boot is cheap and avoids racing the async
            // readdir we're about to do anyway.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fsSync = require('fs') as typeof import('fs');
            if (fsSync.existsSync(candidate)) return candidate;
        } catch {
            // Best-effort; if existsSync isn't available we just take the
            // first candidate and let readdir fail noisily.
        }
    }
    return candidates[0] ?? path.resolve(process.cwd(), DOCS_DIR);
}

// ── Public API ───────────────────────────────────────

/**
 * Read every .md file under docs/help/, chunk it, and persist.
 * Idempotent — safe to call on every boot.
 *
 * Returns one summary per doc (whether or not the doc was rewritten),
 * so callers can log what happened.
 */
export async function indexHelpDocs(): Promise<readonly HelpDocSummary[]> {
    const docsRoot = resolveDocsRoot();
    log.info({ docsRoot }, 'Resolving help docs');

    let files: readonly string[];
    try {
        files = (await fs.readdir(docsRoot))
            .filter((f) => f.endsWith('.md'))
            .sort();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err: msg, docsRoot }, 'Help docs dir not readable — skipping index');
        return [];
    }

    if (files.length === 0) {
        log.warn({ docsRoot }, 'No help docs found — skipping index');
        return [];
    }

    const summaries: HelpDocSummary[] = [];
    for (const file of files) {
        try {
            const summary = await indexOne(docsRoot, file);
            summaries.push(summary);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err: msg, file }, 'Failed to index help doc');
        }
    }

    log.info({
        total: summaries.length,
        inserted: summaries.filter((s) => s.status === 'inserted').length,
        updated: summaries.filter((s) => s.status === 'updated').length,
        unchanged: summaries.filter((s) => s.status === 'unchanged').length,
    }, 'Help docs indexed');

    return summaries;
}

// ── Internal ─────────────────────────────────────────

async function indexOne(docsRoot: string, file: string): Promise<HelpDocSummary> {
    const filePath = path.join(docsRoot, file);
    const body = await fs.readFile(filePath, 'utf8');
    const slug = slugFromFilename(file);
    const title = extractTitle(body) ?? slug;
    const contentHash = hashContent(body);

    const existing = await getOne<{ id: string; content_hash: string }>(
        'SELECT id, content_hash FROM help_documents WHERE slug = $1',
        [slug]
    );

    if (existing !== null && existing.content_hash === contentHash) {
        // Already indexed at this content — count chunks for the summary.
        const countRow = await getOne<{ count: string | number }>(
            'SELECT COUNT(*)::int AS count FROM help_chunks WHERE doc_id = $1',
            [existing.id]
        );
        const count = countRow === null
            ? 0
            : (typeof countRow.count === 'string' ? Number(countRow.count) : countRow.count);
        return { slug, title, chunkCount: count, status: 'unchanged' };
    }

    const chunks = splitByH2(body);
    const docId = await upsertDocument({ slug, title, body, contentHash, existingId: existing?.id ?? null });
    await replaceChunks(docId, chunks);

    return {
        slug,
        title,
        chunkCount: chunks.length,
        status: existing === null ? 'inserted' : 'updated',
    };
}

async function upsertDocument(args: {
    readonly slug: string;
    readonly title: string;
    readonly body: string;
    readonly contentHash: string;
    readonly existingId: string | null;
}): Promise<string> {
    if (args.existingId !== null) {
        await query(
            `UPDATE help_documents
                SET title = $1, body = $2, content_hash = $3, indexed_at = NOW(), updated_at = NOW()
              WHERE id = $4`,
            [args.title, args.body, args.contentHash, args.existingId]
        );
        return args.existingId;
    }

    const inserted = await getOne<{ id: string }>(
        `INSERT INTO help_documents (slug, title, body, content_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [args.slug, args.title, args.body, args.contentHash]
    );
    if (inserted === null) {
        throw new Error(`Failed to insert help_documents row for slug=${args.slug}`);
    }
    return inserted.id;
}

async function replaceChunks(docId: string, chunks: readonly HelpChunk[]): Promise<void> {
    await query('DELETE FROM help_chunks WHERE doc_id = $1', [docId]);
    for (const chunk of chunks) {
        await query(
            `INSERT INTO help_chunks (doc_id, chunk_index, heading, content)
             VALUES ($1, $2, $3, $4)`,
            [docId, chunk.index, chunk.heading, chunk.content]
        );
    }
}

// ── Markdown helpers ─────────────────────────────────

/**
 * `01-quickstart.md` → `quickstart`. Strips the leading numeric prefix
 * because filenames carry order, not identity.
 */
function slugFromFilename(file: string): string {
    return file.replace(/\.md$/i, '').replace(/^\d+-/, '');
}

/** Top-level `# Title` — falls back to first non-empty line. */
function extractTitle(body: string): string | null {
    const h1 = /^#\s+(.+?)\s*$/m.exec(body);
    if (h1 !== null) return h1[1].trim();
    const firstLine = body.split('\n').find((l) => l.trim().length > 0);
    return firstLine === undefined ? null : firstLine.trim();
}

/**
 * Split a markdown body into chunks bounded by H2 (`## …`) headings.
 * Content before the first H2 is its own chunk with empty heading,
 * which keeps lead-in prose searchable.
 */
function splitByH2(body: string): readonly HelpChunk[] {
    const chunks: HelpChunk[] = [];
    const lines = body.split('\n');

    let currentHeading = '';
    let currentLines: string[] = [];

    const flush = () => {
        const content = currentLines.join('\n').trim();
        if (content.length === 0 && currentHeading.length === 0) return;
        chunks.push({
            index: chunks.length,
            heading: currentHeading,
            content,
        });
    };

    for (const line of lines) {
        const h2 = /^##\s+(.+?)\s*$/.exec(line);
        if (h2 !== null) {
            flush();
            currentHeading = h2[1].trim();
            currentLines = [];
            continue;
        }
        currentLines.push(line);
    }
    flush();

    return chunks.filter((c) => c.content.length > 0 || c.heading.length > 0);
}

function hashContent(body: string): string {
    return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}

// ── Test export ──────────────────────────────────────

/** Exposed for unit tests. Not part of the runtime API. */
export const __test__ = {
    splitByH2,
    extractTitle,
    slugFromFilename,
    hashContent,
};
