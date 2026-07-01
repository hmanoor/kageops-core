/**
 * KageOps Tiny HTML→Markdown Converter
 *
 * Hand-rolled converter for the Phase 2 web scraper. Deliberately NOT a full
 * DOM parser — no new npm dependencies. Handles the common subset that
 * Scout/Herald need: titles, headings, paragraphs, lists, links, inline code,
 * and code blocks. Everything else is stripped.
 *
 * Contract:
 *   - Input is the raw HTML body (as a string).
 *   - Output is UTF-8 markdown, trimmed.
 *   - Returns empty string on empty input.
 */

export interface ExtractedLink {
    readonly href: string;
    readonly text: string;
}

export interface HtmlExtraction {
    readonly markdown: string;
    readonly links: readonly ExtractedLink[];
    readonly title: string | null;
    readonly description: string | null;
}

// ── Public API ───────────────────────────────────────

export function extractFromHtml(html: string): HtmlExtraction {
    if (html.length === 0) {
        return { markdown: '', links: [], title: null, description: null };
    }

    const title = extractTitle(html);
    const description = extractMetaDescription(html);
    const links = extractLinks(html);
    const markdown = htmlToMarkdown(html);

    return { markdown, links, title, description };
}

export function htmlToMarkdown(html: string): string {
    // 1. Strip everything we don't want to render.
    let body = extractBody(html);
    body = stripTag(body, 'script');
    body = stripTag(body, 'style');
    body = stripTag(body, 'noscript');
    body = stripTag(body, 'svg');
    body = stripTag(body, 'iframe');
    body = body.replace(/<!--[\s\S]*?-->/g, '');

    // 2. Block-level conversions (order matters — code block first so its
    //    inner tags are preserved verbatim).
    body = body.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
        const code = decodeEntities(stripAllTags(inner)).replace(/\n{3,}/g, '\n\n');
        return `\n\n\`\`\`\n${code.trim()}\n\`\`\`\n\n`;
    });

    body = body.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
        const hashes = '#'.repeat(Number(level));
        const text = collapseWhitespace(decodeEntities(stripAllTags(inner)));
        return text === '' ? '' : `\n\n${hashes} ${text}\n\n`;
    });

    body = body.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => {
        const text = collapseWhitespace(decodeEntities(stripAllTags(inner)));
        return `\n- ${text}`;
    });
    body = body.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');

    body = body.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, inner: string) => {
        const text = collapseWhitespace(decodeEntities(convertInline(inner)));
        return text === '' ? '' : `\n\n${text}\n\n`;
    });

    body = body.replace(/<br\s*\/?>/gi, '\n');

    // 3. Inline conversions on whatever's left.
    body = convertInline(body);
    body = stripAllTags(body);
    body = decodeEntities(body);

    // 4. Normalise whitespace.
    body = body.replace(/\r\n?/g, '\n');
    body = body.replace(/[ \t]+\n/g, '\n');
    body = body.replace(/\n{3,}/g, '\n\n');

    return body.trim();
}

export function extractTitle(html: string): string | null {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (match === null) return null;
    const value = collapseWhitespace(decodeEntities(stripAllTags(match[1])));
    return value.length === 0 ? null : value;
}

export function extractMetaDescription(html: string): string | null {
    // Match any order of attributes: <meta name="description" content="...">
    const patterns: readonly RegExp[] = [
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i,
        /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i,
        /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["'][^>]*>/i,
    ];
    for (const p of patterns) {
        const m = p.exec(html);
        if (m !== null && m[1].length > 0) {
            return collapseWhitespace(decodeEntities(m[1]));
        }
    }
    return null;
}

export function extractLinks(html: string): readonly ExtractedLink[] {
    const results: ExtractedLink[] = [];
    const seen = new Set<string>();
    const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null = pattern.exec(html);
    while (match !== null) {
        const href = match[1].trim();
        const text = collapseWhitespace(decodeEntities(stripAllTags(match[2])));
        if (href.length > 0 && !seen.has(href)) {
            seen.add(href);
            results.push({ href, text });
        }
        match = pattern.exec(html);
    }
    return Object.freeze(results);
}

// ── Internal helpers ─────────────────────────────────

function extractBody(html: string): string {
    const match = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    return match !== null ? match[1] : html;
}

function stripTag(input: string, tag: string): string {
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    return input.replace(pattern, ' ');
}

function stripAllTags(input: string): string {
    return input.replace(/<[^>]+>/g, '');
}

function convertInline(input: string): string {
    let out = input;
    // Links
    out = out.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
        const label = collapseWhitespace(decodeEntities(stripAllTags(text)));
        const safeHref = href.trim();
        if (label === '') return safeHref;
        return `[${label}](${safeHref})`;
    });
    // Strong / em
    out = out.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `**${stripAllTags(inner)}**`);
    out = out.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `*${stripAllTags(inner)}*`);
    // Inline code
    out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${stripAllTags(inner)}\``);
    return out;
}

function collapseWhitespace(input: string): string {
    return input.replace(/\s+/g, ' ').trim();
}

function decodeEntities(input: string): string {
    return input
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&apos;/gi, '\'')
        .replace(/&#(\d+);/g, (_m, n: string) => {
            const code = Number(n);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
        })
        .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => {
            const code = parseInt(h, 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
        });
}
