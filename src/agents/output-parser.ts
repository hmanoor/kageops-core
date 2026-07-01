/**
 * KageOps Output Parser
 *
 * Parses AI-generated output into structured file blocks.
 * Used by all agents that produce file output. Includes path
 * validation to prevent path traversal attacks.
 */

import * as path from 'path';
import { createLogger } from '../shared/logger';

const log = createLogger('OutputParser');

// ── Types ────────────────────────────────────────────

export interface FileBlock {
    readonly filePath: string;
    readonly content: string;
}

// ── Constants ────────────────────────────────────────

/**
 * Regex pattern to extract file blocks from AI output.
 * Format:
 *   --- FILE: path/to/file.ts ---
 *   [file content]
 *   --- END FILE ---
 *
 * Also handles consecutive FILE markers without explicit END FILE.
 */
const FILE_BLOCK_PATTERN = /--- FILE: (.+?) ---\n([\s\S]*?)(?=--- (?:FILE: |END FILE )|$)/g;

// ── Markdown Fence Stripping ────────────────────────

/**
 * Strip markdown code fences from file content.
 *
 * AI models often wrap code in ```lang ... ``` blocks. Two cases exist
 * in the wild:
 *
 *   1. The whole content is one fenced block — handled by the full-wrap
 *      regex below (fast path, preserves content exactly).
 *   2. The model only opens a fence and never closes it (the
 *      2026-04-22 GreenThumb CSS shipped this way — a leading ```css
 *      with no trailing ``` , which breaks every CSS parser). The
 *      full-wrap regex didn't match so the fence survived into the
 *      written file. We now strip any line whose entire non-whitespace
 *      content is a bare markdown fence, so partial / stray fences
 *      don't leak into artifacts.
 *
 * Intentional trade-off: a source file that has a line starting with
 * exactly ` ``` ` outside a string would lose that line. CSS/JS/HTML
 * don't allow that syntactically, so the risk in our domain is zero.
 */
