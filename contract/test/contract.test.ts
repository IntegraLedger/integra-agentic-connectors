// The contract's checks: the document is valid OpenAPI 3.1 (checked with Ajv2020 against the published OAS 3.1 schema, pinned by its
// SHA-256); each refusal code an operation lists has the status the closed refusal table gives it (the README's
// table); every vector's request and expected answer validate against the operation's schemas; each stored ATR's
// bytes hash to the value the vector states (the values were computed with sha256sum and openssl dgst over bytes
// written by hand); every pattern an answer carries is its pairing's pattern in @integraledger/lcp's registry
// (BINDINGS); the embedded document and vectors equal the files they are written from; and a request with an extra
// member fails validation against the document.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import { BINDINGS, isRefusal, type Json, type LcpPattern } from "@integraledger/lcp";
import { exactEip3009, exactErc7710, requestCommitment } from "@integraledger/lcp/x402";
import {
  OPENAPI_BYTES,
  REFUSALS,
  VECTORS,
  type AgreementView,
  type IssueResponse,
  type Proves,
  type RecordView,
} from "../src/index.js";

const addFormats = addFormatsModule as unknown as (a: Ajv2020) => Ajv2020;
const OAS_SCHEMA_SHA256 = "da01ba28852cac0de53893797cb8d1942bc3b05084f526dcc216717dec314ed0";
const oasBytes = readFileSync(new URL("./data/oas-3.1-schema-2022-10-07.json", import.meta.url));
const doc = JSON.parse(Buffer.from(OPENAPI_BYTES).toString("utf8"));
const CONTRACT = "https://contract.test/seller-door";

type Schema = Record<string, unknown>;
/** The document's component references, pointed at one schema resource holding the components as `$defs`. */
function rewrite<T>(v: T): T {
  return JSON.parse(JSON.stringify(v).replaceAll('"#/components/schemas/', `"${CONTRACT}#/$defs/`)) as T;
}
function contractAjv(): Ajv2020 {
  const ajv = addFormats(new Ajv2020({ allErrors: true }));
  ajv.addSchema({ $id: CONTRACT, $defs: rewrite(doc.components.schemas) });
  return ajv;
}
const ajv = contractAjv();

/** The operation for a vector request: its path template, and its request and response schemas. */
function operation(method: string, path: string): { request?: Schema; response(status: number): Schema | undefined } {
  const key = path.startsWith("/status/") ? "/status/{atrHash}" : path;
  const op = doc.paths[key]?.[method.toLowerCase()];
  if (op === undefined) throw new Error(`no operation for ${method} ${path}`);
  const request = op.requestBody?.content?.["application/json"]?.schema;
  return {
    ...(request !== undefined ? { request: rewrite(request) } : {}),
    response(status: number) {
      const s = op.responses[String(status)]?.content?.["application/json"]?.schema;
      return s === undefined ? undefined : rewrite(s);
    },
  };
}

/** Each pairing's pattern in lcp's registry: the source of every pattern a vector's answer carries. */
const REGISTERED = new Map<string, LcpPattern>(BINDINGS.map((b) => [b.id, b.pattern]));

/**
 * The patterns an expected answer carries, each with its pairing: the issue answer's `pairings`, and the `proves` of a
 * claim or a record, with the record's agreement leg.
 */
function answered(body: Json): { pairing: string | undefined; pattern: LcpPattern; agreement: AgreementView | null }[] {
  const b = body as Record<string, unknown>;
  const found: { pairing: string | undefined; pattern: LcpPattern; agreement: AgreementView | null }[] = [];
  for (const p of (b["pairings"] as IssueResponse["pairings"] | undefined) ?? []) {
    found.push({ pairing: p.pairing, pattern: p.pattern, agreement: null });
  }
  const proves = b["proves"] as Proves | undefined;
  if (proves?.pattern) {
    const pairing = (b["pairing"] as string | undefined) ?? (b["settlement"] as RecordView["settlement"] | undefined)?.pairing;
    found.push({ pairing, pattern: proves.pattern, agreement: (b["agreement"] as AgreementView | null | undefined) ?? null });
  }
  return found;
}

/**
 * The refusal codes a response lists for one component: the code enum beside each reference to it in the response's
 * schema. `Refusal` is the door's; `RuntimeRefusal` is the runtime's in front of it.
 */
