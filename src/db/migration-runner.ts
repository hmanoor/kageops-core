/**
 * KageOps Database Migration Runner
 *
 * Pure-function migration utilities: parse migration files,
 * validate chains, compute checksums, and build execution plans.
 * No side effects — all I/O handled by callers.
 */

import * as crypto from 'crypto';

// ── Types ────────────────────────────────────────────

export interface Migration {
    readonly id: string;
    readonly version: number;
    readonly name: string;
    readonly sql: string;
    readonly checksum: string;
    readonly appliedAt: string | null;
}

export interface MigrationResult {
    readonly migration: Migration;
    readonly success: boolean;
    readonly error: string | null;
    readonly durationMs: number;
}

export interface MigrationState {
    readonly applied: readonly Migration[];
    readonly pending: readonly Migration[];
    readonly current: number;
}

export interface MigrationConfig {
    readonly migrationsDir: string;
    readonly tableName: string;
    readonly validateChecksums: boolean;
}

// ── Constants ────────────────────────────────────────

const MIGRATION_FILE_PATTERN = /^(\d{3})-(.+)\.sql$/;

const DEFAULT_CONFIG: MigrationConfig = {
    migrationsDir: 'src/db/migrations',
    tableName: 'schema_migrations',
    validateChecksums: true,
};

// ── Functions ────────────────────────────────────────

/**
 * Compute a djb2 hash of SQL content, returned as hex string.
 */
export function computeChecksum(content: string): string {
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
        hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Parse a migration file from "NNN-name.sql" format.
 * Returns null if the filename doesn't match the expected pattern.
 */
export function parseMigrationFile(fileName: string, content: string): Migration | null {
    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (!match) {
        return null;
    }

    const version = parseInt(match[1], 10);
    const name = match[2];
    const checksum = computeChecksum(content);

    return {
        id: `${version}-${name}`,
        version,
        name,
        sql: content,
        checksum,
        appliedAt: null,
    };
}

/**
 * Sort migrations by version ascending, returning a new array.
 */
export function sortMigrations(migrations: readonly Migration[]): readonly Migration[] {
    return [...migrations].sort((a, b) => a.version - b.version);
}

/**
 * Validate that migrations form a sequential chain with no gaps or duplicates.
 * Returns an array of error messages (empty = valid).
 */
export function validateMigrationChain(migrations: readonly Migration[]): readonly string[] {
    const sorted = sortMigrations(migrations);
    const errors: string[] = [];

    const versionCounts = new Map<number, number>();
    for (const m of sorted) {
        versionCounts.set(m.version, (versionCounts.get(m.version) ?? 0) + 1);
    }

    for (const [version, count] of versionCounts) {
        if (count > 1) {
            errors.push(`Duplicate migration version: ${version}`);
        }
    }

    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        if (curr.version !== prev.version + 1 && prev.version !== curr.version) {
            errors.push(`Gap between version ${prev.version} and ${curr.version}`);
        }
    }

    return errors;
}

/**
 * Return migrations that have not yet been applied.
 */
export function getPendingMigrations(
    all: readonly Migration[],
    applied: readonly Migration[],
): readonly Migration[] {
    const appliedVersions = new Set(applied.map((m) => m.version));
    return sortMigrations(all.filter((m) => !appliedVersions.has(m.version)));
}

/**
 * Build a complete migration state from all known and applied migrations.
 */
export function buildMigrationState(
    all: readonly Migration[],
    applied: readonly Migration[],
): MigrationState {
    const pending = getPendingMigrations(all, applied);
    const sortedApplied = sortMigrations(applied);
    const current = sortedApplied.length > 0
        ? sortedApplied[sortedApplied.length - 1].version
        : 0;

    return { applied: sortedApplied, pending, current };
}

/**
 * Format migration state as a markdown status table.
 */
export function formatMigrationStatus(state: MigrationState): string {
    const lines: string[] = [
        `## Migration Status`,
        '',
        `**Current version:** ${state.current}`,
        `**Applied:** ${state.applied.length} | **Pending:** ${state.pending.length}`,
        '',
        '| Version | Name | Status |',
        '|---------|------|--------|',
    ];

    for (const m of state.applied) {
        lines.push(`| ${m.version} | ${m.name} | Applied |`);
    }
    for (const m of state.pending) {
        lines.push(`| ${m.version} | ${m.name} | Pending |`);
    }

    return lines.join('\n');
}

/**
 * Create a migration config with sensible defaults, optionally overridden.
 */
export function createMigrationConfig(overrides?: Partial<MigrationConfig>): MigrationConfig {
    return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Compare a migration's checksum against an expected value.
 */
export function validateChecksum(migration: Migration, expected: string): boolean {
    return migration.checksum === expected;
}

/**
 * Format a markdown plan showing which migrations will be applied.
 */
export function formatMigrationPlan(pending: readonly Migration[]): string {
    if (pending.length === 0) {
        return '**No pending migrations.** Database is up to date.';
    }

    const lines: string[] = [
        `## Migration Plan`,
        '',
        `**${pending.length} migration(s) to apply:**`,
        '',
        '| # | Version | Name | Checksum |',
        '|---|---------|------|----------|',
    ];

    for (let i = 0; i < pending.length; i++) {
        const m = pending[i];
        lines.push(`| ${i + 1} | ${m.version} | ${m.name} | ${m.checksum} |`);
    }

    return lines.join('\n');
}

/**
 * Summarize a batch of migration results as markdown.
 */
export function formatMigrationResults(results: readonly MigrationResult[]): string {
    const passed = results.filter((r) => r.success).length;
    const failed = results.length - passed;
    const header = failed > 0 ? '## Migration Failed' : '## Migration Complete';

    const lines: string[] = [
        header,
        '',
        `**Passed:** ${passed} | **Failed:** ${failed}`,
        '',
        '| Version | Name | Result | Duration |',
        '|---------|------|--------|----------|',
    ];

    for (const r of results) {
        const status = r.success ? 'OK' : `FAIL: ${r.error}`;
        lines.push(`| ${r.migration.version} | ${r.migration.name} | ${status} | ${r.durationMs}ms |`);
    }

    return lines.join('\n');
}
