// A facilitator that cannot start closes what it opened before it rejects: its store's pool, so no session of it stays
// open in Postgres, and its store's sweep.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveProfileFacilitator } from "../src/index.js";
import { controlledClock, freshDatabase, onLockedPort, until } from "./support.js";

let db: Awaited<ReturnType<typeof freshDatabase>>;

beforeEach(async () => {
  db = await freshDatabase();
});

afterEach(async () => {
  await db.drop();
});

/** The test database's URL with an application_name of its own, and the number of sessions that carry that name. */
function namedStore(): { url: string; sessions(): Promise<number> } {
  const name = `facilitator-start-${randomBytes(6).toString("hex")}`;
  const url = new URL(db.url);
  url.searchParams.set("application_name", name);
  return {
    url: url.toString(),
    async sessions() {
      const r = await db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1",
        [name],
      );
      return r.rows[0]?.n ?? -1;
    },
  };
}

describe("a facilitator that cannot start", () => {
  it("on a port another server holds rejects with the listen's error, and no session of its store stays open", async () => {
    const store = namedStore();
    const holder = createServer();
    const { port } = await onLockedPort(
      (p) =>
        new Promise<void>((resolve, reject) => {
          holder.once("error", reject);
          holder.listen(p, "127.0.0.1", () => resolve());
        }),
    );
    // The pool's idle timeout runs on this clock, which the test never moves: a session the facilitator leaves open
    // stays open, and the wait below never ends. pg-pool's end() resolves once each session is asked to end, before
    // Postgres has ended it, so the count is read until it reaches 0.
    const clock = controlledClock();
    try {
      await expect(
        serveProfileFacilitator({ listen: `127.0.0.1:${port}`, store: { url: store.url }, settleWaitMs: 3_000 }),
      ).rejects.toMatchObject({ code: "EADDRINUSE", syscall: "listen", address: "127.0.0.1", port });
      await until(async () => (await store.sessions()) === 0);
    } finally {
      clock.restore();
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});
