import { NextResponse } from "next/server";
import { getSessionUser } from "../../../../lib/auth.js";
import { coConfigured, fetchInvoices, fetchRecurring } from "../../../../lib/chargeover.js";

// Live "past charges" + upcoming invoice for a client — any signed-in user can view.
export async function GET(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in", invoices: [] }, { status: 401 });
  const co = new URL(req.url).searchParams.get("co");
  if (!co) return NextResponse.json({ invoices: [] });
  if (!coConfigured()) return NextResponse.json({ error: "ChargeOver not connected", invoices: [] });
  try {
    const [invoices, rec] = await Promise.all([
      fetchInvoices(co),
      fetchRecurring(co).catch(() => null), // next-invoice info is best-effort
    ]);
    // ChargeOver pre-generates the upcoming invoice; when an open future-dated
    // one exists, IT is the next invoice — the package date points past it.
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = invoices
      .filter((i) => !i.voided && Number(i.balance) > 0 && String(i.date).slice(0, 10) >= today)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
    const next = upcoming
      ? { date: String(upcoming.date).slice(0, 10), amount: Number(upcoming.balance) }
      : rec?.next || null;
    return NextResponse.json({ invoices, next });
  } catch (e) {
    return NextResponse.json({ error: String(e.message), invoices: [] });
  }
}
