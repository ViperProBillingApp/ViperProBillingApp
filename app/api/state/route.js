import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db.js";
import { getSessionUser } from "../../../lib/auth.js";
import { readState, stripSecrets } from "../../../lib/clients.js";

// Read-only state load. Clients come from the per-row table; settings/rev from
// the blob. All WRITES go through PUT /api/clients/batch, whose per-client diff
// + atomic rev guard is the only safe write path — the old whole-blob PUT here
// was retired because a rev-less payload could clobber every client (the exact
// historical data-loss trap).
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const db = await getDb();
  // F-01: strip secret fields — revealed one client at a time, not in bulk.
  const state = await readState(db);
  return NextResponse.json({ ...state, clients: state.clients.map(stripSecrets) });
}
