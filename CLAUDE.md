# CLAUDE.md — ViperPro CRM

Instructions for Claude sessions working on this repo. Companion docs: `HANDOVER.md`
(deep architecture + history), `AUDIT.md` (security findings register), `PRODUCT.md`,
`DESIGN.md`.

## What this is

Internal staff tool for VIP Event Resources: client billing/arrears tracking,
reminder-email campaigns, workflow boards, and portal credentials for DMCs on the
Viper and Maritz platforms. ~5 staff users. Not public, not multi-tenant.

| | |
| --- | --- |
| Live | <https://viper-pro-billing-app.vercel.app> — auto-deploys on push to `main` |
| Repo | `ViperProBillingApp/ViperProBillingApp` (gh CLI is signed in as this bot) |
| Local | `~/Desktop/Claude/Projects/ViperPro - CRM` (moved 2026-07-17; quote the space) |
| Stack | Next.js 15 (JS, app router), React 19, Vercel serverless, Supabase Postgres |
| Main file | `components/crm.jsx` (~3700 lines, inline styles) — almost everything UI |

## Hard rules

1. **Only edit this repo in its own dedicated chat.** Parallel sessions once collided.
2. **Commit/deploy only when Darryl says so** (he says "commit + deploy"). Never push
   unprompted.
3. **Dev and prod share ONE live database.** There is no staging. Local `npm run dev`
   writes real data and can send real email to real clients. Test with throwaway
   records and clean up.
4. **Never put credentials in committed code** — no seed arrays with passwords, no
   secrets in comments. Seed/patch data via a scratchpad script run locally (pattern:
   read `.env.local` manually, import `lib/db.js`). The permission classifier will
   block credential-bearing commits, and it's right to.
5. **Never run `npm run build` while `next dev` is running** — corrupts `.next`
   (fix: kill dev, `rm -rf .next`, restart).
6. **ENCRYPTION_KEY**: the value in Vercel is authoritative and mirrored in
   `.env.local`. Never rotate or re-migrate without a plan; a lost key makes every
   encrypted secret unrecoverable. All portal/user passwords are AES-256-GCM
   encrypted at rest (`lib/crypto.js`, `enc:v1:` prefix).

## The two data-loss traps (both bit us — read before touching client data)

- **Stale-tab whole-blob overwrite** (largely fixed but stay paranoid): client saves
  now go through `PUT /api/clients/batch` as per-client diffs merged server-side
  against current state with an atomic `rev` guard. But **any new persisted client
  field must be added to `normalise()` in crm.jsx and deployed BEFORE data is
  written**, and its default should be self-healing (re-derivable), else an old
  bundle in an open tab strips it. After every deploy tell Darryl to hard-refresh
  all CRM tabs.
- **Server-side writes must bump `rev` and mirror rows**: any script or route that
  mutates state directly must follow the pattern in `app/api/sync/chargeover/route.js`
  — write the kv blob with `rev + 1`, then `mirrorClients()`. Reads come from
  per-client rows (`readState()` in `lib/clients.js`), blob is the fallback/backup.

## Architecture map

- `lib/db.js` — pg Pool + `SCHEMA_SQL` (auto-migrates on cold start; RLS enabled +
  grants revoked on every table because Supabase's anon REST API would otherwise
  expose them). Tables: `kv` (state blob + settings), `clients` (per-client jsonb
  rows + `ord`), `users`, `sessions`, `password_resets`, `audit_log` (append-only),
  `rate_hits`, `state_backups`, `tasks`, `viper_customers`.
- `lib/clients.js` — readState / mirrorClients / secret strip-merge-encrypt pipeline.
  Secrets never go to the browser in list loads (`stripSecrets`); reveal-on-demand
  via `GET /api/clients/[id]/secrets` (audited); a save with blank secrets preserves
  stored ones (`mergeClientSecrets`) so stripped clients can't wipe them.
