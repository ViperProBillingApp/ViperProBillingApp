import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser, destroyUserSessions, hashPassword } from "../../../../lib/auth.js";
import { writeAudit } from "../../../../lib/security.js";
import { encStr } from "../../../../lib/crypto.js";

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
  const db = await getDb();
  const { rows: targetRows } = await db.query("SELECT id FROM users WHERE id = $1", [userId]);
  if (!targetRows[0]) return NextResponse.json({ error: "User not found." }, { status: 404 });

  if (body.name !== undefined) {
    await db.query("UPDATE users SET name = $1 WHERE id = $2", [String(body.name).trim(), userId]);
  }
  if (body.email !== undefined) {
    const email = String(body.email).trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    try {
      await db.query("UPDATE users SET email = $1 WHERE id = $2", [email, userId]);
    } catch (e) {
      if (e.code === "23505") return NextResponse.json({ error: "A user with that email already exists." }, { status: 409 });
      throw e;
    }
  }
  if (body.password !== undefined && body.password !== "") {
    if (String(body.password).length < 8) return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    await db.query("UPDATE users SET hash = $1, visible_password = $2 WHERE id = $3", [hashPassword(String(body.password)), encStr(String(body.password)), userId]);
    if (userId !== me.id) await destroyUserSessions(userId); // new password = their old sessions end
    await writeAudit({ actorId: me.id, actorEmail: me.email, action: "user.password_reset", entity: "user", entityId: String(userId), req });
  }
  if (body.role !== undefined) {
    await db.query("UPDATE users SET role = $1 WHERE id = $2", [body.role === "admin" ? "admin" : "staff", userId]);
    await writeAudit({ actorId: me.id, actorEmail: me.email, action: "user.role_change", entity: "user", entityId: String(userId), detail: `→ ${body.role === "admin" ? "admin" : "staff"}`, req });
  }
  if (body.active !== undefined) {
    await db.query("UPDATE users SET active = $1 WHERE id = $2", [!!body.active, userId]);
    if (!body.active) await destroyUserSessions(userId); // revoking access signs them out everywhere
    await writeAudit({ actorId: me.id, actorEmail: me.email, action: body.active ? "user.activate" : "user.deactivate", entity: "user", entityId: String(userId), req });
  }
  // profile images (data URLs) — headshot shown on the card, signature appended to outgoing email
  const okImg = (v) => v === null || v === "" || (typeof v === "string" && v.startsWith("data:image/") && v.length <= 900_000);
  for (const k of ["headshot", "signature_image"]) {
    if (body[k] !== undefined) {
      if (!okImg(body[k])) return NextResponse.json({ error: "Image must be a data URL under ~650KB." }, { status: 400 });
      await db.query(`UPDATE users SET ${k} = $1 WHERE id = $2`, [body[k] || null, userId]);
    }
  }
  const { rows } = await db.query("SELECT id, email, name, role, active, created_at, (visible_password IS NOT NULL AND visible_password <> '') AS has_password, headshot, signature_image FROM users WHERE id = $1", [userId]);
  return NextResponse.json({ user: rows[0] });
}

export async function DELETE(req, { params }) {
  const [me, err] = await requireAdmin();
  if (err) return err;
  const { id } = await params;
  const userId = Number(id);
  if (userId === me.id) return NextResponse.json({ error: "You can't delete your own account." }, { status: 400 });
  await destroyUserSessions(userId);
  const db = await getDb();
  const { rows: t } = await db.query("SELECT email FROM users WHERE id = $1", [userId]);
  await db.query("DELETE FROM users WHERE id = $1", [userId]);
  await writeAudit({ actorId: me.id, actorEmail: me.email, action: "user.delete", entity: "user", entityId: String(userId), detail: t[0]?.email || "", req });
  return NextResponse.json({ ok: true });
}
