/**
 * KageOps Command Center — Build Status Panel (Track D)
 *
 * Linear "live logs" layout:
 *   · Top status badge (ok / warn / err) using theme tokens.
 *   · Left 200px phase sidebar listing parsed phases; clicking
 *     a phase scrolls the log stream to that phase's first line.
 *   · Right monospace log stream derived from `logSummary`, with
 *     a small HH:MM:SS gutter when line-prefix timestamps are
 *     detected. Tokens-only styling; no new deps.
 *
 * Public API unchanged: `renderBuildPanel(container, builds)`.
 * The old table fallback still renders when multiple builds are
 * passed — the live-logs layout targets the single-active-build
 * case, which matches how the dashboard actually uses this panel.
 */

import { icon, type IconName } from '../../shared/icons';

// ── Types ────────────────────────────────────────────

export interface BuildEntry {
    readonly id: string;
    readonly projectId: string;
    readonly pipeline: string;
    readonly runId: string | null;
    readonly status: string;
    readonly branch: string | null;
    readonly commitSha: string | null;
    readonly url: string | null;
    readonly logSummary: string | null;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
}

type StatusBucket = 'ok' | 'warn' | 'err' | 'idle';

interface StatusBadgeSpec {
    readonly bucket: StatusBucket;
    readonly iconName: IconName;
    readonly label: string;
}

const STATUS_SPECS: Record<string, StatusBadgeSpec> = {
    success:   { bucket: 'ok',   iconName: 'check-circle',   label: 'Success' },
    passed:    { bucket: 'ok',   iconName: 'check-circle',   label: 'Passed' },
    failed:    { bucket: 'err',  iconName: 'x-circle',       label: 'Failed' },
    error:     { bucket: 'err',  iconName: 'x-circle',       label: 'Error' },
    running:   { bucket: 'warn', iconName: 'hourglass',      label: 'Running' },
    pending:   { bucket: 'warn', iconName: 'hourglass',      label: 'Pending' },
    cancelled: { bucket: 'idle', iconName: 'pause',          label: 'Cancelled' },
    skipped:   { bucket: 'idle', iconName: 'chevron-right',  label: 'Skipped' },
};

function statusSpec(status: string): StatusBadgeSpec {
    return STATUS_SPECS[status.toLowerCase()] ?? {
        bucket: 'idle',
        iconName: 'help-circle',
        label: status,
    };
}

// ── Render entry point ──────────────────────────────

export function renderBuildPanel(
    container: HTMLElement,
    builds: readonly BuildEntry[],
): void {
    container.innerHTML = '';

    if (builds.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No build data available';
        container.appendChild(empty);
        return;
    }

    if (builds.length === 1) {
        container.appendChild(buildLiveLogs(builds[0]));
        return;
    }

    container.appendChild(buildHistory(builds));
}

// ── Single-build live-logs layout ───────────────────

function buildLiveLogs(build: BuildEntry): HTMLElement {
    const root = document.createElement('div');
    root.className = 'build-live';
    root.setAttribute('data-id', build.id);

    root.appendChild(buildHeader(build));

    const body = document.createElement('div');
    body.className = 'build-live__body';

    const phases = extractPhases(build.logSummary ?? '');

    const sidebar = document.createElement('div');
    sidebar.className = 'build-live__sidebar';
    sidebar.setAttribute('aria-label', 'Build phases');
    if (phases.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'build-live__sidebar-empty';
        hint.textContent = 'No phases detected';
        sidebar.appendChild(hint);
    } else {
        for (const phase of phases) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'build-live__phase';
            btn.setAttribute('data-target-line', String(phase.lineIndex));
            const glyph = document.createElement('span');
            glyph.className = `build-live__phase-dot build-live__phase-dot--${phase.bucket}`;
            btn.appendChild(glyph);
            const label = document.createElement('span');
            label.className = 'build-live__phase-label';
            label.textContent = phase.label;
            btn.appendChild(label);
            sidebar.appendChild(btn);
        }
    }
    body.appendChild(sidebar);

    const streamWrap = document.createElement('div');
    streamWrap.className = 'build-live__stream-wrap';

    const stream = document.createElement('div');
    stream.className = 'build-live__stream';
    stream.setAttribute('role', 'log');
    stream.setAttribute('aria-live', 'polite');

    const lines = (build.logSummary ?? '').split(/\r?\n/);
    if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
        const placeholder = document.createElement('div');
        placeholder.className = 'build-live__stream-placeholder';
        placeholder.textContent = 'Waiting for build output\u2026';
        stream.appendChild(placeholder);
    } else {
        lines.forEach((raw, idx) => {
            stream.appendChild(renderLogLine(raw, idx));
        });
    }
    streamWrap.appendChild(stream);
    body.appendChild(streamWrap);
    root.appendChild(body);

    wirePhaseClicks(root, stream);
    return root;
}

