import { defineConfig } from "vitest/config";

/**
 * Backend test runner configuration.
 * Tests exercise the Hono app directly via `createApp().request()`, so no
 * Workers runtime or deployed resources are required in Phase 0.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
