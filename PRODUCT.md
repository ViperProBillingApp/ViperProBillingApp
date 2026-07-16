# Product

## Users

Darryl and a small ViperPro staff team (accounting / account management at VIP Event Resources, theviperpro.com). They use this internal CRM daily to track client billing health, chase arrears, manage the contact workflow, and draft collection emails for manual review before sending via Brevo. Context: desktop, office, task-focused sessions.

## Product Purpose

Track clients across four independent axes (segment, billing status, workflow stage, free-stacking tags), flag overdue accounts, calculate arrears (`periodsBehind()` is the single source of truth), and send escalating payment reminders. Client mail is review-first — staff read the full email and click Send per client. Success = no overdue account slips through, and chasing takes minutes, not hours. Billing data syncs from ChargeOver (match key `chargeoverId`, fallback email); recurring amount and cadence come from billing packages, and overdue-only balances from `fetchOverdueMap()`.

## Brand Personality

Per the official ViperPro brand system (Edition 01 · 2026): trustworthy, calm, organized, efficient — never flashy. Voice: "Plain. Confident. Calm." Sentence case body copy, product-as-subject, no exclamation marks, no hype words, no emoji. All outbound letters are signed "Best, ViperPro Accounting Team" and sent from <accounting@vipeventresources.com>.

## Anti-references

- Flashy SaaS dashboards with gradients, glassmorphism, or hero metrics — the brand is explicitly "never flashy".
- Dark-mode developer-tool aesthetics — imagery stays cool-toned, light and airy.
- Hype marketing copy ("Revolutionize your workflow") — plain statements only.

## Design Principles

1. **Arrears first** — the money at risk is always the most prominent number on screen; everything else supports the chase.
2. **Review before send (client mail)** — no client ever receives mail a human didn't read and send. Staff see the full email and click Send per client; there is deliberately no bulk endpoint. Once sent, the UI says so plainly and archives the sent copy. Staff-facing mail (password resets, invites) sends automatically — the rule protects clients from a bad chase email, not staff from their own tools.
3. **One glance, one answer** — status pills, stage colors, and tags must be readable without opening a record.
4. **Calm authority** — periwinkle accents on grey ink; color signals meaning (overdue, current, bounced), never decoration.

## Accessibility & Inclusion

No formal WCAG mandate; keep body text ≥4.5:1 contrast, semantic status colors paired with text labels (never color alone), and standard keyboard/form behavior. Small trusted user base on desktop browsers.
