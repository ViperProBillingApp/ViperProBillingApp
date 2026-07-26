# Gmail Reply Inbox — Design

Date: 2026-07-26
Status: approved for planning
Author: Darryl Roffey + Claude

## Problem

The collections loop never closes automatically. Chase emails go out through Brevo,
but client replies land in a mailbox the CRM cannot see. Staff mark replies by hand,
and the 10-day "no reply" bounce-back on the `contacted-awaiting` stage is a guess
standing in for information the app does not have.

Consequences today:

- No reliable signal that a client answered, so cards sit in "Contacted · awaiting
  reply" until a timer moves them.
- Reply content lives only in email, so the client card has no record of what was
  agreed.
- Two staff can chase a client who already replied.

Success: a client reply is visible in the CRM within minutes, attached to the right
client, answerable from the CRM, and it moves the card out of "awaiting reply"
without anyone marking anything.

## Scope

In scope:

- Ingesting inbound email that belongs to a client on file.
- Matching it to that client, storing it, and showing it.
- Replying from the CRM, threaded correctly.
- A short "Needs matching" queue for anything not confidently attributed.

Out of scope (deliberate):

- Replacing Gmail. Only client-related threads surface in the CRM; everything else
  stays in Gmail and is never fetched or stored.
- Changing how chase emails are sent. Templated chases stay on Brevo.
- Attachments (phase 1 stores text bodies only; see Open Questions).

## Key decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Watched mailbox | `droffey@vipeventresources.com` | `accounting@` is a Google **Group** — Groups have no Gmail API surface. Using an existing licensed user mailbox avoids a new licence. |
| Query narrowing | Only `label:crm-replies` | `gmail.modify` can read the whole mailbox; narrowing by query is the privacy control. |
| Auth | Service account + domain-wide delegation | Survives mailbox password changes, unlike an OAuth refresh token (Google invalidates refresh tokens carrying Gmail scopes on password change). |
| Scope | `https://www.googleapis.com/auth/gmail.modify` | Single scope covering read, send and labels. Deliberately **not** `https://mail.google.com/`, which adds permanent delete. |
| Delivery | Polling | Push needs a GCP Pub/Sub topic and a verified endpoint. `history.list` costs 2 quota units; polling all day is ~480 units against an 80,000,000/day threshold. Push remains a later bolt-on that changes the trigger only. |
| Storage | New `email_messages` table | The client blob is loaded whole into every browser and is the subject of three past data-loss incidents. Email must not enter that path. |
| Reply sender | `droffey@vipeventresources.com`, personally | No alias setup; a named human chasing payment tends to get a faster response. |
| Chase sender | Unchanged — Brevo, `accounting@` | Keeps the bounce webhook and tracking that already work. |

### Accepted trade-offs

1. **The integration can technically read the whole of Darryl's mailbox.** Gmail has
   no label-scoped permission, so this is enforced by query discipline, not
   configuration. The CRM must only ever query `label:crm-replies`. Widening that
   query is a privacy regression and must be treated as one.
2. **Domain-wide delegation is domain-wide.** The service account could impersonate
   any mailbox in the domain. Mitigated by hard-coding the impersonation subject
   server-side (never from request input) and isolating the GCP project.
3. **Collections replies depend on one person's mailbox.** Acceptable because the
   CRM becomes the shared view. Migration to a dedicated `crm@` service mailbox is
   a config change (watched address + reply-token domain), not a rewrite.

## Architecture

### Data model

New table, created in `SCHEMA_SQL` in `lib/db.js` with RLS enabled and grants
revoked, matching every other table:

```sql
CREATE TABLE IF NOT EXISTS email_messages (
  id             text PRIMARY KEY,        -- Gmail message id → idempotent upserts
  thread_id      text NOT NULL,
  client_id      text,                    -- NULL = unmatched
  direction      text NOT NULL,           -- 'in' | 'out'
  from_email     text NOT NULL,
  to_email       text NOT NULL,
  subject        text,
  snippet        text,
  body_text      text,
  message_id_hdr text,                    -- RFC 2822 Message-ID
  references_hdr text,
  sent_at        timestamptz NOT NULL,
  match_method   text,                    -- 'token' | 'headers' | 'sender' | 'manual'
  match_conf     text,                    -- 'high' | 'low'
  handled_by     text,
  handled_at     timestamptz,
  created_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_messages_client_idx ON email_messages (client_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS email_messages_thread_idx ON email_messages (thread_id);
CREATE INDEX IF NOT EXISTS email_messages_unhandled_idx ON email_messages (handled_at, sent_at DESC);
```

