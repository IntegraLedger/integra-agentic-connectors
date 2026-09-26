import { defineConfig } from "vitest/config";

// The hooks that create and drop a Postgres database for a test file get 60 s.
export default defineConfig({ test: { hookTimeout: 60_000 } });
