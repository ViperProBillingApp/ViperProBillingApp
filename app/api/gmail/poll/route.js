import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { readState, updateState } from "../../../../lib/clients.js";
import { saveMessages, outboundMessageIdIndex, existingMessageIds } from "../../../../lib/emailstore.js";
import { matchMessage } from "../../../../lib/replies.js";
import { gmailConfigured, listRecentMessages, getMessage, labelExists } from "../../../../lib/gmail.js";

export const maxDuration = 60;

// listRecentMessages now returns the FULL window (paginated), so the bound
// that keeps one invocation inside the 60s serverless budget has to live
// here instead: fetch+store at most this many per call. Because processed
// ids become "known" (stored), the next poll picks up where this one left
// off — a backlog drains over successive polls instead of one call timing
// out and losing everything.
const MAX_PER_POLL = 25;

// Flush to the DB periodically instead of once at the end, so a timeout partway
// through a large backlog still keeps what was already fetched — the next poll
// resumes from there instead of re-doing identical work.
const SAVE_BATCH_SIZE = 10;

// Pull recent labelled mail, match it to clients, store it. Called on CRM load
// and on an interval while a tab is open. Idempotent: re-ingesting a message is
// a no-op because the Gmail message id is the primary key.
export async function POST() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!gmailConfigured()) return NextResponse.json({ error: "Gmail is not configured." }, { status: 501 });

  let hasLabel;
  try {
    hasLabel = await labelExists();
  } catch (e) {
    console.error("gmail labelExists failed:", e?.message || e);
    return NextResponse.json({ error: "Gmail is unavailable — check the integration." }, { status: 502 });
  }
  // A missing/renamed label makes the list query below return an empty array —
  // indistinguishable from "no replies today" — so this must fail loudly instead.
  if (!hasLabel) {
    return NextResponse.json(
      { error: "The crm-replies Gmail label is missing — replies cannot be collected." },
      { status: 502 }
    );
  }

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
  const unknown = msgIds.filter((id) => !known.has(id));
  // Bound the WORK, not the list: unknown ids beyond the cap simply wait for
  // the next poll, at which point they're still unknown and get picked up.
  const toFetch = unknown.slice(0, MAX_PER_POLL);
  const more = unknown.length > toFetch.length;
  const skipped = msgIds.length - unknown.length; // already-known ids, not deferred-by-cap ones

  const rows = []; // full set fetched this invocation — used for reporting below
  let pending = []; // buffer awaiting the next flush to the DB
  const repliedClients = new Set();
  let fetchErrors = 0;
  let saved = 0;
  const savedIds = [];
  const impersonated = String(process.env.GMAIL_IMPERSONATE || "").toLowerCase();

  async function flush() {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const r = await saveMessages(db, batch);
    saved += r.saved;
    savedIds.push(...r.savedIds);
  }

  for (const id of toFetch) {
    let m;
    try { m = await getMessage(id); } catch (e) { console.error("gmail get failed:", id, e.message); fetchErrors++; continue; }
    const isOutbound = m.fromEmail === impersonated;
    const match = matchMessage(m, ctx);
    const row = {
      id: m.id, threadId: m.threadId, clientId: match.clientId, direction: isOutbound ? "out" : "in",
      fromEmail: m.fromEmail, toEmail: m.toEmail, subject: m.subject,
      snippet: m.snippet, bodyText: m.bodyText, messageIdHdr: m.messageIdHdr,
      referencesHdr: m.referencesHdr, sentAt: m.sentAt,
      matchMethod: match.method, matchConf: match.confidence,
    };
    rows.push(row);
    pending.push(row);
    // Auto-replies (out-of-office, mailing-list acks) and our own outbound mail
    // are stored so staff can see them in the Conversation view, but neither
    // may drive the "client replied" stage move — an autoresponder or our own
    // sent mail is not a signal that a human read and acted on anything.
    if (!isOutbound && !m.autoReply && match.clientId && match.confidence === "high") {
      repliedClients.add(match.clientId);
    }
    // Flush periodically so a timeout partway through a large backlog still
    // keeps what was already fetched, instead of losing the whole invocation.
    if (pending.length >= SAVE_BATCH_SIZE) await flush();
  }
  await flush();

  // Every message the list call found had a fetch that failed — that is a
  // systemic outage (expired auth, Gmail 5xx), not "no replies today", and must
  // not be reported as ok:true fetched:0.
  if (toFetch.length > 0 && fetchErrors === toFetch.length) {
    console.error(`gmail poll: all ${fetchErrors} message fetches failed`);
    return NextResponse.json({ error: "Gmail is unavailable — check the integration." }, { status: 502 });
  }

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
    // Backlog beyond MAX_PER_POLL is left for the next poll to drain — the
    // caller can use this to keep polling sooner instead of waiting the full
    // normal interval.
    more,
  });
}
