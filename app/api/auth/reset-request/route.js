import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { createResetToken } from "../../../../lib/auth.js";
import { sendResetEmail } from "../../../../lib/email.js";
import { rateLimit, clientIp } from "../../../../lib/security.js";

// Always responds ok — never reveals whether an email is registered.
export async function POST(req) {
  const { email } = await req.json().catch(() => ({}));
  const emailConfigured = !!process.env.BREVO_API_KEY;
  // Throttle reset-link sends per IP so the route can't be used to spam inboxes.
  const { limited } = await rateLimit(`reset:ip:${clientIp(req)}`, 10, 15 * 60 * 1000);
  if (email && emailConfigured && !limited) {
    const db = await getDb();
    const { rows } = await db.query(
      "SELECT id, name, email, active FROM users WHERE LOWER(email) = LOWER($1)",
      [String(email).trim()]
    );
    const user = rows[0];
    if (user && user.active) {
      const token = await createResetToken(user.id);
      const base = process.env.APP_URL || new URL(req.url).origin;
      await sendResetEmail(user.email, user.name, `${base}/reset?token=${token}`);
    }
  }
  return NextResponse.json({ ok: true, emailConfigured });
}
