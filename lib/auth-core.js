import crypto from "node:crypto";
import { getDb } from "./db.js";

export const SESSION_COOKIE = "viper_session";
// F-07: idle timeout, not a flat 30 days. A session dies after IDLE_MS of
// inactivity; activity rolls it forward, capped at ABSOLUTE_MS total lifetime.
const IDLE_MS = 3 * 24 * 3600 * 1000;       // logged out after 3 days idle
const ABSOLUTE_MS = 30 * 24 * 3600 * 1000;  // hard cap regardless of activity
export const SESSION_MAXAGE_S = Math.floor(ABSOLUTE_MS / 1000);
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
  const now = Date.now();
  await db.query(
    "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)",
    [token, userId, now + IDLE_MS, now]
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
    `SELECT u.id, u.email, u.name, u.role, u.active, u.hash, u.visible_password, u.headshot, u.signature_image,
            u.totp_enabled, s.expires_at, s.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token]
  );
  const row = rows[0];
  const now = Date.now();
  if (!row || Number(row.expires_at) < now || !row.active) return null;
  // Idle-rolling: extend on activity, but write at most ~once per 6h and never
  // past the absolute cap. Cheap enough for the hot path.
  const idleEnd = now + IDLE_MS;
  const absoluteCap = Number(row.created_at || 0) + ABSOLUTE_MS;
  const target = Math.min(idleEnd, absoluteCap || idleEnd);
  if (target - Number(row.expires_at) > 6 * 3600 * 1000) {
    await db.query("UPDATE sessions SET expires_at = $1 WHERE token = $2", [target, token]);
  }
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
