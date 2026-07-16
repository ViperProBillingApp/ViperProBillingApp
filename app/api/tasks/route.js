import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db.js";
import { getSessionUser } from "../../../lib/auth.js";

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const LANES = new Set(["todo", "doing", "done"]);

export async function GET() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const db = await getDb();
  const { rows } = await db.query("SELECT * FROM tasks ORDER BY created_at DESC");
  return NextResponse.json({ tasks: rows });
}

export async function POST(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const title = String(b.title || "").trim();
  if (!title) return NextResponse.json({ error: "Title is required." }, { status: 400 });
  const lane = LANES.has(b.lane) ? b.lane : "todo";
  const id = uid();
  const db = await getDb();
  const { rows } = await db.query(
    `INSERT INTO tasks (id, title, lane, owner, client_id, label, note, due, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [id, title, lane, String(b.owner || ""), String(b.clientId || ""), String(b.label || ""), String(b.note || ""), String(b.due || ""), Date.now(), me.email]
  );
  return NextResponse.json({ task: rows[0] });
}
