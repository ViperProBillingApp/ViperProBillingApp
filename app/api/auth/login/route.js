import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { verifyPassword, createSession, SESSION_COOKIE, SESSION_MAXAGE_S } from "../../../../lib/auth.js";
import { verifyTotp } from "../../../../lib/totp.js";
import { rateLimit, clearRate, writeAudit, clientIp } from "../../../../lib/security.js";

const MAX_PER_IP = 20;      // failed attempts / window / IP
const MAX_PER_EMAIL = 8;    // failed attempts / window / account
const WINDOW_MS = 15 * 60 * 1000;

export async function POST(req) {
  const { email, password, code } = await req.json().catch(() => ({}));
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }
  const ip = clientIp(req);
  const emailKey = `login:email:${String(email).trim().toLowerCase()}`;
  const ipKey = `login:ip:${ip}`;
  // F-05: throttle before touching the DB. Count without recording; record only failures below.
  const ipHit = await rateLimit(ipKey, MAX_PER_IP, WINDOW_MS, { record: false });
  const emailHit = await rateLimit(emailKey, MAX_PER_EMAIL, WINDOW_MS, { record: false });
  if (ipHit.limited || emailHit.limited) {
    await writeAudit({ actorEmail: email, action: "login.throttled", req });
    return NextResponse.json({ error: "Too many attempts. Wait a few minutes and try again." }, { status: 429 });
  }

  const db = await getDb();
  const { rows } = await db.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [String(email).trim()]);
  const user = rows[0];
  const fail = async (reason) => {
    await rateLimit(ipKey, MAX_PER_IP, WINDOW_MS);
    await rateLimit(emailKey, MAX_PER_EMAIL, WINDOW_MS);
    await writeAudit({ actorId: user?.id || null, actorEmail: email, action: "login.failed", detail: reason, req });
  };

  if (!user || !user.active || !verifyPassword(String(password), user.hash)) {
    await fail(!user ? "no such user" : !user.active ? "inactive" : "bad password");
    return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
  }
  // F-02: second factor. Don't reveal MFA status until the password is correct.
  if (user.totp_enabled) {
    if (!code) return NextResponse.json({ mfaRequired: true }, { status: 200 });
    if (!verifyTotp(user.totp_secret, code)) {
      await fail("bad totp");
      return NextResponse.json({ mfaRequired: true, error: "Incorrect authentication code." }, { status: 401 });
    }
  }

  await clearRate(emailKey);
  const token = await createSession(user.id);
  await writeAudit({ actorId: user.id, actorEmail: user.email, action: "login.success", req });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAXAGE_S,
  });
  return res;
}
