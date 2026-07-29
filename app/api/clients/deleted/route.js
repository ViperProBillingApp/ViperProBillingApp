import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { writeAudit } from "../../../../lib/security.js";
import { updateState, stripSecrets } from "../../../../lib/clients.js";
import { CO_RETIRED_IDS } from "../../../../lib/chargeover.js";

// Recycle bin for permanently-deleted clients. The batch save writes the whole
// record here on delete; this route lists it back and puts it in again.

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const db = await getDb();
  const { rows } = await db.query("SELECT id, data, deleted_at, deleted_by FROM deleted_clients ORDER BY deleted_at DESC");
  return NextResponse.json({
    deleted: rows.map((r) => ({
      id: r.id,
      company: r.data?.company || "",
      name: r.data?.name || "",
      email: r.data?.email || "",
      segment: r.data?.segment || "",
      chargeoverId: r.data?.chargeoverId || "",
      // Restoring one of these gives a client the ChargeOver sync will never
      // touch again (it's on the never-resurrect list) — say so up front.
      syncExcluded: CO_RETIRED_IDS.has(String(r.data?.chargeoverId || "")),
      deletedAt: Number(r.deleted_at),
      deletedBy: r.deleted_by || "",
    })),
  });
}

// Put a deleted client back into live state, then clear its bin row.
export async function POST(req) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const id = String((await req.json().catch(() => ({})))?.id || "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const db = await getDb();
  const { rows } = await db.query("SELECT data FROM deleted_clients WHERE id = $1", [id]);
  if (!rows[0]) return NextResponse.json({ error: "Not in the deleted list." }, { status: 404 });
  const record = rows[0].data;

  const res = await updateState(db, (state) => {
    if ((state.clients || []).some((c) => c.id === id)) return null; // already back
    return { clients: [...(state.clients || []), record] };
  });
  if (!res.ok) return NextResponse.json({ error: "Could not restore — try again." }, { status: 409 });

  await db.query("DELETE FROM deleted_clients WHERE id = $1", [id]);
  await writeAudit({ actorId: user.id, actorEmail: user.email, action: "clients.restore", entity: "client", entityId: id, detail: record?.company || record?.name || "", req });
  return NextResponse.json({ ok: true, client: stripSecrets(record) });
}

// Drop a record from the bin for good — nothing else holds it after this.
export async function DELETE(req) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const id = String(new URL(req.url).searchParams.get("id") || "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const db = await getDb();
  const r = await db.query("DELETE FROM deleted_clients WHERE id = $1", [id]);
  if (!r.rowCount) return NextResponse.json({ error: "Not in the deleted list." }, { status: 404 });
  await writeAudit({ actorId: user.id, actorEmail: user.email, action: "clients.purge", entity: "client", entityId: id, req });
  return NextResponse.json({ ok: true });
}
