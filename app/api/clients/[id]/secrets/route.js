import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db.js";
import { getSessionUser } from "../../../../../lib/auth.js";
import { readState, pickSecrets, decryptClientSecrets } from "../../../../../lib/clients.js";
import { writeAudit } from "../../../../../lib/security.js";

// F-01: reveal ONE client's secrets on demand (not shipped in the bulk load).
// Every reveal is written to the audit log.
export async function GET(req, { params }) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  const db = await getDb();
  const state = await readState(db);
  const client = state.clients.find((c) => c.id === id);
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  await writeAudit({ actorId: me.id, actorEmail: me.email, action: "secrets.viewed", entity: "client", entityId: id, detail: client.company || client.name || "", req });
  return NextResponse.json({ secrets: pickSecrets(decryptClientSecrets(client)) }); // F-01: decrypt at the reveal boundary
}
