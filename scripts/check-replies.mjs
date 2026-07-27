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

// --- matching cascade ---
const { matchMessage } = await import("../lib/replies.js");

const ctx = {
  clientExists: (id) => ["k3f9a2xq", "other111"].includes(id),
  outboundIndex: new Map([["<sent-1@relay.brevo.com>", "other111"]]),
  clientsByEmail: new Map([
    ["solo@acme.com", ["k3f9a2xq"]],
    ["shared@group.com", ["k3f9a2xq", "other111"]],
  ]),
};
const base = { toAddresses: [], fromEmail: "", inReplyTo: "", references: [] };

// 1. token wins, and beats a conflicting header match
{
  const m = matchMessage({ ...base,
    toAddresses: [`droffey+crm-${tok}@vipeventresources.com`],
    references: ["<sent-1@relay.brevo.com>"], fromEmail: "someone@else.com" }, ctx);
  assert.deepStrictEqual([m.clientId, m.method, m.confidence], ["k3f9a2xq", "token", "high"],
    "valid token wins over conflicting header/sender signals");
}

// a forged token must NOT match, and must fall through to the next signal
{
  const m = matchMessage({ ...base,
    toAddresses: ["droffey+crm-k3f9a2xqdeadbeef@vipeventresources.com"],
    references: ["<sent-1@relay.brevo.com>"] }, ctx);
  assert.strictEqual(m.clientId, "other111", "forged token ignored, header used instead");
  assert.strictEqual(m.method, "headers", "method reflects the signal actually used");
}

// 2. header match scans ALL References, not just In-Reply-To
{
  const m = matchMessage({ ...base,
    references: ["<unknown@x.com>", "<sent-1@relay.brevo.com>"] }, ctx);
  assert.strictEqual(m.clientId, "other111", "matches any id in References");
}

// 3. sender fallback — one hit is confident, several is not
{
  const one = matchMessage({ ...base, fromEmail: "SOLO@acme.com" }, ctx);
  assert.deepStrictEqual([one.clientId, one.method, one.confidence], ["k3f9a2xq", "sender", "high"],
    "single sender match is high confidence and case-insensitive");

  const many = matchMessage({ ...base, fromEmail: "shared@group.com" }, ctx);
  assert.strictEqual(many.confidence, "low", "ambiguous sender is low confidence");
  assert.strictEqual(many.method, "sender", "still reports how it matched");
}

// a valid token also wins over a conflicting sender match
{
  const otherTok = mintReplyToken("other111");
  const m = matchMessage({ ...base,
    toAddresses: [`droffey+crm-${otherTok}@vipeventresources.com`],
    fromEmail: "solo@acme.com" }, ctx);
  assert.deepStrictEqual([m.clientId, m.method], ["other111", "token"],
    "valid token beats a conflicting sender match");
}

// 4. nothing matches → unmatched, never a guess
{
  const m = matchMessage({ ...base, fromEmail: "stranger@nowhere.com" }, ctx);
  assert.deepStrictEqual([m.clientId, m.method], [null, null], "no signal means unmatched");
}

// a token for a client that no longer exists must not resurrect it
{
  const gone = mintReplyToken("deleted1");
  const m = matchMessage({ ...base, toAddresses: [`droffey+crm-${gone}@vipeventresources.com`] }, ctx);
  assert.strictEqual(m.clientId, null, "token for a missing client does not match");
}

// --- gmail.js pure-function checks ---
const { htmlToText, extractToAddresses, extractReferences, isAutoReply } =
  await import("../lib/gmail.js");

// htmlToText: strips <script>/<style> CONTENT, converts <br>/</p> to newlines,
// decodes entities, and is bounded so hostile input can't burn the request.
{
  const html = "<style>.x{color:red}</style><script>alert(1)</script><p>Hi &amp; welcome&#8217;s here<br>Bye</p>";
  const text = htmlToText(html);
  assert.ok(!text.includes("alert(1)"), "script content stripped");
  assert.ok(!text.includes("color:red"), "style content stripped");
  assert.ok(text.includes("\n"), "br/</p> become newlines");
  assert.ok(text.includes("Hi & welcome’s here"), "named and numeric entities decoded");

  // Without the length cap this same input measures ~10s on this machine (the
  // regex scan is quadratic-ish on unclosed "<script" runs); capped it's ~1s.
  // The bound here is 3000ms rather than a tight 1000ms because wall-clock
  // timing is noisy under shared/loaded CI — this still fails hard if the cap
  // regresses (e.g. someone removes HTML_TO_TEXT_MAX_LEN), which is the point.
  const start = Date.now();
  const hostile = "<script".repeat(50_000);
  htmlToText(hostile);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 3000, `hostile input must resolve fast, took ${elapsed}ms`);
}

// Cc must be searched for a reply token, same as To/Delivered-To/X-Original-To.
{
  const payload = { headers: [{ name: "Cc", value: "droffey+crm-abc123@vipeventresources.com" }] };
  const addrs = extractToAddresses(payload);
  assert.ok(addrs.includes("droffey+crm-abc123@vipeventresources.com"), "Cc address is included");
}

// References splits on commas as well as whitespace.
{
  const payload = { headers: [{ name: "References", value: "<a@x.com>, <b@x.com> <c@x.com>" }] };
  assert.deepStrictEqual(extractReferences(payload), ["<a@x.com>", "<b@x.com>", "<c@x.com>"],
    "References splits on commas and whitespace");
}

// autoReply detection: true for known auto-reply signals, false for a normal message.
{
  const autoSubmitted = { headers: [{ name: "Auto-Submitted", value: "auto-replied" }] };
  assert.strictEqual(isAutoReply(autoSubmitted), true, "Auto-Submitted: auto-replied is an auto-reply");

  const bulk = { headers: [{ name: "Precedence", value: "bulk" }] };
  assert.strictEqual(isAutoReply(bulk), true, "Precedence: bulk is an auto-reply");

  const normal = { headers: [{ name: "Subject", value: "Re: invoice" }] };
  assert.strictEqual(isAutoReply(normal), false, "a normal message is not an auto-reply");
}

console.log("check-replies: OK");
