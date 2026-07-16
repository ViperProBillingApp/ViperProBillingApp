import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db.js";
import { getSessionUser } from "../../../lib/auth.js";

// Roster for owner/assignee pickers — any signed-in staff can read it (names +
// emails of colleagues, no secrets). Distinct from the admin-only /api/users.
export async function GET() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const db = await getDb();
  const { rows } = await db.query("SELECT email, name FROM users WHERE active = true ORDER BY name");
  return NextResponse.json({ staff: rows });
}
