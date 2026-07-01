/**
 * Design Tokens — single source of truth for colors, fonts, spacing, and theming.
 * TD-009 / TD-010: Unify hardcoded colors and CSS design tokens.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface ColorToken {
  readonly name: string;
  readonly value: string;
  readonly category: 'brand' | 'agent' | 'status' | 'severity' | 'ui' | 'text';
  readonly description: string;
}

export interface FontToken {
  readonly name: string;
  readonly family: string;
  readonly size: string;
  readonly weight: number;
  readonly lineHeight: string;
}

export interface SpacingToken {
  readonly name: string;
  readonly value: string;
  readonly px: number;
}

export interface ThemeConfig {
  readonly name: string;
  readonly colors: Readonly<Record<string, string>>;
  readonly fonts: Readonly<Record<string, FontToken>>;
  readonly spacing: Readonly<Record<string, string>>;
}

export interface AgentColorScheme {
  readonly agentId: string;
  readonly primary: string;
  readonly secondary: string;
  readonly accent: string;
  readonly text: string;
}

export interface StatusColorScheme {
  readonly status: string;
  readonly background: string;
  readonly foreground: string;
  readonly border: string;
}

export interface CssVariable {
  readonly name: string;
  readonly value: string;
  readonly fallback: string;
}

// ── Brand Colors ───────────────────────────────────────────────────────────

export const BRAND_COLORS: Readonly<Record<string, string>> = {
  'kageops-primary': '#1a1a2e',
  'kageops-secondary': '#16213e',
  'accent': '#e94560',
  'success': '#4caf50',
  'warning': '#ff9800',
  'error': '#f44336',
  'info': '#2196f3',
} as const;

// ── Agent Colors ───────────────────────────────────────────────────────────

export const AGENT_COLORS: readonly AgentColorScheme[] = [
  { agentId: 'sensei', primary: '#ff9800', secondary: '#ffe0b2', accent: '#e65100', text: '#ffffff' },
  { agentId: 'scout', primary: '#4caf50', secondary: '#c8e6c9', accent: '#1b5e20', text: '#ffffff' },
  { agentId: 'blueprint', primary: '#2196f3', secondary: '#bbdefb', accent: '#0d47a1', text: '#ffffff' },
  { agentId: 'pixel', primary: '#9c27b0', secondary: '#e1bee7', accent: '#4a148c', text: '#ffffff' },
  { agentId: 'forge', primary: '#f44336', secondary: '#ffcdd2', accent: '#b71c1c', text: '#ffffff' },
  { agentId: 'cipher', primary: '#009688', secondary: '#b2dfdb', accent: '#004d40', text: '#ffffff' },
  { agentId: 'vigil', primary: '#ffc107', secondary: '#ffecb3', accent: '#ff6f00', text: '#000000' },
  { agentId: 'aegis', primary: '#3f51b5', secondary: '#c5cae9', accent: '#1a237e', text: '#ffffff' },
  { agentId: 'herald', primary: '#e91e63', secondary: '#f8bbd0', accent: '#880e4f', text: '#ffffff' },
] as const;

// ── Status Colors ──────────────────────────────────────────────────────────

export const STATUS_COLORS: readonly StatusColorScheme[] = [
  { status: 'idle', background: '#455a64', foreground: '#ffffff', border: '#607d8b' },
  { status: 'busy', background: '#ff9800', foreground: '#000000', border: '#e65100' },
  { status: 'completed', background: '#4caf50', foreground: '#ffffff', border: '#2e7d32' },
  { status: 'failed', background: '#f44336', foreground: '#ffffff', border: '#c62828' },
  { status: 'pending', background: '#9e9e9e', foreground: '#ffffff', border: '#616161' },
  { status: 'approved', background: '#2196f3', foreground: '#ffffff', border: '#1565c0' },
  { status: 'blocked', background: '#f44336', foreground: '#ffffff', border: '#b71c1c' },
  { status: 'reviewing', background: '#ff9800', foreground: '#000000', border: '#f57c00' },
] as const;

// ── Severity Colors ────────────────────────────────────────────────────────

export const SEVERITY_COLORS: Readonly<Record<string, string>> = {
  'critical': '#f44336',
  'high': '#ff5722',
  'medium': '#ff9800',
  'low': '#4caf50',
  'info': '#2196f3',
} as const;

// ── Font Tokens ────────────────────────────────────────────────────────────

export const FONT_TOKENS: Readonly<Record<string, FontToken>> = {
  heading:    { name: 'heading', family: 'Inter, sans-serif', size: '1.5rem', weight: 700, lineHeight: '1.3' },
  subheading: { name: 'subheading', family: 'Inter, sans-serif', size: '1.125rem', weight: 600, lineHeight: '1.4' },
  body:       { name: 'body', family: 'Inter, sans-serif', size: '0.875rem', weight: 400, lineHeight: '1.5' },
  caption:    { name: 'caption', family: 'Inter, sans-serif', size: '0.75rem', weight: 400, lineHeight: '1.4' },
  mono:       { name: 'mono', family: "'JetBrains Mono', monospace", size: '0.8125rem', weight: 400, lineHeight: '1.5' },
  small:      { name: 'small', family: 'Inter, sans-serif', size: '0.6875rem', weight: 400, lineHeight: '1.4' },
} as const;

// ── Spacing Tokens ─────────────────────────────────────────────────────────

export const SPACING_TOKENS: Readonly<Record<string, SpacingToken>> = {
  xs:  { name: 'xs', value: '4px', px: 4 },
  sm:  { name: 'sm', value: '8px', px: 8 },
  md:  { name: 'md', value: '16px', px: 16 },
  lg:  { name: 'lg', value: '24px', px: 24 },
  xl:  { name: 'xl', value: '32px', px: 32 },
  xxl: { name: 'xxl', value: '48px', px: 48 },
} as const;

// ── Lookup Helpers ─────────────────────────────────────────────────────────

export function getAgentColor(agentId: string): AgentColorScheme | null {
  return AGENT_COLORS.find(a => a.agentId === agentId) ?? null;
}

export function getStatusColor(status: string): StatusColorScheme | null {
  return STATUS_COLORS.find(s => s.status === status) ?? null;
}

// ── CSS Variable Generation ────────────────────────────────────────────────

export function generateCssVariables(theme: ThemeConfig): readonly CssVariable[] {
  const vars: CssVariable[] = [];
  for (const [key, value] of Object.entries(theme.colors)) {
    vars.push({ name: `--color-${key}`, value, fallback: '#000000' });
  }
  for (const [key, font] of Object.entries(theme.fonts)) {
    vars.push({ name: `--font-${key}-family`, value: font.family, fallback: 'sans-serif' });
    vars.push({ name: `--font-${key}-size`, value: font.size, fallback: '1rem' });
    vars.push({ name: `--font-${key}-weight`, value: String(font.weight), fallback: '400' });
    vars.push({ name: `--font-${key}-line-height`, value: font.lineHeight, fallback: '1.5' });
  }
  for (const [key, value] of Object.entries(theme.spacing)) {
    vars.push({ name: `--spacing-${key}`, value, fallback: '0px' });
  }
  return vars;
}

export function generateCssString(variables: readonly CssVariable[]): string {
  const lines = variables.map(v => `  ${v.name}: ${v.value};`);
  return `:root {\n${lines.join('\n')}\n}`;
}

// ── Color Utilities ────────────────────────────────────────────────────────

function hexToRgb(hex: string): readonly [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return [r, g, b] as const;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function meetsAccessibility(foreground: string, background: string, level: 'AA' | 'AAA'): boolean {
  const ratio = contrastRatio(foreground, background);
  return level === 'AA' ? ratio >= 4.5 : ratio >= 7;
}

// ── Themes ─────────────────────────────────────────────────────────────────

const sharedSpacing: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SPACING_TOKENS).map(([k, v]) => [k, v.value])
);

export const DARK_THEME: ThemeConfig = {
  name: 'dark',
  colors: {
    ...BRAND_COLORS,
    'background': '#0f0f1a',
    'surface': '#1a1a2e',
    'text-primary': '#e0e0e0',
    'text-secondary': '#a0a0b0',
    'border': '#2a2a3e',
  },
  fonts: { ...FONT_TOKENS },
  spacing: sharedSpacing,
} as const;

export const LIGHT_THEME: ThemeConfig = {
  name: 'light',
  colors: {
    ...BRAND_COLORS,
    'background': '#f5f5f5',
    'surface': '#ffffff',
    'text-primary': '#212121',
    'text-secondary': '#616161',
    'border': '#e0e0e0',
  },
  fonts: { ...FONT_TOKENS },
  spacing: sharedSpacing,
} as const;

// ── Theme Merging ──────────────────────────────────────────────────────────

export function mergeTheme(base: ThemeConfig, overrides: Partial<ThemeConfig>): ThemeConfig {
  return {
    name: overrides.name ?? base.name,
    colors: { ...base.colors, ...overrides.colors },
    fonts: { ...base.fonts, ...overrides.fonts },
    spacing: { ...base.spacing, ...overrides.spacing },
  };
}

// ── Token Catalog ──────────────────────────────────────────────────────────

export function formatTokenCatalog(theme: ThemeConfig): string {
  const lines: string[] = [`# ${theme.name} Theme Tokens\n`];
  lines.push('## Colors\n');
  lines.push('| Token | Value |');
  lines.push('|-------|-------|');
  for (const [k, v] of Object.entries(theme.colors)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push('\n## Fonts\n');
  lines.push('| Token | Family | Size | Weight |');
  lines.push('|-------|--------|------|--------|');
  for (const [k, f] of Object.entries(theme.fonts)) {
    lines.push(`| ${k} | ${f.family} | ${f.size} | ${f.weight} |`);
  }
  lines.push('\n## Spacing\n');
  lines.push('| Token | Value |');
  lines.push('|-------|-------|');
  for (const [k, v] of Object.entries(theme.spacing)) {
    lines.push(`| ${k} | ${v} |`);
  }
  return lines.join('\n');
}
