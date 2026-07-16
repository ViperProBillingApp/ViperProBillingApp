// F-08 per-client-row layer. Phase 1: a DARK SHADOW of the kv 'state' blob —
// every blob write mirrors here, nothing reads it yet. The blob stays the sole
// source of truth, so this cannot lose or change data. Phase 2 flips reads to
// these rows; Phase 3 retires the blob.

// Recursively key-sorted JSON, so a blob object and its jsonb round-trip (which
// reorders keys) compare equal in verifyMirror.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",")}}`;
  }
  return JSON.stringify(v);
}

// Mirror the full client array into the per-row table: upsert every present
// client, then delete rows for clients no longer present. Set-based (two
// statements), so it's a couple of queries regardless of client count.
// NEVER throws into the caller — a shadow-write failure must not break the real
// blob save. ponytail: no wrapping transaction; the table is dark and fully
// rewritten on the next write, so a torn mirror self-heals. Add a txn at cutover.
export async function mirrorClients(db, clients) {
  try {
    const json = JSON.stringify(Array.isArray(clients) ? clients : []);
    const now = Date.now();
    await db.query(
      `INSERT INTO clients (id, data, updated_at)
       SELECT e->>'id', e, $2 FROM json_array_elements($1::json) e WHERE e->>'id' IS NOT NULL
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [json, now]
    );
    await db.query(
      `DELETE FROM clients WHERE id NOT IN (SELECT e->>'id' FROM json_array_elements($1::json) e WHERE e->>'id' IS NOT NULL)`,
      [json]
    );
    return { ok: true, mirrored: (JSON.parse(json)).length };
  } catch (e) {
    console.error("client mirror failed:", e.message);
    return { ok: false, error: e.message };
  }
}

// One-shot backfill from the current blob (same as a mirror of what's stored).
export async function backfillClients(db) {
  const { rows } = await db.query("SELECT value FROM kv WHERE key = 'state'");
  const clients = rows[0] ? (JSON.parse(rows[0].value).clients || []) : [];
  const r = await mirrorClients(db, clients);
  return { ...r, blobCount: clients.length };
}

// Prove the shadow faithfully matches the blob: same ids, same content.
export async function verifyMirror(db) {
  const { rows: kvRows } = await db.query("SELECT value FROM kv WHERE key = 'state'");
  const blob = kvRows[0] ? (JSON.parse(kvRows[0].value).clients || []) : [];
  const { rows: tblRows } = await db.query("SELECT id, data FROM clients");

  const blobById = new Map(blob.filter((c) => c.id).map((c) => [c.id, c]));
  const tblById = new Map(tblRows.map((r) => [r.id, r.data]));

  const missingInTable = [...blobById.keys()].filter((id) => !tblById.has(id));
  const extraInTable = [...tblById.keys()].filter((id) => !blobById.has(id));
  const contentMismatch = [];
  for (const [id, c] of blobById) {
    if (tblById.has(id) && canonical(c) !== canonical(tblById.get(id))) contentMismatch.push(id);
  }
  return {
    inSync: missingInTable.length === 0 && extraInTable.length === 0 && contentMismatch.length === 0,
    blobCount: blobById.size,
    tableCount: tblById.size,
    missingInTable: missingInTable.slice(0, 20),
    extraInTable: extraInTable.slice(0, 20),
    contentMismatch: contentMismatch.slice(0, 20),
  };
}
