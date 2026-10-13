import { defineConfig } from "vitest/config";

// Unit tests for pure modules only. Kept apart from vite.config.ts so tests
// don't load the React Router plugin (and with it the whole app). The
// Function extensions' pure logic is tested here too.
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts", "extensions/*/src/**/*.test.ts"],
    environment: "node",
  },
});
