import crypto from "node:crypto";

// F-01 encryption-at-rest. AES-256-GCM (authenticated) via node:crypto — no dep.
// DORMANT until ENCRYPTION_KEY is set: with no key, encStr/decStr are identity,
// so the app stores plaintext exactly as before. Set ENCRYPTION_KEY to a 32-byte
// key (64 hex chars or base64), IDENTICAL across every environment sharing the
// DB (Vercel + .env.local). Losing the key makes encrypted secrets unrecoverable.
const ALG = "aes-256-gcm";
const PREFIX = "enc:v1:";

function key() {
  const k = process.env.ENCRYPTION_KEY;
  if (!k) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(k) ? Buffer.from(k, "hex") : Buffer.from(k, "base64");
  if (buf.length !== 32) { console.error("ENCRYPTION_KEY must be 32 bytes (64 hex or base64) — encryption disabled"); return null; }
  return buf;
}

export function encryptionActive() { return !!key(); }

// Encrypt a string. No-op when: dormant (no key), empty, or already encrypted
// (idempotent — safe to call on a mix of plaintext and ciphertext during migration).
export function encStr(plain) {
  const k = key();
  if (!k || typeof plain !== "string" || plain === "" || plain.startsWith(PREFIX)) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALG, k, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
}

// Decrypt. Plaintext (no prefix) passes through unchanged (migration-safe). An
// encrypted value with no/wrong key returns "" — never leak ciphertext as if a secret.
export function decStr(val) {
  if (typeof val !== "string" || !val.startsWith(PREFIX)) return val;
  const k = key();
  if (!k) { console.error("encrypted value present but ENCRYPTION_KEY unset"); return ""; }
  const [, , ivh, tagh, cth] = val.split(":");
  try {
    const d = crypto.createDecipheriv(ALG, k, Buffer.from(ivh, "hex"));
    d.setAuthTag(Buffer.from(tagh, "hex"));
    return Buffer.concat([d.update(Buffer.from(cth, "hex")), d.final()]).toString("utf8");
  } catch (e) { console.error("decrypt failed:", e.message); return ""; }
}

// Self-check: ENCRYPTION_KEY=<64 hex> node lib/crypto.js  (and without, for dormant)
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import("node:assert")).default;
  if (encryptionActive()) {
    const s = "portal-pw-2BUK2020";
    const e = encStr(s);
    assert.ok(e.startsWith(PREFIX) && e !== s, "encrypts");
    assert.equal(decStr(e), s, "round-trips");
    assert.equal(encStr(e), e, "idempotent on ciphertext");
    assert.equal(decStr("plain"), "plain", "plaintext passes through");
    assert.equal(encStr(""), "", "empty untouched");
    console.log("crypto: active — all checks passed");
  } else {
    assert.equal(encStr("x"), "x", "dormant: encrypt is identity");
    assert.equal(decStr("x"), "x", "dormant: decrypt is identity");
    console.log("crypto: dormant (no ENCRYPTION_KEY) — identity checks passed");
  }
}
