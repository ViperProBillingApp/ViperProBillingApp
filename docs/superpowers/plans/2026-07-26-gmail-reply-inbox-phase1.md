# Gmail Reply Inbox — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make client replies visible in the CRM — ingested from a watched Gmail mailbox, matched to the right client, and surfaced on a Replies tab and the client card — so the collections loop stops relying on a 10-day guess.

**Architecture:** Chase emails continue to go out through Brevo, now carrying a signed reply token in `replyTo` and recording Brevo's `messageId`. A polling route pulls new mail from one Gmail mailbox (narrowed to `label:crm-replies`) via a domain-wide-delegated service account, runs a pure-function matching cascade (token → headers → sender), and stores results in a dedicated `email_messages` table. The UI reads that table through its own API; email never enters the client state blob.

**Tech Stack:** Next.js 15 (JS, app router), React 19, Vercel serverless, Supabase Postgres (`pg`), `googleapis`, Brevo transactional API, `node:assert` scripts for tests.

**Spec:** `docs/superpowers/specs/2026-07-26-gmail-reply-inbox-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **JavaScript, not TypeScript.** App router. No type annotations anywhere.
- **Never push or deploy without Darryl saying "commit + deploy".** Commit steps in this plan are LOCAL commits only. Never run `git push`.
- **Never run `npx next build` while `next dev` is running** — it corrupts `.next`. Stop the dev server first; if corrupted, `rm -rf .next` and rebuild.
- **Dev and prod share ONE live database.** There is no staging. Any DB testing uses throwaway records, cleaned up in a `finally` block.
- **There is no test login.** Claude cannot click-verify authenticated UI. Say so plainly; never claim visual verification that did not happen.
- **Server-side writes to the client state blob MUST use `updateState()`** from `lib/clients.js` (rev-guarded, mirrors rows). Never write the `kv` `state` key directly.
- **New persisted client fields need a self-healing `normalise()` default in `components/crm.jsx`, deployed BEFORE any data is written**, or a stale browser tab will strip the field.
- **The Gmail query is `label:crm-replies` and nothing else.** Widening it is a privacy regression — the integration can technically read the whole mailbox and query narrowing is the only control.
- **The Gmail impersonation subject is hard-coded server-side**, read from an env var, never from request input.
- **Never commit credentials.** Service-account keys go in `.env.local` and Vercel env vars only.
- **UI styling:** inline styles, tokens from `lib/brand.js` (`C.*`, `C.boardGradient`, `SANS`, `MONO`, `DISPLAY`). Match surrounding code; do not introduce a CSS framework.
- **Tests are `node:assert` scripts** in `scripts/`, wired into `npm run check`. No test framework.
- Every new API route returns **401 when unauthenticated** via `getSessionUser()`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/replytoken.js` | **Create.** Mint/verify/parse the signed reply token. Pure, no I/O. |
| `lib/replies.js` | **Create.** The matching cascade. Pure functions, no network or DB. |
| `lib/gmail.js` | **Create.** Gmail auth (DWD) + read operations. |
| `lib/emailstore.js` | **Create.** All `email_messages` DB reads/writes. |
| `lib/email.js` | **Modify.** `brevoSend` returns `{ok, messageId}` and accepts `replyTo`. |
| `lib/db.js` | **Modify.** Add `email_messages` to `SCHEMA_SQL` + RLS/grants. |
| `app/api/comms/send/route.js` | **Modify.** Mint token, pass `replyTo`, return `messageId`. |
| `app/api/gmail/poll/route.js` | **Create.** Pull → match → store. |
| `app/api/replies/route.js` | **Create.** List / mark handled / assign unmatched. |
| `components/crm.jsx` | **Modify.** `replied` stage, Replies tab, Conversation section, Today row, poll trigger, store `messageId`. |
| `scripts/check-replies.mjs` | **Create.** Assert tests for token + matching. |
| `package.json` | **Modify.** Add `googleapis`; `check` runs both check scripts. |

---

### Task 1: Reply token (pure, signed)

**Files:**
- Create: `lib/replytoken.js`
- Create: `scripts/check-replies.mjs`
- Modify: `package.json` (the `check` script)

**Interfaces:**
- Consumes: `process.env.ENCRYPTION_KEY` (already set in both environments).
- Produces: `mintReplyToken(clientId) -> string|null`, `verifyReplyToken(token) -> clientId|null`, `tokenFromAddress(addr) -> string|null`. Tasks 2 and 5 use all three.

- [ ] **Step 1: Write the failing test**

Create `scripts/check-replies.mjs`:

```js
// Smallest check that fails if reply-token or reply-matching logic breaks.
// Pure logic only — no DB, no network. Run: npm run check
import assert from "node:assert";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  || "0".repeat(64); // deterministic key for the pure-logic checks

const { mintReplyToken, verifyReplyToken, tokenFromAddress } =
  await import("../lib/replytoken.js");

// mint → verify round trip
const tok = mintReplyToken("k3f9a2xq");
assert.ok(tok, "token should mint");
assert.strictEqual(verifyReplyToken(tok), "k3f9a2xq", "round trip returns the client id");

// forged / tampered tokens must be rejected
assert.strictEqual(verifyReplyToken("k3f9a2xq" + "deadbeef"), null, "bad mac rejected");
assert.strictEqual(verifyReplyToken("garbage"), null, "garbage rejected");
assert.strictEqual(verifyReplyToken(""), null, "empty rejected");
assert.strictEqual(verifyReplyToken(null), null, "null rejected");

// a different client id must not verify against another's mac
const other = mintReplyToken("zzzzzzzz");
assert.notStrictEqual(other, tok, "different ids give different tokens");
assert.strictEqual(verifyReplyToken("k3f9a2xq" + other.slice(-8)), null, "mac is bound to the id");

// address parsing
assert.strictEqual(
  tokenFromAddress(`droffey+crm-${tok}@vipeventresources.com`), tok, "extracts token from address");
assert.strictEqual(tokenFromAddress("droffey@vipeventresources.com"), null, "plain address has no token");
assert.strictEqual(tokenFromAddress(""), null, "empty address safe");

console.log("check-replies: OK");
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && node scripts/check-replies.mjs
```

