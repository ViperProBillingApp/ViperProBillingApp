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

// Depth-first search for a part matching mimeType, base64url-decoded.
function findPart(payload, mimeType) {
  if (!payload) return "";
  if (payload.mimeType === mimeType && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  for (const p of payload.parts || []) {
    const found = findPart(p, mimeType);
    if (found) return found;
  }
  return "";
}

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

// Outlook and most mobile clients send HTML-only replies with no text/plain
// part at all, so without this every such reply falls back to the ~200-char
// snippet instead of the real body. Simple tag-stripping, not a full parser —
// good enough for reading a reply, not for rendering one.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => HTML_ENTITIES[e])
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// text/plain first; text/html as a fallback so HTML-only replies keep their
// body instead of collapsing to the truncated snippet.
function plainBody(payload) {
  const plain = findPart(payload, "text/plain");
  if (plain) return plain;
  const html = findPart(payload, "text/html");
  return html ? htmlToText(html) : "";
}

// Recent messages carrying the CRM label. A 7-day window means a long weekend or
// a week's holiday with nobody opening the CRM still catches everything on the
// next poll — which is why no separate daily cron sweep is needed. Upserts are
// idempotent, so re-reading the same week repeatedly costs nothing.
export async function listRecentMessages(days = 7, max = 50) {
  const gmail = client();
  // Coerced defensively: this string is interpolated straight into the query
  // that enforces the label privacy boundary, so it must never be attacker- or
  // caller-controlled text.
  const d = Number(days) || 7;
  const { data } = await gmail.users.messages.list({
    userId: "me", q: `${CRM_LABEL_QUERY} newer_than:${d}d`, maxResults: max,
  });
  return (data.messages || []).map((m) => m.id);
}

// A missing/unparseable internalDate would otherwise throw a RangeError that
// gets swallowed by the per-message catch in the poll route, silently dropping
// the message from the fetch count with no visible reason.
function sentAtOf(internalDate) {
  const ms = Number(internalDate);
  if (!Number.isFinite(ms)) return new Date().toISOString();
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
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
    toAddresses: [header(p, "To"), header(p, "Delivered-To"), header(p, "X-Original-To"), header(p, "Cc")]
      .filter(Boolean).flatMap((v) => v.split(",").map((s) => s.trim())),
    toEmail: email(header(p, "To")),
    subject: header(p, "Subject"),
    messageIdHdr: header(p, "Message-ID"),
    referencesHdr: header(p, "References"),
    inReplyTo: header(p, "In-Reply-To"),
    // Some mailers emit comma-separated References instead of whitespace-separated.
    references: header(p, "References").split(/[\s,]+/).filter(Boolean),
    snippet: data.snippet || "",
    bodyText: plainBody(p) || data.snippet || "",
    sentAt: sentAtOf(data.internalDate),
  };
}
