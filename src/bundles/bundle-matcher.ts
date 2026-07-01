/**
 * P1-12 — Bundle matcher.
 *
 * Deterministic phrase-matching over a project's free-text brief
 * against bundle `match.phrases` / `match.tags` / `match.rejectPhrases`.
 *
 * Why not an LLM scorer? The original Pillar 1.3 plan called for an
 * LLM call. Deterministic-first wins in this iteration because:
 *   - Predictable: operator can read bundle.yaml and predict the pick.
 *   - Free: zero token spend on what's a one-shot decision per project.
 *   - Testable: every scoring rule is a unit-testable code path.
 *   - Reversible: an LLM fallback can be added later without re-doing
 *     the integration surface (it just becomes a tiebreaker when the
 *     deterministic score is zero or ambiguous).
 *
 * When this matcher returns null, callers leave `projects.selected_bundle`
 * NULL and the existing inline scaffold path runs (the rollback knob
 * committed to in P1-11 stays intact).
 *
 * Algorithm:
 *   - Lowercase + collapse whitespace on the input text.
 *   - For each stack bundle:
 *       1. If any `rejectPhrases` substring appears → score = 0,
 *          bundle disqualified.
 *       2. score = (# of match.phrases that appear as substrings)
 *               + 0.5 × (# of match.tags that appear as standalone
 *                 word boundaries — rejects "javascript" hitting
 *                 "ecmascript" but accepts "html" hitting "html5").
 *   - Return the bundle with the highest non-zero score. Ties:
 *     return the first bundle encountered (registry load order).
 */

import type { BundleRegistry } from './bundle-registry';
import type { LoadedBundle } from './types';

export interface BundleMatchInput {
    /** Project name + description concatenated. Free-form text. */
    readonly text: string;
    readonly registry: BundleRegistry;
}

export interface BundleMatchHit {
    readonly bundle: LoadedBundle;
    readonly score: number;
    /** The match.phrases entries that fired. */
    readonly matchedPhrases: readonly string[];
    /** The match.tags entries that fired. */
    readonly matchedTags: readonly string[];
}

/**
 * Score every stack bundle, return the best. Capabilities + deployers
 * aren't matched in P1-12 — they're claimed in Phase 2 once their
 * composition rules are pinned.
 */
export function matchBundleForBrief(input: BundleMatchInput): BundleMatchHit | null {
    const normalisedText = normalise(input.text);
    if (normalisedText.length === 0) return null;

    let best: BundleMatchHit | null = null;

    for (const bundle of input.registry.ofKind('stack')) {
        const scoreResult = scoreBundle(bundle, normalisedText);
        if (scoreResult === null) continue; // disqualified or zero score
        if (best === null || scoreResult.score > best.score) {
            best = scoreResult;
        }
    }

    return best;
}

/**
 * Build the `<kind>::<name>` key used in `projects.selected_bundle`.
 * Mirrors the parser in forge-bundle-dispatch.
 */
export function buildBundleKey(bundle: LoadedBundle): string {
    return `${bundle.manifest.kind}::${bundle.manifest.name}`;
}

// ── Internals ──

function scoreBundle(bundle: LoadedBundle, normalisedText: string): BundleMatchHit | null {
    const matchBlock = bundle.manifest.match;
    if (matchBlock === undefined) return null;

    // Reject-phrases hit → disqualified entirely.
    for (const reject of matchBlock.rejectPhrases ?? []) {
        if (normalisedText.includes(normalise(reject))) {
            return null;
        }
    }

    const matchedPhrases: string[] = [];
    for (const phrase of matchBlock.phrases ?? []) {
        if (normalisedText.includes(normalise(phrase))) {
            matchedPhrases.push(phrase);
        }
    }

    const matchedTags: string[] = [];
    for (const tag of matchBlock.tags ?? []) {
        if (containsWord(normalisedText, normalise(tag))) {
            matchedTags.push(tag);
        }
    }

    const score = matchedPhrases.length + matchedTags.length * 0.5;
    if (score === 0) return null;

    return {
        bundle,
        score,
        matchedPhrases,
        matchedTags,
    };
}

function normalise(s: string): string {
    return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Word-boundary substring check that's safe for kebab-case + dots.
 * We can't use \b directly — it splits "html5" on the 5 (wrong; we
 * want "html5" to count as containing "html"). Instead we ensure the
 * char immediately before the match is start-of-string or non-letter,
 * and the char after is end-of-string, digit, or non-alphanumeric.
 * Letters following → not a match (so "javascript" doesn't match "java").
 */
function containsWord(haystack: string, needle: string): boolean {
    if (needle.length === 0) return false;
    let idx = 0;
    while (true) {
        const hit = haystack.indexOf(needle, idx);
        if (hit === -1) return false;
        const before = hit === 0 ? '' : haystack[hit - 1] ?? '';
        const after = haystack[hit + needle.length] ?? '';
        const beforeOk = before === '' || !/[a-z]/.test(before);
        const afterOk = after === '' || !/[a-z]/.test(after);
        if (beforeOk && afterOk) return true;
        idx = hit + 1;
    }
}
