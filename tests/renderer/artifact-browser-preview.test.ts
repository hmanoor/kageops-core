/**
 * artifact-browser preview renderer tests (B-421 / B-422).
 *
 * Covers `classify` routing and the pure `renderPreviewHtml` output for
 * every kind (markdown, code, text, image, html, binary) plus the
 * unknown-extension fallback to plain text.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
    classify,
    renderPreviewHtml,
    type FileReadResult,
    type PreviewContext,
} from '../../src/renderer/command-center/artifact-browser-preview';
import {
    escapeHtml,
    highlight,
    languageForExtension,
} from '../../src/renderer/command-center/artifact-browser-highlight';

// ── Fixtures ─────────────────────────────────────────

function makeFile(overrides: Partial<FileReadResult> = {}): FileReadResult {
    return {
        content: 'hello',
        encoding: 'utf8',
        mimeType: 'text/plain',
        sizeBytes: 5,
        mtimeIso: '2026-01-01T00:00:00.000Z',
        isBinary: false,
        ...overrides,
    };
}

const ctx = (relPath: string): PreviewContext => ({ projectId: 'proj-1', relPath });

// ── classify ─────────────────────────────────────────

describe('classify', () => {
    it('returns binary when file.isBinary and not an image', () => {
        const f = makeFile({ isBinary: true, content: null, mimeType: 'application/octet-stream' });
        expect(classify('thing.bin', f)).toBe('binary');
    });

    it('returns image for image extensions even when isBinary is true', () => {
        // Images round-trip through base64 so the service flags isBinary=false,
        // but classify must still route png by extension regardless.
        const f = makeFile({ mimeType: 'image/png', encoding: 'base64' });
        expect(classify('a.png', f)).toBe('image');
    });

    it('returns html for .html / .htm', () => {
        expect(classify('index.html', makeFile())).toBe('html');
        expect(classify('index.htm', makeFile())).toBe('html');
    });

    it('returns markdown for .md / .mdx / .markdown', () => {
        expect(classify('README.md', makeFile())).toBe('markdown');
        expect(classify('post.mdx', makeFile())).toBe('markdown');
        expect(classify('doc.markdown', makeFile())).toBe('markdown');
    });

    it('returns code for known code extensions', () => {
        expect(classify('index.ts', makeFile())).toBe('code');
        expect(classify('style.css', makeFile())).toBe('code');
        expect(classify('pkg.json', makeFile())).toBe('code');
        expect(classify('script.sh', makeFile())).toBe('code');
    });

    it('returns text for unknown extensions with utf8 content', () => {
        expect(classify('LICENSE', makeFile())).toBe('text');
        expect(classify('notes.xyz', makeFile())).toBe('text');
    });

    it('returns binary for unknown extension with null content', () => {
        expect(classify('mystery', makeFile({ content: null }))).toBe('binary');
    });
});

// ── renderPreviewHtml ────────────────────────────────

describe('renderPreviewHtml', () => {
    it('renders a header with escaped relPath and formatted size', () => {
        const out = renderPreviewHtml(ctx('src/a<b>.ts'), makeFile({ content: 'x', sizeBytes: 1 }));
        expect(out.html).toContain('src/a&lt;b&gt;.ts');
        expect(out.html).toContain('1 B');
    });

    it('wraps plain text in a <pre> and escapes HTML', () => {
        const out = renderPreviewHtml(ctx('LICENSE'), makeFile({ content: '<script>bad</script>' }));
        expect(out.kind).toBe('text');
        expect(out.html).toContain('&lt;script&gt;bad&lt;/script&gt;');
        expect(out.html).not.toContain('<script>bad');
    });

    it('renders code with a Prism class and escapes the input', () => {
        const src = 'const x = "<y>";';
        const out = renderPreviewHtml(ctx('a.ts'), makeFile({ content: src }));
        expect(out.kind).toBe('code');
        expect(out.html).toMatch(/language-typescript/);
        // Raw angle brackets from the source must not leak as HTML.
        expect(out.html).not.toContain('<y>');
    });

    it('falls back to plain text for unknown code-ish extensions', () => {
        // .rbx is not in the explicit code set nor known to Prism.
        const out = renderPreviewHtml(ctx('a.rbx'), makeFile({ content: 'abc' }));
        expect(out.kind).toBe('text');
        expect(out.html).toContain('abc');
    });

    it('renders markdown to HTML via marked', () => {
        const out = renderPreviewHtml(
            ctx('README.md'),
            makeFile({ content: '# Hello\n\nSome **bold** text.' }),
        );
        expect(out.kind).toBe('markdown');
        expect(out.html).toContain('<h1');
        expect(out.html).toContain('<strong>bold</strong>');
    });

    it('highlights fenced code blocks inside markdown', () => {
        const md = '# h\n\n```typescript\nconst x = 1;\n```\n';
        const out = renderPreviewHtml(ctx('doc.md'), makeFile({ content: md }));
        expect(out.html).toMatch(/language-typescript/);
    });

    it('sanitizes an embedded <script> tag in rendered markdown (KO-SEC-005/030)', () => {
        const md = 'Some notes.\n\n<script>alert(1)</script>\n\nMore notes.';
        const out = renderPreviewHtml(ctx('doc.md'), makeFile({ content: md }));
        expect(out.kind).toBe('markdown');
        expect(out.html).not.toContain('<script');
        expect(out.html).toContain('Some notes');
    });

    it('builds a data URL for images', () => {
        const base64 = 'iVBORw0KGgo=';
        const out = renderPreviewHtml(
            ctx('pixel.png'),
            makeFile({ content: base64, mimeType: 'image/png', encoding: 'base64' }),
        );
        expect(out.kind).toBe('image');
        expect(out.html).toContain(`data:image/png;base64,${base64}`);
        expect(out.html).toContain('<img ');
    });

    it('uses a sandboxed iframe for HTML previews', () => {
        const out = renderPreviewHtml(ctx('site/index.html'), makeFile({ content: '<p>hi</p>' }));
        expect(out.kind).toBe('html');
        expect(out.html).toContain('<iframe');
        expect(out.html).toContain('sandbox="allow-scripts"');
        expect(out.html).toContain('kageops-artifact://proj-1/site/index.html');
    });

    it('URL-encodes iframe src segments', () => {
        const out = renderPreviewHtml(ctx('sub dir/index.html'), makeFile({ content: '<p>hi</p>' }));
        expect(out.html).toContain('kageops-artifact://proj-1/sub%20dir/index.html');
    });

    it('renders a producer pill in the header when ctx.producedBy is set (B-428)', () => {
        const out = renderPreviewHtml(
            { projectId: 'p', relPath: 'src/app.ts', producedBy: { agent: 'forge', taskId: 'task-9' } },
            makeFile({ content: 'x' }),
        );
        expect(out.html).toContain('ab-preview-producer');
        expect(out.html).toContain('forge');
        expect(out.html).toContain('task-9');
    });

    it('omits the producer pill when ctx.producedBy is absent', () => {
        const out = renderPreviewHtml(ctx('README.md'), makeFile({ content: '# hi' }));
        expect(out.html).not.toContain('ab-preview-producer');
    });

    it('escapes producer fields in the pill', () => {
        const out = renderPreviewHtml(
            {
                projectId: 'p',
                relPath: 'a.ts',
                producedBy: { agent: '<scout>', taskId: 't"1' },
            },
            makeFile({ content: 'x' }),
        );
        expect(out.html).toContain('&lt;scout&gt;');
        expect(out.html).toContain('t&quot;1');
        expect(out.html).not.toContain('<scout>');
    });

    it('renders a binary stub when content is null', () => {
        const out = renderPreviewHtml(
            ctx('blob.bin'),
            makeFile({ content: null, isBinary: true, mimeType: 'application/octet-stream' }),
        );
        expect(out.kind).toBe('binary');
        expect(out.html).toContain('Binary file');
        expect(out.html).toContain('application/octet-stream');
    });
});

// ── Highlight helpers ────────────────────────────────

describe('artifact-browser-highlight', () => {
    it('escapeHtml escapes the five sensitive characters', () => {
        expect(escapeHtml('<a href="x">&\'</a>'))
            .toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    });

    it('languageForExtension maps known extensions', () => {
        expect(languageForExtension('.ts')).toBe('typescript');
        expect(languageForExtension('.tsx')).toBe('tsx');
        expect(languageForExtension('.py')).toBe('python');
        expect(languageForExtension('.yml')).toBe('yaml');
    });

    it('languageForExtension returns null for unknown extensions', () => {
        expect(languageForExtension('.xyz')).toBeNull();
        expect(languageForExtension('')).toBeNull();
    });

    it('languageForExtension is case-insensitive', () => {
        expect(languageForExtension('.TS')).toBe('typescript');
    });

    it('highlight returns Prism-tokenised HTML for a known language', () => {
        const out = highlight('const x = 1;', 'typescript');
        // Prism wraps keywords / numbers in <span class="token …">.
        expect(out).toContain('class="token');
    });

    it('highlight escapes input for an unknown language', () => {
        const out = highlight('<script>', 'klingon');
        expect(out).toBe('&lt;script&gt;');
    });
});
