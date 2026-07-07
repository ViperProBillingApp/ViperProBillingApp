import { NextResponse } from "next/server";
import { getSessionUser } from "../../../../lib/auth.js";
import { coConfigured, fetchInvoices } from "../../../../lib/chargeover.js";

// Live "past charges" for a client — any signed-in user can view.
export async function GET(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in", invoices: [] }, { status: 401 });
  const co = new URL(req.url).searchParams.get("co");
  if (!co) return NextResponse.json({ invoices: [] });
  if (!coConfigured()) return NextResponse.json({ error: "ChargeOver not connected", invoices: [] });
  try {
    return NextResponse.json({ invoices: await fetchInvoices(co) });
  } catch (e) {
    return NextResponse.json({ error: String(e.message), invoices: [] });
  }
}
