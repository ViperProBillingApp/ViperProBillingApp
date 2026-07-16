# ViperPro CRM — Critical Audit

Independent, evidence-based review. Written 2026-07-16 against the source at
`~/Desktop/Claude/viper-crm` (commit `7edd048`). Findings are grounded in code,
not blackbox probing — the live app holds real client PII and plaintext
third-party passwords, so authenticated testing against production was out of
scope by the audit's own rules.

## 0. Scope correction (read this first)

The audit brief is written for a **multi-tenant SaaS product that sells
subscriptions to external customers**. This application is not that, and isn't
trying to be. It is an **internal, single-tenant staff tool** for ~5–10 people
at VIP Event Resources who chase arrears on *their own* clients. There are no
external customer logins, no self-service portal, no subscription-selling, no
payment processing. **ChargeOver is the billing system; this app reads from it.**

Roughly half the brief therefore describes features this app deliberately does
not have. Rather than pad the report with "N/A — no subscription module ×40",
here is the honest split:

**Not applicable by design** (ChargeOver or nothing owns these): subscription
lifecycle (proration, coupons, seat billing, dunning, cancellation flows),
invoice/credit-note generation, payment processing & PCI scope, quotes/estimates,
tax engines, self-service customer portal, sales pipeline/opportunities/forecast,
multi-tenant isolation, GraphQL. Auditing these as "missing" would be noise.

**Applicable and assessed below**: authentication, authorisation, the data
model, secrets handling, the ChargeOver read integration, billing-math accuracy,
audit trail, backups, the reporting module, and data governance for the
sensitive data it *does* hold.

The correct yardstick is "a credible internal financial-ops tool", not
"enterprise SaaS". Scored against the wrong yardstick, everything looks like an
F; scored against what it is, it's a well-built tool with a few serious gaps.

## 1. Executive assessment

**Maturity.** Higher than most internal tools. The auth mechanics are genuinely
good (scrypt + per-user salt + timing-safe compare + hashed single-use reset
tokens), authorisation is enforced server-side and consistently, SQL is
parameterised throughout, and the money math now has a single source of truth
with a test. This is not a prototype.

**The dominant risk is one theme, not fourteen bugs.** This app is a
**plaintext credential vault behind single-factor auth with no immutable audit
log and no automated backup.** It holds ~713 Maritz portal user rows, Viper
admin credentials, per-company portal passwords, *and* every staff member's own
login — all in plaintext, all readable by any authenticated staff session. The
handover confirms the same secrets and API keys were pasted into a chat
transcript. Everything else in this report is secondary to that sentence.

**Strongest aspects:** password/session cryptography; consistent server-side
authz; parameterised SQL; the rev-guard that stops stale-tab overwrites; the
newly-extracted, tested KPI math.

Five greatest business risks:

1. Plaintext credential concentration — one leaked DB dump or hijacked staff
   session exposes hundreds of live third-party passwords (F-01).
2. No immutable audit trail — "who deleted 50 clients / changed this charge" is
   unanswerable; the only record is a mutable, client-supplied array (F-03).
3. No automated backup — data loss has already happened twice this project;
   only manual snapshots saved it (F-04).
4. Single-factor auth is the entire perimeter for that credential vault (F-02).
5. Whole-state blob shipped to every browser — the complete plaintext store
   lives in each staff tab; any XSS = total compromise, and there is no CSP
   (F-06, F-08).

**Five highest-priority improvements:** encrypt secrets at the field level
(F-01) · add MFA (F-02) · add a real append-only audit log (F-03) · turn on
automated PITR backups and test a restore (F-04) · add security headers + a CSP
(F-06).

**Maturity scores (0–10), against "credible internal financial-ops tool":**

