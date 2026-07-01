import { describe, it, expect } from 'vitest';
import {
  BRAND_COLORS, AGENT_COLORS, STATUS_COLORS, SEVERITY_COLORS,
  FONT_TOKENS, SPACING_TOKENS,
  getAgentColor, getStatusColor,
  generateCssVariables, generateCssString,
  contrastRatio, meetsAccessibility,
  DARK_THEME, LIGHT_THEME,
  mergeTheme, formatTokenCatalog,
  type AgentColorScheme, type StatusColorScheme, type ThemeConfig,
} from '../../src/renderer/shared/design-tokens';

describe('design-tokens', () => {
  // ── Brand Colors ───────────────────────────────────────────────────────

  it('has 7 brand colors', () => {
    expect(Object.keys(BRAND_COLORS)).toHaveLength(7);
  });

  it.each([
    ['kageops-primary', '#1a1a2e'],
    ['kageops-secondary', '#16213e'],
    ['accent', '#e94560'],
    ['success', '#4caf50'],
    ['warning', '#ff9800'],
    ['error', '#f44336'],
    ['info', '#2196f3'],
  ] as const)('brand color %s = %s', (key, value) => {
    expect(BRAND_COLORS[key]).toBe(value);
  });

  // ── Agent Colors ───────────────────────────────────────────────────────

  it('has 9 agent color schemes', () => {
    expect(AGENT_COLORS).toHaveLength(9);
  });

  it.each([
    ['sensei', '#ff9800'],
    ['scout', '#4caf50'],
    ['blueprint', '#2196f3'],
    ['pixel', '#9c27b0'],
    ['forge', '#f44336'],
    ['cipher', '#009688'],
    ['vigil', '#ffc107'],
    ['aegis', '#3f51b5'],
    ['herald', '#e91e63'],
  ] as const)('agent %s has primary %s', (agentId, primary) => {
    const scheme = AGENT_COLORS.find(a => a.agentId === agentId);
    expect(scheme).toBeDefined();
    expect(scheme!.primary).toBe(primary);
  });

  it('each agent scheme has all required fields', () => {
    for (const scheme of AGENT_COLORS) {
      expect(scheme).toHaveProperty('agentId');
      expect(scheme).toHaveProperty('primary');
      expect(scheme).toHaveProperty('secondary');
      expect(scheme).toHaveProperty('accent');
      expect(scheme).toHaveProperty('text');
    }
  });

  // ── Status Colors ──────────────────────────────────────────────────────

  it('has 8 status color schemes', () => {
    expect(STATUS_COLORS).toHaveLength(8);
  });

  it.each([
    'idle', 'busy', 'completed', 'failed', 'pending', 'approved', 'blocked', 'reviewing',
  ])('status %s exists', (status) => {
    expect(STATUS_COLORS.find(s => s.status === status)).toBeDefined();
  });

  // ── Severity Colors ────────────────────────────────────────────────────

  it('has 5 severity levels', () => {
    expect(Object.keys(SEVERITY_COLORS)).toHaveLength(5);
  });

  it.each([
    ['critical', '#f44336'],
    ['high', '#ff5722'],
    ['medium', '#ff9800'],
    ['low', '#4caf50'],
    ['info', '#2196f3'],
  ] as const)('severity %s = %s', (level, color) => {
    expect(SEVERITY_COLORS[level]).toBe(color);
  });

  // ── Lookup Helpers ─────────────────────────────────────────────────────

  it('getAgentColor returns scheme for known agent', () => {
    const result = getAgentColor('forge');
    expect(result).not.toBeNull();
    expect(result!.primary).toBe('#f44336');
  });

  it('getAgentColor returns null for unknown agent', () => {
    expect(getAgentColor('unknown-agent')).toBeNull();
  });

  it('getStatusColor returns scheme for known status', () => {
    const result = getStatusColor('completed');
    expect(result).not.toBeNull();
    expect(result!.background).toBe('#4caf50');
  });

  it('getStatusColor returns null for unknown status', () => {
    expect(getStatusColor('nonexistent')).toBeNull();
  });

  // ── CSS Variable Generation ────────────────────────────────────────────

  it('generateCssVariables creates --var-name format', () => {
    const vars = generateCssVariables(DARK_THEME);
    expect(vars.length).toBeGreaterThan(0);
    for (const v of vars) {
      expect(v.name).toMatch(/^--/);
      expect(v.value).toBeTruthy();
      expect(v.fallback).toBeTruthy();
    }
  });

  it('generateCssVariables includes color, font, and spacing vars', () => {
    const vars = generateCssVariables(DARK_THEME);
    const names = vars.map(v => v.name);
    expect(names.some(n => n.startsWith('--color-'))).toBe(true);
    expect(names.some(n => n.startsWith('--font-'))).toBe(true);
    expect(names.some(n => n.startsWith('--spacing-'))).toBe(true);
  });

  it('generateCssString produces valid :root block', () => {
    const vars = generateCssVariables(DARK_THEME);
    const css = generateCssString(vars);
    expect(css).toMatch(/^:root \{/);
    expect(css).toMatch(/\}$/);
    expect(css).toContain('--color-accent');
  });

  // ── Contrast Ratio ─────────────────────────────────────────────────────

  it('contrastRatio black on white = 21', () => {
    const ratio = contrastRatio('#000000', '#ffffff');
    expect(ratio).toBeCloseTo(21, 0);
  });

  it('contrastRatio same color = 1', () => {
    expect(contrastRatio('#ff9800', '#ff9800')).toBeCloseTo(1, 5);
  });

  // ── Accessibility ──────────────────────────────────────────────────────

  it.each([
    ['#000000', '#ffffff', 'AA' as const, true],
    ['#000000', '#ffffff', 'AAA' as const, true],
    ['#777777', '#888888', 'AA' as const, false],
    ['#777777', '#888888', 'AAA' as const, false],
  ])('meetsAccessibility(%s, %s, %s) = %s', (fg, bg, level, expected) => {
    expect(meetsAccessibility(fg, bg, level)).toBe(expected);
  });

  // ── Themes ─────────────────────────────────────────────────────────────

  it('DARK_THEME is a valid ThemeConfig', () => {
    expect(DARK_THEME.name).toBe('dark');
    expect(Object.keys(DARK_THEME.colors).length).toBeGreaterThan(0);
    expect(Object.keys(DARK_THEME.fonts).length).toBeGreaterThan(0);
    expect(Object.keys(DARK_THEME.spacing).length).toBeGreaterThan(0);
  });

  it('LIGHT_THEME is a valid ThemeConfig', () => {
    expect(LIGHT_THEME.name).toBe('light');
    expect(Object.keys(LIGHT_THEME.colors).length).toBeGreaterThan(0);
  });

  it('mergeTheme preserves base and applies overrides', () => {
    const merged = mergeTheme(DARK_THEME, { name: 'custom', colors: { accent: '#ff0000' } });
    expect(merged.name).toBe('custom');
    expect(merged.colors['accent']).toBe('#ff0000');
    // base color preserved
    expect(merged.colors['background']).toBe(DARK_THEME.colors['background']);
    // original not mutated
    expect(DARK_THEME.colors['accent']).toBe('#e94560');
  });

  // ── Font & Spacing Tokens ──────────────────────────────────────────────

  it('FONT_TOKENS has 6 entries', () => {
    expect(Object.keys(FONT_TOKENS)).toHaveLength(6);
  });

  it.each(['heading', 'subheading', 'body', 'caption', 'mono', 'small'])('font token %s exists', (key) => {
    expect(FONT_TOKENS[key]).toBeDefined();
    expect(FONT_TOKENS[key].family).toBeTruthy();
  });

  it('SPACING_TOKENS has 6 entries', () => {
    expect(Object.keys(SPACING_TOKENS)).toHaveLength(6);
  });

  it.each([
    ['xs', 4], ['sm', 8], ['md', 16], ['lg', 24], ['xl', 32], ['xxl', 48],
  ] as const)('spacing %s = %dpx', (key, px) => {
    expect(SPACING_TOKENS[key].px).toBe(px);
  });

  // ── Token Catalog ──────────────────────────────────────────────────────

  it('formatTokenCatalog produces markdown', () => {
    const md = formatTokenCatalog(DARK_THEME);
    expect(md).toContain('# dark Theme Tokens');
    expect(md).toContain('## Colors');
    expect(md).toContain('## Fonts');
    expect(md).toContain('## Spacing');
    expect(md).toContain('|');
  });
});
