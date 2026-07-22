import { NextResponse } from "next/server";
import { getSessionUser } from "../../../../lib/auth.js";
import { sendClientEmail } from "../../../../lib/email.js";
import { rateLimit } from "../../../../lib/security.js";

// Review-first send: the UI shows the full email and staff click Send per
// client — this route sends one message per click. A per-user cap stops a
// hijacked session from turning the trusted sender into a spam relay.
export async function POST(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { limited } = await rateLimit(`comms:${me.id}`, 200, 60 * 60 * 1000);
  if (limited) return NextResponse.json({ error: "Send limit reached for this hour — pause and resume shortly." }, { status: 429 });
  const { to, name, subject, body, recipients, cc, from } = await req.json().catch(() => ({}));
  const okEmail = (e) => /^\S+@\S+\.\S+$/.test(String(e || ""));
  const normList = (arr, cap) => arr
    .map((r) => (typeof r === "string" ? { email: r } : r))
    .filter((r) => okEmail(r?.email)).slice(0, cap)
    .map((r) => ({ email: String(r.email), name: String(r.name || "") }));
  // Group-office sends pass a recipients array (all contacts across the group's offices)
  const list = Array.isArray(recipients) ? normList(recipients, 100) : null;
  const ccList = Array.isArray(cc) ? normList(cc, 20) : null;
  if (list ? list.length === 0 : !okEmail(to)) {
    return NextResponse.json({ error: "No valid recipient email." }, { status: 400 });
  }
  if (from !== undefined && !okEmail(from)) {
    return NextResponse.json({ error: "From must be a valid email address." }, { status: 400 });
  }
  if (!String(subject || "").trim() || !String(body || "").trim()) {
    return NextResponse.json({ error: "Subject and message are required." }, { status: 400 });
  }
  // sender's uploaded signature image rides along on every outgoing template
  const ok = await sendClientEmail(list || String(to), String(name || ""), String(subject), String(body), me.signature_image || "", { cc: ccList || undefined, from: from || undefined });
  if (!ok) return NextResponse.json({ error: "Send failed — Brevo not configured or rejected the message." }, { status: 502 });
  return NextResponse.json({ ok: true });
}
