import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { writeAudit } from "../../../../lib/security.js";
import { mirrorClients, mergeClientSecrets, encryptClients, diffClientChanges } from "../../../../lib/clients.js";

// F-08 Phase 2: per-client-diff save. The client sends only the clients it
// CHANGED (upserts) and REMOVED (deletes) — never the whole array — so a stale
// tab can't overwrite clients it never touched. The merge happens here, against
// current server state, not client-side against a stale copy. This is what
// makes the two historical whole-array wipes structurally impossible.
//
// The blob stays the maintained source of truth (rollback net + what sync/
// webhook read); rows are kept in lockstep via mirrorClients. Phase 3 retires
// the blob.
export async function PUT(req) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const upserts = Array.isArray(body?.upserts) ? body.upserts.filter((c) => c && c.id) : [];
  const deletes = Array.isArray(body?.deletes) ? body.deletes.filter(Boolean).map(String) : [];
  if (!body || (!upserts.length && !deletes.length && body.settings === undefined)) {
    return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
  }

  const db = await getDb();
  const { rows } = await db.query("SELECT value FROM kv WHERE key = 'state'");
  const state = rows[0] ? JSON.parse(rows[0].value) : { clients: [], settings: {}, rev: 0 };
  const curRev = state.rev || 0;
  // Fast path for the common stale case; the atomic UPDATE below is the real guard.
  if (body.rev !== undefined && Number(body.rev) !== curRev) {
    return NextResponse.json({ error: "stale", rev: curRev }, { status: 409 });
  }

  // Merge the diff into current server clients, preserving order.
  // F-01: keep stored secrets when the incoming (stripped) client has them blank.
  const map = new Map((state.clients || []).map((c) => [c.id, c]));
  // Snapshot pre-merge so the audit entry below can diff what changed — taken
  // BEFORE map.set overwrites it, same reason `removed` is snapshotted before delete.
  const beforeById = new Map(upserts.map((c) => [c.id, map.get(c.id)]));
  for (const c of upserts) map.set(c.id, mergeClientSecrets(map.get(c.id), c));
  const removed = deletes.map((id) => map.get(id)).filter(Boolean); // snapshot before dropping
  for (const id of deletes) map.delete(id);
  const newClients = encryptClients([...map.values()]); // F-01: encrypt secrets at rest (dormant until keyed)
  const nextRev = curRev + 1;
  const newVal = JSON.stringify({ clients: newClients, settings: body.settings !== undefined ? body.settings : (state.settings || {}), rev: nextRev });

  // Atomic optimistic concurrency: only write if rev is still what we read.
  const upd = await db.query(
    "UPDATE kv SET value = $1 WHERE key = 'state' AND (value::json->>'rev')::int = $2",
    [newVal, curRev]
  );
  if (upd.rowCount === 0) {
    // No matching row — either none exists yet (bootstrap) or someone raced us.
    const ins = await db.query("INSERT INTO kv (key, value) VALUES ('state', $1) ON CONFLICT (key) DO NOTHING", [newVal]);
    if (ins.rowCount === 0) return NextResponse.json({ error: "stale", rev: (JSON.parse((await db.query("SELECT value FROM kv WHERE key='state'")).rows[0].value).rev) || 0 }, { status: 409 });
  }
  await mirrorClients(db, newClients); // keep rows in lockstep

  // Recycle bin: keep the full record so a delete can be undone from the UI.
  // Best-effort — a failure here must not fail a save that already committed.
  for (const c of removed) {
    try {
      await db.query(
        `INSERT INTO deleted_clients (id, data, deleted_at, deleted_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, deleted_at = EXCLUDED.deleted_at, deleted_by = EXCLUDED.deleted_by`,
        [c.id, JSON.stringify(c), Date.now(), user.email || ""]
      );
    } catch (e) { console.error("recycle-bin write failed:", e.message); }
  }

  // Same bulk-drop breadcrumb the whole-blob path had — but now a diff can only
  // delete what it explicitly listed, so this should essentially never fire.
  if (deletes.length >= 5) {
    await writeAudit({ actorId: user.id, actorEmail: user.email, action: "clients.bulk_delete", detail: `${deletes.length} deleted (rev ${nextRev})`, req });
  }

  // F-03: every OTHER route on this audit trail logs admin/security actions
  // (login, user mgmt, secrets reveal, recycle-bin restore/purge) — but this is
  // the one route behind every ordinary client-card save, and until now it only
  // wrote to audit_log for deletes ≥5. A billing-status change, a pricing edit,
  // or a NEW PORTAL PASSWORD went nowhere but the client's own mutable
  // `activity` array — exactly the architecture the original finding
  // criticized. One row per save fixes that. Only key NAMES are logged, never
  // values, so a secret write shows as "portalPassword changed", not the secret.
  const newById = new Map(newClients.map((n) => [n.id, n])); // read the value actually persisted, not a second encryption pass
  const changed = diffClientChanges(upserts, beforeById, newById);
  if (changed.length || removed.length) {
    await writeAudit({
      actorId: user.id, actorEmail: user.email, action: "clients.saved",
      detail: {
        changed,
        deleted: removed.map((c) => ({ id: c.id, company: c.company || c.name || "" })),
      },
      req,
    });
  }

  return NextResponse.json({ ok: true, rev: nextRev });
}
