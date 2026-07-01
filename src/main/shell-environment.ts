import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ProviderType } from '../shared/types';
import { PROVIDER_BINARIES } from '../shared/constants';

const WINDOW_FALLBACK_PATHS = [
  process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.local\\bin` : '',
  process.env.APPDATA ? `${process.env.APPDATA}\\npm` : '',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs` : '',
  'C:\\Program Files\\nodejs',
  'C:\\Program Files (x86)\\nodejs',
].filter(Boolean);

const binaryCache = new Map<string, string | null>();
let pathDirs: readonly string[] | null = null;

export function findBinary(provider: ProviderType): string | null {
  const binaryName = PROVIDER_BINARIES[provider];
  const cached = binaryCache.get(binaryName);
  if (cached !== undefined) return cached;

  const found = searchForBinary(binaryName);
  binaryCache.set(binaryName, found);
  return found;
}

export function clearCache(): void {
  binaryCache.clear();
  pathDirs = null;
}

function searchForBinary(name: string): string | null {
  const extensions = ['.cmd', '.exe', '.bat', '.ps1', ''];
  const dirs = getPathDirs();

  for (const dir of dirs) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, name + ext);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  // Fallback: try `where` command on Windows
  try {
    const result = execSync(`where ${name}`, { encoding: 'utf-8', timeout: 5000 });
    const firstLine = result.trim().split('\n')[0]?.trim();
    if (firstLine && fs.existsSync(firstLine)) {
      return firstLine;
    }
  } catch {
    // `where` failed, binary not found
  }

  return null;
}

function getPathDirs(): readonly string[] {
  if (pathDirs !== null) return pathDirs;

  const pathEnv = process.env.PATH ?? '';
  const separator = path.delimiter;
  const dirs = pathEnv.split(separator).filter(Boolean);

  pathDirs = [...dirs, ...WINDOW_FALLBACK_PATHS];
  return pathDirs;
}

export function buildSessionEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: 'kageops',
    // Prevent nested session detection for various CLIs
    TERM_PROGRAM: undefined,
  };
}
