import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db.js";
import { getSessionUser } from "../../../lib/auth.js";

// Read-only audit-log viewer, admins only. The log itself is append-only —
// there is no write or delete endpoint (F-03).
export async function GET(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const limit = Math.min(500, Number(new URL(req.url).searchParams.get("limit")) || 200);
  const db = await getDb();
  const { rows } = await db.query(
    "SELECT id, ts, actor_email, action, entity, entity_id, detail, ip FROM audit_log ORDER BY ts DESC LIMIT $1",
    [limit]
  );
  return NextResponse.json({ events: rows });
}
