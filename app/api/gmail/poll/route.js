import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { readState, updateState } from "../../../../lib/clients.js";
import { saveMessages, outboundMessageIdIndex, existingMessageIds } from "../../../../lib/emailstore.js";
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
    // The raw error text is server-side only: it comes from Gmail/Google auth
    // internals and shouldn't be echoed to the caller (and a non-Error throw
    // must not render as the literal string "undefined").
    console.error("gmail list failed:", e?.message || e);
    return NextResponse.json({ error: "Gmail is unavailable — check the integration." }, { status: 502 });
  }

  // Dedupe at read time, not just write time: saveMessages' ON CONFLICT already
  // makes re-fetching harmless, but every re-fetch still costs a messages.get
  // call against Gmail's quota. Skipping known ids here is a large chunk of the
  // work on every poll after the first one in a given 7-day window.
  const known = await existingMessageIds(db, msgIds);
  const toFetch = msgIds.filter((id) => !known.has(id));
  const skipped = msgIds.length - toFetch.length;

  const rows = [];
  const repliedClients = new Set();
  let fetchErrors = 0;
  for (const id of toFetch) {
    let m;
    try { m = await getMessage(id); } catch (e) { console.error("gmail get failed:", id, e.message); fetchErrors++; continue; }
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

  // Every message the list call found had a fetch that failed — that is a
  // systemic outage (expired auth, Gmail 5xx), not "no replies today", and must
  // not be reported as ok:true fetched:0.
  if (toFetch.length > 0 && fetchErrors === toFetch.length) {
    console.error(`gmail poll: all ${fetchErrors} message fetches failed`);
    return NextResponse.json({ error: "Gmail is unavailable — check the integration." }, { status: 502 });
  }

  const { saved, savedIds } = await saveMessages(db, rows);
  const savedIdSet = new Set(savedIds);

  // Only clients with a genuinely NEW high-confidence inbound row may be
  // moved — repliedClients built from `rows` alone could include messages
  // already stored on a previous poll, which would re-flip a card a human
  // had since moved back to contacted-awaiting for an unrelated reason.
  const newReplyClients = new Set(
    rows.filter((r) => savedIdSet.has(r.id) && r.clientId && repliedClients.has(r.clientId)).map((r) => r.clientId)
  );

  let stageMoved = false;
  let stageMoveError = null;
  if (newReplyClients.size) {
    const result = await updateState(db, (s) => {
      let changed = false;
      const now = new Date().toISOString();
      const next = (s.clients || []).map((c) => {
        if (!newReplyClients.has(c.id) || c.stage !== "contacted-awaiting") return c;
        changed = true;
        const activity = [
          { at: now, type: "email", text: "Client replied — moved to Replied · needs action" },
          ...(c.activity || []),
        ].slice(0, 200);
        return { ...c, stage: "replied", stageAt: now, activity };
      });
      return changed ? { clients: next } : null;
    });
    if (!result.ok) {
      stageMoveError = result.error;
      console.error("gmail poll: stage move failed:", result.error);
    } else {
      stageMoved = !result.skipped;
    }
  }

  return NextResponse.json({
    ok: true, fetched: rows.length, saved, skipped, fetchErrors,
    matched: rows.filter((r) => r.clientId).length,
    unmatched: rows.filter((r) => !r.clientId).length,
    stageMoved, ...(stageMoveError ? { stageMoveError } : {}),
  });
}
