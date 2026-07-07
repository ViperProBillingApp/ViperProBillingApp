import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db.js";
import { getSessionUser, hashPassword, generatePassword } from "../../../lib/auth.js";

async function requireAdmin() {
  const me = await getSessionUser();
  if (!me) return [null, NextResponse.json({ error: "Not signed in" }, { status: 401 })];
  if (me.role !== "admin") return [null, NextResponse.json({ error: "Admin only" }, { status: 403 })];
  return [me, null];
}

export async function GET() {
  const [, err] = await requireAdmin();
  if (err) return err;
  const db = await getDb();
  const { rows } = await db.query(
    "SELECT id, email, name, role, active, created_at FROM users ORDER BY created_at"
  );
  return NextResponse.json({ users: rows });
}

export async function POST(req) {
  const [, err] = await requireAdmin();
  if (err) return err;
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  }
  const role = body.role === "admin" ? "admin" : "staff";
  const password = body.password ? String(body.password) : generatePassword();
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }
  const db = await getDb();
  try {
    const { rows } = await db.query(
      "INSERT INTO users (email, name, hash, role) VALUES ($1, $2, $3, $4) RETURNING id",
      [email, String(body.name || "").trim(), hashPassword(password), role]
    );
    return NextResponse.json({
      user: { id: rows[0].id, email, name: body.name || "", role, active: true },
      // returned once so the admin can hand it over; not stored in plain text
      tempPassword: body.password ? undefined : password,
    });
  } catch (e) {
    if (e.code === "23505") {
      return NextResponse.json({ error: "A user with that email already exists." }, { status: 409 });
    }
    throw e;
  }
}
