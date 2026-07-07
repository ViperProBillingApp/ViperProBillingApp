import crypto from "node:crypto";
import { getDb } from "./db.js";

export const SESSION_COOKIE = "viper_session";
const SESSION_MS = 30 * 24 * 3600 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `s1$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [v, saltHex, keyHex] = String(stored).split("$");
  if (v !== "s1" || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(keyHex, "hex");
  if (key.length !== expected.length) return false;
  return crypto.timingSafeEqual(key, expected);
}

export function generatePassword() {
  return crypto.randomBytes(9).toString("base64url"); // 12 chars
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  getDb()
    .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .run(token, userId, Date.now() + SESSION_MS);
  return token;
}

export function destroySession(token) {
  if (token) getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function destroyUserSessions(userId) {
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

const RESET_MS = 60 * 60 * 1000; // reset links live 1 hour

export function createResetToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  getDb()
    .prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(hash, userId, Date.now() + RESET_MS);
  return token;
}

// Returns the user_id and marks the token used, or null if invalid/expired/used.
export function consumeResetToken(token) {
  if (!token) return null;
  const hash = crypto.createHash("sha256").update(String(token)).digest("hex");
  const db = getDb();
  const row = db.prepare("SELECT user_id, expires_at, used FROM password_resets WHERE token_hash = ?").get(hash);
  if (!row || row.used || row.expires_at < Date.now()) return null;
  db.prepare("UPDATE password_resets SET used = 1 WHERE token_hash = ?").run(hash);
  return row.user_id;
}

export function userForToken(token) {
  if (!token) return null;
  const row = getDb()
    .prepare(
      "SELECT u.id, u.email, u.name, u.role, u.active, u.hash, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?"
    )
    .get(token);
  if (!row || row.expires_at < Date.now() || !row.active) return null;
  return row;
}