| Dimension | Score | One-line reason |
| --- | --- | --- |
| Product design | 7 | Focused, coherent, does its actual job well |
| User experience | 7 | Dense but purpose-built for its expert users |
| Security | 4 | Excellent crypto, undermined by plaintext vault + no MFA/headers |
| Reliability | 5 | Rev-guard good; no backups, no monitoring, single blob |
| Billing functionality | 6 | Not a billing system; solid as a billing-health tracker |
| CRM functionality | 6 | Strong arrears-chase workflow; thin general CRM (by design) |
| Data governance | 3 | Plaintext PII+creds, no audit log, no retention/deletion policy |
| Accessibility | 3 | Inline-styled, no semantic/keyboard/AT work; untested |
| Scalability | 4 | Whole-blob-in-browser ceiling; fine for its size, not beyond |
| Commercial readiness | 2 | Internal tool; the yardstick mostly doesn't apply |

**Overall recommendation.** As what it is — an internal staff tool already in
daily use — it is **suitable for continued internal production use, with the
Immediate items below treated as release blockers for any further sensitive
data.** As a customer-facing enterprise SaaS product it is **not suitable for
production**, but that is the wrong goal for this codebase.

## 2. Findings register

Evidence cites `file:line`. Severity reflects impact *in this app's real
context*, not the SaaS template's.

### F-01 · Plaintext credential store · **Critical**

- **Where:** `lib/db.js` (`visible_password` column), `app/api/users/route.js:44`
  (stored in plaintext), `components/crm.jsx` `normalise()` (`portalPassword`,
  `adminPassword`, `maritzPortalPassword`, `maritzAdminPassword`,
  `maritzUserLists[]`). The whole state blob is a single `kv` row.
- **Issue:** Staff logins and hundreds of third-party portal passwords are
  stored with no field-level encryption. `GET /api/users` returns
  `visible_password` to any admin; `GET /api/state` returns the entire
  credential set to any authenticated staff. A DB dump, a stolen Supabase
  connection string, or one hijacked session exposes everything in cleartext.
  The comment "not stored in plain text" at `app/api/users/route.js:47` is
  factually wrong (F-13).
- **Impact:** Mass third-party credential compromise; the blast radius is every
  DMC portal the company has access to, not just this app.
- **Fix:** Encrypt secret fields at rest with a KMS/app key separate from the DB
  (`visible_password` and all `*Password`/`maritzUserLists` fields). Stop
  returning `visible_password` in list responses; reveal one credential at a
  time, per-action, logged. Rotate every secret named in the handover.
- **Complexity:** Medium. **Acceptance:** DB dump contains no readable secret;
  revealing a credential writes an audit row.

### F-02 · No multi-factor authentication · **High**

- **Where:** `app/api/auth/login/route.js`.
- **Issue:** A single password is the entire perimeter for the F-01 vault. No
  TOTP, no WebAuthn, no re-auth for sensitive actions.
- **Fix:** Add TOTP (or WebAuthn) as a second factor, at least for admins and
  for viewing stored credentials.
- **Complexity:** Medium. **Acceptance:** admin login requires a second factor.

### F-03 · No immutable audit trail · **High**

- **Where:** activity is a per-client `activity`/`noteCards` array *inside* the
  state blob (`components/crm.jsx` `logActivity`), capped at 200, mutable, and
  overwritten wholesale on every save. No actor, no IP, no before/after.
- **Issue:** For a tool touching financial/billing status there is no
  tamper-resistant record of who changed or deleted what. After the two
  historical mass-overwrites, the only forensic evidence was manual `kv`
  backups. Server writes (`/api/state`, webhook, cron) record no actor.
- **Fix:** Append-only `audit_log` table (actor, action, entity, before, after,
  ts, ip, request-id), written server-side on every mutating route. Never
  stored in the mutable blob.
- **Complexity:** Medium. **Acceptance:** deleting a client leaves an audit row
  naming the actor that the app cannot edit.

### F-04 · No automated backup / undefined RPO-RTO · **High**

- **Where:** operational; backups this project were manual extra `kv` keys
  (`state_backup_*`, per HANDOVER).
