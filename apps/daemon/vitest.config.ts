import { defineConfig } from "vitest/config";

// Tests run git for real, which is slow on a busy machine. The limit is for a test that hangs.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
