/**
 * KageOps Spec Rule Engine
 *
 * Deterministic rule extraction + artifact checking for AcceptanceGate.
 *
 * V1 rules (pure regex — no DOM engine required):
 *   - `id-exists` — HTML id attribute must appear
 *   - `tag-exists` — an HTML tag must appear (e.g. `<button>`)
 *   - `class-exists` — an element with a given class token must appear
 *   - `text-contains` — rendered visible text must contain a given substring
 *   - `attribute-exists` — an attribute (optionally with value) must appear
 *
 * Rules can come from two sources:
 *   (1) `parseSpec(description)` — regex extraction on the project spec string.
 *   (2) `.kageops/test-cases.json` — structured rules emitted by Scout or a human,
 *        consumed verbatim. Schema: see TestCaseFileSchema at the bottom of this file.
 *
 * The engine never executes code — HTML is checked via regex against the raw
 * string, so a future DOM engine can replace the checkers without changing the
 * rule grammar or the AcceptanceGate API.
 */

import { z } from 'zod';

// ── Rule grammar ────────────────────────────────────────

/**
 * Rule severity controls what happens on a failed check.
 *
 *   'must'   — failure blocks the acceptance gate. Default for every rule.
 *              Triggers a Forge remediation task and (after MAX_RETRIES)
 *              escalates to human approval.
 *   'should' — failure logs a warning but does NOT block. Polish-grade
 *              checks like specific copy strings or non-critical visible
 *              text. Lets a 95% page advance the phase instead of looping
 *              on a comma.
 *
 * Spec authors opt into 'should' via:
 *   - Spec text:  prefix any text directive with `SHOULD ` (e.g.
 *                 `SHOULD include text "BUDGET KILL — ..."`)
 *   - test-cases.json: add `"severity": "should"` to a rule
 *
 * Backwards compatible: undefined severity is treated as 'must'.
 */
export type RuleSeverity = 'must' | 'should';

interface SeverityField {
    readonly severity?: RuleSeverity;
}

export type SpecRule =
    | (SeverityField & { readonly kind: 'id-exists'; readonly id: string })
    | (SeverityField & { readonly kind: 'tag-exists'; readonly tag: string })
    | (SeverityField & { readonly kind: 'class-exists'; readonly className: string })
    | (SeverityField & { readonly kind: 'text-contains'; readonly text: string })
    | (SeverityField & {
        readonly kind: 'attribute-exists';
        readonly name: string;
        readonly value: string | null;
    });

/** Resolve the effective severity for a rule (default 'must'). */
export function ruleSeverity(rule: SpecRule): RuleSeverity {
    return rule.severity ?? 'must';
}

export interface RuleCheck {
    readonly passed: boolean;
    readonly rule: SpecRule;
    readonly expected: string;
    readonly message: string;
}

// ── Spec parsing (description → rules) ──────────────────

const ID_PATTERNS: readonly RegExp[] = [
    /\bid\s*=\s*"([a-zA-Z][\w-]*)"/g,
    /\bid\s*=\s*'([a-zA-Z][\w-]*)'/g,
    /<[^>]*\bid\s*=\s*([a-zA-Z][\w-]*)\b/g,
    // Wave 4 Day 1: `#shorthand` IDs (anchor-style references in spec
    // bullet lists like `  #top         — hero`). Anchored to whitespace
    // or start-of-line so we don't pick up `#define` or `#!shebang`.
    // Excludes a tiny block list of words that look like IDs but are
    // markdown/CSS chrome (#fff, #000, etc.).
    /(?:^|[\s(])#([a-zA-Z][a-zA-Z0-9_-]{1,40})(?=[\s.,;:)\-—–]|$)/gm,
];

/** Hash-prefix words that must NOT be treated as required HTML IDs. */
const SHORTHAND_ID_BLOCKLIST: ReadonlySet<string> = new Set([
    'fff', 'ffffff', '000', '000000', '141414', 'fafafa', '0a0a0a',
    'define', 'include', 'ifdef', 'ifndef', 'endif', 'pragma',
    'todo', 'fixme', 'note', 'hack', 'bug',
]);

// Backtick-wrapped HTML tag: `<button>` or `<input />` — tag name only.
const TAG_IN_BACKTICKS = /`\s*<\s*([a-zA-Z][a-zA-Z0-9]*)\s*\/?\s*>?\s*`/g;

// Backtick-wrapped CSS class selector: `.primary-button`
const CLASS_IN_BACKTICKS = /`\s*\.([a-zA-Z_][\w-]*)\s*`/g;

// Visible-text directives:
//   label "Foo" / label 'Foo'
//   labeled "Foo"
//   text: "Foo"
//   button labeled "Foo"
//   says "Foo"
//
// Each pattern has a paired SHOULD-prefixed variant. When the spec line
// begins with `SHOULD` (case-sensitive, word-boundary) the rule is
// extracted with severity='should' so a missing match logs a warning
// but does not block the acceptance gate. See RuleSeverity for rationale.
const TEXT_DIRECTIVES: readonly RegExp[] = [
    /\b(?:label(?:led|ed)?|text|says?|reads?|showing|displaying|with\s+text)\s*[:=]?\s*"([^"]{1,80})"/gi,
    /\b(?:label(?:led|ed)?|text|says?|reads?|showing|displaying|with\s+text)\s*[:=]?\s*'([^']{1,80})'/gi,
];

