import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";

const LANES = new Set(["todo", "doing", "done"]);
// Whitelisted columns a PATCH may set — keeps arbitrary keys out of the SQL.
const FIELDS = { title: "title", lane: "lane", owner: "owner", clientId: "client_id", label: "label", note: "note", due: "due" };

export async function PATCH(req, { params }) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const sets = [], vals = [];
  for (const [key, col] of Object.entries(FIELDS)) {
    if (b[key] === undefined) continue;
    if (key === "lane" && !LANES.has(b[key])) return NextResponse.json({ error: "Bad lane." }, { status: 400 });
    if (key === "title" && !String(b[key]).trim()) return NextResponse.json({ error: "Title can't be empty." }, { status: 400 });
    vals.push(String(b[key]));
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  vals.push(id);
  const db = await getDb();
  const { rows } = await db.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
  if (!rows[0]) return NextResponse.json({ error: "Task not found." }, { status: 404 });
  return NextResponse.json({ task: rows[0] });
}

export async function DELETE(req, { params }) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  const db = await getDb();
  await db.query("DELETE FROM tasks WHERE id = $1", [id]);
  return NextResponse.json({ ok: true });
}
