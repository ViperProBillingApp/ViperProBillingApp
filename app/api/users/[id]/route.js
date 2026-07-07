import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser, destroyUserSessions, hashPassword } from "../../../../lib/auth.js";

async function requireAdmin() {
  const me = await getSessionUser();
  if (!me) return [null, NextResponse.json({ error: "Not signed in" }, { status: 401 })];
  if (me.role !== "admin") return [null, NextResponse.json({ error: "Admin only" }, { status: 403 })];
  return [me, null];
}

export async function PATCH(req, { params }) {
  const [me, err] = await requireAdmin();
  if (err) return err;
  const { id } = await params;
  const userId = Number(id);
  const body = await req.json().catch(() => ({}));

  if (userId === me.id && (body.role !== undefined || body.active !== undefined)) {
    return NextResponse.json({ error: "You can't change your own role or access." }, { status: 400 });
  }
  const db = getDb();
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });

  if (body.name !== undefined) db.prepare("UPDATE users SET name = ? WHERE id = ?").run(String(body.name).trim(), userId);
  if (body.email !== undefined) {
    const email = String(body.email).trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    try {
      db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, userId);
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) return NextResponse.json({ error: "A user with that email already exists." }, { status: 409 });
      throw e;
    }
  }
  if (body.password !== undefined && body.password !== "") {
    if (String(body.password).length < 8) return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    db.prepare("UPDATE users SET hash = ? WHERE id = ?").run(hashPassword(String(body.password)), userId);
    if (userId !== me.id) destroyUserSessions(userId); // new password = their old sessions end
  }
  if (body.role !== undefined) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(body.role === "admin" ? "admin" : "staff", userId);
  if (body.active !== undefined) {
    db.prepare("UPDATE users SET active = ? WHERE id = ?").run(body.active ? 1 : 0, userId);
    if (!body.active) destroyUserSessions(userId); // revoking access signs them out everywhere
  }
  const user = db.prepare("SELECT id, email, name, role, active, created_at FROM users WHERE id = ?").get(userId);
  return NextResponse.json({ user });
}

export async function DELETE(req, { params }) {
  const [me, err] = await requireAdmin();
  if (err) return err;
  const { id } = await params;
  const userId = Number(id);
  if (userId === me.id) return NextResponse.json({ error: "You can't delete your own account." }, { status: 400 });
  destroyUserSessions(userId);
  getDb().prepare("DELETE FROM users WHERE id = ?").run(userId);
  return NextResponse.json({ ok: true });
}