Expected: FAIL — `Cannot find module '../lib/replytoken.js'`.

- [ ] **Step 3: Write the implementation**

Create `lib/replytoken.js`:

```js
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
```

- [ ] **Step 4: Wire the check script into npm**

In `package.json`, replace the `check` line:

```json
    "check": "node scripts/check-auth.mjs && node scripts/check-replies.mjs"
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && npm run check
```

Expected: existing auth checks pass, then `check-replies: OK`.

- [ ] **Step 6: Commit (local only)**

```bash
git add lib/replytoken.js scripts/check-replies.mjs package.json
git commit -m "Add signed reply tokens for matching client replies"
```

---

### Task 2: Capture Brevo messageId and send the reply token

**Files:**
- Modify: `lib/email.js`
- Modify: `app/api/comms/send/route.js`
- Modify: `components/crm.jsx` (the `markSent` call in `EmailEditor`)

**Interfaces:**
- Consumes: `mintReplyToken` from Task 1.
- Produces: `sendClientEmail(...)` now resolves to `{ ok: boolean, messageId: string|null }` (previously a bare boolean). `POST /api/comms/send` response gains `messageId`. Task 5 matches inbound `References` against these stored ids.

**Context the implementer needs:** `brevoSend` currently returns `r.ok` and discards the body. Brevo's `POST /v3/smtp/email` returns `{"messageId": "<...@relay.domain.com>"}` — store it verbatim, angle brackets included. Brevo **ignores custom standard headers**, so `replyTo` is the only correlation channel available at send time; that is why the token exists.

- [ ] **Step 1: Find every caller so none is missed**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && grep -rn "sendClientEmail\|sendDigestEmail\|sendResetEmail\|sendInviteEmail" app lib components
```

Expected: `sendClientEmail` used in `app/api/comms/send/route.js`; the other three in users/auth routes and the cron. **The other three must keep returning a boolean** — a caller doing `if (!ok)` against an object would always see truthy and silently treat failures as success.

- [ ] **Step 2: Change `brevoSend` and `sendClientEmail` in `lib/email.js`**

Replace the `brevoSend` function body's return path and add `replyTo`:

```js
// Returns { ok, messageId }. messageId is Brevo's RFC2822 Message-ID, stored so
// inbound replies can be matched on In-Reply-To / References.
async function brevoSend(to, name, subject, htmlContent, opts = {}) {
  const key = process.env.BREVO_API_KEY;
  if (!key) return { ok: false, messageId: null };
  const norm = (arr) => arr
    .map((r) => (typeof r === "string" ? { email: r } : r))
    .map((r) => ({ email: r.email, name: r.name || undefined }));
  const payload = {
    sender: opts.from ? { email: opts.from, name: FROM.name } : FROM,
    to: norm(Array.isArray(to) ? to : [{ email: to, name }]),
    subject, htmlContent,
  };
  if (Array.isArray(opts.cc) && opts.cc.length) payload.cc = norm(opts.cc);
  if (opts.replyTo) payload.replyTo = { email: opts.replyTo };
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) return { ok: false, messageId: null };
  const d = await r.json().catch(() => ({}));
  const messageId = d.messageId || (Array.isArray(d.messageIds) ? d.messageIds[0] : null);
  return { ok: true, messageId: messageId || null };
}
```

`sendClientEmail` already `return`s `brevoSend(...)`, so it now resolves to the object — no change needed to its body.

- [ ] **Step 3: Keep the three staff-mail helpers boolean**

In `lib/email.js`, change the three staff helpers to unwrap `.ok` so their existing callers keep working:

```js
export async function sendDigestEmail(recipients, subject, html) {
  return (await brevoSend(recipients, "", subject, html)).ok;
}
```

Apply the same `(await brevoSend(...)).ok` unwrapping to `sendResetEmail` and `sendInviteEmail`, converting each to `async`.

- [ ] **Step 4: Mint the token and return the messageId from the send route**

In `app/api/comms/send/route.js`, add the import:

```js
import { mintReplyToken } from "../../../../lib/replytoken.js";
```

The route currently ends with:

```js
  const ok = await sendClientEmail(list || String(to), String(name || ""), String(subject), String(body), me.signature_image || "", { cc: ccList || undefined, from: from || undefined });
  if (!ok) return NextResponse.json({ error: "Send failed — Brevo not configured or rejected the message." }, { status: 502 });
