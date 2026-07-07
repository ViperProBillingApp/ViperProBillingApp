import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { destroySession, SESSION_COOKIE } from "../../../../lib/auth.js";

export async function POST() {
  const jar = await cookies();
  destroySession(jar.get(SESSION_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