- **Issue:** The whole-blob model means one bad save replaces all client data;
  it has destroyed data twice. Recovery depends on someone having manually
  snapshotted. Supabase PITR status is unknown/untested.
- **Fix:** Enable Supabase PITR (or scheduled `pg_dump` to object storage),
  document RPO/RTO, and **test a restore**. Add a nightly automated `kv` state
  snapshot as belt-and-braces.
- **Complexity:** Low. **Acceptance:** a documented, tested restore procedure
  exists; snapshots run without human action.

### F-05 · No login rate-limiting or lockout · **Medium**

- **Where:** `app/api/auth/login/route.js:5` (`ponytail: no rate limiting`).
- **Issue:** Unlimited password attempts enable brute-force / credential
  stuffing against the single-factor perimeter. scrypt slows offline cracking,
  not online guessing.
- **Fix:** Per-IP + per-account throttle and temporary lockout on the login and
  reset-request routes (edge middleware or a small counter table).
- **Complexity:** Low. **Acceptance:** N failed attempts returns 429 and blocks
  briefly.

### F-06 · No security headers / CSP · **Medium**

- **Where:** `next.config.mjs` is empty; no `middleware.js`.
- **Issue:** No Content-Security-Policy, HSTS, X-Frame-Options, or
  Referrer-Policy. Clickjacking is possible, and there is no defence-in-depth
  against XSS on a page that holds the entire plaintext credential store in
  memory.
- **Fix:** Add headers via `next.config` / middleware: a strict CSP,
  `frame-ancestors 'none'`, HSTS, `Referrer-Policy: no-referrer`.
- **Complexity:** Low. **Acceptance:** securityheaders.com shows CSP + HSTS +
  frame protection.

### F-07 · Long sessions, no idle timeout or step-up · **Medium**

- **Where:** `lib/auth-core.js` (`SESSION_MS = 30 days`).
- **Issue:** 30-day sessions with no inactivity expiry and no re-auth for
  sensitive actions (user management, credential viewing) are generous for a
  tool holding this data. A stolen laptop stays authenticated for a month.
- **Fix:** Shorten to a rolling shorter window with idle timeout; require
  re-auth (or MFA) before revealing credentials or managing users.
- **Complexity:** Low.

### F-08 · Whole-state-blob architecture · **Medium**

- **Where:** `app/api/state/route.js`; the entire client DB is one JSON row
  loaded into, and saved back from, every browser.
- **Issue:** (a) Every staff tab holds the complete plaintext credential store —
  maximal XSS blast radius. (b) Concurrency is last-write-wins; the rev-guard
  prevents *stale* overwrites but two fresh tabs still race. (c) It won't scale
  past a few thousand clients / a handful of editors. The `ponytail:` comment at
  `app/api/state/route.js:8` already flags the upgrade path (per-client rows).
- **Fix:** Medium-term, move to per-client rows so a save touches one record and
  secrets never ship wholesale to the browser. Short-term, F-01's encryption
  limits the blast radius.
- **Complexity:** High (deferred). **Acceptance:** a client edit PUTs one row.

### F-09 · CSV export formula injection · **Low-Medium**

- **Where:** `components/crm.jsx:309` (`exportCsv`) and `:1016`, both
  `Papa.unparse`. Client company names are imported from arbitrary CSVs.
- **Issue:** A client named `=cmd|...` or `+HYPERLINK(...)` becomes a live
  formula when the export is opened in Excel/Sheets.
- **Fix:** Prefix any cell beginning with `= + - @ tab CR` with a `'` (or wrap in
  quotes) before `unparse`.
- **Complexity:** Low. **Acceptance:** an exported name starting `=` opens as
  text.

### F-10 · `/api/recover` has no rate limit; prompt-injection surface · **Low-Medium**

- **Where:** `app/api/recover/route.js`.
- **Issue:** Each call spends Opus tokens + up to 5 web searches. Any authed
  staff (or a stolen session) can run up cost with no throttle. Client-controlled
  `company`/`name`/`email` are interpolated into the prompt; output is bounded to
  a JSON candidate list and human-reviewed before apply, so injection impact is
  low, but cost/abuse is real.
