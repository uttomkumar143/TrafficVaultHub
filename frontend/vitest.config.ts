import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

/**
 * Frontend test runner configuration.
 * Reuses the Vite config (React plugin, `@/` alias) and adds a jsdom
 * environment plus Testing Library matchers.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      globals: false,
      include: ["src/**/*.test.{ts,tsx}"],
      setupFiles: ["./src/test/setup.ts"],
      css: false,
    },
  }),
);
