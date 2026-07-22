import { NextResponse } from "next/server";
import crypto from "crypto";
import { getDb } from "../../../../lib/db.js";
import { updateState } from "../../../../lib/clients.js";

// Brevo transactional event webhook → flag the matching client's email as bad.
// Public, unauthenticated route by nature — guarded by a shared secret Brevo
// sends as a custom header (X-Brevo-Secret). F-11: header only — a secret in the
// query string leaks via logs and referrers.
// ponytail: mutates the whole-state blob (last-write-wins with the UI's saves);
// fine at this volume, revisit if clients move to per-row storage.

const BOUNCE_EVENTS = new Set(["hard_bounce", "invalid_email", "blocked", "error"]);
const SOFT_EVENTS = new Set(["soft_bounce", "deferred"]);

function authorized(req) {
  const want = process.env.BREVO_WEBHOOK_SECRET;
  if (!want) return false; // not configured = closed
  const got = req.headers.get("x-brevo-secret") || "";
  // constant-time compare; equal-length buffers required, so guard length first
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

  const db = await getDb();
  let matched = 0;
  // Guarded write: re-applies against fresh state if a UI save lands concurrently.
  await updateState(db, (state) => {
    matched = 0;
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
    return matched ? { clients: state.clients } : null; // no match → skip write
  });
  return NextResponse.json({ ok: true, event, matched });
}

// Brevo pings the URL on setup with a GET/HEAD; answer so validation passes.
export async function GET() {
  return NextResponse.json({ ok: true, service: "viper-crm brevo webhook" });
}
