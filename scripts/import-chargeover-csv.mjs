// One-off: import a ChargeOver customer CSV export into the CRM (Supabase state).
// Usage: node scripts/import-chargeover-csv.mjs /path/to/export.csv
import fs from "node:fs";
import crypto from "node:crypto";
import Papa from "papaparse";
import { getDb } from "../lib/db.js";

const file = process.argv[2];
if (!file) { console.error("Usage: node scripts/import-chargeover-csv.mjs <export.csv>"); process.exit(1); }

const csv = fs.readFileSync(file, "utf8");
const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });

const stripQuotes = (s) => String(s || "").replace(/^["\s]+|["\s]+$/g, "").trim();
const emails = (s) => String(s || "").split(/[,;\s]+/).map((e) => e.trim()).filter((e) => /\S+@\S+\.\S+/.test(e));
function parseCreated(s) {
  const datePart = String(s || "").split(" at ")[0].trim(); // "Dec 1, 2014"
  const d = new Date(datePart);
  return isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}
const SYM = { USD: "$", GBP: "£", EUR: "€" };

function toClient(row) {
  const [primary, ...rest] = emails(row.Email);
  const balance = Number(row.Balance) || 0;
  const cur = stripQuotes(row.Currency) || "USD";
  const overdue = /overdue|past.?due|unpaid/i.test(row.Status || "");
  const now = new Date();
  return {
    id: crypto.randomBytes(8).toString("hex"),
    chargeoverId: stripQuotes(row["Customer #"]),
    name: stripQuotes(row.Contact),
    company: stripQuotes(row.Customer) || stripQuotes(row.Contact),
    email: primary || "",
    phone: stripQuotes(row.Phone),
    segment: "viper-current",
    billingStatus: overdue ? "not-up-to-date" : "current-pricing",
    stage: "not-contacted",
    tags: [],
    amount: 0,
    billingDay: 1,
    cadence: "monthly",
    currency: SYM[cur] ? cur : "USD",
    lastPaid: "",
    payments: [],
    emailStatus: "ok",
    secondaryContacts: rest.map((e) => ({ name: "", email: e, role: "" })),
    archivedContacts: [],
    candidates: [],
    reminders: {},
    notes: balance > 0 ? `ChargeOver balance: ${SYM[cur] || ""}${balance} (${stripQuotes(row.Status)}).` : "",
    followUp: "",
    activity: [{ at: now.toISOString(), type: "sync", text: "Imported from ChargeOver export" }],
    createdAt: parseCreated(row.Created),
    archivedClient: false,
  };
}

const incoming = data.map(toClient).filter((c) => c.chargeoverId || c.email || c.company);

const db = await getDb();
const { rows } = await db.query("SELECT value FROM kv WHERE key = 'state'");
const state = rows[0] ? JSON.parse(rows[0].value) : { clients: [], settings: {} };
const clients = state.clients || [];

// Key on ChargeOver customer # (unique). Email is only used to fold a customer
// into a pre-existing MANUAL client (one without a chargeoverId) — never to dedupe
// within the ChargeOver set, where separate customers can share a contact email.
const existingCo = new Set(clients.filter((c) => c.chargeoverId).map((c) => String(c.chargeoverId)));
const manualByEmail = new Map(
  clients.filter((c) => !c.chargeoverId && c.email).map((c) => [c.email.toLowerCase(), c])
);

let added = 0, updated = 0, skipped = 0;
for (const c of incoming) {
  if (c.chargeoverId && existingCo.has(c.chargeoverId)) { skipped++; continue; } // already imported
  const manual = c.email ? manualByEmail.get(c.email.toLowerCase()) : null;
  if (manual) {
    manual.chargeoverId = c.chargeoverId;
    if (!manual.company) manual.company = c.company;
    if (c.chargeoverId) existingCo.add(c.chargeoverId);
    manualByEmail.delete(c.email.toLowerCase());
    updated++;
    continue;
  }
  clients.push(c);
  if (c.chargeoverId) existingCo.add(c.chargeoverId);
  added++;
}

await db.query(
  "INSERT INTO kv (key, value) VALUES ('state', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  [JSON.stringify({ clients, settings: state.settings || {} })]
);
const overdue = incoming.filter((c) => c.billingStatus === "not-up-to-date").length;
console.log(`Parsed ${incoming.length} rows → added ${added}, folded into existing ${updated}, skipped ${skipped} (already imported).`);
console.log(`Total clients now: ${clients.length}. Flagged not-up-to-date (overdue): ${overdue}.`);
process.exit(0);
