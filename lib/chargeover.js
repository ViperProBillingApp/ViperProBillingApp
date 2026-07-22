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
    .map((i) => {
      // is_paid is TRUE for voided/written-off invoices too (their balance is 0),
      // so the real status is invoice_status_str/_name — same as the ChargeOver UI.
      const key = String(i.invoice_status_str || "").toLowerCase();
      const dead = key.includes("void") || key.includes("writeoff");
      return {
        id: i.invoice_id,
        number: i.refnumber || String(i.invoice_id),
        date: i.date || i.invoice_date || "",
        total: Number(i.total) || 0,
        balance: Number(i.balance) || 0,
        currency: i.currency_symbol || "$",
        paid: !!i.is_paid && !dead,
        overdue: !!i.is_overdue,
        voided: dead,
        status: i.invoice_status_name || (dead ? "Void" : i.is_paid ? "Paid" : i.is_overdue ? "Overdue" : "Open"),
      };
    });
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
    inChargeOver: true,
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
    // Don't email-match a card already claimed by a DIFFERENT ChargeOver customer.
    // Two customers sharing one billing email would otherwise ping-pong over the
    // same card (identity + balance flipping every sync).
    const i = clients.findIndex((c) => (c.email || "").toLowerCase() === e && !(c.chargeoverId && m.chargeoverId && String(c.chargeoverId) !== m.chargeoverId));
    if (i !== -1) return i;
  }
  return -1;
}

// Truly-overdue balance per customer. ChargeOver PRE-GENERATES upcoming
// invoices, so a customer's raw `balance` includes charges that aren't due
// yet — only invoices flagged is_overdue count as owed right now.
// One paginated account-wide query (~tens of unpaid invoices).
export async function fetchOverdueMap() {
  const map = {};
  const limit = 200;
  for (let offset = 0; offset < 5000; offset += limit) {
    const rows = await coRequest(`/invoice?where=balance:GT:0&offset=${offset}&limit=${limit}`);
    const list = Array.isArray(rows) ? rows : [];
    for (const i of list) {
      if (!i.is_overdue) continue;
      const id = String(i.customer_id);
      map[id] = (map[id] || 0) + (Number(i.balance) || 0);
    }
    if (list.length < limit) break;
  }
  return map;
}

// Every unpaid (non-void) invoice with its due date — the raw rows behind the
// Reports tab's AR ageing. Same query fetchOverdueMap pages, kept per-invoice.
export async function fetchOpenInvoices() {
  const all = [];
  const limit = 200;
  for (let offset = 0; offset < 5000; offset += limit) {
    const rows = await coRequest(`/invoice?where=balance:GT:0&offset=${offset}&limit=${limit}`);
    const list = Array.isArray(rows) ? rows : [];
    for (const i of list) {
      const key = String(i.invoice_status_str || "").toLowerCase();
      if (key.includes("void") || key.includes("writeoff")) continue;
      all.push({
        customerId: String(i.customer_id),
        number: i.refnumber || String(i.invoice_id),
        date: i.date || i.invoice_date || "",
        dueDate: i.due_date || i.date || i.invoice_date || "",
        total: Number(i.total) || 0,
        balance: Number(i.balance) || 0,
        overdue: !!i.is_overdue,
        currency: i.currency_symbol || "$",
      });
    }
    if (list.length < limit) break;
  }
  return all;
}

