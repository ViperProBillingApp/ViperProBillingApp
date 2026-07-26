import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { readState, updateState } from "../../../../lib/clients.js";
import { saveMessages, outboundMessageIdIndex } from "../../../../lib/emailstore.js";
import { matchMessage } from "../../../../lib/replies.js";
import { gmailConfigured, listRecentMessages, getMessage } from "../../../../lib/gmail.js";

export const maxDuration = 60;

// Pull recent labelled mail, match it to clients, store it. Called on CRM load
// and on an interval while a tab is open. Idempotent: re-ingesting a message is
// a no-op because the Gmail message id is the primary key.
export async function POST() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!gmailConfigured()) return NextResponse.json({ error: "Gmail is not configured." }, { status: 501 });

  const db = await getDb();
  const state = await readState(db);
  const clients = state.clients || [];

  const ids = new Set(clients.map((c) => c.id));
  const byEmail = new Map();
  for (const c of clients) {
    const addrs = [c.email, ...(c.secondaryContacts || []).map((s) => s.email)]
      .filter(Boolean).map((e) => String(e).toLowerCase());
    for (const a of addrs) {
      if (!byEmail.has(a)) byEmail.set(a, []);
      if (!byEmail.get(a).includes(c.id)) byEmail.get(a).push(c.id);
    }
  }
  const ctx = {
    clientExists: (id) => ids.has(id),
    outboundIndex: await outboundMessageIdIndex(db),
    clientsByEmail: byEmail,
  };

  let msgIds;
  try {
    msgIds = await listRecentMessages();
  } catch (e) {
    // Auth failures must be loud — a silent failure looks exactly like "no replies".
    console.error("gmail list failed:", e.message);
    return NextResponse.json({ error: `Gmail unavailable: ${e.message}` }, { status: 502 });
  }

  const rows = [];
  const repliedClients = new Set();
  for (const id of msgIds) {
    let m;
    try { m = await getMessage(id); } catch (e) { console.error("gmail get failed:", id, e.message); continue; }
    // Never ingest our own outbound as if it were an inbound reply.
    if (m.fromEmail === String(process.env.GMAIL_IMPERSONATE || "").toLowerCase()) continue;
    const match = matchMessage(m, ctx);
    rows.push({
      id: m.id, threadId: m.threadId, clientId: match.clientId, direction: "in",
      fromEmail: m.fromEmail, toEmail: m.toEmail, subject: m.subject,
      snippet: m.snippet, bodyText: m.bodyText, messageIdHdr: m.messageIdHdr,
      referencesHdr: m.referencesHdr, sentAt: m.sentAt,
      matchMethod: match.method, matchConf: match.confidence,
    });
    if (match.clientId && match.confidence === "high") repliedClients.add(match.clientId);
  }

  const { saved } = await saveMessages(db, rows);

  // Only cards genuinely awaiting a reply move — never override a human's stage.
  if (saved > 0 && repliedClients.size) {
    await updateState(db, (s) => {
      let changed = false;
      const next = (s.clients || []).map((c) => {
        if (!repliedClients.has(c.id) || c.stage !== "contacted-awaiting") return c;
        changed = true;
        return { ...c, stage: "replied", stageAt: new Date().toISOString() };
      });
      return changed ? { clients: next } : null;
    });
  }

  return NextResponse.json({
    ok: true, fetched: rows.length, saved,
    matched: rows.filter((r) => r.clientId).length,
    unmatched: rows.filter((r) => !r.clientId).length,
  });
}