```

Replace with (accepting a new optional `clientId` in the request body, destructured alongside the existing fields):

```js
  // Signed reply token so the client's reply can be attributed on the way back in.
  // Fails closed: no key or no clientId means no token, and matching falls back
  // to headers/sender rather than emitting something unsigned.
  const token = clientId ? mintReplyToken(String(clientId)) : null;
  const replyTo = token ? `${REPLY_INBOX_USER}+crm-${token}@${REPLY_INBOX_DOMAIN}` : undefined;

  const sent = await sendClientEmail(
    list || String(to), String(name || ""), String(subject), String(body),
    me.signature_image || "",
    { cc: ccList || undefined, from: from || undefined, replyTo }
  );
  if (!sent.ok) return NextResponse.json({ error: "Send failed — Brevo not configured or rejected the message." }, { status: 502 });
```

Add near the top of the file, below the imports:

```js
// Where client replies are collected. Split so the local part can carry the
// +crm-<token> suffix. Moving to a dedicated service mailbox later is a config
// change here, nothing more.
const REPLY_INBOX_USER = process.env.REPLY_INBOX_USER || "droffey";
const REPLY_INBOX_DOMAIN = process.env.REPLY_INBOX_DOMAIN || "vipeventresources.com";
```

Then include `messageId` in the success response — find the final `NextResponse.json` in the route and add the field, e.g. `return NextResponse.json({ ok: true, messageId: sent.messageId });`.

- [ ] **Step 5: Store the messageId on the client's send log**

In `components/crm.jsx`, `EmailEditor` currently posts to `/api/comms/send` and then calls `markSent("brevo")`. Change `sendNow` so the parsed response is passed through, and `markSent` records it:

```js
  const markSent = (via, messageId) => {
    const now = new Date().toISOString();
    // Sent = contacted: leave the email queue and start the 10-day reply clock.
    onLogSent(client.id, key, { sentAt: now, via, subject, body, label: tpl.label, dismissedAt: now, messageId: messageId || "" }, tpl.label);
    if (client.stage !== "marked-deletion") {
      onUpdateWithLog?.(client.id, { stage: "contacted-awaiting", stageAt: now }, "stage", "Email sent — Contacted · awaiting reply");
    }
  };
```

In the same component's `sendNow`, include the client id in the POST body so the route can mint the token, and pass the returned id through:

```js
        body: JSON.stringify({
          recipients: toList.map((e) => ({ email: e })),
          ...(ccList.length ? { cc: ccList.map((e) => ({ email: e })) } : {}),
          ...(fromStr.trim().toLowerCase() !== FROM_EMAIL.toLowerCase() ? { from: fromStr.trim() } : {}),
          clientId: client.id,
          subject, body,
        }),
```

and replace `markSent("brevo");` with `markSent("brevo", d.messageId);`.

- [ ] **Step 6: Verify the build compiles**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && npx esbuild components/crm.jsx --loader:.jsx=jsx --outfile=/dev/null && node --check lib/email.js && node --check app/api/comms/send/route.js
```

Expected: esbuild prints a timing line; `node --check` prints nothing (success).

- [ ] **Step 7: Commit (local only)**

```bash
git add lib/email.js app/api/comms/send/route.js components/crm.jsx
git commit -m "Capture Brevo messageId and send a signed reply token on chases"
```

---

### Task 3: Add the "Replied · needs action" stage

**Files:**
- Modify: `components/crm.jsx` (the `STAGES` constant)

**Interfaces:**
- Produces: stage key `"replied"`, usable by Task 5's auto-move.

**Why this ships alone and first:** `normalise()` does `stage: STAGES[r.stage] ? r.stage : "not-contacted"`. A browser tab running an older bundle that does not know `"replied"` would **reset any replied card to "Not contacted"** on its next save. So the stage must be deployed, and every open tab hard-refreshed, *before* anything writes it. Shipping it as its own change makes that ordering explicit.

- [ ] **Step 1: Add the stage**

In `components/crm.jsx`, in the `STAGES` object, add between `contacted-awaiting` and `up-to-date`:

```js
  "replied": { label: "Replied · needs action", color: "#7A4FB5", order: 2.5 },
```

`STAGE_ORDER` sorts numerically on `order`, so `2.5` slots in correctly with no other change.

- [ ] **Step 2: Confirm the 10-day bounce-back leaves it alone**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && grep -n 'contacted-awaiting' components/crm.jsx
```

Expected: the workflow automation only acts on `c.stage === "contacted-awaiting"`. Because a replied card is no longer in that stage, the timer stops firing at it with no code change. **If any automation matches on something broader, stop and report it** rather than adjusting the automation.

- [ ] **Step 3: Verify the build compiles**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && npx esbuild components/crm.jsx --loader:.jsx=jsx --outfile=/dev/null
```

Expected: a timing line, no errors.

- [ ] **Step 4: Commit (local only)**

```bash
git add components/crm.jsx
git commit -m "Add Replied stage ahead of the reply-inbox ingestion"
```

- [ ] **Step 5: Flag the deploy ordering to Darryl**

Tell him in plain words: this stage must be deployed and **all open CRM tabs hard-refreshed** before Task 5 goes live, or a stale tab will reset replied cards to "Not contacted".

---

### Task 4: `email_messages` table and store module

**Files:**
- Modify: `lib/db.js` (`SCHEMA_SQL`)
- Create: `lib/emailstore.js`
- Create: `scripts/check-emailstore.mjs`
- Modify: `package.json` (`check` script)

**Interfaces:**
- Consumes: `getDb()` from `lib/db.js`.
- Produces: `saveMessages(db, rows) -> {saved}`, `listReplies(db, {scope, clientId, limit}) -> rows[]`, `markHandled(db, id, byEmail) -> row|null`, `assignToClient(db, id, clientId) -> row|null`, `outboundMessageIdIndex(db) -> Map<messageIdHdr, clientId>`. Tasks 5 and 6 use these.

