/**
 * Tests for src/renderer/command-center/apo-rollback-panel.ts (B-478)
 *
 * Scope: pure HTML builder + formatter helpers only. Interactive wiring
 * uses `document.createElement`-free HTML, but full click/confirm tests
 * would need jsdom which the repo deliberately avoids — the helpers here
 * cover the logic that matters (row content, escaping, relative-time
 * thresholds).
 */

import { describe, expect, it } from 'vitest';
import {
    buildApoRollbackHtml,
    extractBasename,
    formatRelative,
    formatSize,
    type ApoBackupEntry,
} from '../../src/renderer/command-center/apo-rollback-panel';

// ── Fixtures ─────────────────────────────────────────

function makeEntry(overrides: Partial<ApoBackupEntry> = {}): ApoBackupEntry {
    return {
        backupPath:
            '/Users/x/.kageops/agent-config.openrouter_budget.json.apo-backup-1700000000000.json',
        presetPath: '/Users/x/.kageops/agent-config.openrouter_budget.json',
        timestamp: 1_700_000_000_000,
        createdAt: new Date(1_700_000_000_000).toISOString(),
        size: 2048,
        agentsWithOverrides: ['scout'],
        ...overrides,
    };
}

// ── formatSize ───────────────────────────────────────

describe('formatSize', () => {
    it('formats byte counts under 1 KB as bytes', () => {
        expect(formatSize(0)).toBe('0 B');
        expect(formatSize(512)).toBe('512 B');
        expect(formatSize(1023)).toBe('1023 B');
    });

    it('formats kilobytes with 1 decimal place', () => {
        expect(formatSize(1024)).toBe('1.0 KB');
        expect(formatSize(2048)).toBe('2.0 KB');
        expect(formatSize(1536)).toBe('1.5 KB');
    });

    it('formats megabytes with 2 decimal places', () => {
        expect(formatSize(1024 * 1024)).toBe('1.00 MB');
        expect(formatSize(5 * 1024 * 1024)).toBe('5.00 MB');
    });
});

// ── formatRelative ───────────────────────────────────

describe('formatRelative', () => {
    const NOW = 1_700_000_000_000;

    it('uses seconds below 1 minute', () => {
        expect(formatRelative(NOW - 10_000, NOW)).toBe('10s ago');
    });

    it('uses minutes below 1 hour', () => {
        expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    });

    it('uses hours below 1 day', () => {
        expect(formatRelative(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    });

    it('uses days below 30 days', () => {
        expect(formatRelative(NOW - 5 * 86_400_000, NOW)).toBe('5d ago');
    });

    it('falls back to ISO date for 30+ day gaps', () => {
        const ts = NOW - 40 * 86_400_000;
        expect(formatRelative(ts, NOW)).toBe(
            new Date(ts).toISOString().slice(0, 10)
        );
    });
});

// ── extractBasename ──────────────────────────────────

describe('extractBasename', () => {
    it('returns the filename component from a POSIX path', () => {
        expect(extractBasename('/a/b/c/file.json')).toBe('file.json');
    });

    it('returns the filename component from a Windows path', () => {
        expect(extractBasename('C:\\x\\y\\file.json')).toBe('file.json');
    });

    it('returns the input when it has no separators', () => {
        expect(extractBasename('file.json')).toBe('file.json');
    });
});

// ── buildApoRollbackHtml ─────────────────────────────

describe('buildApoRollbackHtml', () => {
    it('renders the empty-state copy when no backups exist', () => {
        const html = buildApoRollbackHtml([]);
        expect(html).toContain('No APO backups yet');
        expect(html).toContain('class="apo-rollback-panel"');
    });

    it('renders a row per backup with the Restore button', () => {
        const html = buildApoRollbackHtml([
            makeEntry({ timestamp: 1000, backupPath: '/x/preset.json.apo-backup-1000.json' }),
            makeEntry({ timestamp: 2000, backupPath: '/x/preset.json.apo-backup-2000.json' }),
        ]);
        const restoreMatches = html.match(/btn-restore-apo-backup/g) ?? [];
        expect(restoreMatches.length).toBe(2);
        expect(html).toContain('data-backup-path="/x/preset.json.apo-backup-1000.json"');
        expect(html).toContain('data-backup-path="/x/preset.json.apo-backup-2000.json"');
    });

    it('embeds each agent-with-override as a badge', () => {
        const html = buildApoRollbackHtml([
            makeEntry({ agentsWithOverrides: ['scout', 'herald'] }),
        ]);
        expect(html).toContain('agent-badge--scout');
        expect(html).toContain('agent-badge--herald');
        expect(html).toContain('>scout<');
        expect(html).toContain('>herald<');
    });

    it('renders an empty-agent badge when the backup has no overrides', () => {
        const html = buildApoRollbackHtml([
            makeEntry({ agentsWithOverrides: [] }),
        ]);
        expect(html).toContain('agent-badge--none');
        expect(html).toContain('>none<');
    });

    it('includes the Refresh toolbar button exactly once', () => {
        const html = buildApoRollbackHtml([makeEntry()]);
        const refreshMatches = html.match(/btn-refresh-apo-backups/g) ?? [];
        expect(refreshMatches.length).toBe(1);
    });

    it('escapes HTML-sensitive characters in backupPath and agent names', () => {
        const html = buildApoRollbackHtml([
            makeEntry({
                backupPath: '/x/preset"><script>.apo-backup-1000.json',
                agentsWithOverrides: ['"><img'],
            }),
        ]);
        expect(html).not.toContain('<script>');
        expect(html).toContain('&quot;');
    });

    it('renders the file size using formatSize', () => {
        const html = buildApoRollbackHtml([makeEntry({ size: 2048 })]);
        expect(html).toContain('2.0 KB');
    });

    it('embeds the basename of the backup file in the path column', () => {
        const html = buildApoRollbackHtml([
            makeEntry({
                backupPath:
                    '/Users/x/.kageops/agent-config.openrouter_budget.json.apo-backup-1700000000000.json',
            }),
        ]);
        expect(html).toContain(
            'agent-config.openrouter_budget.json.apo-backup-1700000000000.json'
        );
    });

    it('includes the status container (hidden by default)', () => {
        const html = buildApoRollbackHtml([makeEntry()]);
        expect(html).toContain('apo-rollback-status hidden');
    });
});
