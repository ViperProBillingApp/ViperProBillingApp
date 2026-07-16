import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db.js";
import { getSessionUser, hashPassword } from "../../../../../lib/auth.js";
import { writeAudit } from "../../../../../lib/security.js";

// F-01: self-reveal own stored password on demand (was shipped in /me before).
export async function GET(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  await writeAudit({ actorId: me.id, actorEmail: me.email, action: "password.self_revealed", req });
  return NextResponse.json({ visible_password: me.visible_password || null });
}

// No current-password check: the card shows the signed-in user their live
// password (visible_password) instead, so re-typing it proves nothing extra.
export async function POST(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { next } = await req.json().catch(() => ({}));
  if (!next) return NextResponse.json({ error: "New password is required." }, { status: 400 });
  if (String(next).length < 8) return NextResponse.json({ error: "New password must be at least 8 characters." }, { status: 400 });
  const db = await getDb();
  // keep the visible copy current so the "Current password" display stays truthful
  await db.query("UPDATE users SET hash = $1, visible_password = $2 WHERE id = $3", [hashPassword(String(next)), String(next), me.id]);
  await writeAudit({ actorId: me.id, actorEmail: me.email, action: "password.self_change", req });
  return NextResponse.json({ ok: true });
}
