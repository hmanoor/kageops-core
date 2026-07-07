/**
 * KO-SEC-005/030 — `sanitizeHtml` is the shared guard between
 * `marked.parse()` output and the DOM (`innerHTML` / `insertAdjacentHTML`)
 * across the Command Center renderer. Source markdown can be AI-generated
 * (Sensei chat replies, task output, knowledge-base content) so this must
 * strip script execution vectors while preserving normal markdown HTML.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

import { sanitizeHtml } from '../../src/renderer/shared/sanitize-html';

describe('sanitizeHtml (KO-SEC-005/030)', () => {
  it('strips <script> tags', () => {
    const out = sanitizeHtml('<p>hello</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).toContain('hello');
  });

  it('strips inline event-handler attributes', () => {
    const out = sanitizeHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain('onerror');
  });

  it('strips javascript: URLs', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('preserves normal markdown-rendered HTML', () => {
    const out = sanitizeHtml('<p><strong>bold</strong> and <em>em</em> and <a href="https://kageops.ai">link</a></p>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>em</em>');
    expect(out).toContain('href="https://kageops.ai"');
  });
});
