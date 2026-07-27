import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { gmailConfigured, sendThreadedReply, getMessage } from "../../../../lib/gmail.js";
import { getMessageById, saveMessages, markHandled } from "../../../../lib/emailstore.js";

// Reply to a client's inbound email, threaded, AS the signed-in mailbox — via
// Gmail, not Brevo, so it sits in the client's existing thread and in Sent.
// Stores the outgoing message as a direction:'out' row (so the Conversation view
// shows it and a reply to our reply threads back) and marks the inbound handled.
export async function POST(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!gmailConfigured()) return NextResponse.json({ error: "Gmail is not configured." }, { status: 501 });

  const { replyToId, body } = await req.json().catch(() => ({}));
  if (!replyToId || !String(body || "").trim()) {
    return NextResponse.json({ error: "A message body is required." }, { status: 400 });
  }

  const db = await getDb();
  const src = await getMessageById(db, String(replyToId));
  if (!src || src.direction !== "in") {
    return NextResponse.json({ error: "Original message not found." }, { status: 404 });
  }
  if (!src.fromEmail) {
    return NextResponse.json({ error: "That message has no sender address to reply to." }, { status: 400 });
  }

  const subject = /^re:/i.test(src.subject || "") ? src.subject : `Re: ${src.subject || "(no subject)"}`;

  // Plain text typed by staff -> safe HTML. Escape first, THEN turn newlines into
  // breaks, so nothing the user types is interpreted as markup.
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${esc(body).replace(/\r?\n/g, "<br>")}</div>`;
  // Signature image, same data-URL approach the Brevo path uses.
  if (me.signature_image) html += `\n<p><img src="${me.signature_image}" alt="signature" style="max-width:360px;height:auto"></p>`;

  let sent;
  try {
    sent = await sendThreadedReply({
      threadId: src.threadId,
      inReplyTo: src.messageIdHdr,
      references: src.referencesHdr,
      to: src.fromEmail,
      subject,
      bodyHtml: html,
    });
  } catch (e) {
    console.error("gmail reply send failed:", e?.message || e);
    return NextResponse.json({ error: "Send failed — the message was not sent." }, { status: 502 });
  }

  // Store the outbound row so the Conversation shows it. Best-effort: the mail is
  // already sent, so a storage hiccup must NOT surface as a send failure. Fetch
  // the assigned Message-ID/date so a reply to our reply threads back to us.
  try {
    let messageIdHdr = "", sentAt = new Date().toISOString();
    try { const meta = await getMessage(sent.id); messageIdHdr = meta.messageIdHdr; sentAt = meta.sentAt; } catch { /* metadata is a bonus */ }
    await saveMessages(db, [{
      id: sent.id, threadId: sent.threadId || src.threadId, clientId: src.clientId, direction: "out",
      fromEmail: (process.env.GMAIL_IMPERSONATE || "").toLowerCase(), toEmail: src.fromEmail,
      subject, snippet: String(body).slice(0, 200), bodyText: String(body),
      messageIdHdr, referencesHdr: "", sentAt, matchMethod: null, matchConf: null,
    }]);
  } catch (e) { console.error("stored outbound reply failed (mail was still sent):", e?.message || e); }

  // Replying is handling it — drop it from the unhandled queue.
  await markHandled(db, String(replyToId), me.email).catch(() => {});

  return NextResponse.json({ ok: true });
}
