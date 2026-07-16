import crypto from "node:crypto";

// RFC 6238 TOTP with node:crypto — no dependency. 30-second step, 6 digits,
// SHA-1 (what every authenticator app defaults to).
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP = 30;

export function generateSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = "", out = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function b32decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) bits += B32.indexOf(c).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", b32decode(secret)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

// Accepts the code for the current step ±1 (clock drift tolerance).
// `now` in ms, injectable for the self-check.
export function verifyTotp(secret, code, now = Date.now()) {
  if (!secret || !/^\d{6}$/.test(String(code || "").trim())) return false;
  const t = Math.floor(now / 1000 / STEP);
  const want = String(code).trim();
  for (let w = -1; w <= 1; w++) {
    // constant-time-ish compare per candidate
    const cand = hotp(secret, t + w);
    if (cand.length === want.length && crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(want))) return true;
  }
  return false;
}

export function otpauthUri(secret, email, issuer = "ViperPro") {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&period=${STEP}&digits=6`;
}

// Self-check: node lib/totp.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import("node:assert")).default;
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  const t = Math.floor(now / 1000 / STEP);
  const code = hotp(secret, t);
  assert.ok(verifyTotp(secret, code, now), "current code verifies");
  assert.ok(verifyTotp(secret, hotp(secret, t - 1), now), "previous step verifies (drift)");
  assert.ok(!verifyTotp(secret, "000000", now) || code === "000000", "wrong code rejected");
  assert.ok(!verifyTotp(secret, "12345", now), "malformed rejected");
  assert.ok(!verifyTotp(secret, hotp(secret, t + 5), now), "far-future step rejected");
  console.log("totp: all checks passed");
}
