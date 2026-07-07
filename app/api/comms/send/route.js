import { NextResponse } from "next/server";
import { getSessionUser } from "../../../../lib/auth.js";
import { sendClientEmail } from "../../../../lib/email.js";

// Review-first send: the UI shows the full email and staff click Send per
// client — this route sends exactly one message, no bulk endpoint on purpose.
export async function POST(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { to, name, subject, body } = await req.json().catch(() => ({}));
  if (!/^\S+@\S+\.\S+$/.test(String(to || ""))) {
    return NextResponse.json({ error: "No valid recipient email." }, { status: 400 });
  }
  if (!String(subject || "").trim() || !String(body || "").trim()) {
    return NextResponse.json({ error: "Subject and message are required." }, { status: 400 });
  }
  const ok = await sendClientEmail(String(to), String(name || ""), String(subject), String(body));
  if (!ok) return NextResponse.json({ error: "Send failed — Brevo not configured or rejected the message." }, { status: 502 });
  return NextResponse.json({ ok: true });
}
