// All email_messages reads and writes. Email lives in its own table, never in
// the client state blob: the blob is loaded whole into every browser and is the
// subject of three past data-loss incidents. Keep it that way.

// Upsert on the Gmail message id, so duplicate deliveries are a no-op.
export async function saveMessages(db, rows) {
  let saved = 0;
  for (const m of rows) {
    const r = await db.query(
      `INSERT INTO email_messages
         (id, thread_id, client_id, direction, from_email, to_email, subject,
          snippet, body_text, message_id_hdr, references_hdr, sent_at,
          match_method, match_conf)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [m.id, m.threadId, m.clientId || null, m.direction, m.fromEmail, m.toEmail,
       m.subject || "", m.snippet || "", m.bodyText || "", m.messageIdHdr || "",
       m.referencesHdr || "", m.sentAt, m.matchMethod || null, m.matchConf || null]
    );
    saved += r.rowCount;
  }
  return { saved };
}

const SELECT = `SELECT id, thread_id AS "threadId", client_id AS "clientId", direction,
  from_email AS "fromEmail", to_email AS "toEmail", subject, snippet, body_text AS "bodyText",
  message_id_hdr AS "messageIdHdr", references_hdr AS "referencesHdr", sent_at AS "sentAt",
  match_method AS "matchMethod", match_conf AS "matchConf",
  handled_by AS "handledBy", handled_at AS "handledAt"
  FROM email_messages`;

// scope: 'unhandled' | 'unmatched' | 'all'
export async function listReplies(db, { scope = "unhandled", clientId = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (scope === "unhandled") where.push("handled_at IS NULL", "client_id IS NOT NULL", "direction = 'in'");
  if (scope === "unmatched") where.push("client_id IS NULL", "direction = 'in'");
  if (clientId) { params.push(clientId); where.push(`client_id = $${params.length}`); }
  params.push(limit);
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY sent_at DESC LIMIT $${params.length}`;
  const { rows } = await db.query(sql, params);
  return rows;
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

// messageIdHdr -> clientId, for matching inbound References against what we sent.
export async function outboundMessageIdIndex(db) {
  const { rows } = await db.query(
    `SELECT message_id_hdr, client_id FROM email_messages
     WHERE direction = 'out' AND message_id_hdr <> '' AND client_id IS NOT NULL`
  );
  return new Map(rows.map((r) => [r.message_id_hdr, r.client_id]));
}
