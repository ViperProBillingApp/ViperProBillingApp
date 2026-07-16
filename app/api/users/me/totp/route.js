import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db.js";
import { getSessionUser, verifyPassword } from "../../../../../lib/auth.js";
import { generateSecret, otpauthUri, verifyTotp } from "../../../../../lib/totp.js";
import { writeAudit } from "../../../../../lib/security.js";

// Self-service TOTP enrollment. Actions: start | enable | disable.
export async function POST(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { action, code, password } = await req.json().catch(() => ({}));
  const db = await getDb();

  if (action === "start") {
    const secret = generateSecret();
    // stored pending — not active until confirmed with a code
    await db.query("UPDATE users SET totp_secret = $1, totp_enabled = false WHERE id = $2", [secret, me.id]);
    return NextResponse.json({ secret, otpauth: otpauthUri(secret, me.email) });
  }

  if (action === "enable") {
    const { rows } = await db.query("SELECT totp_secret FROM users WHERE id = $1", [me.id]);
    const secret = rows[0]?.totp_secret;
    if (!secret) return NextResponse.json({ error: "Start enrollment first." }, { status: 400 });
    if (!verifyTotp(secret, code)) return NextResponse.json({ error: "That code didn't match. Check your authenticator app." }, { status: 400 });
    await db.query("UPDATE users SET totp_enabled = true WHERE id = $1", [me.id]);
    await writeAudit({ actorId: me.id, actorEmail: me.email, action: "mfa.enabled", req });
    return NextResponse.json({ ok: true });
  }

  if (action === "disable") {
    // require the current password to turn 2FA off
    const { rows } = await db.query("SELECT hash FROM users WHERE id = $1", [me.id]);
    if (!verifyPassword(String(password || ""), rows[0]?.hash || "")) {
      return NextResponse.json({ error: "Enter your current password to disable two-factor." }, { status: 400 });
    }
    await db.query("UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE id = $1", [me.id]);
    await writeAudit({ actorId: me.id, actorEmail: me.email, action: "mfa.disabled", req });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
