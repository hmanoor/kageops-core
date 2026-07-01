/**
 * Artifact Browser syntax highlighting (B-421).
 *
 * Thin wrapper around Prism.js — bundled into the renderer by esbuild so
 * we never violate CSP by loading a CDN script. Only a focused subset of
 * language components is registered to keep the bundle small.
 *
 * Unknown extensions fall back to plain-text (no highlighting) rather
 * than throwing — the preview just renders the raw content in a `<pre>`.
 */

import Prism from 'prismjs';

// Register languages. Prism is authored to mutate a shared global so we
// import the grammars for their side effects only.
import 'prismjs/components/prism-markup';       // html / xml / svg
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-toml';

/**
 * Known code-file extensions → Prism language ids. Everything not in
 * this map is treated as plain text.
 */
const EXT_TO_PRISM_LANG: Readonly<Record<string, string>> = Object.freeze({
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.jsx': 'jsx',
    '.json': 'json',
    '.css': 'css',
    '.html': 'markup',
    '.htm': 'markup',
    '.svg': 'markup',
    '.xml': 'markup',
    '.sql': 'sql',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.toml': 'toml',
    '.md': 'markdown',
    '.mdx': 'markdown',
});

export function languageForExtension(ext: string): string | null {
    return EXT_TO_PRISM_LANG[ext.toLowerCase()] ?? null;
}

/**
 * Return a Prism-highlighted HTML string for `code` in `language`. If the
 * language is unknown, returns HTML-escaped plain text (no formatting).
 */
export function highlight(code: string, language: string): string {
    const grammar = Prism.languages[language];
    if (grammar === undefined) {
        return escapeHtml(code);
    }
    try {
        return Prism.highlight(code, grammar, language);
    } catch {
        return escapeHtml(code);
    }
}

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
