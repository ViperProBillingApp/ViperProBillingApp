// F-08 per-client-row layer. Phase 1: a DARK SHADOW of the kv 'state' blob —
// every blob write mirrors here, nothing reads it yet. The blob stays the sole
// source of truth, so this cannot lose or change data. Phase 2 flips reads to
// these rows; Phase 3 retires the blob.
import { encStr, decStr } from "./crypto.js";

// F-01: secret fields never shipped in the bulk client load. Revealed one
// client at a time via /api/clients/[id]/secrets (audited). Storage keeps them
// (no migration) — only the SERVE strips, and saves PRESERVE them.
export const SECRET_SCALARS = ["portalPassword", "adminPassword", "maritzPortalPassword", "maritzAdminPassword"];
export const SECRET_ARRAYS = ["maritzUserLists", "userLists"]; // contain per-user passwords

// F-01 encryption-at-rest (scalars). encryptClientSecrets runs at every write to
// storage; decryptClientSecrets at the reveal boundary. Dormant until
// ENCRYPTION_KEY is set (encStr/decStr are identity), so this is a no-op today.
// ponytail: user-list password columns (maritzUserLists/userLists) stay plaintext
// for now — reveal-on-demand already gates their exposure; encrypt them in a
// follow-up (they're nested arrays, not scalar strings).
export function encryptClientSecrets(c) {
  const out = { ...c };
  for (const f of SECRET_SCALARS) if (out[f]) out[f] = encStr(out[f]);
  return out;
}
export function decryptClientSecrets(c) {
  const out = { ...c };
  for (const f of SECRET_SCALARS) if (out[f]) out[f] = decStr(out[f]);
  return out;
}
// Encrypt secrets across a whole clients array before persisting (idempotent).
export function encryptClients(clients) {
  return (clients || []).map(encryptClientSecrets);
}

// A copy with secret fields blanked — what the browser gets in the list load.
export function stripSecrets(c) {
  const out = { ...c };
  for (const f of SECRET_SCALARS) out[f] = "";
  for (const f of SECRET_ARRAYS) out[f] = [];
  return out;
}

// Just the secret fields, for the reveal endpoint.
export function pickSecrets(c) {
  const out = {};
  for (const f of SECRET_SCALARS) out[f] = c?.[f] || "";
  for (const f of SECRET_ARRAYS) out[f] = Array.isArray(c?.[f]) ? c[f] : [];
  return out;
}

// Preserve stored secrets when an incoming (stripped) client has them blank —
// this is what stops a save of a stripped client from wiping its secrets. An
// explicit non-empty value still overwrites (that's a real edit).
export function mergeClientSecrets(stored, incoming) {
  if (!stored) return incoming;
  const out = { ...incoming };
  for (const f of SECRET_SCALARS) if (!out[f] && stored[f]) out[f] = stored[f];
  for (const f of SECRET_ARRAYS) if ((!Array.isArray(out[f]) || out[f].length === 0) && stored[f]?.length) out[f] = stored[f];
  return out;
}

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
// client and delete rows for clients no longer present — in ONE data-modifying
// CTE statement, so it is atomic (Postgres runs it in a single implicit
// transaction). Previously two separate statements could tear: a killed
// serverless function between the upsert and the delete left an orphan row for
// a just-deleted client, which readState then resurrected. The unreferenced
// `up` CTE still executes to completion (per the SQL standard), so both the
// upsert and the delete always happen together or not at all.
// NEVER throws into the caller — a shadow-write failure must not break the blob.
export async function mirrorClients(db, clients) {
  try {
    const json = JSON.stringify(Array.isArray(clients) ? clients : []);
    const now = Date.now();
    // WITH ORDINALITY carries the array position into the `ord` column so
    // readState can return clients in their original order.
    await db.query(
      `WITH input AS (
         SELECT e.val->>'id' AS id, e.val AS data, e.ord AS ord
         FROM json_array_elements($1::json) WITH ORDINALITY AS e(val, ord)
         WHERE e.val->>'id' IS NOT NULL
       ),
       up AS (
         INSERT INTO clients (id, data, updated_at, ord)
         SELECT id, data, $2, ord FROM input
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, ord = EXCLUDED.ord
         RETURNING id
       )
       DELETE FROM clients WHERE id NOT IN (SELECT id FROM input)`,
      [json, now]
    );
    return { ok: true, mirrored: (JSON.parse(json)).length };
  } catch (e) {
    console.error("client mirror failed:", e.message);
    return { ok: false, error: e.message };
  }
}

// Guarded whole-blob write for the server-side writers (ChargeOver sync, Brevo
// webhook, encrypt-secrets backfill). Reads current state, lets `mutate(state)`
// build the next clients/settings (return null/undefined to skip the write),
// then commits ONLY if `rev` hasn't moved since the read; on a concurrent write
// it re-reads and re-applies `mutate` against fresh state. This is what stops a
// slow writer (the ~35–60s nightly sync) from clobbering a UI batch save that
// landed mid-flight. Mirrors rows on success, same as the batch route.
export async function updateState(db, mutate, { retries = 5 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { rows } = await db.query("SELECT value FROM kv WHERE key = 'state'");
    const state = rows[0] ? JSON.parse(rows[0].value) : { clients: [], settings: {}, rev: 0 };
    const curRev = state.rev || 0;
    const result = await mutate(state);
    if (!result) return { ok: true, skipped: true, rev: curRev };
    const clients = encryptClients(result.clients || state.clients || []);
    const settings = result.settings !== undefined ? result.settings : (state.settings || {});
    const nextRev = curRev + 1;
    const val = JSON.stringify({ clients, settings, rev: nextRev });
    let committed;
    if (rows[0]) {
      const upd = await db.query("UPDATE kv SET value = $1 WHERE key = 'state' AND (value::json->>'rev')::int = $2", [val, curRev]);
      committed = upd.rowCount > 0;
    } else {
      const ins = await db.query("INSERT INTO kv (key, value) VALUES ('state', $1) ON CONFLICT (key) DO NOTHING", [val]);
      committed = ins.rowCount > 0;
    }
    if (committed) { await mirrorClients(db, clients); return { ok: true, rev: nextRev, meta: result.meta }; }
    // lost the race to a concurrent write — loop, re-read, re-apply mutate.
  }
  return { ok: false, error: "contended", rev: null };
}

// F-08 Phase 3: the read source of truth for clients is now the per-row table.
// Settings + rev still live in the kv 'state' blob (which every writer keeps
// current as a full backup / rollback net). Safety: if the rows are somehow
// LESS complete than the blob backup, serve the blob — clients must never
// silently vanish because a mirror write lagged.
export async function readState(db) {
  const { rows: kvRows } = await db.query("SELECT value FROM kv WHERE key = 'state'");
  const blob = kvRows[0] ? JSON.parse(kvRows[0].value) : { clients: [], settings: null, rev: 0 };
  const blobClients = Array.isArray(blob.clients) ? blob.clients : [];
  const { rows: clientRows } = await db.query("SELECT data FROM clients ORDER BY ord NULLS LAST, id");
  const rowClients = clientRows.map((r) => r.data);
  const useRows = rowClients.length >= blobClients.length; // normal case: equal
  if (!useRows) console.error(`readState: rows(${rowClients.length}) < blob(${blobClients.length}) — serving blob backup`);
  return { clients: useRows ? rowClients : blobClients, settings: blob.settings ?? null, rev: blob.rev || 0 };
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
