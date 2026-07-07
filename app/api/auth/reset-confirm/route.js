import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { consumeResetToken, hashPassword, destroyUserSessions } from "../../../../lib/auth.js";

export async function POST(req) {
  const { token, password } = await req.json().catch(() => ({}));
  if (!token || !password) return NextResponse.json({ error: "Missing token or password." }, { status: 400 });
  if (String(password).length < 8) return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  const userId = await consumeResetToken(String(token));
  if (!userId) return NextResponse.json({ error: "This reset link is invalid or has expired. Request a new one." }, { status: 400 });
  const db = await getDb();
  // user set this themselves via the link — admin's visible copy is now stale
  await db.query("UPDATE users SET hash = $1, visible_password = NULL WHERE id = $2", [hashPassword(String(password)), userId]);
  await destroyUserSessions(userId); // sign out everywhere after a reset
  return NextResponse.json({ ok: true });
}
