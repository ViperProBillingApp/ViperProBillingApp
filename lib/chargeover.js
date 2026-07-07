import crypto from "node:crypto";

// ChargeOver REST API v3 client. HTTP Basic auth with a public key (username)
// + private key (password), both from Settings → Developer → REST API.
// Gated on both keys being present so the app runs fine before it's connected.

export function coConfigured() {
  return !!(process.env.CHARGEOVER_PUBLIC_KEY && process.env.CHARGEOVER_PRIVATE_KEY && process.env.CHARGEOVER_SUBDOMAIN);
}

async function coRequest(path) {
  const base = `https://${process.env.CHARGEOVER_SUBDOMAIN}.chargeover.com/api/v3`;
  const auth = Buffer.from(
    `${process.env.CHARGEOVER_PUBLIC_KEY}:${process.env.CHARGEOVER_PRIVATE_KEY}`
  ).toString("base64");
  const r = await fetch(base + path, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`ChargeOver API ${r.status} on ${path}`);
  const j = await r.json();
  return j.response; // ChargeOver wraps results in { code, status, response }
}

export async function fetchAllCustomers() {
  const all = [];
  const limit = 100;
  for (let offset = 0; offset < 10000; offset += limit) {
    const batch = await coRequest(`/customer?offset=${offset}&limit=${limit}`);
    const rows = Array.isArray(batch) ? batch : [];
    all.push(...rows);
    if (rows.length < limit) break;
  }
  return all;
}

// Past charges (invoices) for one ChargeOver customer, newest first.
export async function fetchInvoices(customerId) {
  const co = encodeURIComponent(customerId);
  const rows = await coRequest(`/invoice?where=customer_id:EQUALS:${co}&order=date:DESC&limit=200`);
  return (Array.isArray(rows) ? rows : [])
    .filter((i) => Number(i.total) !== 0) // skip $0 placeholder invoices — only real charges/credits
    .map((i) => ({
    id: i.invoice_id,
    number: i.refnumber || String(i.invoice_id),
    date: i.date || i.invoice_date || "",
    total: Number(i.total) || 0,
    balance: Number(i.balance) || 0,
    currency: i.currency_symbol || "$",
    paid: !!i.is_paid,
    overdue: !!i.is_overdue,
  }));
}

// Best-effort field extraction. ChargeOver customer schemas vary by account
// (custom fields, how contacts are nested), so this is the one function to
// verify/refine against the live account once both API keys are in.
export function mapCustomer(c) {
  const contact =
    c.bill_contact || c.superuser || (Array.isArray(c.contacts) ? c.contacts[0] : null) || {};
  return {
    chargeoverId: String(c.customer_id ?? c.id ?? "").trim(),
    company: (c.company || "").trim(),
    // Contact name/email come from a SEPARATE contact resource, not the customer
    // object — leave blank if not present so the sync never overwrites the real
    // contact name with the company (mergeCustomers only sets fields that are truthy).
    name: (contact.name || "").trim(),
    email: (contact.email || "").trim(),
    coBalance: Number(c.balance ?? c.balance_amount ?? 0) || 0,
  };
}

function newClient(m) {
  const now = new Date();
  return {
    id: crypto.randomBytes(8).toString("hex"),
    chargeoverId: m.chargeoverId,
    name: m.name,
    company: m.company || m.name,
    email: m.email,
    phone: "",
    segment: "viper-current",
    billingStatus: m.coBalance > 0 ? "not-up-to-date" : "current-pricing",
    coBalance: m.coBalance,
    stage: "not-contacted",
    tags: [],
    amount: 0,
    billingDay: 1,
    cadence: "monthly",
    currency: "",
    lastPaid: "",
    payments: [],
    emailStatus: "ok",
    secondaryContacts: [],
    archivedContacts: [],
    candidates: [],
    reminders: {},
    notes: "",
    followUp: "",
    activity: [{ at: now.toISOString(), type: "sync", text: "Imported from ChargeOver" }],
    createdAt: now.toISOString().slice(0, 10),
    archivedClient: false,
  };
}

function findIdx(clients, m) {
  if (m.chargeoverId) {
    const i = clients.findIndex((c) => String(c.chargeoverId || "") === m.chargeoverId);
    if (i !== -1) return i;
  }
  if (m.email) {
    const e = m.email.toLowerCase();
    const i = clients.findIndex((c) => (c.email || "").toLowerCase() === e);
    if (i !== -1) return i;
  }
  return -1;
}

// billingStatus values that ChargeOver's balance is allowed to drive automatically.
// "old-pricing" / "no-payment-method" / "marked-deletion" are staff calls unrelated
// to balance and must survive a sync untouched.
const AUTO_BILLING_STATUSES = ["not-up-to-date", "payment-failed", "never-charged", "current-pricing"];

// Pure merge: match by ChargeOver ID first, then email. New customers are added;
// existing clients get identity fields + live balance refreshed while every
// CRM-managed field (segment, stage, tags, notes, amount, activity, reminders…)
// is preserved.
// ponytail: O(n·m) findIndex scan — fine for hundreds of customers; index it if
// the account ever grows into the thousands.
export function mergeCustomers(state, mapped) {
  const clients = [...(state.clients || [])];
  let added = 0;
  let updated = 0;
  for (const m of mapped) {
    if (!m.chargeoverId && !m.email) continue;
    const i = findIdx(clients, m);
    if (i !== -1) {
      const ex = clients[i];
      if (m.chargeoverId) ex.chargeoverId = m.chargeoverId;
      if (m.company) ex.company = m.company;
      if (m.name) ex.name = m.name;
      if (m.email) ex.email = m.email;
      ex.coBalance = m.coBalance;
      if (AUTO_BILLING_STATUSES.includes(ex.billingStatus)) {
        ex.billingStatus = m.coBalance > 0 ? "not-up-to-date" : "current-pricing";
      }
      updated++;
    } else {
      clients.push(newClient(m));
      added++;
    }
  }
  return { clients, added, updated };
}