- [ ] **Step 1: Add the table to SCHEMA_SQL**

In `lib/db.js`, inside the `SCHEMA_SQL` template literal, add before the RLS/REVOKE block:

```sql
CREATE TABLE IF NOT EXISTS email_messages (
  id             text PRIMARY KEY,
  thread_id      text NOT NULL,
  client_id      text,
  direction      text NOT NULL,
  from_email     text NOT NULL,
  to_email       text NOT NULL,
  subject        text,
  snippet        text,
  body_text      text,
  message_id_hdr text,
  references_hdr text,
  sent_at        timestamptz NOT NULL,
  match_method   text,
  match_conf     text,
  handled_by     text,
  handled_at     timestamptz,
  created_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_messages_client_idx ON email_messages (client_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS email_messages_thread_idx ON email_messages (thread_id);
CREATE INDEX IF NOT EXISTS email_messages_unhandled_idx ON email_messages (handled_at, sent_at DESC);
ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;
```

Then add `email_messages` to the existing `REVOKE ALL ON ...` list so Supabase's anon REST API cannot reach it. **Do not put backticks inside the SQL comments** — a backtick closes the JS template literal and breaks the build.

- [ ] **Step 2: Write the failing test**

Create `scripts/check-emailstore.mjs`:

```js
// DB-backed check for the email_messages store. Uses throwaway ids, cleaned up
// in `finally`. Skips entirely when DATABASE_URL is unset. Run: npm run check
import assert from "node:assert";

if (!process.env.DATABASE_URL) {
  console.log("check-emailstore: skipped (no DATABASE_URL)");
  process.exit(0);
}

const { getDb } = await import("../lib/db.js");
const { saveMessages, listReplies, markHandled, assignToClient } =
  await import("../lib/emailstore.js");

const db = await getDb();
const A = "test-msg-a-" + Date.now();
const B = "test-msg-b-" + Date.now();

try {
  const row = (id, over = {}) => ({
    id, threadId: "test-thread", clientId: "test-client", direction: "in",
    fromEmail: "someone@example.com", toEmail: "droffey@vipeventresources.com",
    subject: "Re: invoice", snippet: "thanks", bodyText: "thanks",
    messageIdHdr: `<${id}@example.com>`, referencesHdr: "",
    sentAt: new Date().toISOString(), matchMethod: "token", matchConf: "high",
    ...over,
  });

  await saveMessages(db, [row(A)]);
  let got = await listReplies(db, { scope: "all", clientId: "test-client" });
  assert.strictEqual(got.length, 1, "saved row is listed");
  assert.strictEqual(got[0].subject, "Re: invoice", "fields round trip");

  // idempotent: same Gmail id twice must not duplicate
  await saveMessages(db, [row(A)]);
  got = await listReplies(db, { scope: "all", clientId: "test-client" });
  assert.strictEqual(got.length, 1, "re-saving the same message id is a no-op");

  // unhandled → handled
  got = await listReplies(db, { scope: "unhandled", clientId: "test-client" });
  assert.strictEqual(got.length, 1, "starts unhandled");
  await markHandled(db, A, "staff@vipeventresources.com");
  got = await listReplies(db, { scope: "unhandled", clientId: "test-client" });
  assert.strictEqual(got.length, 0, "handled rows leave the unhandled list");

  // unmatched → assigned
  await saveMessages(db, [row(B, { clientId: null, matchMethod: null, matchConf: "low" })]);
  got = await listReplies(db, { scope: "unmatched" });
  assert.ok(got.some((r) => r.id === B), "unmatched row appears in the unmatched list");
  await assignToClient(db, B, "test-client");
  got = await listReplies(db, { scope: "unmatched" });
  assert.ok(!got.some((r) => r.id === B), "assigning removes it from unmatched");

  console.log("check-emailstore: OK");
} finally {
  await db.query("DELETE FROM email_messages WHERE id = ANY($1)", [[A, B]]);
  process.exit(0);
}
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && set -a && . ./.env.local && set +a && node scripts/check-emailstore.mjs
```

Expected: FAIL — `Cannot find module '../lib/emailstore.js'`.

- [ ] **Step 4: Write the implementation**

Create `lib/emailstore.js`:

```js
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
```

- [ ] **Step 5: Wire into npm and run**

In `package.json`:

```json
    "check": "node scripts/check-auth.mjs && node scripts/check-replies.mjs && node scripts/check-emailstore.mjs"
```

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && set -a && . ./.env.local && set +a && npm run check
```

Expected: all three scripts pass, ending `check-emailstore: OK`.

- [ ] **Step 6: Verify the table really exists and is locked down**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && set -a && . ./.env.local && set +a && node -e '
const { getDb } = await import("./lib/db.js");
const db = await getDb();
const t = await db.query("SELECT to_regclass($1) t", ["public.email_messages"]);
const r = await db.query("SELECT relrowsecurity FROM pg_class WHERE relname = $1", ["email_messages"]);
console.log("table:", t.rows[0].t, "| RLS:", r.rows[0].relrowsecurity);
process.exit(0);' --input-type=module
```

Expected: `table: email_messages | RLS: true`.

- [ ] **Step 7: Commit (local only)**

