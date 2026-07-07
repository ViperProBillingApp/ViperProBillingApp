import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db.js";
import { getSessionUser, hashPassword, verifyPassword } from "../../../../../lib/auth.js";

export async function POST(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { current, next } = await req.json().catch(() => ({}));
  if (!current || !next) return NextResponse.json({ error: "Both passwords are required." }, { status: 400 });
  if (String(next).length < 8) return NextResponse.json({ error: "New password must be at least 8 characters." }, { status: 400 });
  if (!verifyPassword(String(current), me.hash)) {
    return NextResponse.json({ error: "Current password is incorrect." }, { status: 401 });
  }
  getDb().prepare("UPDATE users SET hash = ? WHERE id = ?").run(hashPassword(String(next)), me.id);
  return NextResponse.json({ ok: true });
}
