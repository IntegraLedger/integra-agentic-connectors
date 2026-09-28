// The store's record of the Polkadot scan: `since` moves on and never back, and `unread` holds every finalized block
// below it that a scan could not read, until a scan reads it. A scan's write keeps every block of the record that this
// scan did not read, so two scans of one id writing in either order lose no unread block. Expected values: those rules.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type SettlementStore } from "../src/store.js";
import { freshDatabase } from "./support.js";

const NETWORK = "polkadot:68d56f15f85d3136970ec16946040bc1";
const ID = "0xffdc62b15bc3b766b9915bebe37e6282aa5ea4344e32b495f464d4fa7557e6ab";

let db: Awaited<ReturnType<typeof freshDatabase>>;
let store: SettlementStore;

beforeEach(async () => {
  db = await freshDatabase();
  store = await openStore(db.url);
  await store.claim(NETWORK, ID, new Date(Date.now() + 600_000), 100);
});

afterEach(async () => {
  await store.close();
  await db.drop();
}, 60_000);

async function position(): Promise<{ since: number | null; unread: number[] }> {
  const r = await store.read(NETWORK, ID);
  if (r.state === "none") throw new Error("the row is gone");
  return { since: r.since, unread: r.unread };
}

describe("the unread record", () => {
  it("is empty at the claim", async () => {
    expect(await position()).toEqual({ since: 100, unread: [] });
  });

  it("gains the blocks a scan could not read, and since moves past them", async () => {
    await store.advance(NETWORK, ID, { from: 100, to: 200, unread: [150, 120], resolved: [] });
    expect(await position()).toEqual({ since: 200, unread: [120, 150] });
  });

  it("loses a block once a scan reads it again", async () => {
    await store.advance(NETWORK, ID, { from: 100, to: 200, unread: [120, 150], resolved: [] });
    await store.advance(NETWORK, ID, { from: 200, to: 210, unread: [150], resolved: [120] });
    expect(await position()).toEqual({ since: 210, unread: [150] });
  });

  it("loses a block a concurrent scan read in its range, and keeps one outside that range", async () => {
    await store.advance(NETWORK, ID, { from: 100, to: 200, unread: [150, 190], resolved: [] });
    // Another scan from the same claim read every block from 100 to 179, 150 included.
    await store.advance(NETWORK, ID, { from: 100, to: 180, unread: [], resolved: [] });
    expect(await position()).toEqual({ since: 200, unread: [190] });
  });

  it("keeps a block recorded by a scan that writes last, whichever scan read further", async () => {
    await store.advance(NETWORK, ID, { from: 100, to: 180, unread: [], resolved: [] });
    await store.advance(NETWORK, ID, { from: 100, to: 200, unread: [190], resolved: [] });
    expect(await position()).toEqual({ since: 200, unread: [190] });
  });

  it("never moves since back", async () => {
    await store.advance(NETWORK, ID, { from: 100, to: 200, unread: [], resolved: [] });
    await store.advance(NETWORK, ID, { from: 100, to: 150, unread: [], resolved: [] });
    expect(await position()).toEqual({ since: 200, unread: [] });
  });
});

describe("a stored answer", () => {
  it("is written once: a second final answer is not written", async () => {
    const success = { success: true as const, transaction: "0xaa-2", network: NETWORK, payer: "p" };
    expect(await store.answer(NETWORK, ID, success)).toBe(true);
    expect(await store.answer(NETWORK, ID, success)).toBe(false);
  });
});
