import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { encStr, decStr } from "../../../../lib/crypto.js";
import { writeAudit } from "../../../../lib/security.js";

// Whitelisted columns a PATCH may set — keeps arbitrary keys out of the SQL.
const FIELDS = { name: "name", portalUrl: "portal_url", adminUrl: "admin_url", adminUser: "admin_user", adminPw: "admin_pw" };
const out = (r) => ({ id: r.id, name: r.name, portalUrl: r.portal_url, adminUrl: r.admin_url, adminUser: r.admin_user, adminPw: decStr(r.admin_pw) });

export async function PATCH(req, { params }) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(FIELDS)) {
    if (b[k] === undefined) continue;
    if (k === "name" && !String(b[k]).trim()) return NextResponse.json({ error: "Name can't be empty." }, { status: 400 });
    vals.push(k === "adminPw" ? encStr(String(b[k])) : String(b[k]));
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  vals.push(id);
  const db = await getDb();
  const { rows } = await db.query(`UPDATE viper_customers SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
  if (!rows[0]) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await writeAudit({ actorId: me.id, actorEmail: me.email, action: "viper.update", entity: "viper_customers", entityId: id, detail: Object.keys(b).join(", "), req });
  return NextResponse.json({ customer: out(rows[0]) });
}

export async function DELETE(req, { params }) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  const db = await getDb();
  const { rows } = await db.query("DELETE FROM viper_customers WHERE id = $1 RETURNING name", [id]);
  await writeAudit({ actorId: me.id, actorEmail: me.email, action: "viper.delete", entity: "viper_customers", entityId: id, detail: rows[0]?.name || "", req });
  return NextResponse.json({ ok: true });
}
