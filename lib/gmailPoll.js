// Shared core behind both Gmail pollers (the crm-replies-labeled one and the
// whole-mailbox one): fetch candidate messages, match to a client, store the
// genuinely new ones, then react to any high-confidence NEW inbound message —
// move contacted-awaiting to replied, mark the contact live, and push that
// contact to Brevo immediately rather than waiting for the nightly rotation.
import { readState, updateState } from "./clients.js";
import { saveMessages, outboundMessageIdIndex, existingMessageIds } from "./emailstore.js";
import { matchMessage } from "./replies.js";
import { pushContactsNow } from "./brevo.js";

// mode: "full" fetches each candidate directly (cheap once Gmail's own label
// filter has already narrowed the list). "metadata-first" checks headers only
// or matches before paying for a full-body fetch — the broad scan lists a lot
// of mail that will never match a client, and 99% of that mail should never
// have its body pulled through the server at all.
export async function runGmailPoll(db, { candidateIds, fetchFull, fetchMetadata, dropUnmatched, maxPerPoll }) {
  const state = await readState(db);
  const clients = state.clients || [];

  const ids = new Set(clients.map((c) => c.id));
  const byEmail = new Map();
  for (const c of clients) {
    const addrs = [c.email, ...(c.secondaryContacts || []).map((s) => s.email)]
      .filter(Boolean).flatMap((e) => String(e).split(/[,;]/)).map((e) => e.trim().toLowerCase()).filter(Boolean);
    for (const a of addrs) {
      if (!byEmail.has(a)) byEmail.set(a, []);
      if (!byEmail.get(a).includes(c.id)) byEmail.get(a).push(c.id);
    }
  }
  const ctx = { clientExists: (id) => ids.has(id), outboundIndex: await outboundMessageIdIndex(db), clientsByEmail: byEmail };
  const impersonated = String(process.env.GMAIL_IMPERSONATE || "").toLowerCase();

  const known = await existingMessageIds(db, candidateIds);
  const unknown = candidateIds.filter((id) => !known.has(id));
  const toProcess = unknown.slice(0, maxPerPoll);
  const more = unknown.length > toProcess.length;

  const rows = [];
  let pending = []; // flushed periodically so a timeout partway through a backlog keeps what was already fetched
  const replyHits = new Map(); // clientId -> fromEmail of the message that proved it
  let fetchErrors = 0;
  let saved = 0;
  const savedIds = [];

  async function flush() {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const r = await saveMessages(db, batch);
    saved += r.saved;
    savedIds.push(...r.savedIds);
  }

  for (const id of toProcess) {
    let meta;
    try {
      meta = fetchMetadata ? await fetchMetadata(id) : null;
    } catch (e) {
      console.error("gmail metadata fetch failed:", id, e?.message || e);
      fetchErrors++;
      continue;
    }
    // Cheap pre-check on headers alone: skip the full-body fetch entirely for
    // mail that can't match anyone (the common case for a whole-mailbox scan).
    if (meta) {
      const preMatch = matchMessage(meta, ctx);
      if (!preMatch.clientId && dropUnmatched) continue;
    }

    let m;
    try { m = await fetchFull(id); } catch (e) { console.error("gmail get failed:", id, e?.message || e); fetchErrors++; continue; }
    const match = matchMessage(m, ctx);
    if (!match.clientId && dropUnmatched) continue;
    const isOutbound = m.fromEmail === impersonated;

    const row = {
      id: m.id, threadId: m.threadId, clientId: match.clientId, direction: isOutbound ? "out" : "in",
      fromEmail: m.fromEmail, toEmail: m.toEmail, subject: m.subject,
      snippet: m.snippet, bodyText: m.bodyText, messageIdHdr: m.messageIdHdr,
      referencesHdr: m.referencesHdr, sentAt: m.sentAt,
      matchMethod: match.method, matchConf: match.confidence,
    };
    rows.push(row);
    pending.push(row);
    // Auto-replies and our own outbound mail are stored (so staff see them in
    // the Conversation view) but neither counts as "the client is alive".
    if (!isOutbound && !m.autoReply && match.clientId && match.confidence === "high" && !replyHits.has(match.clientId)) {
      replyHits.set(match.clientId, m.fromEmail);
    }
    if (pending.length >= 10) await flush();
  }
  await flush();

  if (toProcess.length > 0 && fetchErrors === toProcess.length) {
    throw new Error("all message fetches failed — treat as a Gmail outage, not zero new mail");
  }

  const savedIdSet = new Set(savedIds);
  const newReplyClients = new Map(
    [...replyHits].filter(([clientId]) => rows.some((r) => savedIdSet.has(r.id) && r.clientId === clientId))
  );

  // Counted from the state already in hand, BEFORE updateState — its mutate
  // callback re-runs on a rev-conflict retry, so any counter incremented
  // inside it double-counts (the exact bug the Maritz-import pass hit
  // earlier). The callback below only computes the patch, never a tally.
  const beforeById = new Map(state.clients.map((c) => [c.id, c]));
  const stageMoveIds = new Set([...newReplyClients.keys()].filter((id) => beforeById.get(id)?.stage === "contacted-awaiting"));
  const contactsMarkedLive = [...newReplyClients.keys()].filter((id) => beforeById.get(id)?.contactLive !== true).length;

  let stageMoved = false, stageMoveError = null;
  if (newReplyClients.size) {
    const result = await updateState(db, (s) => {
      let changed = false;
      const now = new Date().toISOString();
      const next = (s.clients || []).map((c) => {
        if (!newReplyClients.has(c.id)) return c;
        const stageMove = stageMoveIds.has(c.id) && c.stage === "contacted-awaiting";
        if (c.contactLive === true && !stageMove) return c; // nothing left to change on this client
        changed = true;
        return {
          ...c,
          contactLive: true,
          contactLiveCheckedAt: now,
          ...(stageMove ? {
            stage: "replied", stageAt: now,
            activity: [{ at: now, type: "email", text: "Client replied — moved to Replied · needs action" }, ...(c.activity || [])].slice(0, 200),
          } : {}),
        };
      });
      return changed ? { clients: next } : null;
    });
    if (!result.ok) stageMoveError = result.error;
    else stageMoved = stageMoveIds.size > 0;
  }

  // Push to Brevo right away — best-effort, a failure here must not undo the
  // CRM-side state change above (the nightly rotation will still catch it).
  let brevoPushed = 0;
  if (newReplyClients.size) {
    try {
      const fresh = await readState(db);
      const r = await pushContactsNow(fresh.clients || [], [...newReplyClients.values()]);
      brevoPushed = r.pushed;
    } catch (e) {
      console.error("gmail poll: brevo push failed:", e?.message || e);
    }
  }

  return {
    fetched: rows.length, saved, fetchErrors, more,
    matched: rows.filter((r) => r.clientId).length,
    unmatched: rows.filter((r) => !r.clientId).length,
    stageMoved, contactsMarkedLive, brevoPushed, ...(stageMoveError ? { stageMoveError } : {}),
  };
}
