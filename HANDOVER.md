# ViperPro CRM — Session Handover

Context for whoever picks this up next (human or AI). Written 2026-07-16.

## The app

Internal staff tool for VIP Event Resources: tracks client billing, arrears, reminder emails, and portal access for DMCs on the Viper and Maritz portals.

| | |
| --- | --- |
| Live | <https://viper-pro-billing-app.vercel.app> (auto-deploys on push to `main`) |
| Repo | `ViperProBillingApp/ViperProBillingApp` |
| Local | `~/Desktop/Claude/viper-crm` |
| Stack | Next.js 15 (JS, app router), React 19, Vercel serverless, Supabase Postgres |
| Main file | `components/crm.jsx` (~3000 lines, mostly inline-styled) |
| Brand | `lib/brand.js` — `C` palette, `SANS`/`DISPLAY`/`MONO`, `Wordmark` |

**Only edit this app in its own chat.** A parallel session on `take3-app` once collided with this one.

## Architecture you must understand

### Whole-state JSON + the rev guard

All CRM data lives in **one JSON blob**: table `kv`, key `state`, shaped `{ clients: [...], settings: {...}, rev: N }`. The browser loads it, mutates React state, and debounce-saves the **entire blob** back.

Every writer bumps `rev`. `PUT /api/state` rejects a stale `rev` with 409, and the UI shows a "Reload latest" banner.

### ⚠️ The stale-tab trap — read this before touching data

**This caused real data loss twice in one session.** A browser tab holding an older copy of the state can save the whole blob back and silently erase newer records. It bit us two ways:

1. **A tab on an old code bundle** doesn't know about new fields. `normalise()` strips unknown keys, so saving wiped `maritzUserLists` off every card — twice.
2. **A tab holding an old client array** overwrote the list and **deleted 50 client cards** (restored from backup — see below).

Rules that follow from this:

- **Any new client field MUST be added to `normalise()`** in `crm.jsx`, and that code must be **deployed**, *before* writing it to the database. Otherwise the next tab save deletes it.
- After a deploy, **hard-refresh every open CRM tab** (Cmd+Shift+R). Keep **one** tab open.
- After any bulk DB write, re-read the DB to confirm it stuck.

### Database backups

Restore points saved as extra `kv` keys during this session:

- `state_backup_dedup` — pre-deduplication snapshot (335 clients)
- `state_backup_prerestore` — taken before the 48-card restore

### ChargeOver integration (`lib/chargeover.js`)

- **Recurring amount + cadence come from billing packages** (`fetchRecurring`), *not* invoices. Invoices can't distinguish $250/yr from $250/mo.
- **`is_paid` is true for voided invoices too** — real status is `invoice_status_str`.
- **CO pre-generates upcoming invoices**, so a customer's raw `balance` includes not-yet-due charges. `fetchOverdueMap()` gives the overdue-only figure, stored per client as `coOverdue`; `owedBalance()` prefers it.
- **`CO_DUPLICATE_IDS`** maps duplicate CO customer ids → primary, so the sync can't resurrect merged cards. Remove entries once the duplicates are merged inside ChargeOver.

## What changed this session

### Features

- **Emails tab** — sent-email archive with search; "Email sent · date" opens the sent copy in a popup; Audience before Template; editable To/From plus CC with a contact dropdown; sending auto-moves the client to *Contacted · awaiting reply* and dismisses the card (10-day no-reply bounce-back); Done button; post-send status dropdowns.
- **Client card** — Info/Billing/Portal tabs; Activity entries link to the sent email; pricing section follows the segment dropdown; Maritz portal access section (URL/admin/user/password/admin-user/admin-password, each with copy) plus a searchable Maritz users table; admin credentials added to Viper portal access; group-offices picker creates a dedicated `<Name> (Group)` billing card; multi-office billing toggle for single offices billed at group rates.
- **Left menu** — **Pricing** (central inline editor for the three global pricing objects) and **Maritz Onboarding** (new-office checklist).
- **Client list** — right-click a company to open it in a new tab (`?client=<id>` deep links; URL stays in sync).
- **Group billing card** — Copy names, per-office ChargeOver status pills, back-to-group button.