function buildHeader(build: BuildEntry): HTMLElement {
    const spec = statusSpec(build.status);
    const header = document.createElement('div');
    header.className = 'build-live__header';

    const badge = document.createElement('span');
    badge.className = `build-live__badge build-live__badge--${spec.bucket}`;
    const badgeGlyph = document.createElement('span');
    badgeGlyph.className = 'build-live__badge-glyph';
    badgeGlyph.setAttribute('aria-hidden', 'true');
    badgeGlyph.innerHTML = icon(spec.iconName, { size: 14 });
    badge.appendChild(badgeGlyph);
    const badgeLabel = document.createElement('span');
    badgeLabel.textContent = spec.label;
    badge.appendChild(badgeLabel);
    header.appendChild(badge);

    const titles = document.createElement('div');
    titles.className = 'build-live__titles';
    const pipeline = document.createElement('div');
    pipeline.className = 'build-live__pipeline';
    if (build.url !== null) {
        const a = document.createElement('a');
        a.className = 'build-live__pipeline-link';
        a.setAttribute('href', build.url);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.textContent = build.pipeline;
        pipeline.appendChild(a);
    } else {
        pipeline.textContent = build.pipeline;
    }
    titles.appendChild(pipeline);

    const meta = document.createElement('div');
    meta.className = 'build-live__meta';
    meta.appendChild(metaChip('Branch', build.branch ?? '\u2014'));
    meta.appendChild(metaChip('Commit', shortSha(build.commitSha)));
    meta.appendChild(metaChip('Duration', computeDuration(build.startedAt, build.completedAt)));
    meta.appendChild(metaChip('Started', build.startedAt !== null ? formatTime(build.startedAt) : '\u2014'));
    titles.appendChild(meta);

    header.appendChild(titles);
    return header;
}

function metaChip(label: string, value: string): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'build-live__chip';
    const lab = document.createElement('span');
    lab.className = 'build-live__chip-label';
    lab.textContent = label;
    const val = document.createElement('span');
    val.className = 'build-live__chip-value';
    val.textContent = value;
    chip.appendChild(lab);
    chip.appendChild(val);
    return chip;
}

// ── Log line rendering ──────────────────────────────

const TIME_PREFIX_RE = /^(\d{2}:\d{2}:\d{2})\s+/;
const PHASE_MARKER_RE = /^\s*(?:#{2,4}|==>|\[phase\])\s+(.+?)\s*$/i;

function renderLogLine(raw: string, idx: number): HTMLElement {
    const line = document.createElement('div');
    line.className = 'build-live__line';
    line.setAttribute('data-line', String(idx));

    const timeMatch = TIME_PREFIX_RE.exec(raw);
    const rest = timeMatch !== null ? raw.slice(timeMatch[0].length) : raw;

    const gutter = document.createElement('span');
    gutter.className = 'build-live__gutter';
    gutter.textContent = timeMatch !== null ? timeMatch[1] : '';
    line.appendChild(gutter);

    const body = document.createElement('span');
    body.className = 'build-live__line-text';
    body.textContent = rest;

    const level = classifyLineLevel(rest);
    if (level !== 'info') {
        line.classList.add(`build-live__line--${level}`);
    }
    if (PHASE_MARKER_RE.exec(rest) !== null) {
        line.classList.add('build-live__line--phase');
    }

    line.appendChild(body);
    return line;
}

type LineLevel = 'info' | 'ok' | 'warn' | 'err';

function classifyLineLevel(text: string): LineLevel {
    const lower = text.toLowerCase();
    if (/\b(error|fatal|failed|failure|panic)\b/.test(lower)) return 'err';
    if (/\b(warn|warning|deprecat)/.test(lower)) return 'warn';
    if (/\b(passed|succeeded|success|ok|done)\b/.test(lower)) return 'ok';
    return 'info';
}

// ── Phase extraction ─────────────────────────────────

interface PhaseEntry {
    readonly label: string;
    readonly lineIndex: number;
    readonly bucket: StatusBucket;
}

function extractPhases(logSummary: string): readonly PhaseEntry[] {
    const lines = logSummary.split(/\r?\n/);
    const out: PhaseEntry[] = [];
    lines.forEach((raw, idx) => {
        const text = raw.replace(TIME_PREFIX_RE, '');
        const match = PHASE_MARKER_RE.exec(text);
        if (match === null) return;
        const label = match[1].trim();
        if (label === '') return;
        const level = classifyLineLevel(label);
        const bucket: StatusBucket = level === 'err'
            ? 'err'
            : level === 'warn'
                ? 'warn'
                : level === 'ok'
                    ? 'ok'
                    : 'idle';
        out.push({ label, lineIndex: idx, bucket });
    });
    return out;
}

function wirePhaseClicks(root: HTMLElement, stream: HTMLElement): void {
    const buttons = root.querySelectorAll<HTMLElement>('.build-live__phase');
    buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const idx = btn.getAttribute('data-target-line');
            if (idx === null) return;
            const target = stream.querySelector<HTMLElement>(`[data-line="${idx}"]`);
            if (target !== null) {
                target.scrollIntoView({ block: 'start' });
                target.classList.add('build-live__line--flash');
                setTimeout(() => target.classList.remove('build-live__line--flash'), 1200);
            }
            const prev = root.querySelector<HTMLElement>('.build-live__phase.is-active');
            if (prev !== null) prev.classList.remove('is-active');
            btn.classList.add('is-active');
        });
    });
}