/**
 * Detect whether a directive match is preceded by a SHOULD marker on the
 * same line. A line starts at the previous '\n' (or 0). We look back from
 * the match position for the literal token `SHOULD` followed by whitespace,
 * not as part of a larger word.
 */
function isShouldContext(description: string, matchIndex: number): boolean {
    const lineStart = description.lastIndexOf('\n', matchIndex - 1) + 1;
    const before = description.slice(lineStart, matchIndex);
    return /\bSHOULD\b/.test(before);
}

// Backtick-wrapped attribute assertion: `data-testid="submit"` or `role=button`
const ATTR_IN_BACKTICKS = /`\s*([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^`\s"']+))\s*`/g;

/**
 * Extract spec rules from a free-text description.
 * Backwards-compatible with the original `extractRequiredIds` behavior for
 * `id-exists` rules. Additional grammars are additive.
 */
export function parseSpec(description: string): readonly SpecRule[] {
    const rules: SpecRule[] = [];

    const seenIds = new Set<string>();
    for (const pattern of ID_PATTERNS) {
        let match: RegExpExecArray | null;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(description)) !== null) {
            const id = match[1];
            if (seenIds.has(id)) continue;
            // Filter out hash-prefix tokens that aren't real HTML IDs
            // (hex colors, preprocessor directives, markdown markers).
            if (SHORTHAND_ID_BLOCKLIST.has(id.toLowerCase())) continue;
            // Hex colors masquerade as IDs (#fff, #abc123, #FFFFFF1A); skip
            // any pure-hex token of 3 / 4 / 6 / 8 chars.
            if (/^[0-9a-fA-F]{3}$/.test(id)) continue;
            if (/^[0-9a-fA-F]{4}$/.test(id)) continue;
            if (/^[0-9a-fA-F]{6}$/.test(id)) continue;
            if (/^[0-9a-fA-F]{8}$/.test(id)) continue;
            seenIds.add(id);
            rules.push({ kind: 'id-exists', id });
        }
    }

    const seenTags = new Set<string>();
    TAG_IN_BACKTICKS.lastIndex = 0;
    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = TAG_IN_BACKTICKS.exec(description)) !== null) {
        const tag = tagMatch[1].toLowerCase();
        if (!seenTags.has(tag)) {
            seenTags.add(tag);
            rules.push({ kind: 'tag-exists', tag });
        }
    }

    const seenClasses = new Set<string>();
    CLASS_IN_BACKTICKS.lastIndex = 0;
    let classMatch: RegExpExecArray | null;
    while ((classMatch = CLASS_IN_BACKTICKS.exec(description)) !== null) {
        const className = classMatch[1];
        if (!seenClasses.has(className)) {
            seenClasses.add(className);
            rules.push({ kind: 'class-exists', className });
        }
    }

    const seenTexts = new Set<string>();
    for (const pattern of TEXT_DIRECTIVES) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(description)) !== null) {
            const text = match[1].trim();
            if (text.length === 0 || seenTexts.has(text)) continue;
            seenTexts.add(text);
            // Only annotate severity when it's 'should' — leaving the
            // field undefined for the default ('must') keeps the rule
            // shape backwards-compatible with prior parseSpec callers
            // that compared against `{ kind, text }` literals.
            if (isShouldContext(description, match.index)) {
                rules.push({ kind: 'text-contains', text, severity: 'should' });
            } else {
                rules.push({ kind: 'text-contains', text });
            }
        }
    }

    const seenAttrs = new Set<string>();
    ATTR_IN_BACKTICKS.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR_IN_BACKTICKS.exec(description)) !== null) {
        const name = attrMatch[1].toLowerCase();
        const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? null;
        // Skip `id=...` and `class=...` — those are covered by other rule kinds.
        if (name === 'id' || name === 'class') continue;
        const key = value === null ? name : `${name}=${value}`;
        if (!seenAttrs.has(key)) {
            seenAttrs.add(key);
            rules.push({ kind: 'attribute-exists', name, value });
        }
    }

    return rules;
}

// ── Rule checking (rule + HTML → pass/fail) ─────────────

/**
 * Strip HTML tags + scripts + styles from a string, leaving visible text only.
 * Collapses whitespace. Case-preserving.
 */
