import { getDb } from "./db.js";

// Server-side security ops shared by the routes: append-only audit log,
// DB-backed rate limiting (serverless-safe — an in-memory Map wouldn't survive
// cold starts or span function instances), and expired-row GC.

export function clientIp(req) {
  const xff = req.headers.get("x-forwarded-for");
  return (xff ? xff.split(",")[0] : req.headers.get("x-real-ip") || "").trim() || "unknown";
}

// Append-only: routes only ever INSERT. Never throws into the caller — an audit
// failure must not break the action, but it is logged to the server console.
export async function writeAudit({ actorId = null, actorEmail = "", action, entity = "", entityId = "", detail = "", req = null }) {
  try {
    const db = await getDb();
    await db.query(
      "INSERT INTO audit_log (ts, actor_id, actor_email, action, entity, entity_id, detail, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [Date.now(), actorId, String(actorEmail || ""), String(action), String(entity || ""), String(entityId || ""), typeof detail === "string" ? detail : JSON.stringify(detail), req ? clientIp(req) : ""]
    );
  } catch (e) {
    console.error("audit write failed:", e.message);
  }
}

// Count hits in the window; record this one. Returns { limited, count }.
// Fail-open on DB error so a throttle-table hiccup can't lock everyone out.
export async function rateLimit(key, max, windowMs, { record = true } = {}) {
  try {
    const db = await getDb();
    const since = Date.now() - windowMs;
    const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM rate_hits WHERE k = $1 AND ts > $2", [key, since]);
    const count = rows[0]?.n || 0;
    if (record) await db.query("INSERT INTO rate_hits (k, ts) VALUES ($1, $2)", [key, Date.now()]);
    return { limited: count >= max, count };
  } catch (e) {
    console.error("rate limit check failed:", e.message);
    return { limited: false, count: 0 };
  }
}

export async function clearRate(key) {
  try {
    const db = await getDb();
    await db.query("DELETE FROM rate_hits WHERE k = $1", [key]);
  } catch (e) { console.error("rate clear failed:", e.message); }
}

// Housekeeping run by the daily cron: drop expired sessions, used/old reset
// tokens, stale rate-limit rows, and trim the state-backup ring.
export async function gcExpired(keepBackups = 30) {
  const db = await getDb();
  const now = Date.now();
  await db.query("DELETE FROM sessions WHERE expires_at < $1", [now]);
  await db.query("DELETE FROM password_resets WHERE expires_at < $1", [now]);
  await db.query("DELETE FROM rate_hits WHERE ts < $1", [now - 24 * 3600 * 1000]);
  await db.query("DELETE FROM audit_log WHERE ts < $1", [now - 365 * 24 * 3600 * 1000]); // 1-year retention
  await db.query(
    "DELETE FROM state_backups WHERE id NOT IN (SELECT id FROM state_backups ORDER BY created_at DESC LIMIT $1)",
    [keepBackups]
  );
}

// Nightly full-state snapshot into the backup ring (F-04: automated backups,
// not just the manual kv snapshots that saved us before).
export async function snapshotState() {
  const db = await getDb();
  const { rows } = await db.query("SELECT value FROM kv WHERE key = 'state'");
  if (!rows[0]) return { backed: false, reason: "no state" };
  await db.query("INSERT INTO state_backups (created_at, value) VALUES ($1, $2)", [Date.now(), rows[0].value]);
  return { backed: true };
}
