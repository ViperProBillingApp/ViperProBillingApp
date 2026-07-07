// Smallest check that fails if the auth/security path breaks. Run: npm run check
import assert from "node:assert";
import fs from "node:fs";

process.env.VIPER_DB = "/tmp/viper-check.db";
fs.rmSync(process.env.VIPER_DB, { force: true });

const { getDb } = await import("../lib/db.js");
const { hashPassword, verifyPassword, createSession, userForToken, destroySession } = await import("../lib/auth-core.js");

// password hashing
const h = hashPassword("correct horse");
assert.ok(verifyPassword("correct horse", h), "valid password should verify");
assert.ok(!verifyPassword("wrong horse", h), "wrong password must fail");
assert.ok(!verifyPassword("correct horse", "garbage"), "malformed hash must fail");
assert.notStrictEqual(hashPassword("x"), hashPassword("x"), "salts must differ");

// sessions
const db = getDb();
db.prepare("INSERT INTO users (email, name, hash, role) VALUES ('t@t.co', 'T', ?, 'staff')").run(h);
const userId = Number(db.prepare("SELECT id FROM users WHERE email = 't@t.co'").get().id);
const token = createSession(userId);
assert.strictEqual(userForToken(token)?.email, "t@t.co", "session should resolve to user");
assert.strictEqual(userForToken("nope"), null, "unknown token must not resolve");
destroySession(token);
assert.strictEqual(userForToken(token), null, "destroyed session must not resolve");

// deactivated users are locked out even with a live session
const token2 = createSession(userId);
db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(userId);
assert.strictEqual(userForToken(token2), null, "deactivated user must not resolve");

fs.rmSync(process.env.VIPER_DB, { force: true });
fs.rmSync(process.env.VIPER_DB + "-wal", { force: true });
fs.rmSync(process.env.VIPER_DB + "-shm", { force: true });
console.log("auth checks passed");
