import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db.js";
import { getSessionUser } from "../../../lib/auth.js";

// Daily KPI snapshots written by /api/cron/daily — the Reports tab's trend data.
// Separate kv key from 'state', so it can never collide with the rev guard.
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const db = await getDb();
  const { rows } = await db.query("SELECT value FROM kv WHERE key = 'snapshots'");
  return NextResponse.json({ snapshots: rows[0] ? JSON.parse(rows[0].value) : [] });
}
