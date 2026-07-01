/**
 * Review Config — REVIEW.md Convention Support (B-214)
 *
 * Parses and applies project-level REVIEW.md files that customize
 * review behavior per project. Vigil reads this before any code review.
 */

// ── Types ────────────────────────────────────────────

export interface ReviewConfig {
    readonly alwaysCheck: readonly string[];
    readonly style: readonly string[];
    readonly skip: readonly string[];
    readonly focus: readonly string[];
    readonly maxFindings: number;
    readonly blockOnSeverity: string;
}

// ── Defaults ─────────────────────────────────────────

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
    alwaysCheck: [],
    style: [],
    skip: [],
    focus: [],
    maxFindings: 50,
    blockOnSeverity: 'critical',
};

// ── Parsing ──────────────────────────────────────────

/**
 * Extracts list items under a given heading from markdown content.
 * Returns lines that start with `- ` under the heading, until the next heading.
 */
function extractSection(lines: readonly string[], heading: string): readonly string[] {
    const headingLower = heading.toLowerCase();
    let inSection = false;
    const items: string[] = [];

    for (const line of lines) {
        if (line.startsWith('## ')) {
            inSection = line.slice(3).trim().toLowerCase() === headingLower;
            continue;
        }
        if (inSection && line.startsWith('- ')) {
            items.push(line.slice(2).trim());
        }
    }

    return items;
}

/**
 * Parses Settings section key-value pairs.
 * Expects lines like `- max_findings: 30` or `- block_on: high`.
 */
function extractSettings(lines: readonly string[]): Readonly<Record<string, string>> {
    const settingItems = extractSection(lines, 'Settings');
    const result: Record<string, string> = {};

    for (const item of settingItems) {
        const colonIndex = item.indexOf(':');
        if (colonIndex === -1) continue;
        const key = item.slice(0, colonIndex).trim();
        const value = item.slice(colonIndex + 1).trim();
        result[key] = value;
    }

    return result;
}

/**
 * Parses a REVIEW.md file into a ReviewConfig.
 *
 * Supported sections:
 * - ## Always Check   → alwaysCheck
 * - ## Style          → style
 * - ## Skip           → skip
 * - ## Focus          → focus
 * - ## Settings       → maxFindings, blockOnSeverity
 */
export function parseReviewMd(content: string): ReviewConfig {
    if (!content.trim()) {
        return DEFAULT_REVIEW_CONFIG;
    }

    const lines = content.split('\n').map(l => l.trimEnd());

    const alwaysCheck = extractSection(lines, 'Always Check');
    const style = extractSection(lines, 'Style');
    const skip = extractSection(lines, 'Skip');
    const focus = extractSection(lines, 'Focus');
    const settings = extractSettings(lines);

    const rawMax = settings['max_findings'];
    const parsedMax = rawMax !== undefined ? parseInt(rawMax, 10) : NaN;
    const maxFindings = Number.isFinite(parsedMax) ? parsedMax : DEFAULT_REVIEW_CONFIG.maxFindings;

    const blockOnSeverity = settings['block_on'] ?? DEFAULT_REVIEW_CONFIG.blockOnSeverity;

    return {
        alwaysCheck,
        style,
        skip,
        focus,
        maxFindings,
        blockOnSeverity,
    };
}

// ── Loading ──────────────────────────────────────────

/**
 * Tries to read REVIEW.md from the project root using the provided file reader.
 * Returns DEFAULT_REVIEW_CONFIG if the file is not found or cannot be read.
 *
 * @param repoPath - Absolute path to the project repository root
 * @param readFileFn - Sandboxed file reader compatible with AutonautAgent
 */
export function loadReviewConfig(
    repoPath: string,
    readFileFn: (repoPath: string, filePath: string) => string,
): ReviewConfig {
    try {
        const content = readFileFn(repoPath, 'REVIEW.md');
        return parseReviewMd(content);
    } catch {
        return DEFAULT_REVIEW_CONFIG;
    }
}

// ── File Filtering ───────────────────────────────────

/**
 * Checks if a file path matches a skip pattern.
 *
 * Supported pattern types:
 * - Exact match:        `tsconfig.json`
 * - Glob suffix:        `*.test.ts`  (matches any file ending with `.test.ts`)
 * - Directory prefix:   `dist/`      (matches any path starting with `dist/`)
 */
export function shouldSkipFile(filePath: string, skipPatterns: readonly string[]): boolean {
    return skipPatterns.some(pattern => {
        // Directory prefix match
        if (pattern.endsWith('/')) {
            return filePath.startsWith(pattern) || filePath.includes(`/${pattern.slice(0, -1)}/`);
        }

        // Glob suffix match (e.g., *.test.ts)
        if (pattern.startsWith('*.')) {
            const suffix = pattern.slice(1); // e.g., ".test.ts"
            return filePath.endsWith(suffix);
        }

        // Exact match
        return filePath === pattern || filePath.endsWith(`/${pattern}`);
    });
}

/**
 * Removes files from the list that match any skip pattern in the config.
 */
export function filterFilesByConfig(
    files: readonly string[],
    config: ReviewConfig,
): readonly string[] {
    if (config.skip.length === 0) return files;
    return files.filter(f => !shouldSkipFile(f, config.skip));
}

// ── Prompt Building ──────────────────────────────────

/**
 * Enhances a review prompt with rules from a REVIEW.md config.
 * If all config arrays are empty and settings are defaults, returns the base prompt unchanged.
 */
export function buildConfigAwarePrompt(config: ReviewConfig, basePrompt: string): string {
    const hasRules =
        config.alwaysCheck.length > 0 ||
        config.style.length > 0 ||
        config.focus.length > 0 ||
        config.maxFindings !== DEFAULT_REVIEW_CONFIG.maxFindings;

    if (!hasRules) {
        return basePrompt;
    }

    const sections: string[] = ['## Project Review Rules', ''];

    if (config.alwaysCheck.length > 0) {
        sections.push('Always check:');
        for (const rule of config.alwaysCheck) {
            sections.push(`- ${rule}`);
        }
        sections.push('');
    }

    if (config.style.length > 0) {
        sections.push('Style preferences:');
        for (const pref of config.style) {
            sections.push(`- ${pref}`);
        }
        sections.push('');
    }

    if (config.focus.length > 0) {
        sections.push('Focus areas:');
        for (const area of config.focus) {
            sections.push(`- ${area}`);
        }
        sections.push('');
    }

    sections.push(`Max findings: ${config.maxFindings}`);
    sections.push('');
    sections.push(basePrompt);

    return sections.join('\n');
}
