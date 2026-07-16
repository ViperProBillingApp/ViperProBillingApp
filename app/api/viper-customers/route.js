import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db.js";
import { getSessionUser } from "../../../lib/auth.js";
import { encStr, decStr } from "../../../lib/crypto.js";
import { writeAudit } from "../../../lib/security.js";

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const out = (r) => ({ id: r.id, name: r.name, portalUrl: r.portal_url, adminUrl: r.admin_url, adminUser: r.admin_user, adminPw: decStr(r.admin_pw) });

export async function GET(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const db = await getDb();
  const { rows } = await db.query("SELECT * FROM viper_customers ORDER BY LOWER(name)");
  // One audit line per open — these rows carry live portal passwords.
  await writeAudit({ actorId: me.id, actorEmail: me.email, action: "viper.list", entity: "viper_customers", detail: `${rows.length} rows`, req });
  return NextResponse.json({ customers: rows.map(out) });
}

export async function POST(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const name = String(b.name || "").trim();
  if (!name) return NextResponse.json({ error: "Name is required." }, { status: 400 });
  const db = await getDb();
  const { rows } = await db.query(
    `INSERT INTO viper_customers (id, name, portal_url, admin_url, admin_user, admin_pw, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [uid(), name, String(b.portalUrl || ""), String(b.adminUrl || ""), String(b.adminUser || ""), encStr(String(b.adminPw || "")), Date.now()]
  );
  await writeAudit({ actorId: me.id, actorEmail: me.email, action: "viper.add", entity: "viper_customers", entityId: rows[0].id, detail: name, req });
  return NextResponse.json({ customer: out(rows[0]) });
}
