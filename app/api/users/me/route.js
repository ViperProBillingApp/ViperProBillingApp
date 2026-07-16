import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";

const MAX_IMG = 900_000; // ~900KB data-URL cap
const okImg = (v) => v === null || v === "" || (typeof v === "string" && v.startsWith("data:image/") && v.length <= MAX_IMG);

export async function GET() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.json({
    // F-01: own password revealed on demand via GET /api/users/me/password, not shipped here.
    user: { id: me.id, email: me.email, name: me.name, role: me.role, has_password: !!(me.visible_password), headshot: me.headshot || null, signature_image: me.signature_image || null, totp_enabled: !!me.totp_enabled },
  });
}

// Self-service profile images: headshot (circular preview) and email
// signature image (appended to outgoing client emails).
export async function PATCH(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const db = await getDb();
  for (const k of ["headshot", "signature_image"]) {
    if (body[k] !== undefined) {
      if (!okImg(body[k])) return NextResponse.json({ error: "Image must be under ~650KB (data URL)." }, { status: 400 });
      await db.query(`UPDATE users SET ${k} = $1 WHERE id = $2`, [body[k] || null, me.id]);
    }
  }
  return NextResponse.json({ ok: true });
}
