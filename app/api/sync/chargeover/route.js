import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { coConfigured, fetchAllCustomers, mapCustomer, mergeCustomers, backfillRecurringAmounts, fetchOverdueMap } from "../../../../lib/chargeover.js";
import { mirrorClients, readState, encryptClients } from "../../../../lib/clients.js";

// Long-ish job; give it room (customer fetch + a bounded batch of invoice lookups).
export const maxDuration = 60;

async function runSync() {
  const db = await getDb();
  const state = await readState(db); // F-08 Phase 3: clients from rows
  const customers = await fetchAllCustomers();
  const overdue = await fetchOverdueMap().catch(() => null); // best-effort; falls back to raw balance
  const { clients, added, updated } = mergeCustomers(state, customers.map(mapCustomer), overdue);
  const { filled, remaining } = await backfillRecurringAmounts(clients);
  // bump the rev so open tabs holding pre-sync state can't clobber the sync
  const next = { clients: encryptClients(clients), settings: state.settings || {}, rev: (state.rev || 0) + 1 }; // F-01: encrypt at rest
  await db.query(
    "INSERT INTO kv (key, value) VALUES ('state', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [JSON.stringify(next)]
  );
  await mirrorClients(db, next.clients); // F-08 dark shadow
  return { ok: true, customers: customers.length, added, updated, amountsFilled: filled, amountsRemaining: remaining };
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
