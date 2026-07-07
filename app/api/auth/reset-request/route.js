import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { createResetToken } from "../../../../lib/auth.js";
import { sendResetEmail } from "../../../../lib/email.js";

// Always responds ok — never reveals whether an email is registered.
export async function POST(req) {
  const { email } = await req.json().catch(() => ({}));
  const emailConfigured = !!process.env.BREVO_API_KEY;
  if (email && emailConfigured) {
    const user = getDb().prepare("SELECT id, name, email, active FROM users WHERE email = ?").get(String(email).trim());
    if (user && user.active) {
      const token = createResetToken(user.id);
      const base = process.env.APP_URL || new URL(req.url).origin;
      await sendResetEmail(user.email, user.name, `${base}/reset?token=${token}`);
    }
  }
  return NextResponse.json({ ok: true, emailConfigured });
}
