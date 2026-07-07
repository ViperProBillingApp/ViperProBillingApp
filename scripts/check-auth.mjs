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

if (!process.env.DATABASE_URL) {
  console.log("auth checks passed (crypto only — set DATABASE_URL to also check sessions/reset tokens)");
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