export function stripMarkdownFences(content: string): string {
    const trimmed = content.trim();

    // Case 1 — full wrap: strip and return the inner block untouched.
    const fenceMatch = trimmed.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);
    if (fenceMatch !== null) {
        return fenceMatch[1].trim();
    }

    // Case 2 — stray fence at the boundary only. Strip an unmatched
    // leading or trailing fence line; never touch fences in the
    // middle, since README.md and other markdown artifacts legitimately
    // embed fenced code blocks. The GreenThumb failure was a leading
    // ` ```css ` with no closing fence — that's exactly what this
    // catches.
    const lines = trimmed.split(/\r?\n/);
    const fenceLine = /^\s*```[a-zA-Z0-9_-]*\s*$/;
    const firstIsFence = lines.length > 0 && fenceLine.test(lines[0]);
    const lastIsFence = lines.length > 0 && fenceLine.test(lines[lines.length - 1]);

    if (firstIsFence && lastIsFence && lines.length >= 2) {
        // Both ends fenced but the full-wrap regex didn't match — usually
        // a whitespace quirk on the closing fence. Treat as full wrap.
        return lines.slice(1, -1).join('\n').trim();
    }
    if (firstIsFence) return lines.slice(1).join('\n').trim();
    if (lastIsFence) return lines.slice(0, -1).join('\n').trim();

    return trimmed;
}

// ── Output sanitization (defense-in-depth beyond fence stripping) ─

/**
 * Extensions treated as "code-ish" — smart quotes and non-breaking
 * spaces break parsers in these files, so we normalize them. Markdown,
 * plain text, and HTML are intentionally excluded: smart quotes are
 * legitimate typography there, and HTML tolerates them in body content.
 */
const CODE_FILE_EXTENSIONS = new Set([
    '.js', '.mjs', '.cjs', '.jsx',
    '.ts', '.tsx',
    '.json',
    '.css', '.scss', '.sass', '.less',
    '.py',
    '.sh', '.bash', '.zsh', '.ps1',
    '.rb', '.go', '.rs',
    '.java', '.kt', '.swift',
    '.c', '.cc', '.cpp', '.h', '.hpp',
    '.yaml', '.yml', '.toml',
    '.sql',
]);

/**
 * Strip a leading UTF-8 BOM (U+FEFF). Breaks `JSON.parse`, some strict
 * HTML parsers, and shebang resolution in shell scripts.
 */
export function stripBom(content: string): string {
    return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
}

/**
 * Remove zero-width characters anywhere in the content:
 *   U+200B  zero-width space
 *   U+200C  zero-width non-joiner
 *   U+200D  zero-width joiner
 *   U+FEFF  BOM / zero-width no-break space
 *
 * These are invisible on every terminal and editor, and AI models
 * occasionally emit them mid-token. The resulting file "looks fine"
 * but silently breaks the next parser that sees it.
 */
export function stripZeroWidth(content: string): string {
    return content.replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/**
 * Replace curly quotes with straight equivalents. AI models sometimes
 * emit ` “hello” ` or ` ’s ` inside code — which JS, CSS, and JSON
 * all reject. Markdown and plain text are excluded from this transform.
 */
export function normalizeSmartQuotes(content: string): string {
    return content
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"');
}

/**
 * Replace non-breaking spaces (U+00A0) with regular spaces. NBSPs
 * look identical to spaces but aren't whitespace to most parsers —
 * Python in particular raises IndentationError when one lands inside
 * leading indentation.
 */
export function normalizeNbsp(content: string): string {
    return content.replace(/\u00A0/g, ' ');
}

/**
 * Full output-hygiene pipeline for AI-written file content.
 *
 * Runs in order:
 *   1. stripBom             (always — BOM breaks JSON + shebangs)
 *   2. stripMarkdownFences  (always — handles the GreenThumb class)
 *   3. stripZeroWidth       (always — invisible garbage)
 *   4. normalizeNbsp        (code files only)
 *   5. normalizeSmartQuotes (code files only)
 *
 * Every transform is idempotent, so calling this multiple times on
 * the same content is a no-op after the first pass. Callers that
 * already cleaned content (e.g. via parseFileBlocks) pay only the
 * regex-scan cost on the second call.
 *
 * This is the single choke point for agent-written files —
 * AutonautAgent.writeFile routes every write through it.
 */
export function sanitizeAgentOutput(content: string, filePath: string): string {
    let out = stripBom(content);
    out = stripMarkdownFences(out);
    out = stripZeroWidth(out);

    const ext = path.extname(filePath).toLowerCase();
    if (CODE_FILE_EXTENSIONS.has(ext)) {
        out = normalizeNbsp(out);
        out = normalizeSmartQuotes(out);
    }

    return out;
}

/**
 * BPF-9: sanitize a generated `package.json` so weak (OSS/budget) models can't
 * make it un-installable. Their classic mistake is adding TypeScript **path
 * aliases** (`@/components`, `@/lib`, `@/app`) — or otherwise illegal names — to
 * `dependencies`, which `npm install` rejects with `EINVALIDPACKAGENAME`,
 * failing the whole build gate. Drop any dependency key that isn't a valid npm
 * package name across all dependency fields; keep the valid ones untouched.
 *
 * Pure + conservative: non-JSON or non-object content is returned verbatim
 * (never corrupt a file we can't parse), and the JSON is only re-serialized when
 * something was actually stripped. Valid `@scope/name`, plain names, and any
 * version range (incl. `*`) are preserved.
 */
export function sanitizePackageJson(content: string): string {
    let pkg: unknown;
    try {
        pkg = JSON.parse(content);
    } catch {
        return content; // not valid JSON — leave it alone
    }
    if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) return content;

    const obj = pkg as Record<string, unknown>;
    const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    const dropped: string[] = [];

    for (const field of DEP_FIELDS) {
        const deps = obj[field];
        if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) continue;
        const cleaned: Record<string, unknown> = {};
        for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
            if (isValidNpmPackageName(name)) {
                cleaned[name] = version;
            } else {
                dropped.push(name);
            }
        }
        obj[field] = cleaned;
    }

    if (dropped.length === 0) return content;
    log.warn({ dropped }, 'BPF-9: stripped invalid dependency names from package.json (path aliases / illegal names)');
    return JSON.stringify(obj, null, 2) + '\n';
}

/** npm package-name rules: optional lowercase @scope/, then a lowercase name. */
const VALID_NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function isValidNpmPackageName(name: string): boolean {
    if (name.length === 0 || name.length > 214) return false;
    // Explicitly reject TS path aliases (`@/x`) — `@/` has no scope segment.
    if (name.startsWith('@/')) return false;
    return VALID_NPM_PACKAGE_NAME.test(name);
}

// ── Parser ───────────────────────────────────────────

// ── F-390 — Content-shape validation (PR: Forge stub-prose guard) ─

/**
 * Decide whether `content` looks like a real artifact written to
 * `filePath`, vs. a chat-style summary or file-description prose that
 * an AI model emitted by mistake.
 *
 * **Why this exists.** 2026-05-21 #165 stage 2 smoke surfaced Forge's
 * IMPROVE-phase consolidated task writing 1-3 line file-description
 * prose into `.ts`/`.tsx` files (e.g. `backend/src/index.ts` =
 * `"Express app with createApp() factory; Map<id,Vehicle> state; ..."`).
 * The decomposer's allowlist worked, the file count looked right, the
 * verifier said pass — but the artifacts were stubs. F-390 fixes the
 * write side; F-391 fixes the verifier side. This function is the
 * shared content-shape oracle both sides use.
 *
 * **Heuristic per extension.**
 * - `.html` / `.htm` — must contain a real tag in the first 500 chars
 * - `.css` — must contain `{`, `}`, an at-rule, or a custom-property
 * - `.js` / `.ts` / `.jsx` / `.tsx` — must contain one of
 *   `function`, `const`, `let`, `var`, `class`, `import`, `export`,
 *   `=>` somewhere. Prose like "MapContainer (OSM tiles…)" lacks all
 *   of these and is correctly rejected. A bare call statement like
 *   `createRoot('#root').render(<App />)` would also be rejected,
 *   which is intentional — entry files should at minimum import the
 *   thing they're calling, so a tokenless `.tsx` is itself suspect.
 * - `.json` — must start with `{` or `[`
 * - `.md` — must contain a markdown structural marker OR be > 200 chars
 *   (prose IS the artifact for Markdown — only obvious chat summaries
 *   are rejected)
 *
 * False negatives (real content rejected) cause an operator-visible
 * task failure with the file path + content preview in the log; the
 * operator can edit the prompt or retry. False positives (prose
 * accepted) cause silent corruption — which is what F-390 catches.
 * The trade-off is intentional: prefer to fail loud.
 *
 * Renamed from the private `looksLikeArtifactContent` in
 * `autonaut-agent.ts`. Same algorithm, now reachable by every caller
 * (writeOutputFiles per-block, BuildVerificationGate per F-391).
 */
export function isLikelyArtifactContent(content: string, expectedPath: string): boolean {
    // Normalize invisible garbage + line endings BEFORE any line-shape
    // inspection. AI models emit BOMs / zero-width chars mid-token and
    // mixed CRLF/LF, both of which would skew the first-line and
    // ratio heuristics below.
    const normalized = stripZeroWidth(stripBom(content)).replace(/\r\n/g, '\n');
    const trimmed = normalized.trim();
    if (trimmed.length === 0) return false;

    const lower = expectedPath.toLowerCase();
    const isProseArtifact = lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt') || lower.endsWith('.rst');

    // ── Chat-summary lead gate (ALL files, prose included) ───────
    // The 2026-06 root `app/(auth)/login/page.tsx` leaked
    // "All 6 test files written. Summary of what was created:" + a table.
    // These chat-summary leads are never a real artifact — not even in a
    // Markdown doc — so reject them for every file type up front.
    if (startsWithChatSummary(trimmed)) {
        return false;
    }

    // ── No-op-note gate (BPF-38, ALL files) ──────────────────────
    // "_(file already exists — content shown above)_" is a no-op note, not an
    // artifact. `_(...)_` mimics a JS call so the code-line heuristic below
    // would accept it; reject it up front for every file type.
    if (startsWithNoOpNote(trimmed)) {
        return false;
    }

    // ── Reasoning-lead gate (code + structured files only) ───────
    // The 374-line layout.tsx leak opened "Let me read them all
    // systematically. ...". For CODE and structured files the first
    // meaningful line is never reasoning narration, so reject these
    // leads here. Prose artifacts (.md/.txt) legitimately open with
    // "Here is the strategy:" / "Looking at the data, ..." so the
    // reasoning list is NOT applied to them.
    if (!isProseArtifact && startsWithReasoning(trimmed)) {
        return false;
    }

    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
        const head = trimmed.slice(0, 500);
        return /<\s*(html|head|body|div|section|nav|main|header|footer|h[1-6]|p|a|script|link|meta|!doctype)\b/i.test(head);
    }
    if (lower.endsWith('.css')) {
        return /\{|\}|@import|@media|@font-face|--[a-z]/i.test(trimmed);
    }
    if (
        lower.endsWith('.js') || lower.endsWith('.ts') || lower.endsWith('.tsx') ||
        lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')
    ) {
        // Hole-A fix: don't trust a keyword found ANYWHERE — leaked
        // monologues quote real code snippets. Require the FIRST
        // meaningful line to be code-shaped AND reject when the head of
        // the file reads as prose (sentences, few code punctuators).
        const firstMeaningful = firstMeaningfulCodeLine(trimmed);
        if (firstMeaningful === null) return false;
        if (!looksLikeCodeLine(firstMeaningful)) return false;
        if (isMostlyProse(trimmed)) return false;
        return true;
    }
    if (lower.endsWith('.json')) {
        const head = trimmed.slice(0, 5);
        return head.startsWith('{') || head.startsWith('[');
    }
    if (lower.endsWith('.md')) {
        // Prose IS the artifact for Markdown — only reject obvious
        // chat-summary leads (caught by startsWithNarration above).
        if (/^(#|\*|-|\d+\.|>|`)/m.test(trimmed)) return true;
        return trimmed.length > 200;
    }
    if (lower.endsWith('.py')) {
        const firstMeaningful = firstMeaningfulCodeLine(trimmed);
        if (firstMeaningful === null) return false;
        return /\b(def |class |import |from |if |for |while |return |with |async )/.test(firstMeaningful) ||
            /[=:]/.test(firstMeaningful) || /^@/.test(firstMeaningful);
    }
    if (lower.endsWith('.go')) {
        return /\b(package |import |func |type |var |const )/.test(trimmed);
    }
    if (lower.endsWith('.rs')) {
        return /\b(fn |use |mod |struct |enum |impl |let |pub |const )/.test(trimmed);
    }
    if (lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml')) {
        return /:/.test(trimmed) || /=/.test(trimmed);
    }
    if (lower.endsWith('.sql')) {
        return /\b(CREATE|SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|WITH)\b/i.test(trimmed);
    }

    // Unknown suffix — narration already rejected above; only obvious
    // chat-summary leads remain. Most legitimate "docs/X" / "README"-
    // style writes land here, so we keep the gate loose.
    const firstLine = trimmed.split(/\n/, 1)[0].toLowerCase();
    const chatLeads = [
        'done.',
        'all ',
        'here is',
        'here are',
        'context gathered',
        'reviewed ',
        'poc landing',
        '--- design brief',
        'design brief',
        'looks good',
        'task complete',
    ];
    return !chatLeads.some((lead) => firstLine.startsWith(lead));
}

