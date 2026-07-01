/**
 * KageOps Skill Importer — Phase 3 / iter 1
 *
 * Walks a directory (usually `.claude/skills/`) and upserts every
 * `SKILL.md` it finds as a skill with `source='imported'`.
 *
 * Frontmatter format (YAML-ish, only 3 fields):
 *   ---
 *   name: kageops-database
 *   description: Short one-liner
 *   tags: foo, bar              # optional
 *   ---
 *   <body markdown>
 *
 * Only `name` + `description` are mandatory. We parse by hand — the spec
 * explicitly forbids new npm dependencies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../shared/logger';
import { SkillStore } from './skill-store';
import type { Skill } from './types';

const log = createLogger('Skills');

// ── Types ────────────────────────────────────────────

export interface ParsedSkillFile {
    readonly name: string;
    readonly description: string;
    readonly tags: readonly string[];
    readonly body: string;
}

export interface SkillImportResult {
    readonly imported: number;
    readonly updated: number;
    readonly skipped: number;
    readonly errors: readonly string[];
}

// ── Frontmatter parser ───────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u;

/**
 * Minimal YAML-ish parser — supports only the three shapes we emit:
 *   key: value
 *   key: "quoted value"
 *   key: [a, b, c]
 * Anything fancier is ignored. Returned strings are trimmed.
 */
function parseFrontmatterBlock(raw: string): Record<string, string | readonly string[]> {
    const out: Record<string, string | readonly string[]> = {};
    const lines = raw.split(/\r?\n/u);
    for (const line of lines) {
        if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
        const colon = line.indexOf(':');
        if (colon === -1) continue;

        const key = line.slice(0, colon).trim();
        let value = line.slice(colon + 1).trim();
        if (key.length === 0) continue;

        // Inline array: [a, b, c]
        if (value.startsWith('[') && value.endsWith(']')) {
            const inner = value.slice(1, -1);
            out[key] = inner
                .split(',')
                .map((s) => stripQuotes(s.trim()))
                .filter((s) => s.length > 0);
            continue;
        }

        // Strip optional matching quotes.
        value = stripQuotes(value);
        out[key] = value;
    }
    return out;
}

function stripQuotes(s: string): string {
    if (s.length >= 2) {
        const first = s.charAt(0);
        const last = s.charAt(s.length - 1);
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return s.slice(1, -1);
        }
    }
    return s;
}

/**
 * Parse a single SKILL.md file. Returns null (with a debug log) when
 * the file lacks frontmatter or the mandatory `name` field.
 */
export function parseSkillFile(content: string): ParsedSkillFile | null {
    const match = content.match(FRONTMATTER_RE);
    if (match === null) {
        return null;
    }
    const fields = parseFrontmatterBlock(match[1]);
    const body = match[2].trim();

    const nameField = fields['name'];
    if (typeof nameField !== 'string' || nameField.trim().length === 0) {
        return null;
    }

    const descField = fields['description'];
    const description = typeof descField === 'string' ? descField : '';

    let tags: readonly string[] = [];
    const tagsField = fields['tags'];
    if (Array.isArray(tagsField)) {
        tags = tagsField.filter((t) => typeof t === 'string' && t.length > 0);
    } else if (typeof tagsField === 'string' && tagsField.trim().length > 0) {
        tags = tagsField.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
    }

    return Object.freeze({
        name: nameField.trim(),
        description: description.trim(),
        tags: Object.freeze(tags),
        body,
    });
}

// ── Importer ─────────────────────────────────────────

export class SkillImporter {
    constructor(private readonly store: SkillStore = new SkillStore()) {}

    /**
     * Scan `rootDir` for `SKILL.md` files (one per subdirectory, or
     * directly in the dir). Every parsed file is upserted with
     * `source='imported'`. Missing directories are a no-op — caller
     * decides whether to log.
     */
    async importFromClaudeDir(rootDir: string): Promise<SkillImportResult> {
        if (!fs.existsSync(rootDir)) {
            log.debug({ rootDir }, 'Skills dir does not exist — skipping import');
            return freezeResult({ imported: 0, updated: 0, skipped: 0, errors: [] });
        }

        const files = listSkillFiles(rootDir);
        if (files.length === 0) {
            return freezeResult({ imported: 0, updated: 0, skipped: 0, errors: [] });
        }

        let imported = 0;
        let updated = 0;
        let skipped = 0;
        const errors: string[] = [];

        for (const file of files) {
            try {
                const raw = fs.readFileSync(file, 'utf-8');
                const parsed = parseSkillFile(raw);
                if (parsed === null) {
                    skipped += 1;
                    log.debug({ file }, 'Skipping SKILL.md without frontmatter or name');
                    continue;
                }

                const existing = await this.store.getByName(parsed.name);
                if (existing === null) {
                    await this.createImported(parsed);
                    imported += 1;
                } else if (shouldUpdate(existing, parsed)) {
                    await this.store.update(parsed.name, {
                        description: parsed.description,
                        body: parsed.body,
                        tags: parsed.tags,
                        source: 'imported',
                    });
                    updated += 1;
                } else {
                    skipped += 1;
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                errors.push(`${file}: ${msg}`);
                log.warn({ file, err: msg }, 'Failed to import skill');
            }
        }

        const result = freezeResult({ imported, updated, skipped, errors });
        log.info(
            { rootDir, imported, updated, skipped, errorCount: errors.length },
            'Skill import complete'
        );
        return result;
    }

    private async createImported(parsed: ParsedSkillFile): Promise<void> {
        const skill = await this.store.create({
            name: parsed.name,
            description: parsed.description,
            body: parsed.body,
            tags: parsed.tags,
            source: 'imported',
        });
        await this.store.recordEvolution(skill.id, 'captured', {
            notes: `Imported from .claude/skills/${parsed.name}/SKILL.md`,
        });
    }
}

// ── Helpers ──────────────────────────────────────────

function shouldUpdate(existing: Skill, incoming: ParsedSkillFile): boolean {
    return (
        existing.body !== incoming.body ||
        existing.description !== incoming.description ||
        !arraysEqual(existing.tags, incoming.tags)
    );
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Collect every `SKILL.md` under `rootDir`. We look one level deep
 * (each skill lives in its own folder), then fall back to a direct
 * match in the root itself.
 */
function listSkillFiles(rootDir: string): readonly string[] {
    const results: string[] = [];
    const directHit = path.join(rootDir, 'SKILL.md');
    if (fs.existsSync(directHit)) {
        results.push(directHit);
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
        return [];
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(rootDir, entry.name, 'SKILL.md');
        if (fs.existsSync(candidate)) {
            results.push(candidate);
        }
    }
    return results;
}

function freezeResult(r: {
    imported: number;
    updated: number;
    skipped: number;
    errors: readonly string[];
}): SkillImportResult {
    return Object.freeze({
        imported: r.imported,
        updated: r.updated,
        skipped: r.skipped,
        errors: Object.freeze([...r.errors]),
    });
}
