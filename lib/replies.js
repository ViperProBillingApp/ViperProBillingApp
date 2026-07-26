// Matching an inbound message to a client. Pure functions — no DB, no network —
// so the cascade is unit-testable, which matters because mis-filing collections
// mail is expensive and silent.
//
// Order matters. The token is checked first and wins outright: forwarded mail
// carries In-Reply-To/References too, so a header match alone can attribute a
// forward to the wrong client.
import { verifyReplyToken, tokenFromAddress } from "./replytoken.js";

export function matchMessage(msg, ctx) {
  const none = { clientId: null, method: null, confidence: "low" };

  // 1. Signed reply token in To/Delivered-To — survives the client replying from
  //    a different address or their mail client stripping headers.
  for (const addr of msg.toAddresses || []) {
    const tok = tokenFromAddress(addr);
    if (!tok) continue;
    const id = verifyReplyToken(tok);
    if (id && ctx.clientExists(id)) return { clientId: id, method: "token", confidence: "high" };
  }

  // 2. Any Message-ID we sent, found anywhere in References or In-Reply-To.
  const ids = [...(msg.references || []), msg.inReplyTo].filter(Boolean);
  for (const mid of ids) {
    const id = ctx.outboundIndex.get(mid);
    if (id && ctx.clientExists(id)) return { clientId: id, method: "headers", confidence: "high" };
  }

  // 3. Sender address. Also catches a client emailing about an invoice unprompted.
  const fromLower = String(msg.fromEmail || "").toLowerCase();
  let hits = ctx.clientsByEmail.get(fromLower);
  if (!hits) {
    // Direct lookup assumes the caller already lowercased the map's keys. Don't
    // let a caller that forgot silently misfile a client's reply as unmatched —
    // fall back to a case-insensitive scan.
    for (const [key, val] of ctx.clientsByEmail) {
      if (key.toLowerCase() === fromLower) { hits = val; break; }
    }
  }
  hits = hits || [];
  if (hits.length === 1) return { clientId: hits[0], method: "sender", confidence: "high" };
  if (hits.length > 1) return { clientId: hits[0], method: "sender", confidence: "low" };

  return none;
}