/**
 * BPF-4: recover an artifact from output that begins with a narration
 * preamble. Non-premium models (Haiku, qwen-coder, kimi) routinely prepend
 * a conversational lead — "I'll analyze the workspace first, then implement…",
 * "Let me…", or a fenced ```` ```tsx ```` block — BEFORE the real file body.
 * `isLikelyArtifactContent` correctly rejects the whole thing (first line is
 * narration), which then fails the task and stalls the run. The model's real
 * artifact is usually right there after the preamble, so recover it instead of
 * throwing it away.
 *
 * Returns the recovered body, or `null` when there's nothing safely
 * recoverable. CONSERVATIVE by design:
 *   - returns `null` if the content is already a valid artifact (no-op),
 *   - never touches prose artifacts (`.md/.txt/…` — prose IS the content),
 *   - prefers an explicitly fenced block (the model delimited it itself),
 *   - otherwise strips only a MINORITY leading prose preamble down to the
 *     first code-shaped line (won't salvage a few code lines from a giant
 *     monologue), and
 *   - only returns a candidate that itself PASSES `isLikelyArtifactContent`
 *     (self-guards against chat-summaries and mostly-prose, which still fail).
 */
export function recoverArtifactFromNarration(content: string, expectedPath: string): string | null {
    if (isLikelyArtifactContent(content, expectedPath)) return null;

    const lower = expectedPath.toLowerCase();
    const isProseArtifact =
        lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt') || lower.endsWith('.rst');
    if (isProseArtifact) return null;

    const normalized = stripZeroWidth(stripBom(content)).replace(/\r\n/g, '\n');

    // 1. Prefer an explicitly fenced block — the model delimited the artifact.
    const fenced = firstFencedBlockBody(normalized);
    if (fenced !== null && fenced.trim().length > 0 && isLikelyArtifactContent(fenced, expectedPath)) {
        return fenced;
    }

    // 2. Strip a leading prose preamble down to the first code-shaped line.
    const stripped = stripLeadingProsePreamble(normalized);
    if (stripped !== null && isLikelyArtifactContent(stripped, expectedPath)) {
        return stripped;
    }

    return null;
}

