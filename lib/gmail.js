import { google } from "googleapis";

// Read access to ONE mailbox, narrowed to one label. gmail.modify is the single
// scope covering read + send + labels; mail.google.com is deliberately NOT used
// because it adds permanent delete.
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

// Only ever this label. The service account can technically read the whole
// mailbox, so this query IS the privacy control — do not widen it.
export const CRM_LABEL_QUERY = "label:crm-replies";

export function gmailConfigured() {
  return !!(process.env.GMAIL_SA_EMAIL && process.env.GMAIL_SA_PRIVATE_KEY && process.env.GMAIL_IMPERSONATE);
}

function client() {
  const auth = new google.auth.JWT({
    email: process.env.GMAIL_SA_EMAIL,
    key: String(process.env.GMAIL_SA_PRIVATE_KEY).replace(/\\n/g, "\n"),
    scopes: SCOPES,
    // Hard-coded server-side from env, NEVER from request input — this is the
    // mitigation for the domain-wide delegation blast radius.
    subject: process.env.GMAIL_IMPERSONATE,
  });
  return google.gmail({ version: "v1", auth });
}

const header = (payload, name) =>
  (payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

// Depth-first search for the first text/plain part; falls back to the snippet.
function plainBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  for (const p of payload.parts || []) {
    const found = plainBody(p);
    if (found) return found;
  }
  return "";
}

// Recent messages carrying the CRM label. A 7-day window means a long weekend or
// a week's holiday with nobody opening the CRM still catches everything on the
// next poll — which is why no separate daily cron sweep is needed. Upserts are
// idempotent, so re-reading the same week repeatedly costs nothing.
export async function listRecentMessages(days = 7, max = 50) {
  const gmail = client();
  const { data } = await gmail.users.messages.list({
    userId: "me", q: `${CRM_LABEL_QUERY} newer_than:${days}d`, maxResults: max,
  });
  return (data.messages || []).map((m) => m.id);
}

export async function getMessage(id) {
  const gmail = client();
  const { data } = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const p = data.payload;
  const from = header(p, "From");
  const email = (s) => (/<([^>]+)>/.exec(s)?.[1] || s || "").trim().toLowerCase();
  return {
    id: data.id,
    threadId: data.threadId,
    fromEmail: email(from),
    toAddresses: [header(p, "To"), header(p, "Delivered-To"), header(p, "X-Original-To")]
      .filter(Boolean).flatMap((v) => v.split(",").map((s) => s.trim())),
    toEmail: email(header(p, "To")),
    subject: header(p, "Subject"),
    messageIdHdr: header(p, "Message-ID"),
    referencesHdr: header(p, "References"),
    inReplyTo: header(p, "In-Reply-To"),
    references: header(p, "References").split(/\s+/).filter(Boolean),
    snippet: data.snippet || "",
    bodyText: plainBody(p) || data.snippet || "",
    sentAt: new Date(Number(data.internalDate)).toISOString(),
  };
}
