import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { coConfigured, fetchAllCustomers, mapCustomer, mergeCustomers } from "../../../../lib/chargeover.js";

// Long-ish job; give it room.
export const maxDuration = 60;

async function runSync() {
  const db = await getDb();
  const { rows } = await db.query("SELECT value FROM kv WHERE key = 'state'");
  const state = rows[0] ? JSON.parse(rows[0].value) : { clients: [], settings: {} };
  const customers = await fetchAllCustomers();
  const { clients, added, updated } = mergeCustomers(state, customers.map(mapCustomer));
  const next = { clients, settings: state.settings || {} };
  await db.query(
    "INSERT INTO kv (key, value) VALUES ('state', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [JSON.stringify(next)]
  );
  return { ok: true, customers: customers.length, added, updated };
}

// Nightly Vercel Cron — authenticated by the CRON_SECRET bearer Vercel injects.
export async function GET(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!coConfigured()) return NextResponse.json({ error: "ChargeOver keys not set" }, { status: 501 });
  try {
    return NextResponse.json(await runSync());
  } catch (e) {
    return NextResponse.json({ error: String(e.message) }, { status: 502 });
  }
}

// Manual "Sync ChargeOver" button — admins only.
export async function POST() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });
  if (!coConfigured()) {
    return NextResponse.json(
      { error: "ChargeOver isn't connected yet — add the public and private API keys." },
      { status: 501 }
    );
  }
  try {
    return NextResponse.json(await runSync());
  } catch (e) {
    return NextResponse.json({ error: String(e.message) }, { status: 502 });
  }
}
