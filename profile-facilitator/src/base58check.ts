/** Base58check encoding (Bitcoin's alphabet, a four-byte double-SHA-256 checksum), as Tron writes addresses. */
import { createHash } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function sha256(b: Uint8Array): Uint8Array {
  return createHash("sha256").update(b).digest();
}

export function base58check(payload: Uint8Array): string {
  const bytes = new Uint8Array(payload.length + 4);
  bytes.set(payload, 0);
  bytes.set(sha256(sha256(payload)).subarray(0, 4), payload.length);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
