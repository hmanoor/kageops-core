/**
 * Design Brief — Structured design context for Pixel agent
 *
 * Enforces design-first thinking by generating a structured brief
 * before any UI code is produced. Anti-generic rules prevent
 * placeholder content, default aesthetics, and scope creep.
 */

// ── Types ─────────────────────────────────────────────

export interface DesignBrief {
    readonly purpose: string;
    readonly audience: string;
    readonly aesthetic: string;
    readonly constraints: readonly string[];
    readonly antiPatterns: readonly string[];
    readonly inspirations: readonly string[];
}

export interface DesignBriefResult {
    readonly brief: DesignBrief;
    readonly promptEnhancement: string;
}

// ── Constants ─────────────────────────────────────────

export const ANTI_GENERIC_RULES: readonly string[] = [
    'Do NOT use generic placeholder content (Lorem ipsum, "Click here", "Welcome to our app")',
    'Do NOT default to blue-and-white corporate aesthetic unless explicitly appropriate',
    'Do NOT add features not mentioned in the brief (no surprise chatbots, no cookie banners)',
    'Every UI element must justify its existence — if it does not serve the purpose, remove it',
    'Do NOT copy common SaaS dashboard patterns unless this IS a SaaS dashboard',
    'Do NOT use stock-photo hero sections or generic illustration styles',
    'Avoid over-engineering: simple solutions beat complex ones when they serve the same purpose',
    'Do NOT assume a "standard" navigation structure — derive it from actual user flows',
] as const;

export const DEFAULT_BRIEF: DesignBrief = {
    purpose: 'Not specified',
    audience: 'General users',
    aesthetic: 'Clean and functional',
    constraints: [],
    antiPatterns: [],
    inspirations: [],
} as const;

// ── Prompt Builders ───────────────────────────────────

export function buildDesignBriefPrompt(
    taskTitle: string,
    taskDescription: string
): string {
    const antiGenericSection = ANTI_GENERIC_RULES.map((r) => `- ${r}`).join('\n');

    return (
        `You are generating a structured design brief before any UI is created.\n\n` +
        `Task: ${taskTitle}\n` +
        `Description: ${taskDescription}\n\n` +
        `## Anti-Generic Rules (MANDATORY)\n` +
        `${antiGenericSection}\n\n` +
        `Produce ONLY the following structured block — no prose before or after:\n\n` +
        `--- DESIGN BRIEF ---\n` +
        `PURPOSE: <one sentence — what problem does this UI solve?>\n` +
        `AUDIENCE: <who uses it? skill level, context, device>\n` +
        `AESTHETIC: <visual style: minimal, playful, corporate, brutalist, etc.>\n` +
        `CONSTRAINTS: <item1 | item2 | item3 — tech limits, a11y, legal, etc.>\n` +
        `ANTI_PATTERNS: <item1 | item2 — specific things to avoid for THIS project>\n` +
        `INSPIRATIONS: <item1 | item2 — reference designs, products, or art movements>\n` +
        `--- END BRIEF ---`
    );
}

export function buildEnhancedDesignPrompt(
    brief: DesignBrief,
    originalPrompt: string
): string {
    const constraintsList =
        brief.constraints.length > 0
            ? brief.constraints.join(', ')
            : 'None specified';

    const antiPatternLines = [
        ...ANTI_GENERIC_RULES,
        ...brief.antiPatterns,
    ]
        .map((r) => `- ${r}`)
        .join('\n');

    return (
        `## Design Context\n` +
        `Purpose: ${brief.purpose}\n` +
        `Audience: ${brief.audience}\n` +
        `Aesthetic: ${brief.aesthetic}\n` +
        `Constraints: ${constraintsList}\n` +
        (brief.inspirations.length > 0
            ? `Inspirations: ${brief.inspirations.join(', ')}\n`
            : '') +
        `\n## Anti-Patterns (DO NOT)\n` +
        `${antiPatternLines}\n` +
        `\n## Original Task\n` +
        `${originalPrompt}`
    );
}

// ── Parser ────────────────────────────────────────────

function splitPipeList(raw: string): readonly string[] {
    return raw
        .split('|')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function extractField(text: string, fieldName: string): string {
    const regex = new RegExp(`^${fieldName}:\\s*(.+)$`, 'm');
    const match = regex.exec(text);
    return match ? match[1].trim() : '';
}

function extractListField(text: string, fieldName: string): readonly string[] {
    const raw = extractField(text, fieldName);
    return raw ? splitPipeList(raw) : [];
}

function extractBriefBlock(aiOutput: string): string | null {
    const start = aiOutput.indexOf('--- DESIGN BRIEF ---');
    const end = aiOutput.indexOf('--- END BRIEF ---');
    if (start === -1 || end === -1 || end <= start) return null;
    return aiOutput.slice(start + '--- DESIGN BRIEF ---'.length, end);
}

export function parseDesignBrief(aiOutput: string): DesignBrief {
    const block = extractBriefBlock(aiOutput);
    const source = block ?? aiOutput;

    const purpose = extractField(source, 'PURPOSE') || DEFAULT_BRIEF.purpose;
    const audience = extractField(source, 'AUDIENCE') || DEFAULT_BRIEF.audience;
    const aesthetic = extractField(source, 'AESTHETIC') || DEFAULT_BRIEF.aesthetic;
    const constraints = extractListField(source, 'CONSTRAINTS');
    const antiPatterns = extractListField(source, 'ANTI_PATTERNS');
    const inspirations = extractListField(source, 'INSPIRATIONS');

    return {
        purpose,
        audience,
        aesthetic,
        constraints,
        antiPatterns,
        inspirations,
    };
}
