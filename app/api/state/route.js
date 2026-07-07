import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db.js";
import { getSessionUser } from "../../../lib/auth.js";

// ponytail: whole-state blob, last-write-wins — mirrors the prototype's storage.
// Move to per-client rows when the ChargeOver sync lands.
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const row = getDb().prepare("SELECT value FROM kv WHERE key = 'state'").get();
  return NextResponse.json(row ? JSON.parse(row.value) : { clients: [], settings: null });
}

export async function PUT(req) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.clients)) {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }
  getDb()
    .prepare("INSERT INTO kv (key, value) VALUES ('state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ clients: body.clients, settings: body.settings || {} }));
  return NextResponse.json({ ok: true });
}
