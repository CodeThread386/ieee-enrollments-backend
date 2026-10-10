import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.js"],
    // Each file starts its own in-memory MongoDB; first run downloads mongod.
    hookTimeout: 120000,
    testTimeout: 30000,
  },
});
