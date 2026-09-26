---
title: The vectors
description: The contract's vectors - their format, what they fix, and how to replay them against a door or a test double.
---

# The vectors

The **vectors** are the shared test cases that fix the contract byte for byte. Each file in `contract/vectors/` is one
exchange with the seller door: the requests a connector sends, and the answers any door must give. They serve two
readers:

- **A door implementation** replays each step's request and checks its answer.
- **A connector** uses them as the answers of its test double, so its tests speak the real contract. This
  repository's `scripts/stand-in-door.mjs` is such a double.

The package exports them, parsed, as `VECTORS`. [The vectors reference](../reference/vectors.md) lists every step.

## The format

A vector is `{name, fixed, steps, source}`.

- `fixed` names every value the steps depend on: the tenant, its credential and that credential's SHA-256, the
  declared resources and their pairings, the storage base, the clock (Unix seconds) and the ATR identifiers the steps
  mint, in order. Where a step needs the agreement step, it also names the tenant's hosts and its agreement: the
  nominal payment's pairing, network, asset, payee, amount and time bound, and the `host` its URL is on when the
  tenant has more than one.
- Each step is `{agreed?, request, expect, stored?, storedFiles?}`:
  - `agreed`: the buyer's agreement payment for that record was recorded before the request, as
    `{atrHash, network, transaction}`;
  - `request`: `{method, path, headers, body}`;
  - `expect`: `{status, body, headers?}`;
  - `stored`: the file the step writes to the seller's storage, `{bytes, sha256}`;
  - `storedFiles`: the number of files the storage holds after the step.
- `source` names the command or public specification each expected value comes from.

A refusal's expected body names its `code` only: its `sentence` may be reworded, and its `correlationId` is checked
for presence.

## Replay the vectors against a door

A door that holds the vector's `fixed` state (the tenant, its credential, the resources, the clock and the ATR
identifiers) must give each step's answer. This program replays every vector against `SELLER_DOOR_URL` and compares
status, body and headers:

```ts title="replay.ts"
import { isDeepStrictEqual } from "node:util";
import { VECTORS } from "@integraledger/agentic-connectors";

const door = process.env.SELLER_DOOR_URL ?? "https://seller.example/door";

let failed = 0;
for (const [name, vector] of Object.entries(VECTORS)) {
  for (const [i, step] of vector.steps.entries()) {
    const init: RequestInit = { method: step.request.method, headers: step.request.headers };
    if (step.request.body !== undefined) init.body = JSON.stringify(step.request.body);
    const res = await fetch(`${door}${step.request.path}`, init);
    const body = (await res.json()) as Record<string, unknown>;
    const expected = step.expect.body as Record<string, unknown>;
    // A refusal is compared by its code; its sentence may be reworded and its correlation id varies.
    const got = "code" in expected ? { code: body["code"] } : body;
    const headersMatch = Object.entries(step.expect.headers ?? {}).every(([k, v]) => res.headers.get(k) === v);
    const ok = res.status === step.expect.status && isDeepStrictEqual(got, expected) && headersMatch;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name} step ${i + 1}: ${step.request.method} ${step.request.path} -> ${res.status}`);
  }
}
console.log(failed === 0 ? "every step answered as its vector expects" : `${failed} step(s) differ`);
```

```text output
ok   CV1 step 1: POST /issue -> 200
ok   CV2 step 1: POST /issue -> 200
ok   CV2 step 2: POST /issue -> 200
ok   CV3 step 1: POST /issue -> 200
ok   CV3 step 2: POST /issue -> 409
ok   CV4 step 1: POST /issue -> 422
ok   CV5 step 1: POST /issue -> 401
ok   CV5 step 2: POST /issue -> 403
ok   CV6 step 1: POST /issue -> 200
ok   CV6 step 2: POST /claim -> 200
ok   CV6 step 3: POST /claim -> 409
ok   CV7 step 1: POST /issue -> 200
ok   CV7 step 2: POST /report -> 202
ok   CV8 step 1: GET /status/0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad -> 404
ok   CV9 step 1: POST /issue -> 200
ok   CV9 step 2: POST /claim -> 422
ok   CV9 step 3: POST /report -> 200
ok   CV9 step 4: GET /status/0xcfa3a6589bf1e273ab105bb7144a2d5944af1caed14f58b39145d46842f825d8 -> 200
ok   CV10 step 1: POST /issue -> 200
ok   CV10 step 2: POST /report -> 200
ok   CV10 step 3: GET /status/0x61c55d46c99a6199e8917bfbbcf7cb59b19f731dbd15c7ab750e9c2a2c664b32 -> 200
every step answered as its vector expects
```

A real door also writes the ATR to storage: check each `stored` step's bytes at `<storageBase><atrHash>`, and that
their SHA-256 is `stored.sha256`.

## Check the stored bytes without a door

```ts title="stored.ts"
import { createHash } from "node:crypto";
import { VECTORS } from "@integraledger/agentic-connectors";

for (const [name, vector] of Object.entries(VECTORS)) {
  for (const step of vector.steps) {
    if (step.stored === undefined) continue;
    const h = `0x${createHash("sha256").update(step.stored.bytes, "utf8").digest("hex")}`;
    console.log(name, Buffer.byteLength(step.stored.bytes, "utf8"), h === step.stored.sha256 ? "ok" : "MISMATCH");
  }
}
```

```text output
CV1 506 ok
CV2 506 ok
CV3 506 ok
CV6 506 ok
CV7 506 ok
CV9 206 ok
CV10 206 ok
```