```bash
git add lib/db.js lib/emailstore.js scripts/check-emailstore.mjs package.json
git commit -m "Add email_messages table and store module"
```

---

### Task 5: Matching cascade (pure)

**Files:**
- Create: `lib/replies.js`
- Modify: `scripts/check-replies.mjs` (append matching tests)

**Interfaces:**
- Consumes: `verifyReplyToken`, `tokenFromAddress` from Task 1.
- Produces: `matchMessage(msg, ctx) -> { clientId, method, confidence }`. Task 6 calls it.
  - `msg`: `{ toAddresses: string[], fromEmail: string, inReplyTo: string, references: string[] }`
  - `ctx`: `{ clientExists: (id)=>boolean, outboundIndex: Map<string,string>, clientsByEmail: Map<string,string[]> }`
  - returns `method` of `'token' | 'headers' | 'sender' | null`, `confidence` of `'high' | 'low'`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/check-replies.mjs`, before the final `console.log`:

```js
const { matchMessage } = await import("../lib/replies.js");

const ctx = {
  clientExists: (id) => ["k3f9a2xq", "other111"].includes(id),
  outboundIndex: new Map([["<sent-1@relay.brevo.com>", "other111"]]),
  clientsByEmail: new Map([
    ["solo@acme.com", ["k3f9a2xq"]],
    ["shared@group.com", ["k3f9a2xq", "other111"]],
  ]),
};
const base = { toAddresses: [], fromEmail: "", inReplyTo: "", references: [] };

// 1. token wins, and beats a conflicting header match
{
  const m = matchMessage({ ...base,
    toAddresses: [`droffey+crm-${tok}@vipeventresources.com`],
    references: ["<sent-1@relay.brevo.com>"], fromEmail: "someone@else.com" }, ctx);
  assert.deepStrictEqual([m.clientId, m.method, m.confidence], ["k3f9a2xq", "token", "high"],
    "valid token wins over conflicting header/sender signals");
}

// a forged token must NOT match, and must fall through to the next signal
{
  const m = matchMessage({ ...base,
    toAddresses: ["droffey+crm-k3f9a2xqdeadbeef@vipeventresources.com"],
    references: ["<sent-1@relay.brevo.com>"] }, ctx);
  assert.strictEqual(m.clientId, "other111", "forged token ignored, header used instead");
  assert.strictEqual(m.method, "headers", "method reflects the signal actually used");
}

// 2. header match scans ALL References, not just In-Reply-To
{
  const m = matchMessage({ ...base,
    references: ["<unknown@x.com>", "<sent-1@relay.brevo.com>"] }, ctx);
  assert.strictEqual(m.clientId, "other111", "matches any id in References");
}

// 3. sender fallback — one hit is confident, several is not
{
  const one = matchMessage({ ...base, fromEmail: "SOLO@acme.com" }, ctx);
  assert.deepStrictEqual([one.clientId, one.method, one.confidence], ["k3f9a2xq", "sender", "high"],
    "single sender match is high confidence and case-insensitive");

  const many = matchMessage({ ...base, fromEmail: "shared@group.com" }, ctx);
  assert.strictEqual(many.confidence, "low", "ambiguous sender is low confidence");
  assert.strictEqual(many.method, "sender", "still reports how it matched");
}

// 4. nothing matches → unmatched, never a guess
{
  const m = matchMessage({ ...base, fromEmail: "stranger@nowhere.com" }, ctx);
  assert.deepStrictEqual([m.clientId, m.method], [null, null], "no signal means unmatched");
}

