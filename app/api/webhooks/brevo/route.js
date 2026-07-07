import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";

// Brevo transactional event webhook → flag the matching client's email as bad.
// Public, unauthenticated route by nature — guarded by a shared secret Brevo
// sends as a custom header (X-Brevo-Secret) or ?secret= query param.
// ponytail: mutates the whole-state blob (last-write-wins with the UI's saves);
// fine at this volume, revisit if clients move to per-row storage.

const BOUNCE_EVENTS = new Set(["hard_bounce", "invalid_email", "blocked", "error"]);
const SOFT_EVENTS = new Set(["soft_bounce", "deferred"]);

function authorized(req) {
  const want = process.env.BREVO_WEBHOOK_SECRET;
  if (!want) return false; // not configured = closed
  const got = req.headers.get("x-brevo-secret") || new URL(req.url).searchParams.get("secret");
  return got === want;
}

export async function POST(req) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const ev = await req.json().catch(() => null);
  const email = (ev?.email || "").trim().toLowerCase();
  const event = ev?.event || "";
  if (!email || !event) return NextResponse.json({ ok: true, ignored: "no email/event" });

  let status = null;
  if (BOUNCE_EVENTS.has(event)) status = "bounced";
  else if (SOFT_EVENTS.has(event)) status = "undelivered";
  const optOut = event === "unsubscribed" || event === "spam";
  if (!status && !optOut) return NextResponse.json({ ok: true, ignored: event });

  const db = getDb();
  const row = db.prepare("SELECT value FROM kv WHERE key = 'state'").get();
  if (!row) return NextResponse.json({ ok: true, ignored: "no state yet" });
  const state = JSON.parse(row.value);

  let matched = 0;
  for (const c of state.clients || []) {
    if ((c.email || "").trim().toLowerCase() !== email) continue;
    matched++;
    if (status) c.emailStatus = status;
    if (optOut && !(c.tags || []).includes("opted-out")) c.tags = [...(c.tags || []), "opted-out"];
    c.activity = [
      { at: new Date().toISOString(), type: "email", text: `Brevo: ${event} for ${email}` },
      ...(c.activity || []),
    ].slice(0, 200);
  }
  if (matched) {
    db.prepare("UPDATE kv SET value = ? WHERE key = 'state'").run(JSON.stringify(state));
  }
  return NextResponse.json({ ok: true, event, matched });
}

// Brevo pings the URL on setup with a GET/HEAD; answer so validation passes.
export async function GET() {
  return NextResponse.json({ ok: true, service: "viper-crm brevo webhook" });
}
