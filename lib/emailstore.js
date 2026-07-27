// All email_messages reads and writes. Email lives in its own table, never in
// the client state blob: the blob is loaded whole into every browser and is the
// subject of three past data-loss incidents. Keep it that way.

// Upsert on the Gmail message id, so duplicate deliveries are a no-op.
// savedIds is the subset actually inserted (excludes rows ON CONFLICT skipped)
// — callers that must react only to genuinely NEW rows (e.g. moving a client's
// workflow stage) need this instead of the row list itself, which may include
// messages already stored from a previous poll.
export async function saveMessages(db, rows) {
  let saved = 0;
  const savedIds = [];
  for (const m of rows) {
    const r = await db.query(
      `INSERT INTO email_messages
         (id, thread_id, client_id, direction, from_email, to_email, subject,
          snippet, body_text, message_id_hdr, references_hdr, sent_at,
          match_method, match_conf)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [m.id, m.threadId, m.clientId || null, m.direction, m.fromEmail, m.toEmail,
       m.subject || "", m.snippet || "", m.bodyText || "", m.messageIdHdr || "",
       m.referencesHdr || "", m.sentAt, m.matchMethod || null, m.matchConf || null]
    );
    saved += r.rowCount;
    if (r.rowCount) savedIds.push(r.rows[0].id);
  }
  return { saved, savedIds };
}

// Which of these Gmail message ids are already stored — lets the poller skip
// re-fetching mail it has, instead of paying a messages.get to discover that.
export async function existingMessageIds(db, ids) {
  if (!ids.length) return new Set();
  const { rows } = await db.query("SELECT id FROM email_messages WHERE id = ANY($1)", [ids]);
  return new Set(rows.map((r) => r.id));
}

const COMMON_COLS = `id, thread_id AS "threadId", client_id AS "clientId", direction,
  from_email AS "fromEmail", to_email AS "toEmail", subject, snippet,
  message_id_hdr AS "messageIdHdr", references_hdr AS "referencesHdr", sent_at AS "sentAt",
  match_method AS "matchMethod", match_conf AS "matchConf",
  handled_by AS "handledBy", handled_at AS "handledAt"`;

// scope: 'unhandled' | 'unmatched' | 'all'
//
// List views (no clientId) poll every 2 minutes in every open tab and can
// return up to `limit` rows — shipping the full body_text there means whole
// quoted email chains cross the wire on a timer nobody is reading them from.
// The per-client Conversation view (clientId given) is the one place the full
// body is actually read, so only that path pays for it.
export async function listReplies(db, { scope = "unhandled", clientId = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (scope === "unhandled") where.push("handled_at IS NULL", "client_id IS NOT NULL", "direction = 'in'");
  if (scope === "unmatched") where.push("client_id IS NULL", "direction = 'in'");
  if (clientId) { params.push(clientId); where.push(`client_id = $${params.length}`); }
  params.push(limit);
  const bodyCol = clientId ? `body_text AS "bodyText"` : `left(body_text, 2000) AS "bodyText"`;
  const sql = `SELECT ${COMMON_COLS}, ${bodyCol} FROM email_messages${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY sent_at DESC LIMIT $${params.length}`;
  const { rows } = await db.query(sql, params);
  return rows;
}

// One message by id, with its full body — used by the reply-send route to read
// the thread/headers of the message being replied to.
export async function getMessageById(db, id) {
  const { rows } = await db.query(`SELECT ${COMMON_COLS}, body_text AS "bodyText" FROM email_messages WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function markHandled(db, id, byEmail) {
  const { rows } = await db.query(
    `UPDATE email_messages SET handled_by = $2, handled_at = now() WHERE id = $1 RETURNING id`,
    [id, byEmail || ""]
  );
  return rows[0] || null;
}

export async function assignToClient(db, id, clientId) {
  const { rows } = await db.query(
    `UPDATE email_messages SET client_id = $2, match_method = 'manual', match_conf = 'high' WHERE id = $1 RETURNING id`,
    [id, clientId]
  );
  return rows[0] || null;
}

// Does this client id exist? The email_messages.client_id column has no foreign
// key, so an unchecked assign would file a message against a client that isn't
// there — invisible in the unmatched queue and unrecoverable through the API.
export async function clientRowExists(db, clientId) {
  if (!clientId) return false;
  const { rows } = await db.query("SELECT 1 FROM clients WHERE id = $1 LIMIT 1", [clientId]);
  return rows.length > 0;
}

// messageIdHdr -> clientId, for matching inbound References against what we sent.
export async function outboundMessageIdIndex(db) {
  const { rows } = await db.query(
    `SELECT message_id_hdr, client_id FROM email_messages
     WHERE direction = 'out' AND message_id_hdr <> '' AND client_id IS NOT NULL`
  );
  return new Map(rows.map((r) => [r.message_id_hdr, r.client_id]));
}
