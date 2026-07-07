/**
 * KO-SEC-005/030 — Sensei chat replies are rendered from `marked.parse()`
 * straight into `innerHTML` / `insertAdjacentHTML`. Since reply text can be
 * AI-generated (and the chat transcript can include prior turns echoed back
 * by a model), an unsanitized reply is a stored-XSS vector in the Autonauts
 * chat panel. `renderChatBubble` must sanitize before returning HTML.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

import { renderChatBubble, type ChatEntry } from '../../src/renderer/command-center/autonauts-view';

describe('renderChatBubble (KO-SEC-005/030)', () => {
  it('strips a <script> tag from an assistant reply', () => {
    const entry: ChatEntry = {
      role: 'assistant',
      text: 'Sure, here you go.<script>alert(1)</script>',
      timestamp: new Date().toISOString(),
    };
    const html = renderChatBubble(entry);
    expect(html).not.toContain('<script');
  });

  it('strips an inline event-handler attribute from an assistant reply', () => {
    const entry: ChatEntry = {
      role: 'assistant',
      text: '<img src="x" onerror="alert(1)">',
      timestamp: new Date().toISOString(),
    };
    const html = renderChatBubble(entry);
    expect(html).not.toContain('onerror');
  });

  it('still renders normal markdown for assistant replies', () => {
    const entry: ChatEntry = {
      role: 'assistant',
      text: '**bold** text',
      timestamp: new Date().toISOString(),
    };
    const html = renderChatBubble(entry);
    expect(html).toContain('<strong>bold</strong>');
  });
});
