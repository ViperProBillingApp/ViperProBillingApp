import crypto from "node:crypto";
import { getDb } from "./db.js";

export const SESSION_COOKIE = "viper_session";
const SESSION_MS = 30 * 24 * 3600 * 1000;
const RESET_MS = 60 * 60 * 1000; // reset links live 1 hour

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

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const db = await getDb();
  await db.query(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
    [token, userId, Date.now() + SESSION_MS]
  );
  return token;
}

export async function destroySession(token) {
  if (!token) return;
  const db = await getDb();
  await db.query("DELETE FROM sessions WHERE token = $1", [token]);
}

export async function destroyUserSessions(userId) {
  const db = await getDb();
  await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

export async function userForToken(token) {
  if (!token) return null;
  const db = await getDb();
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.role, u.active, u.hash, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token]
  );
  const row = rows[0];
  if (!row || Number(row.expires_at) < Date.now() || !row.active) return null;
  return row;
}

export async function createResetToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const db = await getDb();
  await db.query(
    "INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [hash, userId, Date.now() + RESET_MS]
  );
  return token;
}

// Returns the user_id and marks the token used, or null if invalid/expired/used.
export async function consumeResetToken(token) {
  if (!token) return null;
  const hash = crypto.createHash("sha256").update(String(token)).digest("hex");
  const db = await getDb();
  const { rows } = await db.query(
    "SELECT user_id, expires_at, used FROM password_resets WHERE token_hash = $1",
    [hash]
  );
  const row = rows[0];
  if (!row || row.used || Number(row.expires_at) < Date.now()) return null;
  await db.query("UPDATE password_resets SET used = true WHERE token_hash = $1", [hash]);
  return row.user_id;
}
