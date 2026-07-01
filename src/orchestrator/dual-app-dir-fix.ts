/**
 * Dual App Router directory resolver (BPF-34) — a deterministic pre-build repair.
 *
 * Next.js renders ONE App Router dir: when both a root `app/` and a `src/app/`
 * exist, the root `app/` wins and `src/app/` is silently ignored. The ClubHubOSS6
 * trap: the scaffold ships `app/` (with the real layout + auth/api routes) but a
 * weak/OSS model wrote the landing page to `src/app/page.tsx`. Next rendered the
 * stock `app/page.tsx`; the real page sat dead in `src/app/`. The build still
 * passed, so the project "completed" shipping the stock page.
 *
 * Resolution: consolidate into the ACTIVE dir. Move every file from the shadowed
 * `src/app/` into `app/` (Forge's content is the intended work, so it overwrites
 * the stock scaffold counterpart), then remove `src/app/`. The build +
 * acceptance gates (BPF-33) validate the merged result. Same thesis as
 * BPF-26..33: absorb the OSS structural defect deterministically.
 *
 * Conservative: only acts when BOTH dirs exist; copies files (never directories
 * wholesale) so partial trees merge cleanly; never throws.
 */

import * as path from 'path';

export interface DualAppDirResolution {
    readonly merged: boolean;
    /** Files moved from src/app → app (repo-relative, forward-slashed). */
    readonly movedFiles: readonly string[];
}

function isDir(p: string, fsImpl: typeof import('fs')): boolean {
    try {
        return fsImpl.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * If both `app/` and `src/app/` exist, merge the shadowed `src/app/` into the
 * active root `app/` (overwriting) and remove `src/app/`. No-op otherwise.
 * Never throws.
 */
export function resolveDualAppDir(
    repoPath: string,
    fsImpl: typeof import('fs'),
): DualAppDirResolution {
    const rootApp = path.join(repoPath, 'app');
    const srcApp = path.join(repoPath, 'src', 'app');
    if (!isDir(rootApp, fsImpl) || !isDir(srcApp, fsImpl)) {
        return { merged: false, movedFiles: [] };
    }

    const moved: string[] = [];
    try {
        const walk = (dir: string): void => {
            let entries: import('fs').Dirent[];
            try {
                entries = fsImpl.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.isFile()) {
                    const relToSrcApp = path.relative(srcApp, full);
                    const dest = path.join(rootApp, relToSrcApp);
                    try {
                        fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
                        fsImpl.copyFileSync(full, dest);
                        moved.push(path.join('app', relToSrcApp).replace(/\\/g, '/'));
                    } catch {
                        // a single-file failure must not abort the merge
                    }
                }
            }
        };
        walk(srcApp);

        // Remove the now-redundant shadow dir so Next has exactly one app root.
        try {
            fsImpl.rmSync(srcApp, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
    } catch {
        return { merged: moved.length > 0, movedFiles: moved };
    }

    return { merged: moved.length > 0, movedFiles: moved };
}
