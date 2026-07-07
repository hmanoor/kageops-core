/**
 * KO-SEC-005/030 — shared sanitizer for markdown-rendered HTML.
 *
 * `marked.parse()` output is inserted into the DOM (via `innerHTML` /
 * `insertAdjacentHTML`) across several Command Center panels. The source
 * text can be AI-generated (Sensei chat replies, task output, knowledge-base
 * content) or otherwise not fully trusted, so every such insertion must run
 * through this sanitizer first — never insert `marked.parse()` output
 * directly.
 */

import DOMPurify from 'dompurify';

export function sanitizeHtml(html: string): string {
    return DOMPurify.sanitize(html);
}
