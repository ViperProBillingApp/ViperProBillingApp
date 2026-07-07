import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { verifyPassword, createSession, SESSION_COOKIE } from "../../../../lib/auth.js";

// ponytail: no rate limiting — internal staff tool; add if ever exposed publicly
export async function POST(req) {
  const { email, password } = await req.json().catch(() => ({}));
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }
  const user = getDb().prepare("SELECT * FROM users WHERE email = ?").get(String(email).trim());
  if (!user || !user.active || !verifyPassword(String(password), user.hash)) {
    return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
  }
  const token = createSession(user.id);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 3600,
  });
  return res;
}
