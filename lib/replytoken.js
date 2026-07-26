import crypto from "node:crypto";

// Reply tokens. A chase goes out with replyTo droffey+crm-<clientId><mac8>@domain;
// the token comes back in the reply's To/Delivered-To header and identifies the
// client. The MAC stops a forged or mistyped token resolving to someone's record.
// Keyed off the existing ENCRYPTION_KEY via a fixed label, so there is no new
// secret to manage or rotate.
const LABEL = "viperpro-reply-token-v1";
const MAC_LEN = 8;

function secret() {
  const k = process.env.ENCRYPTION_KEY;
  if (!k) return null;
  return crypto.createHmac("sha256", k).update(LABEL).digest();
}

function mac(secretBuf, id) {
  return crypto.createHmac("sha256", secretBuf).update(id).digest("hex").slice(0, MAC_LEN);
}

// Returns null when there is no key or no id — callers must send WITHOUT a token
// rather than emit an unsigned one (fail closed; matching degrades to headers/sender).
export function mintReplyToken(clientId) {
  const s = secret();
  const id = String(clientId || "");
  if (!s || !id) return null;
  return `${id}${mac(s, id)}`;
}

export function verifyReplyToken(token) {
  const s = secret();
  if (!s || typeof token !== "string" || token.length <= MAC_LEN) return null;
  const id = token.slice(0, -MAC_LEN);
  const got = Buffer.from(token.slice(-MAC_LEN));
  const want = Buffer.from(mac(s, id));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  return id;
}

// Pull the token out of "droffey+crm-<token>@vipeventresources.com".
export function tokenFromAddress(addr) {
  const m = /\+crm-([A-Za-z0-9]+)@/.exec(String(addr || ""));
  return m ? m[1] : null;
}
