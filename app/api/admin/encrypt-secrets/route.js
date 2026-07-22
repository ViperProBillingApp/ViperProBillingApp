import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { updateState } from "../../../../lib/clients.js";
import { encStr, encryptionActive } from "../../../../lib/crypto.js";
import { writeAudit } from "../../../../lib/security.js";

// F-01 encryption-at-rest migration. Idempotent — encStr skips already-encrypted
// values, so it's safe to run more than once. No-op unless ENCRYPTION_KEY is set.
// Run ONCE after provisioning the key (identically) in every environment.
export async function POST(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });
  if (!encryptionActive()) {
    return NextResponse.json({ error: "ENCRYPTION_KEY is not set — nothing to migrate." }, { status: 400 });
  }
  const db = await getDb();

  // Clients: re-encrypt every client's scalar secrets (updateState calls
  // encryptClients on the way in; idempotent). Guarded so it can't clobber a
  // concurrent UI save.
  let clientCount = 0;
  await updateState(db, (state) => { clientCount = (state.clients || []).length; return { clients: state.clients }; });

  // Users: encrypt any plaintext visible_password.
  const { rows } = await db.query("SELECT id, visible_password FROM users WHERE visible_password IS NOT NULL AND visible_password <> ''");
  let users = 0;
  for (const u of rows) {
    if (String(u.visible_password).startsWith("enc:v1:")) continue; // already encrypted
    await db.query("UPDATE users SET visible_password = $1 WHERE id = $2", [encStr(String(u.visible_password)), u.id]);
    users++;
  }

  await writeAudit({ actorId: me.id, actorEmail: me.email, action: "secrets.encrypted", detail: `${clientCount} clients, ${users} user passwords`, req });
  return NextResponse.json({ ok: true, clients: clientCount, usersEncrypted: users });
}
