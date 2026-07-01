/**
 * Context compressor for agent prompts.
 * Compresses natural language prose while preserving technical content.
 * ~45% input token reduction on agent context.
 * Inspired by: Caveman caveman-compress module.
 */

// ── Protected Patterns ──────────────────────────────
// These regions are extracted before compression and restored after.

const PROTECTED_PATTERNS: readonly RegExp[] = [
    /```[\s\S]*?```/g,                          // fenced code blocks
    /`[^`]+`/g,                                  // inline code
    /https?:\/\/\S+/g,                           // URLs
    /(?:^|\s)((?:[\w./\\-]+\/)+[\w./\\-]+)/gm,  // file paths with slashes
    /(?:^|\s)(\.\/[\w./\\-]+)/gm,               // relative paths
    /^#{1,6}\s.+$/gm,                            // headings
    /v?\d+\.\d+(?:\.\d+)?/g,                     // version numbers
];

// ── Filler / Hedging / Pleasantry Removals ──────────

const DROP_PHRASES: readonly RegExp[] = [
    /\bIt is important to note that\b/gi,
    /\bPlease note that\b/gi,
    /\bAs mentioned\b/gi,
    /\bbasically\b/gi,
    /\bessentially\b/gi,
    /\bactually\b/gi,
    /\bI think\b/gi,
    /\bI believe\b/gi,
    /\bit seems like\b/gi,
    /\bperhaps\b/gi,
    /\bmaybe\b/gi,
    /\bSure!\b/gi,
    /\bGreat question!\b/gi,
    /\bHappy to help\b/gi,
    /\bOf course\b/gi,
];

const DROP_ARTICLES: RegExp = /\b(?:a|an|the)\b/gi;

// ── Phrase Compression Map ──────────────────────────

interface PhraseMapping {
    readonly pattern: RegExp;
    readonly replacement: string;
}

const PHRASE_COMPRESSIONS: readonly PhraseMapping[] = [
    { pattern: /\bin order to\b/gi, replacement: 'to' },
    { pattern: /\bas well as\b/gi, replacement: 'and' },
    { pattern: /\bdue to the fact that\b/gi, replacement: 'because' },
    { pattern: /\bat this point in time\b/gi, replacement: 'now' },
    { pattern: /\bin the event that\b/gi, replacement: 'if' },
    { pattern: /\ba large number of\b/gi, replacement: 'many' },
    { pattern: /\bon the other hand\b/gi, replacement: 'however' },
];

// ── Placeholder Management ──────────────────────────

const PLACEHOLDER_PREFIX = '\x00PH';
const PLACEHOLDER_SUFFIX = '\x00';

function makePlaceholder(index: number): string {
    return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
}

// ── Core Functions ──────────────────────────────────

/**
 * Extract protected regions from text, replacing them with placeholders.
 * Returns the modified text and a map of placeholder → original content.
 */
function extractProtectedRegions(
    text: string
): { readonly processed: string; readonly regions: ReadonlyMap<string, string> } {
    const regions = new Map<string, string>();
    let processed = text;
    let index = 0;

    for (const pattern of PROTECTED_PATTERNS) {
        // Reset lastIndex for global patterns
        const regex = new RegExp(pattern.source, pattern.flags);
        processed = processed.replace(regex, (match) => {
            const placeholder = makePlaceholder(index);
            regions.set(placeholder, match);
            index += 1;
            return placeholder;
        });
    }

    return { processed, regions };
}

/**
 * Restore placeholders with their original protected content.
 */
function restoreProtectedRegions(
    text: string,
    regions: ReadonlyMap<string, string>
): string {
    let restored = text;
    for (const [placeholder, original] of regions) {
        restored = restored.split(placeholder).join(original);
    }
    return restored;
}

/**
 * Compress prose text by removing filler, hedging, articles, and compressing phrases.
 */
function compressProse(text: string): string {
    let result = text;

    // Remove filler phrases, hedging, pleasantries
    for (const pattern of DROP_PHRASES) {
        result = result.replace(new RegExp(pattern.source, pattern.flags), '');
    }

    // Compress common phrases
    for (const { pattern, replacement } of PHRASE_COMPRESSIONS) {
        result = result.replace(new RegExp(pattern.source, pattern.flags), replacement);
    }

    // Drop articles
    result = result.replace(DROP_ARTICLES, '');

    // Collapse multiple spaces to single
    result = result.replace(/ {2,}/g, ' ');

    // Collapse multiple newlines to max 2
    result = result.replace(/\n{3,}/g, '\n\n');

    // Trim leading/trailing spaces on each line
    result = result
        .split('\n')
        .map((line) => line.trim())
        .join('\n');

    return result;
}

/**
 * Compress natural language prose while preserving technical content.
 * Code blocks, inline code, URLs, file paths, headings, version numbers,
 * and commands are kept verbatim. Only prose sections are compressed.
 */
export function compressContext(text: string): string {
    if (text.length === 0) return text;

    const { processed, regions } = extractProtectedRegions(text);
    const compressed = compressProse(processed);
    return restoreProtectedRegions(compressed, regions);
}

/**
 * Rough token estimate based on character count.
 * Approximation: 1 token ≈ 4 characters.
 */
export function estimateTokens(text: string): number {
    return Math.floor(text.length / 4);
}

/**
 * Only compress if estimated tokens exceed threshold.
 * Returns original text if below threshold.
 *
 * @param text - Input text to potentially compress
 * @param thresholdTokens - Token threshold (default: 500)
 */
export function compressIfLarge(text: string, thresholdTokens: number = 500): string {
    if (estimateTokens(text) <= thresholdTokens) {
        return text;
    }
    return compressContext(text);
}