// Duplicate ChargeOver customers (same real-world company registered twice).
// The secondary ids are SKIPPED by the sync so they never resurrect a card the
// CRM merged away; the primary id's card represents the company. Remove an
// entry once the duplicate is merged inside ChargeOver itself.
// secondary co id -> primary co id (primary listed for documentation)
export const CO_DUPLICATE_IDS = {
  149: 178, // AlliedPRA (bare parent duplicate)
  196: 190, // Discover Bermuda
  195: 190, // Discover Bermuda / The Fairmont Southampton
  253: 271, // Travel Excellence S.A. -> Travel Excellence Costa Rica (NB: 253/264 both carried $250 balances)
  264: 271, // Travel Excellence -> Travel Excellence Costa Rica (271 is the live account)
  148: 105, // ACCESS San Diego LLC
  199: 203, // CONNECT DMC (CONNECT TRAVEL) -> Connect DMC
  167: 22,  // Destination Puerto Rico | Travel Services -> Destination Puerto Rico
  141: 60,  // GRUPOS INCENTIVOS TERRAMAR (GIT tax-id name) -> Grupos Incentivos Terramar
  96: 268,  // Summit Events LLC -> Summit Events
};

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
export function mergeCustomers(state, mapped, overdueByCo = null) {
  const clients = [...(state.clients || [])];
  let added = 0;
  let updated = 0;
  for (const m of mapped) {
    if (!m.chargeoverId && !m.email) continue;
    if (CO_DUPLICATE_IDS[m.chargeoverId] !== undefined) continue; // known CO duplicate — primary card covers it
    // owed RIGHT NOW: overdue-only when we have the map (raw balance includes
    // pre-generated invoices that aren't due yet)
    const owedNow = overdueByCo ? (overdueByCo[m.chargeoverId] || 0) : m.coBalance;
    const i = findIdx(clients, m);
    if (i !== -1) {
      const ex = clients[i];
      if (m.chargeoverId) ex.chargeoverId = m.chargeoverId;
      if (m.company) ex.company = m.company;
      if (m.name) ex.name = m.name;
      if (m.email) ex.email = m.email;
      ex.coBalance = m.coBalance;
      ex.inChargeOver = true;
      // Only touch coOverdue / auto billing status when we have RELIABLE overdue
      // data. If the overdue fetch failed (overdueByCo null), refresh the raw
      // balance but leave status + coOverdue at last-known — driving status off
      // the raw balance would flag clients "not up to date" for invoices that
      // aren't due yet.
      if (overdueByCo) {
        ex.coOverdue = owedNow;
        if (AUTO_BILLING_STATUSES.includes(ex.billingStatus)) {
          ex.billingStatus = owedNow > 0 ? "not-up-to-date" : "current-pricing";
        }
      }
      updated++;
    } else {
      clients.push({ ...newClient(m), ...(overdueByCo ? { coOverdue: owedNow } : {}), billingStatus: owedNow > 0 ? "not-up-to-date" : "current-pricing" });
      added++;
    }
  }
  return { clients, added, updated };
}

// Recurring amount + cadence come from ChargeOver's own billing packages —
// each package carries mrr/arr and its paycycle. (The old approach inferred
// the amount from the latest invoice, which can't tell a $250/yr fee from
// $250/mo and inflated the MRR metric 12x for annual clients, a bit more
// with every sync as the backfill progressed.)
export async function fetchRecurring(customerId) {
  const rows = await coRequest(`/billing_package?where=customer_id:EQUALS:${encodeURIComponent(customerId)}`);
  const live = (Array.isArray(rows) ? rows : []).filter((p) => p.package_status_state === "a");
  const mrr = live.reduce((n, p) => n + (Number(p.mrr) || 0), 0);
  const annual = live.length > 0 && live.every((p) => p.paycycle === "yrl");
  // earliest upcoming invoice across the active packages, with its cycle amount
  const next = live
    .filter((p) => p.next_invoice_datetime)
    .map((p) => ({ date: String(p.next_invoice_datetime).slice(0, 10), amount: Number(p.paycycle === "yrl" ? p.arr : p.mrr) || 0 }))
    .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
  return { mrr, annual, packages: live.length, next };
}

// One API call per client, so each sync refreshes a bounded batch (oldest
// package-check first, tracked via coAmountAt) rather than all ~330 at once,
// to stay well inside the serverless time limit. Full rotation ≈ 11 syncs.
// ponytail: hard caps + a wall-clock budget, not a queue/job system.
const BACKFILL_LIMIT = 30;
const BACKFILL_CONCURRENCY = 6;
const BACKFILL_BUDGET_MS = 35_000;

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

export async function backfillRecurringAmounts(clients) {
  const stamp = new Date().toISOString();
  const candidates = clients
    // group billing masters carry the manually-set group tier price — never overwrite
    .filter((c) => c.chargeoverId && !(c.multiOffice && c.priceMode === "group" && c.groupBillingMaster))
    .sort((a, b) => (a.coAmountAt || "").localeCompare(b.coAmountAt || ""))
    .slice(0, BACKFILL_LIMIT);
  const start = Date.now();
  let filled = 0;
  await pool(candidates, async (c) => {
    if (Date.now() - start > BACKFILL_BUDGET_MS) return;
    const r = await fetchRecurring(c.chargeoverId);
    c.coAmountAt = stamp;
    if (r.packages > 0) {
      c.cadence = r.annual ? "annual" : "monthly";
      c.amount = Math.round((r.annual ? r.mrr * 12 : r.mrr) * 100) / 100;
    } else {
      c.amount = 0; // no active recurring package — contributes nothing to MRR
    }
    filled++;
  }, BACKFILL_CONCURRENCY);
  return { filled, remaining: Math.max(0, clients.filter((c) => c.chargeoverId && !c.coAmountAt).length) };
}
