// F-03: which top-level keys changed per client, for the audit log — never the
// VALUES. Pure logic, no DB needed. Guards the exact regression the review
// found: a client save reaching audit_log for NOTHING but bulk deletes ≥5.
import assert from "node:assert/strict";
import { diffClientChanges } from "../lib/clients.js";

const byId = (rows) => new Map(rows.map((r) => [r.id, r]));

// A genuinely new client: no "before" row at all.
{
  const upserts = [{ id: "a", company: "New Co" }];
  const before = byId([]);
  const after = byId([{ id: "a", company: "New Co", billingStatus: "current-pricing" }]);
  const out = diffClientChanges(upserts, before, after);
  assert.deepEqual(out, [{ id: "a", company: "New Co", keys: ["(new client)"] }]);
}

// An edited field shows up by name; an untouched field does not.
{
  const upserts = [{ id: "a" }];
  const before = byId([{ id: "a", company: "Acme", billingStatus: "not-up-to-date" }]);
  const after = byId([{ id: "a", company: "Acme", billingStatus: "current-pricing" }]);
  const out = diffClientChanges(upserts, before, after);
  assert.deepEqual(out, [{ id: "a", company: "Acme", keys: ["billingStatus"] }]);
}

// A secret field change shows only the KEY NAME, never the value — this is the
// whole point of the fix (a portal-password write must be visible in the audit
// log without the password itself ever appearing in it).
{
  const upserts = [{ id: "a" }];
  const before = byId([{ id: "a", company: "Acme", portalPassword: "enc:v1:old" }]);
  const after = byId([{ id: "a", company: "Acme", portalPassword: "enc:v1:new" }]);
  const out = diffClientChanges(upserts, before, after);
  assert.deepEqual(out, [{ id: "a", company: "Acme", keys: ["portalPassword"] }]);
  assert.ok(!JSON.stringify(out).includes("enc:v1:new"), "must never log the secret value");
}

// A secret preserved verbatim across the save (idempotent re-encryption of the
// same ciphertext) must NOT read as "changed" — this is the false-positive the
// idempotent encStr() no-op exists to prevent.
{
  const upserts = [{ id: "a" }]; // browser sent it blank; mergeClientSecrets restored the stored ciphertext
  const before = byId([{ id: "a", company: "Acme", portalPassword: "enc:v1:same" }]);
  const after = byId([{ id: "a", company: "Acme", portalPassword: "enc:v1:same" }]);
  const out = diffClientChanges(upserts, before, after);
  assert.deepEqual(out, [], "an unchanged secret must not appear as a change");
}

// No net change at all → no entry (a save that only touches OTHER clients).
{
  const upserts = [{ id: "a" }];
  const before = byId([{ id: "a", company: "Acme" }]);
  const after = byId([{ id: "a", company: "Acme" }]);
  assert.deepEqual(diffClientChanges(upserts, before, after), []);
}

// Upserted then deleted in the same save — nothing to diff, not a crash.
{
  const upserts = [{ id: "a" }];
  const before = byId([{ id: "a", company: "Acme" }]);
  const after = byId([]); // deleted after the merge, so it's gone from `after`
  assert.deepEqual(diffClientChanges(upserts, before, after), []);
}

console.log("check-audit-diff: ok");