// a token for a client that no longer exists must not resurrect it
{
  const gone = mintReplyToken("deleted1");
  const m = matchMessage({ ...base, toAddresses: [`droffey+crm-${gone}@vipeventresources.com`] }, ctx);
  assert.strictEqual(m.clientId, null, "token for a missing client does not match");
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && node scripts/check-replies.mjs
```

Expected: FAIL — `Cannot find module '../lib/replies.js'`.

- [ ] **Step 3: Write the implementation**

Create `lib/replies.js`:

```js
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
  const hits = ctx.clientsByEmail.get(String(msg.fromEmail || "").toLowerCase()) || [];
  if (hits.length === 1) return { clientId: hits[0], method: "sender", confidence: "high" };
  if (hits.length > 1) return { clientId: hits[0], method: "sender", confidence: "low" };

  return none;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && npm run check
```

Expected: `check-replies: OK`.

- [ ] **Step 5: Commit (local only)**

```bash
git add lib/replies.js scripts/check-replies.mjs
git commit -m "Add reply matching cascade with tests"
```

---

### Task 6: Gmail client and the ingestion route

**Files:**
- Create: `lib/gmail.js`
- Create: `app/api/gmail/poll/route.js`
- Modify: `package.json` (add `googleapis`)
- Modify: `.env.local` (local only — never committed)

**Interfaces:**
- Consumes: `matchMessage` (Task 5), `saveMessages` / `outboundMessageIdIndex` (Task 4), `readState` and `updateState` from `lib/clients.js`.
- Produces: `POST /api/gmail/poll` returning `{ ok, fetched, matched, unmatched }`. Task 7's UI calls it.

**Env vars required** (add to `.env.local` and Vercel):

```
GMAIL_SA_EMAIL=...iam.gserviceaccount.com
GMAIL_SA_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GMAIL_IMPERSONATE=droffey@vipeventresources.com
REPLY_INBOX_USER=droffey
REPLY_INBOX_DOMAIN=vipeventresources.com
```

- [ ] **Step 1: Install the dependency**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && npm install googleapis
```

- [ ] **Step 2: Write the Gmail client**

Create `lib/gmail.js`:

```js
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
```

- [ ] **Step 3: Write the ingestion route**

Create `app/api/gmail/poll/route.js`:

```js
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { readState, updateState } from "../../../../lib/clients.js";
import { saveMessages, outboundMessageIdIndex } from "../../../../lib/emailstore.js";
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
    console.error("gmail list failed:", e.message);
    return NextResponse.json({ error: `Gmail unavailable: ${e.message}` }, { status: 502 });
  }

  const rows = [];
  const repliedClients = new Set();
  for (const id of msgIds) {
    let m;
    try { m = await getMessage(id); } catch (e) { console.error("gmail get failed:", id, e.message); continue; }
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

  const { saved } = await saveMessages(db, rows);

  // Only cards genuinely awaiting a reply move — never override a human's stage.
  if (saved > 0 && repliedClients.size) {
    await updateState(db, (s) => {
      let changed = false;
      const next = (s.clients || []).map((c) => {
        if (!repliedClients.has(c.id) || c.stage !== "contacted-awaiting") return c;
        changed = true;
        return { ...c, stage: "replied", stageAt: new Date().toISOString() };
      });
      return changed ? { clients: next } : null;
    });
  }

  return NextResponse.json({
    ok: true, fetched: rows.length, saved,
    matched: rows.filter((r) => r.clientId).length,
    unmatched: rows.filter((r) => !r.clientId).length,
  });
}
```

- [ ] **Step 4: Verify it compiles and rejects unauthenticated callers**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && node --check lib/gmail.js && node --check app/api/gmail/poll/route.js && npx next build 2>&1 | grep -iE "Compiled|error" | head -5
```

Expected: `✓ Compiled successfully`. (Stop `next dev` first if it is running.)

- [ ] **Step 5: Report the manual verification gap to Darryl**

State plainly: the Gmail path cannot be verified without live credentials and a real test email. Ask Darryl to (a) complete the GCP/DWD prerequisites, (b) send a test email to `droffey+crm-<token>@vipeventresources.com`, and (c) confirm the poll route returns `matched: 1`.

- [ ] **Step 6: Commit (local only)**

```bash
git add lib/gmail.js app/api/gmail/poll/route.js package.json package-lock.json
git commit -m "Add Gmail client and reply ingestion route"
```

---

### Task 7: Replies API

**Files:**
- Create: `app/api/replies/route.js`

**Interfaces:**
- Consumes: `listReplies`, `markHandled`, `assignToClient` (Task 4).
- Produces: `GET /api/replies?scope=unhandled|unmatched|all&clientId=` → `{ replies: [...] }`; `PATCH /api/replies` with `{ id, action: 'handled'|'assign', clientId? }`. Task 8's UI calls both.

- [ ] **Step 1: Write the route**

Create `app/api/replies/route.js`:

```js
import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db.js";
import { getSessionUser } from "../../../lib/auth.js";
import { listReplies, markHandled, assignToClient } from "../../../lib/emailstore.js";

export async function GET(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const url = new URL(req.url);
  const scope = ["unhandled", "unmatched", "all"].includes(url.searchParams.get("scope"))
    ? url.searchParams.get("scope") : "unhandled";
  const clientId = url.searchParams.get("clientId") || null;
  const db = await getDb();
  return NextResponse.json({ replies: await listReplies(db, { scope, clientId }) });
}

export async function PATCH(req) {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id, action, clientId } = await req.json().catch(() => ({}));
  if (!id || !["handled", "assign"].includes(action)) {
    return NextResponse.json({ error: "id and a valid action are required." }, { status: 400 });
  }
  const db = await getDb();
  const row = action === "handled"
    ? await markHandled(db, String(id), me.email)
    : await assignToClient(db, String(id), String(clientId || ""));
  if (!row) return NextResponse.json({ error: "Message not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && node --check app/api/replies/route.js
```

Expected: no output.

- [ ] **Step 3: Commit (local only)**

```bash
git add app/api/replies/route.js
git commit -m "Add replies list/handle/assign API"
```

---

### Task 8: Replies tab, Today row, and polling trigger

**Files:**
- Modify: `components/crm.jsx`

**Interfaces:**
- Consumes: `GET/PATCH /api/replies` (Task 7), `POST /api/gmail/poll` (Task 6), and the existing `ClientPicker` component already in `components/crm.jsx`.
- Produces: a `RepliesTab` component covering both the handled pile and the "Needs matching" queue, plus a `replies.length + unmatched.length` count used by the tab label and the Today row.

**Patterns to follow:** tabs are declared in the `nav` array `[["digest","Today"],["clients","Clients"],["workflow","Workflow"],["comms","Emails"]]` and rendered by `{tab === "x" && <XTab …/>}`. Styling uses `C.*` tokens and inline styles.

- [ ] **Step 1: Add reply state and the poll loop**

In the main CRM component, near the other `useState` declarations:

```js
  const [replies, setReplies] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  // A broken Gmail integration looks exactly like "no replies today", which is the
  // worst possible failure. Surface it instead of swallowing it.
  const [mailErr, setMailErr] = useState("");
  const loadReplies = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        fetch("/api/replies?scope=unhandled"),
        fetch("/api/replies?scope=unmatched"),
      ]);
      if (a.ok) setReplies((await a.json()).replies || []);
      if (b.ok) setUnmatched((await b.json()).replies || []);
    } catch { /* transient — next poll retries */ }
  }, []);
  // Poll Gmail on load, then every 2 minutes while this tab is open. The call is
  // cheap against Gmail's daily quota, so this is well within budget.
  useEffect(() => {
    if (!loaded) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/gmail/poll", { method: "POST" });
        if (stop) return;
        if (r.ok) setMailErr("");
        else if (r.status === 501) setMailErr(""); // not configured yet — not an error
        else {
          const d = await r.json().catch(() => ({}));
          setMailErr(d.error || "Gmail sync failed — replies may be missing.");
        }
      } catch { if (!stop) setMailErr("Gmail sync unreachable — replies may be missing."); }
      if (!stop) await loadReplies();
    };
    tick();
    const iv = setInterval(tick, 120000);
    return () => { stop = true; clearInterval(iv); };
  }, [loaded, loadReplies]);
