import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { loadTestEnv } from "./test/helpers/env";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Mirror the tsconfig "@/*" path alias so tests can import modules that use
  // it internally (server actions do, throughout src/modules).
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    env: loadTestEnv(),
    // RLS policies are applied once here rather than in two competing
    // beforeAll hooks — see test/global-setup.ts.
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