export function stripHtml(html: string): string {
    return html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function checkIdExists(id: string, html: string): boolean {
    const pattern = new RegExp(
        `\\sid\\s*=\\s*(?:"${escapeRegex(id)}"|'${escapeRegex(id)}'|${escapeRegex(id)}\\b)`,
        'i'
    );
    return pattern.test(html);
}

function checkTagExists(tag: string, html: string): boolean {
    const pattern = new RegExp(`<${escapeRegex(tag)}\\b`, 'i');
    return pattern.test(html);
}

function checkClassExists(className: string, html: string): boolean {
    // class="foo bar baz" — token match, whitespace-separated.
    // Extract every class attribute value, split on whitespace, look for the token.
    const pattern = /\sclass\s*=\s*["']([^"']*)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
        const tokens = match[1].split(/\s+/).filter((t) => t.length > 0);
        if (tokens.includes(className)) return true;
    }
    return false;
}

function checkTextContains(text: string, html: string): boolean {
    // Normalize the search term the same way stripHtml normalizes the
    // page text — collapse any whitespace run (newline + spaces, tabs,
    // multiple spaces) into a single ASCII space. Without this, a spec
    // rule that captured a literal newline (e.g. `"FOO —\n  bar"` from
    // a paragraph wrap in the description) is structurally impossible
    // to match because stripHtml produces only single-space-separated
    // text. See landing-premium v6 BUDGET KILL multiline edge case.
    const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
    return normalize(stripHtml(html)).includes(normalize(text));
}

function checkAttributeExists(name: string, value: string | null, html: string): boolean {
    if (value === null) {
        const pattern = new RegExp(`\\s${escapeRegex(name)}\\s*=`, 'i');
        return pattern.test(html);
    }
    const pattern = new RegExp(
        `\\s${escapeRegex(name)}\\s*=\\s*(?:"${escapeRegex(value)}"|'${escapeRegex(value)}'|${escapeRegex(value)}\\b)`,
        'i'
    );
    return pattern.test(html);
}

/**
 * Check a single rule against an HTML string.
 */
export function checkRule(rule: SpecRule, html: string): RuleCheck {
    switch (rule.kind) {
        case 'id-exists': {
            const passed = checkIdExists(rule.id, html);
            return {
                passed,
                rule,
                expected: `<... id="${rule.id}">`,
                message: passed
                    ? `id="${rule.id}" present`
                    : `Spec requires <... id="${rule.id}"> but it was not found in the artifact`,
            };
        }
        case 'tag-exists': {
            const passed = checkTagExists(rule.tag, html);
            return {
                passed,
                rule,
                expected: `<${rule.tag}>`,
                message: passed
                    ? `<${rule.tag}> tag present`
                    : `Spec requires a <${rule.tag}> element but the artifact has none`,
            };
        }
        case 'class-exists': {
            const passed = checkClassExists(rule.className, html);
            return {
                passed,
                rule,
                expected: `class="${rule.className}"`,
                message: passed
                    ? `class "${rule.className}" present`
                    : `Spec requires an element with class="${rule.className}" but none was found`,
            };
        }
        case 'text-contains': {
            const passed = checkTextContains(rule.text, html);
            return {
                passed,
                rule,
                expected: `visible text "${rule.text}"`,
                message: passed
                    ? `text "${rule.text}" present`
                    : `Spec requires visible text "${rule.text}" but the artifact does not contain it`,
            };
        }
        case 'attribute-exists': {
            const passed = checkAttributeExists(rule.name, rule.value, html);
            const expected = rule.value === null
                ? `${rule.name}=`
                : `${rule.name}="${rule.value}"`;
            return {
                passed,
                rule,
                expected,
                message: passed
                    ? `attribute ${expected} present`
                    : `Spec requires attribute ${expected} but the artifact does not contain it`,
            };
        }
    }
}

/**
 * Check all rules; returns the per-rule result array in the same order.
 */
export function checkAllRules(
    rules: readonly SpecRule[],
    html: string
): readonly RuleCheck[] {
    return rules.map((rule) => checkRule(rule, html));
}

// ── Scout-provided test-cases.json schema ───────────────

const SeveritySchema = z.enum(['must', 'should']).optional();

const SpecRuleSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('id-exists'), id: z.string().min(1).max(100), severity: SeveritySchema }),
    z.object({ kind: z.literal('tag-exists'), tag: z.string().min(1).max(30), severity: SeveritySchema }),
    z.object({ kind: z.literal('class-exists'), className: z.string().min(1).max(100), severity: SeveritySchema }),
    z.object({ kind: z.literal('text-contains'), text: z.string().min(1).max(200), severity: SeveritySchema }),
    z.object({
        kind: z.literal('attribute-exists'),
        name: z.string().min(1).max(100),
        value: z.string().max(200).nullable(),
        severity: SeveritySchema,
    }),
]);

export const TestCaseFileSchema = z.object({
    version: z.literal(1),
    source: z.enum(['scout', 'manual', 'imported']).default('manual'),
    description: z.string().optional(),
    rules: z.array(SpecRuleSchema).max(100),
});

export type TestCaseFile = z.infer<typeof TestCaseFileSchema>;

/**
 * Parse + validate a Scout/manual test-cases.json payload. Returns the rules
 * or throws a ZodError on schema violation.
 */
export function loadTestCasesJson(raw: string): readonly SpecRule[] {
    const json: unknown = JSON.parse(raw);
    const parsed = TestCaseFileSchema.parse(json);
    return parsed.rules;
}

// ── Helpers ─────────────────────────────────────────────

function escapeRegex(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
