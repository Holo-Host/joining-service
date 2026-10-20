import { configDefaults, defineConfig } from 'vitest/config';

// Only this checkout's tests. Without an explicit exclude, vitest also
// collects test files from git worktrees under .claude/worktrees/, which
// run against their own stale node_modules and fail for unrelated reasons.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