Gmail's message id as primary key makes duplicate delivery a no-op.

Sync cursor: `gmail_history_id` stored in the existing `kv` table.

### Modules

| File | Responsibility |
| --- | --- |
| `lib/gmail.js` | DWD auth; `listNewMessages(historyId)`, `getMessage(id)`, `sendThreadedReply(...)` |
| `lib/replies.js` | Matching cascade. **Pure functions** — no network, no DB — so it is unit-testable |
| `app/api/gmail/poll/route.js` | POST. Pull → match → store. Session-guarded |
| `app/api/replies/route.js` | GET list (unhandled / all / by client); PATCH mark handled; PATCH assign unmatched to a client |
| `app/api/replies/send/route.js` | POST threaded reply |

### Change to existing code

`brevoSend` in `lib/email.js` currently returns bare `r.ok` and discards the
response body, which contains Brevo's `messageId`. It must return
`{ ok, messageId }`. The send path stores that id on the `reminders` entry and
writes a `direction: 'out'` row. Without this, header matching has nothing to
match against.

The same send path sets the reply token as `replyTo` (format defined under
[Reply matching](#reply-matching)).

### Sync triggers

1. On CRM load — one `history.list` call.
2. Every ~2 minutes while a tab is open.
3. Daily reconciliation sweep (`messages.list q=newer_than:2d label:crm-replies`)
   folded into the **existing** `/api/cron/daily`. Vercel Hobby allows 2 cron jobs
   and both are already used, so no new cron may be added.

`historyId` is advanced **only after rows are committed**, so a mid-run failure
re-reads rather than skips.

## Reply matching

A cascade, evaluated in order. Each message stores the method and confidence that
matched it so mis-filing is diagnosable.

1. **Reply token (primary).** Chases carry
   `replyTo: droffey+crm-<clientId><hmac8>@vipeventresources.com`. The token appears
   in the inbound `To:` / `Delivered-To:` header. The HMAC (8 chars, derived from
   the existing `ENCRYPTION_KEY` with a fixed label, so no new secret) rejects
   forged or mistyped tokens. This is the only signal that survives a client
   replying from a different address or a mail client stripping headers.
   Requires `ENCRYPTION_KEY` to be set (it is, in both environments). If it were
   ever absent, token generation must fail closed — send without a token and let
   matching degrade to steps 2 and 3, never emit an unsigned token.
2. **Header match (corroboration).** Compare every id in the inbound `References`
   header — not just `In-Reply-To` — against stored Brevo `messageId`s. Note:
   **forwarded mail also carries these headers**, so a forward can mis-attribute.
   The token therefore wins whenever both are present.
3. **Sender match (fallback).** `From:` against client email and
   `secondaryContacts` emails. Exactly one match → high confidence; several → low.
   This also catches a client emailing about an invoice unprompted, not just replies.
4. **No confident match** → "Needs matching" queue.

Brevo cannot inject custom headers (its `headers` field ignores standard headers,
and is ignored entirely on templated sends), which is why the token — not a
correlation header — is primary.

Guards:

- Only ingest messages carrying `label:crm-replies`. Never spam, never the rest of
  the mailbox.
- Never ingest our own outbound as though it were an inbound reply.

## User interface

**Replies becomes a top-level tab** alongside Today / Clients / Workflow / Emails,
with an unread count in the label. It is the new daily driver and should not be
buried inside Emails.

It also appears in two other places:

- **Today** — a "N replies waiting" row.
- **Client card** — a Conversation section showing that client's thread, inbound and
  outbound interleaved.

**Shared pile.** Every matched reply arrives unhandled. Anyone may open, read and
answer it. Sending a reply, or explicitly marking it done, flips it to handled and
stamps who did it. No hard locking (per decision); instead, if another staff member
replied to that client within the last few minutes, the composer shows a plain
warning before sending.

**New workflow stage**, ordered between `contacted-awaiting` and `up-to-date`:

```
"replied": { label: "Replied · needs action", order: 2.5 }
```

When a reply is matched, the card moves there automatically. The 10-day bounce-back
only ever acted on `contacted-awaiting`, so it stops firing at replied cards without
further change — the timer becomes a genuine fallback for genuine silence.

Adding a stage requires the self-healing `normalise()` default treatment described
in CLAUDE.md, deployed before any data is written.

**Replying** stays review-first: a human writes it, reads it, and clicks send. It
goes out via the Gmail API using the inbound `threadId` with correct
`In-Reply-To` / `References`, so it threads for both sides and lands in the
mailbox's Sent folder. The signature is appended as today.

Gmail requires all three of: `threadId` on the message, RFC 2822-compliant
`References`/`In-Reply-To`, and a matching `Subject`. The `Re:` prefix threads
correctly in practice but must be verified against the real mailbox during rollout.

## Error handling

Failures must be loud. A broken integration that resembles "no replies today" is
worse than no integration.

| Failure | Behaviour |
| --- | --- |
| Auth failure (grant revoked, mailbox suspended) | Visible banner in the CRM; never swallowed |
| `historyId` expired (HTTP 404) | Expected, not exceptional — automatic full sweep over recent mail, then re-store the id |
| Duplicate Pub/Sub or poll delivery | Harmless; Gmail message id is the primary key |
| Partial ingestion failure | `historyId` advances only after commit, so re-read rather than skip |
| Send failure | Thread stays unhandled; draft preserved; error shown |
| Missing Brevo `messageId` | Degrade to token/sender matching rather than dropping the message |
| Gmail 429 / `rateLimitExceeded` | Exponential backoff |

## Security

- Single scope `gmail.modify`. Not `mail.google.com`.
- Impersonation subject **hard-coded server-side**, never read from request input.
- Isolated GCP project; service account key in a Vercel env var alongside existing
  secrets; never exposed to the browser bundle.
- All new routes session-guarded, returning 401 unauthenticated.
- `email_messages` gets RLS + revoked grants like every other table.
- Message bodies inherit the mailbox's sensitivity — store only what is needed.
- Reply-token HMAC prevents forged tokens resolving to a client.

## Testing

- **`lib/replies.js` matching cascade** — assert-based unit tests covering token
  verification, forged token rejection, `References` parsing, ambiguous sender,
  and the forwarded-email mis-attribution case. This is the highest-value test
  surface and the reason matching is pure functions.
- **Data layer** — scratchpad Node script against the DB (insert → assert → clean
  up), per the repo's existing workflow.
- **Gmail integration** — cannot be meaningfully unit tested; verify with a real
  send/receive to a throwaway address during rollout.
- **UI** — there is no test login, so Claude cannot click-verify. Darryl must test
  the Replies tab before it is trusted.

## Delivery phases

Both phases ship. This is ordering, not scope reduction.

**Phase 1 — plumbing and read.** `messageId` capture and reply tokens in the Brevo
send path; `lib/gmail.js` auth; `email_messages` table; polling route; matching
cascade; Replies tab (read, mark handled, needs-matching queue); Conversation
section on the client card; new `replied` stage with auto-move. *The loop closes
here, before any send code exists.*

**Phase 2 — two-way.** Threaded reply composer sending via the Gmail API.

**Phase 3 — optional.** Pub/Sub push for instant delivery in place of polling.

## Prerequisites (Darryl)

1. Create a Gmail filter: mail to `droffey+crm-*` gets the label `crm-replies`.
2. Create a dedicated GCP project; enable the Gmail API; create a service account.
3. Admin console → Security → Access and data control → API controls →
   Domain-wide delegation → add the service account's **numeric client ID** (not its
   email) with scope `https://www.googleapis.com/auth/gmail.modify`. Propagation can
   take up to 24 hours. A second super-admin approval may be required.
4. Supply the service account key and watched address as env vars.

## Open questions

- **Attachments.** Phase 1 stores text bodies only. If clients routinely attach
  remittance advices, attachment handling needs its own decision (store in Supabase,
  or link out to Gmail). Defer until observed.
- **Retention.** No pruning in phase 1. Revisit if the table grows large.
- **`Re:` subject prefix.** Verify Gmail threads correctly with the prefix during
  rollout; fall back to `threadId` + headers alone if not.

## Documentation debt noted during this design

`PRODUCT.md` anti-references still say "no gradients, never flashy", but the app now
uses the blue board gradient across the header, Today, Clients, Workflow and Emails.
The docs should be updated to match the shipped design. Not part of this build.
