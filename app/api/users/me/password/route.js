import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db.js";
import { getSessionUser, hashPassword } from "../../../../../lib/auth.js";

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
  return NextResponse.json({ ok: true });
}
