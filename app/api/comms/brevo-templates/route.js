import { NextResponse } from "next/server";
import { getSessionUser } from "../../../../lib/auth.js";

// Lists the account's Brevo transactional (SMTP) templates so staff can import
// them into the CRM's own template set. Read-only; admin only.
export async function GET() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const key = process.env.BREVO_API_KEY;
  if (!key) return NextResponse.json({ error: "Brevo isn't configured (no API key).", configured: false }, { status: 200 });
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/templates?limit=200&sort=desc", {
      headers: { "api-key": key, accept: "application/json" },
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return NextResponse.json({ error: d.message || "Brevo rejected the request." }, { status: 502 });
    const templates = (d.templates || []).map((t) => ({
      id: t.id, name: t.name || `Template ${t.id}`, subject: t.subject || "", html: t.htmlContent || "", active: t.isActive !== false,
    }));
    return NextResponse.json({ configured: true, templates });
  } catch {
    return NextResponse.json({ error: "Couldn't reach Brevo — try again." }, { status: 502 });
  }
}
