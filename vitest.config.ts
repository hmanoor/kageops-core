import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        exclude: [
            'node_modules',
            'dist',
            'projects/**',           // Agent-generated projects
            '.claude/worktrees/**',  // Worktree copies — still picked up via glob
        ],
        retry: 2,                    // Retry flaky tests (CI runners are slower)
        testTimeout: 10_000,         // 10s per test (default 5s too tight for CI)
    },
});
