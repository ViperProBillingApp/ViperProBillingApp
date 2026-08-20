// Brevo Contacts API — separate from lib/email.js, which only does
// transactional sends. Keeps every client-card contact's CUSTOMER attribute
// in Brevo matching this CRM's own Maritz/Viper classification, so Brevo
// segments/campaigns can be built off a field the CRM keeps accurate instead
// of a manually-maintained list.

export function brevoConfigured() {
  return !!process.env.BREVO_API_KEY;
}

// Brevo's own CUSTOMER attribute, set up in the Brevo dashboard (not created
// by this code) — enumeration confirmed against the live account 2026-08-20.
const CUSTOMER = { VIPER: 1, MARITZ: 2, BOTH: 3, PAST_VIPER: 4, PAST_MARITZ: 5 };

function splitName(full) {
  const cleaned = (full || "").replace(/\([^)]*\)/g, "").replace(/["“”]/g, "").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || "" };
}

// Pure aggregation, no network calls — safe to check against a plain array
// of client objects in a scratchpad script. Folds every {name,email} on every
// live client card into one row per email, since the same rep often sits on
// more than one card (shared regional/global sales contacts): their CUSTOMER
// value has to reflect ALL the cards they're on, not just whichever one a
// batched run happened to look at.
export function buildContactSync(clients) {
  const byEmail = new Map();
  for (const c of clients || []) {
    if (c.archivedClient && !c.formerCustomer) continue; // dead/merged duplicate — its contacts already live on the surviving card
    const isMaritz = !!c.maritzPortal, isViper = !!c.viperCustomer;
    if (!isMaritz && !isViper) continue; // not a customer of either program — no CUSTOMER value fits
    const isPast = !!c.formerCustomer;
    const people = [{ name: c.name, email: c.email }, ...(c.secondaryContacts || [])];
    for (const p of people) {
      // The client-level email field sometimes carries several comma/semicolon
      // -joined addresses ("send to both") — Brevo's API rejects that as one
      // "email", so split it. Every resulting address gets the same name; for
      // the (rare) case where it's actually two different people sharing a
      // slot, that's a minor cosmetic miss, not a dropped contact.
      const addrs = (p.email || "").split(/[,;]/).map((s) => s.trim().toLowerCase()).filter((e) => e.includes("@"));
      for (const email of addrs) {
        const row = byEmail.get(email) || { name: "", companies: new Set(), isMaritz: false, isViper: false, anyCurrent: false, anyPast: false };
        row.isMaritz = row.isMaritz || isMaritz;
        row.isViper = row.isViper || isViper;
        if (isPast) row.anyPast = true; else row.anyCurrent = true;
        if (c.company) row.companies.add(c.company);
        if (!row.name && p.name) row.name = p.name;
        byEmail.set(email, row);
      }
    }
  }
  const out = [];
  for (const [email, row] of byEmail) {
    // Active on ANY card wins over past-only — a contact who moved from a
    // former client to a current one is current, not past.
    const target = row.anyCurrent
      ? (row.isMaritz && row.isViper ? CUSTOMER.BOTH : row.isMaritz ? CUSTOMER.MARITZ : CUSTOMER.VIPER)
      // ponytail: Brevo has no "past + both programs" value; Maritz wins the
      // tie since it's the larger of the two portfolios here today.
      : (row.isMaritz ? CUSTOMER.PAST_MARITZ : CUSTOMER.PAST_VIPER);
    const { first, last } = splitName(row.name);
    const attributes = { CUSTOMER: target };
    if (first) attributes.FIRSTNAME = first;
    if (last) attributes.LASTNAME = last;
    if (row.companies.size === 1) attributes.COMPANY = [...row.companies][0]; // ambiguous when a rep spans multiple companies — leave blank rather than guess
    out.push({ email, attributes });
  }
  return out;
}

async function upsertContact(email, attributes) {
  const r = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, attributes, updateEnabled: true }),
  });
  if (!r.ok) throw new Error(`Brevo ${r.status} for ${email}`);
}

async function pool(items, worker, concurrency) {
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]).catch(() => {});
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

// Brevo's own latency runs ~1s/call. A live timing test at concurrency 25
// against ~400 contacts either overran the route's time budget or started
// tripping Brevo's rate limit (intermittent failures) — pushing concurrency
// further to force one run to cover everyone just fights the API instead of
// working with it. A bounded batch + persisted rotation cursor is the same
// fix backfillRecurringAmounts already uses for ChargeOver, so a contacts
// list that outgrows one run's budget still gets a full pass every few nights.
const SYNC_CONCURRENCY = 10;
const SYNC_BATCH = 150;

// Pushes up to SYNC_BATCH contacts starting at `cursor` into the deterministic
// (sorted-by-email) full contact list, wrapping around at the end. Returns
// the cursor the next run should start from, so the route can persist it.
export async function syncBrevoContacts(clients, cursor = 0) {
  const rows = buildContactSync(clients).sort((a, b) => a.email.localeCompare(b.email));
  if (!rows.length) return { total: 0, pushed: 0, failed: 0, nextCursor: 0 };
  const start = ((cursor % rows.length) + rows.length) % rows.length;
  const batch = Array.from({ length: Math.min(SYNC_BATCH, rows.length) }, (_, i) => rows[(start + i) % rows.length]);

  let pushed = 0, failed = 0;
  await pool(batch, async (row) => {
    try {
      await upsertContact(row.email, row.attributes);
      pushed++;
    } catch {
      failed++; // self-heals next rotation — no retry here, so one slow contact can't stall the batch
    }
  }, SYNC_CONCURRENCY);

  return { total: rows.length, pushed, failed, nextCursor: (start + batch.length) % rows.length };
}
