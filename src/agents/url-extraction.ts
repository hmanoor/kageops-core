/**
 * URL extraction helper
 *
 * Scans free-form text (typically a task description) for http(s) URLs so
 * specialist agents (Scout, Herald, …) can automatically pull web context
 * via `AutonautAgent.webResearch()`.
 *
 * Design notes:
 *   - Regex-based, no dependencies. Catches the common cases (including
 *     URLs inside markdown links like `[text](https://example.com)`).
 *   - Trailing punctuation that commonly follows a URL in prose — e.g.
 *     `.`, `,`, `)`, `]`, `;`, `'`, `"` — is stripped from the match.
 *   - Duplicates are removed while preserving first-seen order.
 *   - Returns a `readonly string[]` per project immutability rules.
 */

// ── Regex ────────────────────────────────────────────

/**
 * Matches http:// or https:// followed by one or more non-whitespace chars.
 * Trailing punctuation is trimmed after the match — see TRAILING_PUNCT.
 */
const URL_REGEX = /https?:\/\/[^\s<>"'`\]]+/gi;

/**
 * Punctuation characters that are almost always prose, not part of the URL,
 * when they appear at the end of a match. Examples:
 *   "see https://example.com." → trim the dot
 *   "(https://example.com)"    → trim the close paren
 *   "[docs](https://x.com)"    → trim the close paren
 */
const TRAILING_PUNCT = new Set([
    '.', ',', ')', ']', ';', "'", '"', '!', '?', ':',
]);

// ── Public API ───────────────────────────────────────

/**
 * Extract http(s) URLs from arbitrary text.
 *
 * @param text Arbitrary string (may be empty, may contain markdown).
 * @returns Deduplicated, order-preserving list of URL strings.
 */
export function extractUrls(text: string): readonly string[] {
    if (text.length === 0) return [];

    const seen = new Set<string>();
    const results: string[] = [];

    const matches = text.match(URL_REGEX);
    if (matches === null) return [];

    for (const raw of matches) {
        const cleaned = stripTrailingPunctuation(raw);
        if (cleaned.length === 0) continue;
        if (seen.has(cleaned)) continue;
        seen.add(cleaned);
        results.push(cleaned);
    }

    return results;
}

// ── Helpers ──────────────────────────────────────────

function stripTrailingPunctuation(url: string): string {
    let end = url.length;
    while (end > 0 && TRAILING_PUNCT.has(url.charAt(end - 1))) {
        end -= 1;
    }
    return url.slice(0, end);
}
