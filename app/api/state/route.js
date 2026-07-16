import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db.js";
import { getSessionUser } from "../../../lib/auth.js";
import { writeAudit } from "../../../lib/security.js";
import { mirrorClients, readState, stripSecrets, mergeClientSecrets, encryptClients } from "../../../lib/clients.js";

// Whole-state blob with a revision guard: every write bumps `rev`, and a PUT
// carrying an older rev is rejected (409) instead of silently clobbering newer
// data. This is what stops a stale browser tab from wiping edits made by
// another tab, the ChargeOver sync, or the Brevo webhook.
// ponytail: still one blob, not per-client rows — rev guard removes the
// data-loss hazard; move to rows if concurrent editing becomes routine.
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const db = await getDb();
  // F-08 Phase 3: clients come from the per-row table; settings/rev from the blob.
  // F-01: strip secret fields — revealed one client at a time, not in bulk.
  const state = await readState(db);
  return NextResponse.json({ ...state, clients: state.clients.map(stripSecrets) });
}

export async function PUT(req) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.clients)) {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }
  const db = await getDb();
  const { rows } = await db.query("SELECT value FROM kv WHERE key = 'state'");
  const currentRev = rows[0] ? (JSON.parse(rows[0].value).rev || 0) : 0;
  // Clients that predate the rev guard send no rev — accept (can't verify) so
  // old tabs keep working; every save from current code is checked.
  if (body.rev !== undefined && Number(body.rev) !== currentRev) {
    return NextResponse.json({ error: "stale", rev: currentRev }, { status: 409 });
  }
  const rev = currentRev + 1;
  // F-01: preserve stored secrets when this (possibly stripped) save has them
  // blank, so a save can't wipe portal passwords / user lists.
  const storedById = new Map((JSON.parse(rows[0]?.value || '{"clients":[]}').clients || []).map((c) => [c.id, c]));
  const clients = encryptClients(body.clients.map((c) => mergeClientSecrets(storedById.get(c.id), c))); // F-01: encrypt at rest
  // Flag a sharp drop in client count — the exact shape of the two historical
  // stale-tab overwrites. Doesn't block (can't tell a real bulk delete from a
  // clobber), but leaves an audit breadcrumb naming who saved it.
  const prevCount = rows[0] ? (JSON.parse(rows[0].value).clients?.length || 0) : 0;
  const newCount = clients.length;
  await db.query(
    "INSERT INTO kv (key, value) VALUES ('state', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [JSON.stringify({ clients, settings: body.settings || {}, rev })]
  );
  await mirrorClients(db, clients); // F-08 dark shadow — best-effort, never blocks the save
  if (prevCount - newCount >= 5) {
    await writeAudit({ actorId: user.id, actorEmail: user.email, action: "state.bulk_drop", detail: `clients ${prevCount} → ${newCount} (rev ${rev})`, req });
  }
  return NextResponse.json({ ok: true, rev });
}
