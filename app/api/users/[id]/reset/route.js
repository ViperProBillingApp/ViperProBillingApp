import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db.js";
import { getSessionUser, hashPassword, generatePassword, destroyUserSessions } from "../../../../../lib/auth.js";
import { encStr } from "../../../../../lib/crypto.js";

export async function POST(req, { params }) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const { id } = await params;
  const userId = Number(id);
  const db = await getDb();
  const { rows } = await db.query("SELECT id FROM users WHERE id = $1", [userId]);
  if (!rows[0]) return NextResponse.json({ error: "User not found." }, { status: 404 });

  const tempPassword = generatePassword();
  await db.query("UPDATE users SET hash = $1, visible_password = $2 WHERE id = $3", [hashPassword(tempPassword), encStr(tempPassword), userId]);
  await destroyUserSessions(userId);
  // shown once to the admin; hand it to the user and have them change it
  return NextResponse.json({ tempPassword });
}