```

- [ ] **Step 2: Add the tab**

Change the tab array to include Replies with its unread count:

```js
            {[["digest", "Today"], ["clients", "Clients"], ["workflow", "Workflow"], ["comms", "Emails"],
              ["replies", `Replies${replies.length ? ` · ${replies.length}` : ""}`]].map(([k, t]) => (
              <Tab key={k} active={tab === k} onClick={() => setTab(k)}>{t}</Tab>
            ))}
```

The count includes unmatched, because a message nobody can see is exactly the
thing this feature exists to prevent:

```js
              ["replies", `Replies${replies.length + unmatched.length ? ` · ${replies.length + unmatched.length}` : ""}`]
```

And render it beside the other tab bodies:

```js
            {tab === "replies" && <RepliesTab replies={replies} unmatched={unmatched} clients={clients} onOpen={setDetailId} onRefresh={loadReplies} />}
```

Render the error banner just above the tab bodies, styled like the existing
`saveState === "stale"` banner:

```js
        {mailErr && (
          <div style={{ background: C.redBg, border: `1px solid ${C.red}33`, borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: C.red, fontWeight: 600 }}>
            {mailErr}
          </div>
        )}
```

- [ ] **Step 3: Add the Today row**

In `DigestTab`'s rows, add (it already receives `onGo`):

```js
          <Row n={replyCount} label="Client replies waiting" to="replies" />