function codesOf(response: Schema, component: "Refusal" | "RuntimeRefusal"): string[] {
  const schema = (response["content"] as Record<string, { schema: Schema }> | undefined)?.["application/json"]?.schema;
  const branches = (schema?.["oneOf"] as Schema[] | undefined) ?? (schema !== undefined ? [schema] : []);
  return branches.flatMap((b) => {
    const all = b["allOf"] as [Schema, { properties: { code: { enum: string[] } } }] | undefined;
    return all?.[0]["$ref"] === `#/components/schemas/${component}` ? all[1].properties.code.enum : [];
  });
}

/** Every refusal code of one component each operation lists, with the status it is listed under. */
function listedCodes(component: "Refusal" | "RuntimeRefusal" = "Refusal"): { method: string; path: string; status: string; code: string }[] {
  const out: { method: string; path: string; status: string; code: string }[] = [];
  for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, { responses: Record<string, Schema> }>>)) {
    for (const [method, op] of Object.entries(item)) {
      for (const [status, response] of Object.entries(op.responses)) {
        for (const code of codesOf(response, component)) out.push({ method, path, status, code });
      }
    }
  }
  return out;
}

function check(schema: Schema, value: unknown): string[] {
  const validate = ajv.compile(schema);
  return validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

describe("the OpenAPI document", () => {
  it("the OAS 3.1 schema file is the published one, by SHA-256", () => {
    expect(createHash("sha256").update(oasBytes).digest("hex")).toBe(OAS_SCHEMA_SHA256);
  });

  it("openapi.json validates against the OAS 3.1 schema", () => {
    // The schema's dialect is JSON Schema 2020-12, where `format` is an annotation, so formats are not asserted here.
    // Ajv resolves `$dynamicAnchor` only at a schema's root, so each `{"$dynamicRef": "#meta"}` is read as the
    // `$ref` it resolves to when no dialect extends the schema: `#/$defs/schema`, the one `meta` anchor.
    const oas = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    const schema = JSON.parse(oasBytes.toString("utf8").replaceAll('"$dynamicRef": "#meta"', '"$ref": "#/$defs/schema"'));
    const validate = oas.compile(schema);
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(doc.openapi).toBe("3.1.1");
    // The document is versioned with the package.
    expect(doc.info.version).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    expect(doc.servers).toEqual([
      {
        url: "{doorBase}",
        description: "Every path in this document is under the door's base URL, its path prefix included: `POST /issue` is `POST {doorBase}/issue`.",
        variables: { doorBase: { default: "https://seller.example/door" } },
      },
    ]);
    // Every path is relative to the base URL, the way OpenAPI appends a path to its server's URL.
    for (const path of Object.keys(doc.paths)) expect(path, path).toMatch(/^\/[^/]/);
    expect(doc.components.securitySchemes.sellerCredential).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "isk_<base64url>" });
    expect(doc.paths["/openapi.json"].get.security).toEqual([]);
  });

  it("every request object refuses unknown members", () => {
    for (const name of ["IssueRequest", "Offer", "ContentSlot", "RequestCommitment", "ClaimRequest", "ReportOutcome", "ReportClosed"]) {
      expect(doc.components.schemas[name].additionalProperties, name).toBe(false);
    }
  });

  it("the refusal schema's codes are exactly the closed table", () => {
    expect([...doc.components.schemas.Refusal.properties.code.enum].sort()).toEqual(Object.keys(REFUSALS).sort());
  });

  it("each operation lists a door refusal code at the status the closed table gives it", () => {
    for (const { method, path, status, code } of listedCodes()) {
      expect(REFUSALS[code], `${method} ${path} ${code}`).toBe(Number(status));
    }
  });

  it("every code of the closed table is listed on some operation", () => {
    expect([...new Set(listedCodes().map((l) => l.code))].sort()).toEqual(Object.keys(REFUSALS).sort());
  });

  it("each operation lists 403 door/browser-origin: the door refuses any request that carries an Origin header", () => {
    // The README's first rule: "The door refuses any request that carries an `Origin` header (`403 door/browser-origin`)."
    for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, unknown>>)) {
      for (const method of Object.keys(item)) {
        const codes = listedCodes().filter((l) => l.path === path && l.method === method && l.status === "403");
        expect(codes.map((l) => l.code), `${method} ${path}`).toEqual(["door/browser-origin"]);
      }
    }
  });

  it("the runtime in front of the door answers codes of its own, none of them in the closed table", () => {
    const codes = (doc.components.schemas.RuntimeRefusal.properties.code.oneOf as { const: string }[]).map((c) => c.const);
    expect(codes).toEqual(["bad-request", "method-not-allowed", "request-timeout", "body-too-large", "fault", "at-capacity"]);
    for (const c of codes) expect(REFUSALS[c], c).toBeUndefined();
    expect(doc.components.schemas.RuntimeRefusal.required).toEqual(doc.components.schemas.Refusal.required);
  });

  it("each operation lists the runtime's answers at their HTTP statuses", () => {
    // Each code at the status HTTP gives its case: 400 and 431 a request that cannot be read (RFC 9110 §15.5.1, RFC 6585
    // §5), 405 a method not served (§15.5.6), 408 a request not received in time (§15.5.9), 413 content too large
    // (§15.5.14), 500 a fault (§15.6.1) and 503 a service unavailable for now (§15.6.4).
    const expected = [
      ["400", "bad-request"],
      ["405", "method-not-allowed"],
      ["408", "request-timeout"],
      ["413", "body-too-large"],
      ["431", "bad-request"],
      ["500", "fault"],
      ["503", "at-capacity"],
    ];
    for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, unknown>>)) {
      for (const method of Object.keys(item)) {
        const listed = listedCodes("RuntimeRefusal")
          .filter((l) => l.path === path && l.method === method)
          .map((l) => [l.status, l.code]);
        expect(listed, `${method} ${path}`).toEqual(expected);
      }
    }
  });

  it("each operation lists 405 door/method, the answer to a method its path does not serve", () => {
    for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, unknown>>)) {
      for (const method of Object.keys(item)) {
        const codes = listedCodes().filter((l) => l.path === path && l.method === method && l.status === "405");
        expect(codes.map((l) => l.code), `${method} ${path}`).toEqual(["door/method"]);
      }
    }
  });

  it("the record's and the agreement leg's states are the same closed lists in the types and the document", () => {
    // The states the seller door defines, `stale` the terminal one for a claimed leg that reached its cap. A key
    // missing from or added to either object is a type error against the union it is typed by.
    const record: Record<RecordView["state"], true> = { issued: true, settling: true, paid: true, closed: true, stale: true };
    const agreement: Record<AgreementView["state"], true> = { required: true, settling: true, recorded: true, stale: true };
    expect(doc.components.schemas.RecordView.properties.state.enum).toEqual(Object.keys(record));
    expect(doc.components.schemas.Agreement.properties.state.enum).toEqual(Object.keys(agreement));
  });

  it("states the bounds the door enforces", () => {
    const s = doc.components.schemas;
    expect(s.IssueRequest.properties.offers).toMatchObject({ minItems: 1, maxItems: 16 });
    expect(s.IssueRequest.properties.content).toMatchObject({ maxItems: 56 });
    expect(s.IssueRequest.properties.lifetimeSeconds).toMatchObject({ minimum: 1, maximum: 604800 });
    expect(s.IssueRequest.properties.mintRequestId.pattern).toBe("^[A-Za-z0-9._:-]{1,128}$");
    expect(s.Reference).toMatchObject({ minLength: 1, maxLength: 256 });
    expect(s.ClaimRequest.properties.network).toMatchObject({ maxLength: 64 });
  });

  it("a bound's description names the refusal code that answers it, at its status in the closed table", () => {
    // The codes are the refusal table's meanings: issue/input-bounds for the offer and slot counts, core/slot-name for a
    // slot name off its pattern, door/reference-required for a reference off its bound.
    const s = doc.components.schemas;
    const mapped: [string, string][] = [
      [s.IssueRequest.properties.offers.description, "issue/input-bounds"],
      [s.IssueRequest.properties.content.description, "issue/input-bounds"],
      [s.ContentSlot.properties.slot.description, "core/slot-name"],
      [s.Reference.description, "door/reference-required"],
    ];
    for (const [description, code] of mapped) {
      expect(description).toContain(`${REFUSALS[code]} \`${code}\``);
    }
  });

  it("RequestCommitment states the request-target bound the LCP package applies: 8192 characters", async () => {
    expect(doc.components.schemas.RequestCommitment.description).toContain("is at most 8192 characters");
    const at = (length: number) => requestCommitment({ method: "GET", target: `/${"a".repeat(length - 1)}`, body: new Uint8Array() });
    expect(isRefusal(await at(8192))).toBe(false);
    expect(await at(8193)).toMatchObject({ refused: true, code: "x402/request-too-large" });
  });

  it("LcpPattern admits the patterns the pairings publish, with and without a named instrument", () => {
    const schema = { $ref: `${CONTRACT}#/$defs/LcpPattern` };
    expect(check(schema, exactEip3009.pattern)).toEqual([]);
    expect(check(schema, exactErc7710.pattern)).toEqual([]);
  });
});