- **Fix:** Per-user rate limit + a daily cap; keep the human-review gate.
- **Complexity:** Low.

### F-11 · Webhook secret via query param; no dedup · **Low**

- **Where:** `app/api/webhooks/brevo/route.js` (`?secret=` accepted).
- **Issue:** A secret in the query string can leak via logs/referrers. No replay
  dedup (mostly idempotent, so impact is low).
- **Fix:** Accept the secret only via header; consider HMAC signature
  verification if Brevo supports it.
- **Complexity:** Low.

### F-12 · TLS cert not verified to the database · **Low**

- **Where:** `lib/db.js` (`ssl: { rejectUnauthorized: false }`).
- **Issue:** Accepts any certificate — theoretically MITM-able. Standard for
  Supabase quick-connect, but worth pinning the CA.
- **Complexity:** Low.

### F-13 · Misleading "not stored in plain text" comment · **Low**

- **Where:** `app/api/users/route.js:47`. It *is* stored in plaintext
  (`visible_password`). Fix the comment; it hides F-01 from the next reader.

### F-14 · Expired sessions/reset tokens never garbage-collected · **Observation**

- **Where:** `lib/auth-core.js` — no cleanup of expired `sessions` /
  `password_resets` rows. Harmless but unbounded growth; a nightly `DELETE
  WHERE expires_at < now` is tidy.

### F-15 · No `robots.txt`; production URL indexable · **Observation**

- Login-gated, so low risk, but add a `robots.txt` disallow.

## 3. What was NOT tested (stated honestly)

- **Authenticated production behaviour** — not exercised; the live DB holds real
  PII and plaintext credentials, and the brief forbids accessing real customer
  data. All authenticated findings are from code, not runtime.
- **Accessibility with assistive tech** — not run through a screen reader or
  axe; the score reflects code inspection (inline styles, no semantic landmarks,
  status colours are at least paired with text labels, no visible focus work).
- **Load / concurrency under real multi-user editing** — reasoned from the
  architecture, not measured.
- **Email deliverability (SPF/DKIM/DMARC)** — DNS not inspected.
- **Supabase backup/PITR configuration** — not visible from the repo.

## 4. Remediation roadmap

### Immediate (before storing any more sensitive data)

1. F-01 encrypt secret fields + stop bulk-returning `visible_password`.
2. F-04 enable + test automated backups.
3. F-03 append-only audit log on mutating routes.
4. Rotate the credentials/API keys named in HANDOVER §"Security debt".

### Phase 1 (30 days)

- F-02 MFA for admins · F-05 login throttling · F-06 security headers + CSP ·
  F-13 fix the comment · F-09 CSV sanitisation.

### Phase 2 (31–90 days)

- F-07 session hardening + step-up auth · F-10 recover throttle · F-11 webhook
  header-only secret · F-14 token GC · basic error/uptime monitoring (there is
  none today).

### Phase 3 (3–6 months)

- F-08 move the state blob to per-client rows (removes the browser-side
  credential exposure and the concurrency ceiling in one change) · data
  retention/deletion policy for former clients · accessibility pass to WCAG 2.2
  AA on the core screens.

### Longer term

- If this ever grows beyond a handful of staff, the per-row migration (F-08)
  plus real RBAC granularity (finance vs account-manager scopes) is the natural
  next platform step. Not needed at current scale.

## 5. Quick wins (low effort, real value)

Fix the F-13 comment · add `robots.txt` (F-15) · CSV formula-escape (F-09) ·
security headers (F-06) · expired-token GC (F-14) · move the webhook secret to a
header (F-11). All are hours, not days.

## 6. Release blockers (if handling new sensitive data)

F-01 (plaintext secrets) and F-04 (no tested backup). Everything else is
important but not a hard gate for a tool already in careful internal use.