/** First fenced ```` ```lang … ``` ```` block body, or null. */
function firstFencedBlockBody(normalized: string): string | null {
    const m = normalized.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```/);
    return m !== null ? m[1] : null;
}

/**
 * Drop leading lines until the first code-shaped line and return the
 * remainder. Returns null when there's no code line, when code is already the
 * first meaningful line (the rejection wasn't a preamble), or when the
 * stripped preamble is not a clear minority (>600 chars, or ≥ the body) — the
 * latter guards against salvaging a code tail from a long monologue.
 */
function stripLeadingProsePreamble(normalized: string): string | null {
    const lines = normalized.split('\n');
    let codeIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length === 0) continue;
        if (FENCE_LINE.test(line)) continue;
        if (looksLikeCodeLine(line)) {
            codeIdx = i;
            break;
        }
    }
    if (codeIdx <= 0) return null;

    const preamble = lines.slice(0, codeIdx).join('\n');
    const body = lines.slice(codeIdx).join('\n');
    if (body.trim().length === 0) return null;
    if (preamble.length > 600) return null;
    if (preamble.length >= body.length) return null;
    return body;
}

// ── isLikelyArtifactContent helpers (2026-06 narration-leak guard) ─

/**
 * Reasoning-lead phrases an AI model uses when it spills its internal
 * monologue into a file body. Applied ONLY to code + structured files —
 * for those, the first meaningful line is never a sentence of reasoning.
 * Prose artifacts (.md/.txt) legitimately open with several of these
 * ("Here is the plan:", "Looking at the data, ...") and are exempt.
 *
 * Driven by the 2026-06 Next.js boot failure: 374 lines of monologue
 * starting "Let me read them all systematically. ... Actually, I need to
 * just read the files." landed in `layout.tsx` and 500'd every route.
 */
const REASONING_LEADS: readonly string[] = [
    'let me ',
    "let's ",
    'actually,',
    'actually i',
    'i need to',
    "i'll ",
    'i have ',
    "i've ",
    'i should',
    'i realize',
    'i realise',
    'i think',
    'i want',
    'i can ',
    'wait,',
    'hmm',
    'okay,',
    'ok,',
    'looking at',
    'given the',
    'here is',
    'here are',
    'first, ',
    'now i',
    'so i',
    'reviewed ',
    'context gathered',
] as const;

/**
 * Chat-SUMMARY leads — the model narrating what it just produced. These
 * are never a real artifact for ANY file type, Markdown included (the
 * 2026-06 root `app/(auth)/login/page.tsx` leaked
 * "All 6 test files written. Summary of what was created:" + a table).
 */
const CHAT_SUMMARY_LEADS: readonly string[] = [
    'summary of what',
    'summary of the',
    'summary of changes',
    'done.',
    'all done',
    'task complete',
    'here is a summary',
    "here's a summary",
    'i have created',
    "i've created",
    'i have written',
    "i've written",
    'i have implemented',
    "i've implemented",
    'files created',
    'files written',
] as const;

/**
 * "all <n> ... written/created" chat-summary lead, e.g. "All 6 test
 * files written" / "All three components created". The literal "all "
 * lead alone is too broad (CSS can open "all: unset;"), so we require a
 * count + a creation verb.
 */
const ALL_N_WRITTEN = /^all\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b.*\b(written|created|added|done|implemented|complete)\b/i;

/**
 * "No-op note" leads (BPF-38) — the model reporting it did NOT emit content
 * because the file already exists / needs no changes, INSTEAD of emitting the
 * file body. claude-cli does this when it reads a file, decides it's fine, and
 * returns a note like `_(file already exists — full content shown above)_`.
 * Written verbatim, that note OVERWRITES the real artifact (this corrupted 3
 * Prism test files). It's never a valid artifact for any file type. The
 * leading markdown emphasis / parens that disguise it as code (`_(...)_`,
 * `**…**`) are stripped before matching.
 */
const NO_OP_NOTE_LEADS: readonly string[] = [
    'file already exists',
    'already exists',
    'already created',
    'already written',
    'no changes needed',
    'no changes required',
    'no change needed',
    'no edits needed',
    'content shown',
    'content is shown',
    'shown above',
    'full content shown',
    'left as is',
    'left as-is',
    'kept as is',
    'kept as-is',
];

function startsWithNoOpNote(trimmed: string): boolean {
    const first = firstMeaningfulProseLine(trimmed);
    if (first === null) return false;
    const stripped = first.replace(/^[\s_*`(>#-]+/, '').toLowerCase();
    return NO_OP_NOTE_LEADS.some((lead) => stripped.startsWith(lead));
}

/**
 * BPF-38: is this content a model "no-op note" (e.g. "file already exists, no
 * changes") rather than a real file body? Exposed so the write path can skip
 * the write and PRESERVE the existing file instead of clobbering it.
 */
export function isNoOpFileNote(content: string): boolean {
    const trimmed = stripZeroWidth(stripBom(content)).replace(/\r\n/g, '\n').trim();
    if (trimmed.length === 0) return false;
    return startsWithNoOpNote(trimmed);
}

/**
 * True when the first meaningful line is a chat summary. Markdown-aware:
 * a leading `#` heading is treated as content (a `# Summary of what was
 * created` heading still rejects), not skipped like a code comment.
 */
function startsWithChatSummary(trimmed: string): boolean {
    const first = firstMeaningfulProseLine(trimmed);
    if (first === null) return false;
    const lower = first.replace(/^#+\s*/, '').toLowerCase();
    if (CHAT_SUMMARY_LEADS.some((lead) => lower.startsWith(lead))) return true;
    if (ALL_N_WRITTEN.test(first.replace(/^#+\s*/, ''))) return true;
    return false;
}

/**
 * True when the first meaningful line opens with reasoning narration.
 * For code/structured files only. Skips blanks, fences, and a single
 * leading line-comment so a `// note` or fenced lead can't mask the prose.
 */
function startsWithReasoning(trimmed: string): boolean {
    const first = firstMeaningfulLine(trimmed);
    if (first === null) return false;
    const lower = first.toLowerCase();
    return REASONING_LEADS.some((lead) => lower.startsWith(lead));
}

/**
 * First non-blank, non-fence line WITHOUT skipping comments — used for
 * the prose/markdown chat-summary check where `#` and `//` are content.
 */
function firstMeaningfulProseLine(trimmed: string): string | null {
    for (const raw of trimmed.split('\n')) {
        const line = raw.trim();
        if (line.length === 0) continue;
        if (FENCE_LINE.test(line)) continue;
        return line;
    }
    return null;
}

const FENCE_LINE = /^\s*```[a-zA-Z0-9_-]*\s*$/;

/**
 * First non-blank, non-fence line, skipping at most one leading
 * line-comment (`//` or `#`). Returns the trimmed line, or null when the
 * content is only blanks/fences.
 */
function firstMeaningfulLine(trimmed: string): string | null {
    const lines = trimmed.split('\n');
    let skippedComment = false;
    for (const raw of lines) {
        const line = raw.trim();
        if (line.length === 0) continue;
        if (FENCE_LINE.test(line)) continue;
        if (!skippedComment && (line.startsWith('//') || line.startsWith('#'))) {
            skippedComment = true;
            continue;
        }
        return line;
    }
    return null;
}

/**
 * First meaningful line for code-shape checks. Same as
 * firstMeaningfulLine but also skips block-comment opener/`*` lines so a
 * leading JSDoc banner doesn't get mistaken for the artifact's first line.
 */
function firstMeaningfulCodeLine(trimmed: string): string | null {
    const lines = trimmed.split('\n');
    let inBlockComment = false;
    let skippedLineComment = false;
    for (const raw of lines) {
        const line = raw.trim();
        if (line.length === 0) continue;
        if (FENCE_LINE.test(line)) continue;
        if (inBlockComment) {
            if (line.includes('*/')) {
                inBlockComment = false;
                const after = line.slice(line.indexOf('*/') + 2).trim();
                if (after.length > 0) return after;
            }
            continue;
        }
        if (line.startsWith('/*')) {
            if (!line.includes('*/')) inBlockComment = true;
            else {
                const after = line.slice(line.indexOf('*/') + 2).trim();
                if (after.length > 0) return after;
            }
            continue;
        }
        if (line.startsWith('*')) continue; // inside a JSDoc banner body
        if (!skippedLineComment && line.startsWith('//')) {
            skippedLineComment = true;
            continue;
        }
        return line;
    }
    return null;
}

/**
 * Does this single line look like a line of source code (vs. a sentence
 * of prose)? Code lines carry one of the JS/TS structural keywords, a
 * code punctuator at the boundary (`{ } ; ( ) = < >`), or a JSX/HTML tag
 * open. Prose lines are bare words ending in `.`/`?`/`:`.
 */
function looksLikeCodeLine(line: string): boolean {
    if (/^(import|export|const|let|var|function|class|interface|type|enum|async|await|return|if|for|while|switch|case|default|new|throw|try|catch|public|private|protected|declare|module|namespace)\b/.test(line)) {
        return true;
    }
    if (/^[@<{}[\]()]/.test(line)) return true; // decorator, JSX, object/array/paren open
    if (/^['"`]use (client|server|strict)['"`]/.test(line)) return true; // directive prologue
    if (/=>|===|!==|\)\s*\{/.test(line)) return true; // arrow / strict-eq / call-block
    if (/^[\w.$]+\s*\(/.test(line) && line.includes(')')) return true; // a call statement
    if (/^[\w.$[\]]+\s*=[^=]/.test(line)) return true; // an assignment

    // A line ending in a statement/block punctuator counts as code only
    // when it ALSO carries real code structure (assignment, call, member
    // access, or no spaces). Semicolon-separated PROSE — "Express app
    // with createApp() factory; Map<id> state; Zod validation;" — looks
    // like a sentence list, not a statement, and must be rejected.
    if (/[;{}]\s*$/.test(line)) {
        const hasCodeStructure = /[=(){}[\]<>]|=>|\.\w/.test(line.replace(/;\s*$/, ''));
        const wordCount = (line.match(/\b[a-zA-Z]{2,}\b/g) ?? []).length;
        const looksSententialList = wordCount >= 6 && /\b(with|and|the|for|of|a|an|to|on|per)\b/i.test(line);
        return hasCodeStructure && !looksSententialList;
    }
    return false;
}

/**
 * Prose-to-code ratio heuristic for .ts/.tsx-class files. Inspect the
 * first ~40 lines: if most non-blank lines read as sentences (end in
 * `.`/`?`) and the head contains very few code punctuators
 * (`; { } =>`), it's narration regardless of a stray keyword.
 */
function isMostlyProse(trimmed: string): boolean {
    const head = trimmed.split('\n', 40).map((l) => l.trim()).filter((l) => l.length > 0 && !FENCE_LINE.test(l));
    if (head.length === 0) return false;

    const sentenceLines = head.filter((l) => /[.?]$/.test(l) && !/[;{})]$/.test(l)).length;
    const punctuators = (trimmed.slice(0, 4000).match(/[;{}]|=>/g) ?? []).length;

    // Mostly sentence-shaped lines + almost no code punctuation ⇒ prose.
    const proseRatio = sentenceLines / head.length;
    return proseRatio >= 0.5 && punctuators <= 2;
}

/**
 * Parse AI output into file blocks.
 * Returns empty array when no file blocks are found (never throws).
 */
export function parseFileBlocks(aiOutput: string): readonly FileBlock[] {
    const blocks: FileBlock[] = [];

    // Reset regex state (global regex retains lastIndex)
    FILE_BLOCK_PATTERN.lastIndex = 0;

    let match;
    while ((match = FILE_BLOCK_PATTERN.exec(aiOutput)) !== null) {
        const rawPath = match[1].trim();
        const rawContent = match[2].trim();

        // Skip empty paths or content
        if (rawPath.length === 0 || rawContent.length === 0) {
            continue;
        }

        // Validate the file path
        if (!isValidFilePath(rawPath)) {
            log.warn({ rawPath }, 'Rejected unsafe file path');
            continue;
        }

        // Strip markdown code fences that AI models wrap around file content
        const content = stripMarkdownFences(rawContent);
        blocks.push({ filePath: rawPath, content });
    }

    return blocks;
}

/**
 * Validate a file path for safety.
 * Rejects path traversal, absolute paths, null bytes, and other dangers.
 */
export function isValidFilePath(filePath: string): boolean {
    // Reject null bytes
    if (filePath.includes('\0')) {
        return false;
    }

    // Reject absolute paths (Unix or Windows)
    if (path.isAbsolute(filePath)) {
        return false;
    }

    // Reject path traversal
    const normalized = path.normalize(filePath);
    if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
        return false;
    }

    // Also reject explicit .. in the raw path (catches edge cases)
    if (filePath.includes('..')) {
        return false;
    }

    // Reject Windows drive letters (e.g., C:\)
    if (/^[a-zA-Z]:/.test(filePath)) {
        return false;
    }

    return true;
}
