import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "."),
      // server-only throws outside Next.js runtime; stub it in Vitest.
      "server-only": resolve(import.meta.dirname, "./lib/__mocks__/server-only"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts", "./mocks/setup.ts"],
    passWithNoTests: true,
    // node_modules is served through the Docker bind mount, which on Windows is
    // slow enough that per-file worker startup times out ("Timeout waiting for
    // worker to respond"). Those files were silently skipped: the suite reported
    // 52 passing tests when 67 exist, and still exited 1 — a red suite that
    // looked green. One long-lived worker (mirroring the backend's `--runInBand`)
    // plus a shared environment removes the repeated startup cost.
    //
    // `isolate: false` trades per-file isolation for speed, so global state must
    // be reset between tests — `mocks/setup.ts` already calls
    // `server.resetHandlers()` and `vitest.setup.ts` runs `cleanup()`.
    pool: "threads",
    maxWorkers: 1,
    isolate: false,
  },
});