describe("the vectors", () => {
  it("are CV1 to CV10", () => {
    expect(Object.keys(VECTORS)).toEqual(["CV1", "CV2", "CV3", "CV4", "CV5", "CV6", "CV7", "CV8", "CV9", "CV10"]);
  });

  for (const [name, v] of Object.entries(VECTORS)) {
    it(`${name} · every request and expected answer validates against the operation's schemas`, () => {
      for (const step of v.steps) {
        const op = operation(step.request.method, step.request.path);
        if (op.request !== undefined) expect(check(op.request, step.request.body), `${name} request`).toEqual([]);
        const schema = op.response(step.expect.status);
        expect(schema, `${name} ${step.expect.status}`).toBeDefined();
        const body = step.expect.body as Record<string, unknown>;
        const answer = "code" in body ? { ...body, sentence: "s", correlationId: "c" } : body;
        expect(check(schema!, answer), `${name} ${step.expect.status}`).toEqual([]);
        if ("code" in body) expect(REFUSALS[body["code"] as string]).toBe(step.expect.status);
      }
    });

    it(`${name} · every pattern an answer carries is its pairing's pattern in lcp's registry`, () => {
      for (const step of v.steps) {
        for (const { pairing, pattern, agreement } of answered(step.expect.body)) {
          const registered = REGISTERED.get(pairing ?? "");
          expect(registered, `${name} ${pairing}`).toBeDefined();
          if (agreement === null) {
            expect(pattern, `${name} ${pairing}`).toEqual(registered);
          } else if (agreement.state === "recorded") {
            // The record names the recorded agreement in the statement's <network> and <transaction>.
            const statement = registered!.proves
              .replace("<network>", () => agreement.network!)
              .replace("<transaction>", () => agreement.transaction!);
            expect(pattern, `${name} ${pairing}`).toEqual({ ...registered, proves: statement });
          } else {
            // With no agreement recorded, the record states what is missing in place of the pairing's statement.
            const { proves: _missing, ...members } = pattern;
            const { proves: _statement, ...expected } = registered!;
            expect(members, `${name} ${pairing}`).toEqual(expected);
          }
        }
      }
    });

    it(`${name} · each stored ATR's bytes hash to the stated value`, () => {
      for (const step of v.steps) {
        if (step.stored === undefined) continue;
        expect(`0x${createHash("sha256").update(step.stored.bytes, "utf8").digest("hex")}`).toBe(step.stored.sha256);
      }
    });
  }

  it("CV1's stored bytes are 506 bytes, the fixed credential's digest is the stated one", () => {
    expect(Buffer.byteLength(VECTORS["CV1"]!.steps[0]!.stored!.bytes, "utf8")).toBe(506);
    const f = VECTORS["CV1"]!.fixed;
    expect(`0x${createHash("sha256").update(f.credential, "utf8").digest("hex")}`).toBe(f.credentialDigest);
    expect(f.credentialDigest).toBe("0xbc357689ffc51ab5e745f005b3df2faaab2c715f110e41fc56d4ca8fdead30d4");
  });

  it("the answers that carry a pattern, each checked against lcp's registry, are CV1, CV2, CV3, CV6, CV7, CV9 and CV10's", () => {
    const carrying = Object.entries(VECTORS)
      .filter(([, v]) => v.steps.some((step) => answered(step.expect.body).length > 0))
      .map(([name]) => name);
    expect(carrying).toEqual(["CV1", "CV2", "CV3", "CV6", "CV7", "CV9", "CV10"]);
  });

  it("OPENAPI_BYTES are openapi.json's bytes, and VECTORS are each vectors/CV<n>.json parsed, in number order", () => {
    expect(Buffer.from(OPENAPI_BYTES).equals(readFileSync(new URL("../openapi.json", import.meta.url)))).toBe(true);
    const files = readdirSync(new URL("../vectors/", import.meta.url))
      .filter((f) => /^CV[0-9]+\.json$/.test(f))
      .sort((a, b) => Number(a.slice(2, -5)) - Number(b.slice(2, -5)));
    expect(Object.keys(VECTORS)).toEqual(files.map((f) => f.slice(0, -5)));
    for (const f of files) {
      expect(VECTORS[f.slice(0, -5)], f).toEqual(JSON.parse(readFileSync(new URL(`../vectors/${f}`, import.meta.url), "utf8")));
    }
  });

  it("CV1's request with an extra member \"price\": 1 fails validation against the document", () => {
    const step = VECTORS["CV1"]!.steps[0]!;
    const op = operation("POST", "/issue");
    const extended = { ...(step.request.body as Record<string, unknown>), price: 1 };
    const errors = check(op.request!, extended);
    expect(errors.some((e) => e.includes("must NOT have additional properties"))).toBe(true);
  });
});
