// Smallest check that fails if the auth/security path breaks. Run: npm run check
// Crypto checks always run. Session/reset-token checks only run when
// DATABASE_URL is set (they use a throwaway user, cleaned up in `finally`).
import assert from "node:assert";
import crypto from "node:crypto";

const {
  hashPassword, verifyPassword, createSession, userForToken, destroySession,
  createResetToken, consumeResetToken,
} = await import("../lib/auth-core.js");

const h = hashPassword("correct horse");
assert.ok(verifyPassword("correct horse", h), "valid password should verify");
assert.ok(!verifyPassword("wrong horse", h), "wrong password must fail");
assert.ok(!verifyPassword("correct horse", "garbage"), "malformed hash must fail");
assert.notStrictEqual(hashPassword("x"), hashPassword("x"), "salts must differ");

// ChargeOver merge logic (pure, no DB) — match by id then email, preserve CRM fields
const { mapCustomer, mergeCustomers, unround } = await import("../lib/chargeover.js");
{
  // ChargeOver rounds a package price to whole cents per MONTH, so annual
  // figures come back a few cents out. Undo that, but only inside the window
  // the rounding can actually produce.
  assert.strictEqual(unround(399.96), 400, "$400/yr reported as 399.96");
  assert.strictEqual(unround(249.96), 250, "$250/yr reported as 249.96");
  assert.strictEqual(unround(649.92), 650, "$650/yr — the biggest undershoot seen");
  assert.strictEqual(unround(2000.04), 2000, "overshoot corrects too");
  assert.strictEqual(unround(3500.04), 3500, "overshoot at scale");
  assert.strictEqual(unround(40), 40, "an exact price is untouched");
  assert.strictEqual(unround(0), 0, "zero stays zero");
  // Genuinely non-round prices must survive — snapping these would invent money.
  assert.strictEqual(unround(20.83), 20.83, "a real $20.83/mo is not a rounding artefact");
  assert.strictEqual(unround(399.5), 399.5, "50c off a dollar is a real price");
  assert.strictEqual(unround(249.8), 249.8, "20c off is outside the rounding window");
}
{
  const m = mapCustomer({ customer_id: 42, company: "Acme", bill_contact: { name: "Jo", email: "JO@ACME.com" }, balance: 100 });
  assert.strictEqual(m.chargeoverId, "42", "maps customer_id");
  assert.strictEqual(m.email, "JO@ACME.com", "reads nested contact email");

  let st = { clients: [] };
  let r = mergeCustomers(st, [mapCustomer({ customer_id: 1, company: "A", bill_contact: { email: "a@a.com" } })]);
  assert.deepStrictEqual([r.added, r.updated], [1, 0], "new customer added");

  // Company is staff-curated (merges, renames, disambiguating group offices) —
  // ChargeOver's own customer-name field must NOT overwrite it once set, or a
  // manual rename silently reverts on the next nightly sync (this happened for
  // real: TAM's merge rename was undone with no activity log entry to explain why).
  r = mergeCustomers({ clients: r.clients }, [mapCustomer({ customer_id: 1, company: "A Renamed", bill_contact: { email: "a@a.com" } })]);
  assert.deepStrictEqual([r.added, r.updated, r.clients.length], [0, 1, 1], "same id updates, no duplicate");
  assert.strictEqual(r.clients[0].company, "A", "an existing company name is never overwritten by CO's own name");

  // A blank company DOES get filled in from ChargeOver — only overwriting is disallowed.
  r = mergeCustomers({ clients: [{ id: "y", chargeoverId: "2", email: "blank@b.com", company: "" }] }, [mapCustomer({ customer_id: 2, company: "Filled In", bill_contact: { email: "blank@b.com" } })]);
  assert.strictEqual(r.clients[0].company, "Filled In", "a blank company is filled in from ChargeOver");

  // Retired customers must never be re-created by a sync. Deleting a
  // ChargeOver-linked client used to be undone on the next sync, which silently
  // rebuilt it WITHOUT its email/contact (ChargeOver's /customer has neither).
  r = mergeCustomers({ clients: [] }, [mapCustomer({ customer_id: 69, company: "Hosts Destination Services, LLC" })]);
  assert.deepStrictEqual([r.added, r.clients.length], [0, 0], "retired CO id is not re-added by sync");
  r = mergeCustomers({ clients: [] }, [mapCustomer({ customer_id: 70, company: "Not retired" })]);
  assert.strictEqual(r.added, 1, "a non-retired id still syncs normally");

  // match an existing manual client by email; preserve its CRM-only fields
  st = { clients: [{ id: "x", chargeoverId: "", email: "b@b.com", company: "B", tags: ["vip"], segment: "viper-current" }] };
  r = mergeCustomers(st, [mapCustomer({ customer_id: 9, company: "B", bill_contact: { email: "B@B.com" } })]);
  assert.deepStrictEqual([r.added, r.updated], [0, 1], "email match updates existing");
  assert.strictEqual(r.clients[0].chargeoverId, "9", "backfills chargeoverId");
  assert.deepStrictEqual(r.clients[0].tags, ["vip"], "CRM-only fields preserved");
}

if (!process.env.DATABASE_URL) {
  console.log("auth + sync checks passed (crypto/merge only — set DATABASE_URL to also check sessions/reset tokens)");
  process.exit(0);
}

const { getDb } = await import("../lib/db.js");
const db = await getDb();
const email = `__checkauth_${crypto.randomBytes(4).toString("hex")}@example.invalid`;

try {
  const { rows } = await db.query(
    "INSERT INTO users (email, name, hash, role) VALUES ($1, 'T', $2, 'staff') RETURNING id",
    [email, h]
  );
  const userId = rows[0].id;

  const token = await createSession(userId);
  assert.strictEqual((await userForToken(token))?.email, email, "session should resolve to user");
  assert.strictEqual(await userForToken("nope"), null, "unknown token must not resolve");
  await destroySession(token);
  assert.strictEqual(await userForToken(token), null, "destroyed session must not resolve");

  // deactivated users are locked out even with a live session
  const token2 = await createSession(userId);
  await db.query("UPDATE users SET active = false WHERE id = $1", [userId]);
  assert.strictEqual(await userForToken(token2), null, "deactivated user must not resolve");
  await db.query("UPDATE users SET active = true WHERE id = $1", [userId]);

  // reset tokens: single-use, unknown/expired rejected
  const reset = await createResetToken(userId);
  assert.strictEqual(await consumeResetToken("bogus"), null, "unknown reset token must not resolve");
  assert.strictEqual(Number(await consumeResetToken(reset)), userId, "valid reset token resolves to user");
  assert.strictEqual(await consumeResetToken(reset), null, "reset token must be single-use");

  const expired = await createResetToken(userId);
  const eh = crypto.createHash("sha256").update(expired).digest("hex");
  await db.query("UPDATE password_resets SET expires_at = 1 WHERE token_hash = $1", [eh]);
  assert.strictEqual(await consumeResetToken(expired), null, "expired reset token must not resolve");

  console.log("auth checks passed");
} finally {
  await db.query("DELETE FROM users WHERE email = $1", [email]); // cascades sessions + resets
  await db.end();
}
process.exit(0);
