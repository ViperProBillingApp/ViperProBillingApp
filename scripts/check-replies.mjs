// Smallest check that fails if reply-token or reply-matching logic breaks.
// Pure logic only — no DB, no network. Run: npm run check
import assert from "node:assert";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  || "0".repeat(64); // deterministic key for the pure-logic checks

const { mintReplyToken, verifyReplyToken, tokenFromAddress } =
  await import("../lib/replytoken.js");

// mint → verify round trip
const tok = mintReplyToken("k3f9a2xq");
assert.ok(tok, "token should mint");
assert.strictEqual(verifyReplyToken(tok), "k3f9a2xq", "round trip returns the client id");

// forged / tampered tokens must be rejected
assert.strictEqual(verifyReplyToken("k3f9a2xq" + "deadbeef"), null, "bad mac rejected");
assert.strictEqual(verifyReplyToken("garbage"), null, "garbage rejected");
assert.strictEqual(verifyReplyToken(""), null, "empty rejected");
assert.strictEqual(verifyReplyToken(null), null, "null rejected");

// a different client id must not verify against another's mac
const other = mintReplyToken("zzzzzzzz");
assert.notStrictEqual(other, tok, "different ids give different tokens");
assert.strictEqual(verifyReplyToken("k3f9a2xq" + other.slice(-8)), null, "mac is bound to the id");

// address parsing
assert.strictEqual(
  tokenFromAddress(`droffey+crm-${tok}@vipeventresources.com`), tok, "extracts token from address");
assert.strictEqual(tokenFromAddress("droffey@vipeventresources.com"), null, "plain address has no token");
assert.strictEqual(tokenFromAddress(""), null, "empty address safe");

console.log("check-replies: OK");
