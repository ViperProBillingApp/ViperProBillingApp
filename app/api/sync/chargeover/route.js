import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { coConfigured, fetchAllCustomers, mapCustomer, mergeCustomers, backfillRecurringAmounts, fetchOverdueMap } from "../../../../lib/chargeover.js";
import { updateState } from "../../../../lib/clients.js";

// Long-ish job; give it room (customer fetch + a bounded batch of invoice lookups).
export const maxDuration = 60;

async function runSync() {
  const db = await getDb();
  // Slow network work OUTSIDE the guarded write, so retries don't re-fetch.
  const customers = await fetchAllCustomers();
  const overdue = await fetchOverdueMap().catch(() => null); // best-effort; falls back to raw balance
  const mapped = customers.map(mapCustomer);
  let added = 0, updated = 0, filled = 0, remaining = 0;
  // Merge + backfill INSIDE updateState so it re-applies against fresh state if
  // a UI save lands during the sync — the merge no longer clobbers that save.
  const res = await updateState(db, async (state) => {
    const merged = mergeCustomers(state, mapped, overdue);
    added = merged.added; updated = merged.updated;
    const bf = await backfillRecurringAmounts(merged.clients);
    filled = bf.filled; remaining = bf.remaining;
    return { clients: merged.clients, settings: state.settings || {} };
  });
  if (!res.ok) return { ok: false, error: "Sync could not commit after repeated concurrent saves — try again." };
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
