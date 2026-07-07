/**
 * Artifact Browser — preview pane (B-421 / B-422).
 *
 * Renders a file payload from `artifacts:read-file` as one of:
 *
 *   • markdown  — `marked` → HTML, with code blocks Prism-highlighted
 *   • code      — Prism-highlighted via extension lookup
 *   • text      — plain text, `pre-wrap`
 *   • image     — `<img src="data:${mime};base64,${content}">`
 *   • html      — sandboxed iframe via `kageops-artifact://` (B-422)
 *   • binary    — metadata-only stub
 *
 * Unknown extensions degrade to plain text (no highlight) rather than
 * throwing. The iframe for HTML previews is `sandbox="allow-scripts"`,
 * matching the scheme registered by the main process.
 */

import { marked } from 'marked';
import { escapeHtml, highlight, languageForExtension } from './artifact-browser-highlight';
import { sanitizeHtml } from '../shared/sanitize-html';

export interface FileReadResult {
    readonly content: string | null;
    readonly encoding: 'utf8' | 'base64';
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly mtimeIso: string;
    readonly isBinary: boolean;
}

export type PreviewKind = 'markdown' | 'code' | 'text' | 'image' | 'html' | 'binary' | 'empty';

export interface PreviewProducer {
    readonly agent: string;
    readonly taskId: string;
}

export interface PreviewContext {
    readonly projectId: string;
    readonly relPath: string;
    readonly producedBy?: PreviewProducer;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);
const CODE_EXTS_EXPLICIT = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.json', '.css', '.html', '.htm', '.sql', '.sh', '.bash', '.zsh',
    '.py', '.go', '.rs', '.yml', '.yaml', '.toml',
]);
const MARKDOWN_EXTS = new Set(['.md', '.mdx', '.markdown']);

export function classify(relPath: string, file: FileReadResult): PreviewKind {
    if (file.isBinary && !isImageExt(relPath)) return 'binary';
    const ext = extOf(relPath);
    if (ext === '.html' || ext === '.htm') return 'html';
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (MARKDOWN_EXTS.has(ext)) return 'markdown';
    if (CODE_EXTS_EXPLICIT.has(ext)) return 'code';
    if (file.content === null) return 'binary';
    return 'text';
}

export interface PreviewRenderResult {
    readonly kind: PreviewKind;
    readonly html: string;
}

/**
 * Build the inner HTML for a preview without injecting it. Keeping this
 * pure makes testing trivial — the caller writes it into a container.
 */
export function renderPreviewHtml(
    ctx: PreviewContext,
    file: FileReadResult,
): PreviewRenderResult {
    const kind = classify(ctx.relPath, file);
    const header = renderHeader(ctx, file);

    if (kind === 'binary' || file.content === null) {
        return {
            kind: 'binary',
            html: header + renderBinaryStub(file),
        };
    }

    if (kind === 'image') {
        const src = `data:${escapeHtml(file.mimeType)};base64,${escapeHtml(file.content)}`;
        return {
            kind: 'image',
            html: header + `<div class="ab-preview-image-wrap"><img src="${src}" alt="${escapeHtml(ctx.relPath)}"></div>`,
        };
    }

    if (kind === 'html') {
        const url = artifactUrl(ctx.projectId, ctx.relPath);
        return {
            kind: 'html',
            html: header + `<iframe class="ab-preview-iframe" sandbox="allow-scripts" src="${escapeHtml(url)}" title="HTML preview"></iframe>`,
        };
    }

    if (kind === 'markdown') {
        return { kind, html: header + renderMarkdown(file.content) };
    }

    if (kind === 'code') {
        const ext = extOf(ctx.relPath);
        const lang = languageForExtension(ext);
        if (lang === null) {
            return { kind: 'text', html: header + renderPlainText(file.content) };
        }
        const highlighted = highlight(file.content, lang);
        return {
            kind,
            html: header + `<pre class="ab-preview-code language-${escapeHtml(lang)}"><code>${highlighted}</code></pre>`,
        };
    }

    return { kind: 'text', html: header + renderPlainText(file.content) };
}

// ── Helpers ──────────────────────────────────────────

function renderHeader(ctx: PreviewContext, file: FileReadResult): string {
    const producer = ctx.producedBy !== undefined
        ? '<span class="ab-preview-producer" title="' +
          escapeHtml(`Produced by ${ctx.producedBy.agent} (task ${ctx.producedBy.taskId})`) +
          '">' +
          `${escapeHtml(ctx.producedBy.agent)} &middot; task ${escapeHtml(ctx.producedBy.taskId)}` +
          '</span>'
        : '';
    return (
        '<div class="ab-preview-header">' +
        `<span class="ab-preview-path">${escapeHtml(ctx.relPath)}</span>` +
        `<span class="ab-preview-meta">${formatBytes(file.sizeBytes)} &middot; ${formatMtime(file.mtimeIso)}</span>` +
        producer +
        '</div>'
    );
}

function renderBinaryStub(file: FileReadResult): string {
    return (
        '<div class="ab-preview-binary">' +
        `<div><strong>Binary file</strong></div>` +
        `<div>Type: ${escapeHtml(file.mimeType)}</div>` +
        `<div>Size: ${formatBytes(file.sizeBytes)}</div>` +
        `<div>Modified: ${escapeHtml(formatMtime(file.mtimeIso))}</div>` +
        '</div>'
    );
}

function renderPlainText(content: string): string {
    return `<pre class="ab-preview-text"><code>${escapeHtml(content)}</code></pre>`;
}

function renderMarkdown(content: string): string {
    // `marked.parse` is synchronous when `async: false` (default). We
    // cast through `unknown` to avoid a cross-version union with
    // `Promise<string>`.
    const rawHtml = marked.parse(content, { async: false }) as unknown as string;
    // Post-process: highlight code blocks that declared a language.
    const enhanced = rawHtml.replace(
        /<pre><code class="language-([a-zA-Z0-9_-]+)">([\s\S]*?)<\/code><\/pre>/g,
        (_match, lang: string, body: string) => {
            const raw = decodeHtml(body);
            const highlighted = highlight(raw, lang);
            return `<pre class="ab-preview-code language-${lang}"><code>${highlighted}</code></pre>`;
        },
    );
    // KO-SEC-005/030: file content can be AI-generated — sanitize the final
    // markup (after code-block highlighting) before it reaches innerHTML.
    return sanitizeHtml(`<div class="ab-preview-markdown">${enhanced}</div>`);
}

function decodeHtml(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

function artifactUrl(projectId: string, relPath: string): string {
    const safeRel = relPath.split('/').map(encodeURIComponent).join('/');
    return `kageops-artifact://${encodeURIComponent(projectId)}/${safeRel}`;
}

function extOf(relPath: string): string {
    const idx = relPath.lastIndexOf('.');
    if (idx === -1) return '';
    return relPath.slice(idx).toLowerCase();
}

function isImageExt(relPath: string): boolean {
    return IMAGE_EXTS.has(extOf(relPath));
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMtime(iso: string): string {
    try {
        return new Date(iso).toLocaleString('en-GB', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    } catch {
        return iso;
    }
}
