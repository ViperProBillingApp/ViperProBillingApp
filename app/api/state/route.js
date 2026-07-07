import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db.js";
import { getSessionUser } from "../../../lib/auth.js";

// ponytail: whole-state blob, last-write-wins — mirrors the prototype's storage.
// Move to per-client rows when the ChargeOver sync lands.
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const db = await getDb();
  const { rows } = await db.query("SELECT value FROM kv WHERE key = 'state'");
  return NextResponse.json(rows[0] ? JSON.parse(rows[0].value) : { clients: [], settings: null });
}

export async function PUT(req) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.clients)) {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }
  const db = await getDb();
  await db.query(
    "INSERT INTO kv (key, value) VALUES ('state', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [JSON.stringify({ clients: body.clients, settings: body.settings || {} })]
  );
  return NextResponse.json({ ok: true });
}
