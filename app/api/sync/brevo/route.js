import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { brevoConfigured, syncBrevoContacts } from "../../../../lib/brevo.js";
import { readState } from "../../../../lib/clients.js";

export const maxDuration = 60;

// Read-only against CRM client state (no updateState — this only pushes to
// Brevo, it never writes a client's data), so there's no rev/mirror concern
// here. The one thing persisted is the rotation cursor, in the generic kv
// table (same spot the daily digest keeps its snapshot history) — plain
// enough not to need its own table.
async function runSync() {
  const db = await getDb();
  const state = await readState(db);
  const row = await db.query("SELECT value FROM kv WHERE key = 'brevo_sync_cursor'");
  const cursor = row.rows[0] ? JSON.parse(row.rows[0].value) : 0;
  const res = await syncBrevoContacts(state.clients || [], cursor);
  await db.query(
    "INSERT INTO kv (key, value) VALUES ('brevo_sync_cursor', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [JSON.stringify(res.nextCursor)]
  );
  return { ok: true, ...res };
}

// Nightly Vercel Cron — authenticated by the CRON_SECRET bearer Vercel injects.
export async function GET(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!brevoConfigured()) return NextResponse.json({ error: "Brevo isn't configured" }, { status: 501 });
  try {
    return NextResponse.json(await runSync());
  } catch (e) {
    return NextResponse.json({ error: String(e.message) }, { status: 502 });
  }
}

// Manual trigger — admins only. No UI button wired up yet; call directly
// (e.g. via curl with a session cookie) to force a run without waiting for
// the nightly cron.
export async function POST() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });
  if (!brevoConfigured()) return NextResponse.json({ error: "Brevo isn't configured" }, { status: 501 });
  try {
    return NextResponse.json(await runSync());
  } catch (e) {
    return NextResponse.json({ error: String(e.message) }, { status: 502 });
  }
}
