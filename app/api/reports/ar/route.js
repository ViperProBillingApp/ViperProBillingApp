import { NextResponse } from "next/server";
import { getSessionUser } from "../../../../lib/auth.js";
import { coConfigured, fetchOpenInvoices } from "../../../../lib/chargeover.js";

export const maxDuration = 60;

// Live AR ageing rows straight from ChargeOver — fetched on demand when the
// Reports tab's ageing section is opened, not on every page view.
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!coConfigured()) return NextResponse.json({ error: "ChargeOver isn't connected." }, { status: 501 });
  try {
    return NextResponse.json({ invoices: await fetchOpenInvoices(), fetchedAt: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: String(e.message) }, { status: 502 });
  }
}