### Bug fixes

- **MRR was inflating daily** (~$138k vs a real ~$20k): the sync set `amount` from the latest invoice, so annual clients counted 12× and cancelled customers kept phantom revenue. Now driven by active billing packages.
- **Void invoices displayed as paid.**
- **"2 periods behind · owes $400" on clients who owed nothing** — CO's pre-generated invoices inflated the balance.
- **Email icon dropdown was clipped/invisible** — archived rows' 55% opacity created a stacking context; now portalled to `document.body`.
- **Workflow "removed from workflow" view was empty** — hidden cards are mostly *Up to date*, which had no column.
- **Security: RLS enabled + anon/authenticated grants revoked** on all four tables. The app connects as the table owner (bypasses RLS), but Supabase's anon-key REST API had the whole client DB and `users` (password hashes) world-readable.

### Data operations (live database)

- Imported the Maritz multi-office sheet → 7 group cards over their offices.
- Segment sweep against `LegacyViperPortalUserPasswords` + `Maritz Pulled Full Master`: 26 real Viper customers, 208 Maritz portal, 113 past.
- De-duplication: 13 cards merged; 10 CO duplicate ids suppressed.
- **Maritz portal users scraped** from `maritzadmin.viperdmc.com` → 176 cards, **713 user-memberships**.
- **Restored 48 client cards** lost to the stale-tab overwrite.
- Marked *Meptur* and *Tropical Incentives - Mexico City* for deletion.

## Gotchas worth knowing

- **Scraping the Maritz admin site**: employee usernames **and plaintext passwords** are exposed at `EmployeeDetail.aspx?eid=N&tab=System+Account` (values are in the HTML; the default tab doesn't render them). Per-office membership must come from `OfficeDetail.aspx?oid=N` — the *All Employees* list only shows each person's **primary** office, which is why offices sharing staff (e.g. Tropical Incentives) came up short.
- **Group tiers** are by office count; group members are "covered" (owe nothing) and the master card carries the one active price.
- **"Administrator, Site"** is the portal's built-in account — excluded from user counts and copied lists via `isSiteAdmin()`.
- The **Browser pane and the Chrome extension are separate sessions**; neither shares a login with your normal Chrome window. Claude cannot type passwords into login forms — a human must log in.

## Security debt (deliberate, but know about it)

- **Plaintext passwords in the state blob**: Maritz portal user lists (~713 rows), Viper portal admin credentials, per-company portal passwords. Readable by anyone with CRM access.
- **`users.visible_password`** stores staff logins in plaintext by design, so an admin can hand them over.
- **Credentials and API keys were pasted into the chat transcript** (Maritz admin password, Supabase/Brevo/ChargeOver keys earlier). **Rotate them if that transcript is shared.**

## Outstanding

| Item | Notes |
| --- | --- |
| Daily digest email | **Done** — /api/cron/daily (06:30) snapshots KPIs + emails active staff; admins can POST it to run now. Shares lib/metrics.js with the UI |
| MEP → Meptur | Marked for deletion on the basis that MEP Destination Business Solutions is Meptur's MICE brand — worth a human sanity check; it was an active billing client |
| Spectra | Two cards: "Spectra" (CO 184) and "Spectra DMC" (CO 78). Believed separate accounts — confirm |
| ChargeOver duplicates | 10 duplicate customers suppressed app-side; merge them in ChargeOver, then drop from `CO_DUPLICATE_IDS`. **Travel Excellence 264 + 253 both carried $250 balances — possible double-billing** |
| Destination Xpyrynz | Portal capture pending (needs the password) |
| thelatitudelongitude.com / CRAVE | Match decision outstanding |

## Working conventions

- Every batch ends with an explicit **"commit + deploy"** from the user — don't push unprompted.
- Verify deploys with `gh api repos/ViperProBillingApp/ViperProBillingApp/commits/<sha>/status --jq '.state'`.
- Dry-run every data script first (`--apply` to write), and report counts before/after.
- `npx next build` before committing.
- If the shell loses access to `.git` ("Operation not permitted"), route git through the Desktop Commander tool.
