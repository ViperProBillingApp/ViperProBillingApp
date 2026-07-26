import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db.js";
import { getSessionUser } from "../../../lib/auth.js";
import { listReplies, markHandled, assignToClient, clientRowExists } from "../../../lib/emailstore.js";

export async function GET(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const url = new URL(req.url);
  const scopeParam = url.searchParams.get("scope");
  // Whitelist check: an unrecognised scope falling through unchecked would make
  // listReplies build an empty WHERE clause, returning every stored row instead
  // of the intended slice — the one security-relevant line in this file.
  const scope = ["unhandled", "unmatched", "all"].includes(scopeParam) ? scopeParam : "unhandled";
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
  let row;
  if (action === "handled") {
    row = await markHandled(db, String(id), me.email);
  } else {
    // client_id has no foreign key (see clientRowExists), so an empty or bogus
    // clientId here would silently file the message against a client that
    // doesn't exist — invisible in the unmatched queue and unrecoverable.
    const trimmedClientId = String(clientId || "").trim();
    if (!trimmedClientId) {
      return NextResponse.json({ error: "assign requires a clientId." }, { status: 400 });
    }
    if (!(await clientRowExists(db, trimmedClientId))) {
      return NextResponse.json({ error: "No client with that id." }, { status: 400 });
    }
    row = await assignToClient(db, String(id), trimmedClientId);
  }
  if (!row) return NextResponse.json({ error: "Message not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
