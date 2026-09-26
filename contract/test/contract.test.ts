// The contract's checks: the document is valid OpenAPI 3.1 (checked with Ajv2020 against the published OAS 3.1 schema, pinned by its
// SHA-256); every vector's request and expected answer validate against the operation's schemas; each stored ATR's
// bytes hash to the value the vector states (the values were computed with sha256sum and openssl dgst over bytes
// written by hand); and a request with an extra member fails validation against the document.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import { exactEip3009, exactErc7710 } from "@integraledger/lcp/x402";
import { OPENAPI_BYTES, REFUSALS, VECTORS } from "../src/index.js";

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
    expect(doc.info.version).toBe("0.1.0");
    expect(doc.servers).toEqual([{ url: "{doorBase}", variables: { doorBase: { default: "https://seller.example/door" } } }]);
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

  it("states the bounds the door enforces", () => {
    const s = doc.components.schemas;
    expect(s.IssueRequest.properties.offers).toMatchObject({ minItems: 1, maxItems: 16 });
    expect(s.IssueRequest.properties.content).toMatchObject({ maxItems: 56 });
    expect(s.IssueRequest.properties.lifetimeSeconds).toMatchObject({ minimum: 1, maximum: 604800 });
    expect(s.IssueRequest.properties.mintRequestId.pattern).toBe("^[A-Za-z0-9._:-]{1,128}$");
    expect(s.Reference).toMatchObject({ minLength: 1, maxLength: 256 });
    expect(s.ClaimRequest.properties.network).toMatchObject({ maxLength: 64 });
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

  it("CV1's request with an extra member \"price\": 1 fails validation against the document", () => {
    const step = VECTORS["CV1"]!.steps[0]!;
    const op = operation("POST", "/issue");
    const extended = { ...(step.request.body as Record<string, unknown>), price: 1 };
    const errors = check(op.request!, extended);
    expect(errors.some((e) => e.includes("must NOT have additional properties"))).toBe(true);
  });
});
