import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { backfillClients, verifyMirror } from "../../../../lib/clients.js";

// F-08 Phase 1 admin controls for the dark client-row shadow.
// GET  → verify the shadow matches the blob (read-only).
// POST → backfill the shadow from the current blob.
async function requireAdmin() {
  const me = await getSessionUser();
  if (!me) return [null, NextResponse.json({ error: "Not signed in" }, { status: 401 })];
  if (me.role !== "admin") return [null, NextResponse.json({ error: "Admin only" }, { status: 403 })];
  return [me, null];
}

export async function GET() {
  const [, err] = await requireAdmin();
  if (err) return err;
  const db = await getDb();
  return NextResponse.json(await verifyMirror(db));
}

export async function POST() {
  const [, err] = await requireAdmin();
  if (err) return err;
  const db = await getDb();
  const backfill = await backfillClients(db);
  const verify = await verifyMirror(db);
  return NextResponse.json({ backfill, verify });
}