// ── Multi-build history fallback ────────────────────

function buildHistory(builds: readonly BuildEntry[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'build-history';

    const title = document.createElement('div');
    title.className = 'build-history__title';
    title.textContent = 'Build history';
    wrap.appendChild(title);

    const list = document.createElement('div');
    list.className = 'build-history__list';
    for (const b of builds) {
        list.appendChild(historyRow(b));
    }
    wrap.appendChild(list);
    return wrap;
}

function historyRow(build: BuildEntry): HTMLElement {
    const spec = statusSpec(build.status);
    const row = document.createElement('div');
    row.className = 'build-history__row';
    row.setAttribute('data-id', build.id);

    const badge = document.createElement('span');
    badge.className = `build-history__badge build-history__badge--${spec.bucket}`;
    badge.setAttribute('aria-label', spec.label);
    badge.innerHTML = icon(spec.iconName, { size: 12 });
    row.appendChild(badge);

    const pipeline = document.createElement('span');
    pipeline.className = 'build-history__pipeline';
    pipeline.textContent = build.pipeline;
    row.appendChild(pipeline);

    const branch = document.createElement('span');
    branch.className = 'build-history__cell';
    branch.textContent = build.branch ?? '\u2014';
    row.appendChild(branch);

    const sha = document.createElement('span');
    sha.className = 'build-history__cell';
    sha.textContent = shortSha(build.commitSha);
    row.appendChild(sha);

    const dur = document.createElement('span');
    dur.className = 'build-history__cell';
    dur.textContent = computeDuration(build.startedAt, build.completedAt);
    row.appendChild(dur);

    const started = document.createElement('span');
    started.className = 'build-history__cell';
    started.textContent = build.startedAt !== null ? formatTime(build.startedAt) : '\u2014';
    row.appendChild(started);

    return row;
}

// ── Utilities ────────────────────────────────────────

function shortSha(sha: string | null): string {
    if (sha === null || sha === '') return '\u2014';
    return sha.substring(0, 7);
}

function computeDuration(startedAt: string | null, completedAt: string | null): string {
    if (startedAt === null) return '\u2014';
    const start = new Date(startedAt).getTime();
    if (!Number.isFinite(start)) return '\u2014';

    if (completedAt === null) {
        const elapsed = Date.now() - start;
        return `${formatDurationMs(elapsed)}\u2026`;
    }
    const end = new Date(completedAt).getTime();
    if (!Number.isFinite(end)) return '\u2014';
    return formatDurationMs(end - start);
}

function formatDurationMs(ms: number): string {
    if (ms < 0) return '\u2014';
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
}

function formatTime(isoString: string): string {
    try {
        const d = new Date(isoString);
        if (Number.isNaN(d.getTime())) return '--:--';
        return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '--:--';
    }
}
