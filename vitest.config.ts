import { defineConfig } from "vitest/config";

// Unit tests for pure modules only. Kept apart from vite.config.ts so tests
// don't load the React Router plugin (and with it the whole app).
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    environment: "node",
  },
});
