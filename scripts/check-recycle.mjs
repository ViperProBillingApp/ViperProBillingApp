// Smallest check that fails if the client recycle bin breaks. Run: npm run check
// Needs DATABASE_URL (skips without one). Uses a throwaway client that is
// removed again in `finally`, so it never leaves a record behind.
import assert from "node:assert";

if (!process.env.DATABASE_URL) {
  console.log("check-recycle: skipped (no DATABASE_URL)");
  process.exit(0);
}

const { getDb } = await import("../lib/db.js");
const { updateState, readState } = await import("../lib/clients.js");
const db = await getDb();

const id = `__recyclecheck_${Date.now()}`;
const rec = { id, company: "__Recycle Check__", email: "check@example.invalid", portalPassword: "s3cret" };
// The same append the restore route performs.
const restore = (data) => updateState(db, (st) => (st.clients.some((c) => c.id === id) ? null : { clients: [...st.clients, data] }));

try {
  await db.query("INSERT INTO deleted_clients (id, data, deleted_at, deleted_by) VALUES ($1,$2,$3,'check')", [id, JSON.stringify(rec), Date.now()]);
  const { rows } = await db.query("SELECT data FROM deleted_clients WHERE id = $1", [id]);
  assert.ok(rows[0], "a deleted client lands in the bin");

  const before = (await readState(db)).clients.length;
  assert.ok((await restore(rows[0].data)).ok, "restore commits");

  const after = await readState(db);
  assert.strictEqual(after.clients.length, before + 1, "restore adds exactly one client");
  const back = after.clients.find((c) => c.id === id);
  assert.strictEqual(back?.company, "__Recycle Check__", "the whole record comes back");
  assert.ok(back.portalPassword, "secrets survive the round trip");

  await restore(rows[0].data);
  assert.strictEqual((await readState(db)).clients.filter((c) => c.id === id).length, 1, "restoring twice must not duplicate");

  console.log("check-recycle: OK");
} finally {
  await updateState(db, (st) => ({ clients: st.clients.filter((c) => c.id !== id) }));
  await db.query("DELETE FROM deleted_clients WHERE id = $1", [id]);
  await db.end();
}
process.exit(0);
