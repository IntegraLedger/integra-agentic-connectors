import { defineConfig } from "vitest/config";

// The hooks that create and drop a Postgres database for a test file get 60 s, and so does each test. Every wait the
// facilitator makes runs on a clock the test moves, so neither bound decides a verdict: each only stops a test that
// never ends.
export default defineConfig({ test: { hookTimeout: 60_000, testTimeout: 60_000 } });
