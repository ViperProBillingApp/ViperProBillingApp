import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db.js";
import { getSessionUser } from "../../../lib/auth.js";
import { listReplies, markHandled, assignToClient } from "../../../lib/emailstore.js";

export async function GET(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const url = new URL(req.url);
  const scope = ["unhandled", "unmatched", "all"].includes(url.searchParams.get("scope"))
    ? url.searchParams.get("scope") : "unhandled";
  const clientId = url.searchParams.get("clientId") || null;
  const db = await getDb();
  return NextResponse.json({ replies: await listReplies(db, { scope, clientId }) });
}

export async function PATCH(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id, action, clientId } = await req.json().catch(() => ({}));
  if (!id || !["handled", "assign"].includes(action)) {
    return NextResponse.json({ error: "id and a valid action are required." }, { status: 400 });
  }
  const db = await getDb();
  const row = action === "handled"
    ? await markHandled(db, String(id), me.email)
    : await assignToClient(db, String(id), String(clientId || ""));
  if (!row) return NextResponse.json({ error: "Message not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