- `lib/crypto.js` — field encryption, dormant without ENCRYPTION_KEY, idempotent.
- `lib/security.js` — audit log, DB rate limiting, session GC, nightly snapshot.
- `lib/chargeover.js` / `lib/email.js` (Brevo) — external integrations.
- `lib/totp.js` — optional per-user MFA (RFC 6238).
- `app/api/cron/daily` — nightly: KPI snapshot, state backup, staff digest email
  (Vercel cron, `CRON_SECRET` bearer auth).
- `components/crm.jsx` — tabs: Today, Clients, Workflow (Client stages + Tasks
  boards on a Trello-blue gradient), Emails (compose queue + Campaigns + sent
  archive). Left menu: Add client, Contact recovery, Email templates, Pricing,
  Maritz Onboarding, Viper Customers, Reports (floating window), Settings,
  Sync ChargeOver, Users.

## Feature notes that aren't obvious from the code

- **Campaigns** (`settings.campaigns`): frozen memberIds + sequential rounds; progress
  is DERIVED from each client's send log (`c.reminders`, key `type:YYYY-MM`) via
  `sentInRound()`. Two rounds using the same template in the same month collide
  (one reminders key) — each round needs its own template.
- **Viper Customers** (left menu): inline-editable grid over the `viper_customers`
  table; edits propagate to the matching client card's Portal tab (match by portal
  URL host, then normalized company name) through the normal card-save pipeline.
- **Tasks board**: lanes todo/doing/waiting/done (whitelisted in both
  `app/api/tasks*` routes), checklist stored as JSON text, assign-on-card dropdown.
- **Modal backdrops close on mousedown-on-backdrop, not click** — a click fires when
  a text-selection drag ends past the panel edge and was closing windows mid-edit.
  Keep this pattern for any new overlay.
- `arrearsPeriods()` (balance ÷ rate) is the real arrears figure; raw
  `periodsBehind()` is only the fallback for un-synced clients.

## Environment (.env.local mirrors Vercel)

`DATABASE_URL` (Supabase — session pooler locally, transaction pooler :6543 in
Vercel; direct host is IPv6-only and unreachable), `ENCRYPTION_KEY`, `CRON_SECRET`,
`BREVO_API_KEY` (`xkeysib-…`, NOT the smtp key), `BREVO_WEBHOOK_SECRET`,
`CHARGEOVER_PUBLIC_KEY`/`CHARGEOVER_PRIVATE_KEY`, `CHARGEOVER_SUBDOMAIN`,
`ANTHROPIC_API_KEY` (contact recovery), `APP_URL`. Optional: `DATABASE_CA`
(turns on TLS cert verification — F-12).

## Verify + deploy workflow

1. `npx next build` must pass (grep for `✓ Compiled`).
2. Data-layer changes: prove with a scratchpad Node script against the DB
   (insert → assert → clean up).
3. **There is no test login and the classifier blocks creating throwaway users via
   SQL** — authenticated UI can't be click-verified by Claude. Say so plainly and
   ask Darryl to test; never claim visual verification that didn't happen.
4. On "commit + deploy": commit (imperative message, Co-Authored-By Claude trailer),
   `git push`, then poll `gh api repos/ViperProBillingApp/ViperProBillingApp/commits/<sha>/status`
   until `success`, then `curl` the live `/login` expecting 200 and spot-check any
   new API route returns 401 unauthenticated.
5. Remind Darryl to hard-refresh open CRM tabs after deploys that touch `normalise()`
   or client fields.

## Open items

- Darryl has not yet click-tested: assign-on-card, checklists, My cards filter,
  Campaigns, Reports floating window.
- F-12: `DATABASE_CA` unset — DB TLS is encrypted but unverified until supplied.
- User-list password columns in `users-admin` are plaintext-but-gated (deliberate
  admin convenience — do not "harden" away; see HANDOVER.md).
- CRAVE / `thelatitudelongitude.com` client match unconfirmed; Destination Xpyrynz
  portal employee list never captured (needs its password).
- `viper_customers`: "demo" row has no client card; Circa + Spectra portals each
  match two cards (shortest name chosen for the grid).