```

Pass `replyCount={replies.length}` where `DigestTab` is rendered, and accept it in the component signature.

- [ ] **Step 4: Write the RepliesTab component**

Add near the other tab components in `components/crm.jsx`:

```js
/* ---------------------------- Replies tab ---------------------------- */
// Shared pile: every reply arrives unhandled, anyone can answer it, and
// handling it stamps who did. No hard locking by design — a warning at send
// time is enough for a five-person team.
function RepliesTab({ replies, unmatched, clients, onOpen, onRefresh }) {
  const [openId, setOpenId] = useState(null);
  const byId = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c])), [clients]);
  const patch = async (body) => {
    await fetch("/api/replies", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    onRefresh();
  };
  const handle = (id) => patch({ id, action: "handled" });
  if (!replies.length && !unmatched.length) {
    return <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 40, textAlign: "center", color: C.sub, fontSize: 14 }}>
      No replies waiting. New client replies appear here within a couple of minutes.
    </div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Needs matching — mail we could not confidently attribute. Without this,
          an unmatched reply would be invisible, which is the failure this whole
          feature exists to prevent. */}
      {unmatched.length > 0 && (
        <div style={{ background: C.amberBg, borderRadius: 12, border: `1px solid ${C.amber}55`, padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.amber, marginBottom: 8 }}>
            Needs matching · {unmatched.length}
          </div>
          {unmatched.map((m) => (
            <div key={m.id} style={{ background: C.panel, borderRadius: 8, padding: "9px 11px", marginBottom: 6 }}>
              <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, fontFamily: MONO, fontWeight: 600 }}>{m.fromEmail}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10.5, color: C.faint }}>{fmtDate(m.sentAt)}</span>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 3 }}>{m.subject || "(no subject)"}</div>
              <div style={{ fontSize: 12, color: C.sub, marginTop: 3, lineHeight: 1.5 }}>{m.snippet}</div>
              <div style={{ marginTop: 8 }}>
                <ClientPicker clients={clients} value="" onChange={(cid) => cid && patch({ id: m.id, action: "assign", clientId: cid })} />
              </div>
            </div>
          ))}
        </div>
      )}
      {replies.map((m) => {
        const c = byId[m.clientId];
        const open = openId === m.id;
        return (
          <div key={m.id} style={{ background: C.panel, borderRadius: 12, border: `1px solid ${C.line}`, padding: 14 }}>
            <div className="flex items-center" style={{ gap: 10, flexWrap: "wrap" }}>
              <button onClick={() => c && onOpen(c.id)} style={{ background: "none", border: "none", padding: 0, cursor: c ? "pointer" : "default", fontSize: 14, fontWeight: 700, color: C.ink }}>
                {c ? (c.company || c.name) : "Unmatched sender"}
              </button>
              <span style={{ fontSize: 11.5, color: C.sub, fontFamily: MONO }}>{m.fromEmail}</span>
              {m.matchConf === "low" && <MiniPill fg={C.amber} bg={C.amberBg}>low confidence</MiniPill>}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11.5, color: C.faint }}>{fmtDate(m.sentAt)}</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6 }}>{m.subject || "(no subject)"}</div>
            <div style={{ fontSize: 12.5, color: C.sub, marginTop: 4, whiteSpace: open ? "pre-wrap" : "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.5 }}>
              {open ? m.bodyText : m.snippet}
            </div>
            <div className="flex items-center" style={{ gap: 8, marginTop: 10 }}>
              <GhostBtn onClick={() => setOpenId(open ? null : m.id)}>{open ? "Collapse" : "Read full"}</GhostBtn>
              <MiniBtn solid onClick={() => handle(m.id)}>Mark handled</MiniBtn>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Verify it compiles**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && npx esbuild components/crm.jsx --loader:.jsx=jsx --outfile=/dev/null
```

Expected: a timing line, no errors.

- [ ] **Step 6: Commit (local only)**

```bash
git add components/crm.jsx
git commit -m "Add Replies tab with unread count and Today row"
```

---

### Task 9: Conversation section on the client card

**Files:**
- Modify: `components/crm.jsx` (`DetailDrawer`)

**Interfaces:**
- Consumes: `GET /api/replies?scope=all&clientId=<id>` (Task 7).

- [ ] **Step 1: Write the component**

Add near the other drawer sections in `components/crm.jsx`:

```js
// Conversation with this client — inbound and outbound interleaved, newest first.
// Loaded on demand so the client list load stays untouched.
function Conversation({ client }) {
  const [msgs, setMsgs] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/replies?scope=all&clientId=${encodeURIComponent(client.id)}`)
      .then((r) => (r.ok ? r.json() : { replies: [] }))
      .then((d) => { if (live) setMsgs(d.replies || []); })
      .catch(() => { if (live) setMsgs([]); });
    return () => { live = false; };
  }, [client.id]);
  if (msgs === null) return <Section title="Conversation"><div style={{ fontSize: 12.5, color: C.faint }}>Loading…</div></Section>;
  if (!msgs.length) return <Section title="Conversation"><div style={{ fontSize: 12.5, color: C.faint }}>No email exchanged with this client yet.</div></Section>;
  return (
    <Section title={`Conversation · ${msgs.length}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {msgs.map((m) => (
          <div key={m.id} style={{ background: m.direction === "in" ? C.paper : "#E7EDF8", borderRadius: 8, padding: "9px 11px" }}>
            <div className="flex items-center" style={{ gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: m.direction === "in" ? C.ink : C.action }}>
                {m.direction === "in" ? m.fromEmail : "We sent"}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10.5, color: C.faint }}>{fmtDate(m.sentAt)}</span>
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 3 }}>{m.subject || "(no subject)"}</div>
            <div style={{ fontSize: 12, color: C.sub, marginTop: 3, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{m.bodyText || m.snippet}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}
```

- [ ] **Step 2: Render it in the drawer**

Inside `DetailDrawer`'s Info tab body, alongside the other `<Section>` blocks (place it directly above `{client.chargeoverId && <PastCharges … />}`):

```js
        <Conversation client={client} />
```

- [ ] **Step 3: Verify it compiles**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && npx esbuild components/crm.jsx --loader:.jsx=jsx --outfile=/dev/null && npx next build 2>&1 | grep -iE "Compiled|error" | head -5
```

Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Run the full check suite**

```bash
cd '/Users/darrylroffey/Desktop/Claude/Projects/ViperPro - CRM' && set -a && . ./.env.local && set +a && npm run check
```

Expected: all three check scripts pass.

- [ ] **Step 5: Commit (local only)**

```bash
git add components/crm.jsx
git commit -m "Add Conversation section to the client card"
```

- [ ] **Step 6: Hand back to Darryl**

Report: what shipped, that **the UI was not click-verified** (no test login), the deploy ordering requirement from Task 3 (stage first, hard-refresh all tabs), and the Gmail prerequisites still outstanding.

---

## Deploy sequence (do not reorder)

1. Deploy Task 3 (the `replied` stage) and have **every open CRM tab hard-refreshed**. A stale tab would otherwise reset replied cards to "Not contacted".
2. Darryl completes the Gmail prerequisites (filter/label, GCP project, service account, DWD grant with the **numeric** client ID, env vars in Vercel).
3. Deploy the rest.
4. Send one test email to `droffey+crm-<token>@vipeventresources.com` and confirm the poll route reports `matched: 1`.

## Deviations from the spec (deliberate)

Recorded so the spec and plan do not silently disagree.

1. **No `history.list` / `gmail_history_id` cursor.** The spec describes a history
   cursor stored in `kv`. This plan uses `messages.list q="label:crm-replies
   newer_than:7d"` instead. Rationale: `historyId` invalidation (HTTP 404 after
   Gmail expires the history window) needs a full-sweep recovery path anyway, so
   the cursor adds a failure mode without adding capability at this volume. The
   Gmail message id is the primary key, so re-reading the same week is a no-op.
   Revisit if mail volume grows enough that a 7-day window costs real time.
2. **No separate daily cron reconciliation sweep.** The spec folds one into
   `/api/cron/daily`. The 7-day poll window makes it redundant — a week's absence
   is still caught on the next CRM load — and it avoids touching the cron file.
   Add it if the mailbox ever goes unread for more than a week.

## Out of scope for this plan

- **Phase 2 — replying from the CRM** (threaded send via the Gmail API). Gets its own plan.
- **Phase 3 — Pub/Sub push** instead of polling.
- Attachments, retention/pruning, and the `PRODUCT.md` gradient documentation debt.
