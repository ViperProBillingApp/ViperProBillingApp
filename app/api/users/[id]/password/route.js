import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db.js";
import { getSessionUser } from "../../../../../lib/auth.js";
import { writeAudit } from "../../../../../lib/security.js";

// F-01: admin reveals ONE staff member's stored password on demand (not shipped
// in the users list). Audited.
export async function GET(req, { params }) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const { id } = await params;
  const db = await getDb();
  const { rows } = await db.query("SELECT email, visible_password FROM users WHERE id = $1", [Number(id)]);
  if (!rows[0]) return NextResponse.json({ error: "User not found" }, { status: 404 });
  await writeAudit({ actorId: me.id, actorEmail: me.email, action: "password.revealed", entity: "user", entityId: String(id), detail: rows[0].email, req });
  return NextResponse.json({ visible_password: rows[0].visible_password || null });
}
