import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db.js";
import { getSessionUser, hashPassword, generatePassword, destroyUserSessions } from "../../../../../lib/auth.js";

export async function POST(req, { params }) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const { id } = await params;
  const userId = Number(id);
  const db = getDb();
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });

  const tempPassword = generatePassword();
  db.prepare("UPDATE users SET hash = ? WHERE id = ?").run(hashPassword(tempPassword), userId);
  destroyUserSessions(userId);
  // shown once to the admin; hand it to the user and have them change it
  return NextResponse.json({ tempPassword });
}
