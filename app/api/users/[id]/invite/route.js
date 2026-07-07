import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db.js";
import { getSessionUser, createResetToken } from "../../../../../lib/auth.js";
import { sendInviteEmail } from "../../../../../lib/email.js";

// Emails a staff member their username + a set-password link ("Email login").
export async function POST(req, { params }) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });
  if (!process.env.BREVO_API_KEY) {
    return NextResponse.json({ error: "Email isn't configured — set BREVO_API_KEY first." }, { status: 501 });
  }
  const { id } = await params;
  const userId = Number(id);
  const db = await getDb();
  const { rows } = await db.query("SELECT id, name, email, active FROM users WHERE id = $1", [userId]);
  const user = rows[0];
  if (!user) return NextResponse.json({ error: "User not found." }, { status: 404 });
  if (!user.active) return NextResponse.json({ error: "This user is blocked — restore access first." }, { status: 400 });

  const token = await createResetToken(userId);
  const base = process.env.APP_URL || new URL(req.url).origin;
  const sent = await sendInviteEmail(user.email, user.name, `${base}/reset?token=${token}`);
  if (!sent) return NextResponse.json({ error: "Couldn't send the email — check the Brevo key/sender." }, { status: 502 });
  return NextResponse.json({ ok: true, email: user.email });
}
