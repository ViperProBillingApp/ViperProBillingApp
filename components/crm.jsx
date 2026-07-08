"use client";
import React, { useState, useEffect, useMemo, useCallback } from "react";
import Papa from "papaparse";
import { C, SANS, DISPLAY, MONO, Wordmark } from "../lib/brand.js";
import UsersAdmin from "./users-admin.jsx";

/* ================================================================== *
 * ViperPro — Client CRM & Collections
 * Ported from the artifact prototype (viper-crm-v2.jsx).
 * Storage: /api/state (SQLite-backed, whole-state, debounced saves).
 * Contact recovery: /api/recover (server-side Claude web search).
 * ================================================================== */

const SYMBOL = { GBP: "£", USD: "$", EUR: "€" };

/* ------------------------------ Axes ------------------------------ */
const SEGMENTS = {
  "viper-current": { label: "Viper Customer", color: "#0E766E" },
  "viper-past": { label: "Past Viper Customer", color: "#8A94A6" },
  "maritz-portal": { label: "Maritz - Viper Portal", color: "#3B5BA5" },
};
const BILLING = {
  "current-pricing": { label: "Up to date · current pricing", color: C.green, bg: C.greenBg },
  "old-pricing": { label: "Up to date · old pricing", color: C.amber, bg: C.amberBg },
  "not-up-to-date": { label: "Not up to date", color: C.red, bg: C.redBg },
  "never-charged": { label: "Never charged", color: C.grey, bg: C.greyBg },
  "payment-failed": { label: "Payment failed", color: C.red, bg: C.redBg },
  "no-payment-method": { label: "No payment method", color: C.amber, bg: C.amberBg },
  "marked-deletion": { label: "Marked for deletion", color: C.grey, bg: C.greyBg },
};
const STAGES = {
  "not-contacted": { label: "Not contacted", color: "#8A94A6", order: 0 },
  "need-to-contact": { label: "Need to contact", color: C.amber, order: 1 },
  "contacted-awaiting": { label: "Contacted · awaiting reply", color: "#3B5BA5", order: 2 },
  "up-to-date": { label: "Up to date", color: C.green, order: 3 },
  "on-hold": { label: "On hold", color: "#7A4FB5", order: 4 },
  "marked-deletion": { label: "Marked for deletion", color: C.red, order: 5 },
};
const STAGE_ORDER = Object.keys(STAGES).sort((a, b) => STAGES[a].order - STAGES[b].order);
const TAGS = {
  "needs-contact-info": { label: "Needs new contact info", color: C.amber },
  "email-bouncing": { label: "Email bouncing", color: C.red },
  "opted-out": { label: "Opted out / do not contact", color: C.red },
  "price-pending": { label: "Price increase: pending", color: C.amber },
  "price-accepted": { label: "Price increase: accepted", color: C.green },
  "price-declined": { label: "Price increase: declined", color: C.red },
  "grandfathered": { label: "Grandfathered pricing", color: "#3B5BA5" },
  "vip": { label: "VIP / key account", color: "#7A4FB5" },
  "renewal-soon": { label: "Renewal approaching", color: C.amber },
  "contact-found": { label: "New contact found · review", color: "#0E766E" },
  "payment-plan": { label: "On payment plan", color: "#3B5BA5" },
  "disputed": { label: "Disputed charge", color: C.red },
};
const CADENCE = { monthly: { label: "Monthly", months: 1 }, annual: { label: "Annual", months: 12 } };

/* ----------------------------- Helpers ----------------------------- */
function pad(n) { return String(n).padStart(2, "0"); }
function iso(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function monthsAgo(n, day = 5) { const d = new Date(); d.setMonth(d.getMonth() - n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(day)}`; }
function periodKey(date = new Date()) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`; }
function monthName(date = new Date()) { return date.toLocaleString("en-GB", { month: "long", year: "numeric" }); }
function parseDate(s) { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
function fmtDate(s) { const d = parseDate(s); return d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"; }
function money(a, cur) { return `${SYMBOL[cur] || "£"}${(Number(a) || 0).toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`; }
function firstName(n) { return (n || "there").trim().split(/\s+/)[0]; }
function uid() { return Math.random().toString(36).slice(2, 10); }
function monthIndex(d) { return d.getFullYear() * 12 + d.getMonth(); }

function lastPaymentDate(c) {
  let best = parseDate(c.lastPaid);
  for (const p of c.payments || []) { const d = parseDate(p.date); if (d && (!best || d > best)) best = d; }
  return best;
}
// How many billing periods is this client behind? 0 = current.
// Single source of truth for "who owes what" — do not duplicate elsewhere.
function periodsBehind(c, now = new Date()) {
  if (["never-charged", "marked-deletion"].includes(c.billingStatus)) return 0;
  if (c.stage === "marked-deletion") return 0;
  const cad = CADENCE[c.cadence]?.months || 1;
  const day = Number(c.billingDay) || 1;
  // No payment on record yet? Anchor to signup instead — treats "just joined"
  // the same as "just paid," so a brand-new client isn't instantly counted as
  // owing their first period before a single billing cycle has even elapsed.
  const anchor = lastPaymentDate(c) || parseDate(c.createdAt) || now;
  let diff = monthIndex(now) - monthIndex(anchor);
  if (now.getDate() < day) diff -= 1; // current period not yet due if we're before the billing day
  return Math.max(0, Math.min(24, Math.floor(diff / cad)));
}
// Real ChargeOver balance beats the calendar-based guess whenever we have one —
// dividing it by the recorded rate gives "how many periods' worth is owed"
// without depending on billingDay/lastPaid bookkeeping being accurate. This is
// what makes "final notice" and "total owed" trustworthy for synced clients.
function arrearsPeriods(c, now = new Date()) {
  if (c.coBalance != null && Number(c.amount) > 0) {
    if (c.coBalance <= 0) return 0;
    return Math.max(1, Math.min(24, Math.round(c.coBalance / Number(c.amount))));
  }
  return periodsBehind(c, now);
}
function totalOwed(c, now = new Date()) {
  if (c.coBalance != null) return Math.max(0, c.coBalance);
  return periodsBehind(c, now) * (Number(c.amount) || 0);
}
// Who needs a payment reminder. periodsBehind only works once we know recurring
// amounts — the ChargeOver billing status is the reliable signal for CSV-imported
// clients, so either counts.
function needsReminder(c, now = new Date()) {
  if (["never-charged", "marked-deletion"].includes(c.billingStatus) || c.stage === "marked-deletion") return false;
  return arrearsPeriods(c, now) >= 1 || ["not-up-to-date", "payment-failed"].includes(c.billingStatus);
}
function escalationOf(c) {
  const n = arrearsPeriods(c);
  if (n >= 3) return { level: 3, label: "Final notice", color: C.red };
  if (n === 2) return { level: 2, label: "Second reminder", color: C.amber };
  if (n === 1) return { level: 1, label: "Reminder", color: C.amber };
  return null;
}
function monthlyValue(c) { return (Number(c.amount) || 0) / (CADENCE[c.cadence]?.months || 1); }
// Compare calendar dates as "YYYY-MM-DD" strings, not Date objects — a
// date-only string parses as UTC midnight, which can read as "not due yet"
// or "already due" depending on the browser's timezone offset from UTC.
function followUpDue(c, now = new Date()) { return !!c.followUp && c.followUp <= iso(now); }
// Who needs a follow-up. An explicit follow-up date that's due always counts;
// otherwise it's derived from the workflow — "need to contact" and "contacted ·
// awaiting reply" are the stages where the ball is in your court. Skips
// archived / former clients.
const FOLLOWUP_STAGES = ["need-to-contact", "contacted-awaiting"];
function needsFollowUp(c, now = new Date()) {
  if (c.archivedClient || c.formerCustomer) return false;
  return followUpDue(c, now) || FOLLOWUP_STAGES.includes(c.stage);
}
function logActivity(c, type, text) {
  return [{ at: new Date().toISOString(), type, text }, ...(c.activity || [])].slice(0, 200);
}

/* --------------------------- Comms types --------------------------- */
const FROM_EMAIL = "accounting@vipeventresources.com";
const SIGNATURE = "Best,\nViperPro Accounting Team";
const COMMS = {
  reminder: {
    label: "Payment reminder",
    subject: (c, s) => {
      const e = escalationOf(c);
      const owed = totalOwed(c);
      if (e?.level === 3) return owed > 0 ? `Final notice — outstanding balance of ${money(owed, c.currency || s.currency)}` : "Final notice — outstanding balance on your account";
      if (e?.level === 2) return `Second reminder — ${monthName()} payment outstanding`;
      return `Payment reminder — ${monthName()}`;
    },
    body: (c, s) => {
      const cur = c.currency || s.currency;
      const owedN = totalOwed(c);
      // amounts may be unknown (CSV import) — never write "$0" to a client
      const owed = owedN > 0 ? money(owedN, cur) : null;
      const n = arrearsPeriods(c);
      const e = escalationOf(c);
      if (e?.level === 3) return `Hi ${firstName(c.name)},

Despite previous reminders, your account shows ${owed ? `an outstanding balance of ${owed} covering ${n} billing periods` : "an outstanding balance"}.

Please arrange payment within 7 days, or get in touch to discuss a payment plan. If we don't hear from you, we may have to suspend service while the account is resolved — which we'd much rather avoid.

If you believe this is in error, reply and we'll sort it straight away.

${SIGNATURE}`;
      if (e?.level === 2) return `Hi ${firstName(c.name)},

Following up on my earlier note — ${owed ? `your balance of ${owed} (${n} billing periods)` : "your account balance"} is still showing as outstanding.

If there's an issue with the invoice or you'd like to spread the payment, just reply and we'll work something out. Otherwise you can settle it at your convenience.

${SIGNATURE}`;
      return `Hi ${firstName(c.name)},

A quick reminder that your ${monthName()} payment${Number(c.amount) > 0 ? ` of ${money(c.amount, cur)}` : ""} is currently showing as outstanding.

If it's already on its way, please ignore this. Otherwise you can settle it whenever suits — just reply if you'd like a fresh invoice.

${SIGNATURE}`;
    },
  },
  price: {
    label: "Price change notice",
    subject: (c, s) => `An update to your ${s.businessName} pricing`,
    body: (c, s) => `Hi ${firstName(c.name)},

I'm writing to let you know about an upcoming change to your ${s.businessName} pricing, effective from your next renewal. Your ${CADENCE[c.cadence]?.label.toLowerCase() || "monthly"} rate will move to [NEW AMOUNT].

Everything you use today stays exactly as it is — this reflects continued investment in the platform. Full details are attached, and I'm happy to talk it through.

${SIGNATURE}`,
  },
  deletion: {
    label: "Account scheduled for deletion",
    subject: (c, s) => `Your ${s.businessName} account is scheduled for deletion`,
    body: (c, s) => `Hi ${firstName(c.name)},

Your ${s.businessName} account is currently scheduled for deletion.

If you'd like to keep your account, reply to this email or contact us at ${FROM_EMAIL} and we'll pause the process straight away. If we don't hear from you, the account and its data will be removed on the scheduled date.

If you believe this is in error, let us know and we'll sort it out.

${SIGNATURE}`,
  },
  custom: {
    label: "Custom message",
    subject: () => "",
    body: (c) => `Hi ${c.company || c.name},



${SIGNATURE}`,
  },
};
const BUILTIN_COMMS_KEYS = Object.keys(COMMS);

// Token substitution for staff-edited templates (settings.emailTemplates).
function tokenize(str, tokens) {
  return String(str || "").replace(/\{\{(\w+)\}\}/g, (_, k) => (tokens[k] ?? ""));
}
function templateTokens(c, s) {
  const cur = c.currency || s.currency;
  const owedN = totalOwed(c);
  return {
    firstName: firstName(c.name), name: c.name, company: c.company || c.name,
    businessName: s.businessName, monthName: monthName(),
    amount: Number(c.amount) > 0 ? money(c.amount, cur) : "",
    owed: owedN > 0 ? money(owedN, cur) : "", periods: String(arrearsPeriods(c)),
    cadence: CADENCE[c.cadence]?.label.toLowerCase() || "monthly", signature: SIGNATURE,
  };
}
const TEMPLATE_TOKENS = ["firstName", "name", "company", "businessName", "monthName", "amount", "owed", "periods", "cadence", "signature"];
// Merge built-in templates (dynamic, escalation-aware) with staff-edited overrides
// from settings.emailTemplates (plain strings + {{tokens}}) and any brand-new
// custom template types staff created on the Emails page.
// ponytail: editing "reminder" replaces ALL of its escalation-tier wording with
// one flat template — flagged in the Emails page UI, not worth a 3-tier editor.
function getTemplates(settings) {
  const custom = settings.emailTemplates || {};
  const out = {};
  for (const k of BUILTIN_COMMS_KEYS) {
    const ov = custom[k];
    out[k] = ov
      ? { label: ov.label || COMMS[k].label, subject: (c, s) => tokenize(ov.subject, templateTokens(c, s)), body: (c, s) => tokenize(ov.body, templateTokens(c, s)) }
      : COMMS[k];
  }
  for (const k of Object.keys(custom)) {
    if (BUILTIN_COMMS_KEYS.includes(k)) continue;
    out[k] = { label: custom[k].label || k, subject: (c, s) => tokenize(custom[k].subject, templateTokens(c, s)), body: (c, s) => tokenize(custom[k].body, templateTokens(c, s)) };
  }
  return out;
}

/* ---------------------------- Sample data ---------------------------- */
const SAMPLE = [
  { name: "Harbourside Events", company: "Harbourside Events Ltd", email: "accounts@harbourside.co", segment: "viper-current", billingStatus: "not-up-to-date", stage: "need-to-contact", tags: ["price-pending"], amount: 480, billingDay: 1, cadence: "monthly", currency: "USD", createdAt: monthsAgo(8), payments: [{ date: monthsAgo(2, 3), amount: 480 }], notes: "Promised payment after their summer program — chase if nothing by mid-month." },
  { name: "Marina Bay Group", company: "Marina Bay Group", email: "finance@marinabay.com", phone: "+1 435 555 0110", segment: "maritz-portal", billingStatus: "current-pricing", stage: "up-to-date", tags: ["vip"], amount: 950, billingDay: 5, cadence: "monthly", currency: "USD", createdAt: monthsAgo(14), payments: [{ date: iso(), amount: 950 }, { date: monthsAgo(1), amount: 950 }] },
  { name: "Cannes Lettings Ltd", company: "Cannes Lettings", email: "hello@canneslettings.fr", segment: "maritz-portal", billingStatus: "not-up-to-date", stage: "not-contacted", tags: [], amount: 3600, billingDay: 3, cadence: "annual", currency: "EUR", createdAt: monthsAgo(26), payments: [{ date: monthsAgo(14, 3), amount: 3600 }], emailStatus: "bounced" },
  { name: "Dickey & Co", company: "Dickey & Co", email: "billing@dickeyco.uk", segment: "viper-current", billingStatus: "current-pricing", stage: "up-to-date", tags: [], amount: 320, billingDay: 28, cadence: "monthly", currency: "GBP", createdAt: monthsAgo(6), payments: [{ date: monthsAgo(1, 27), amount: 320 }] },
  { name: "Newquay Coast Rentals", company: "Newquay Coast Rentals", email: "team@newquaycoast.co.uk", segment: "maritz-portal", billingStatus: "old-pricing", stage: "contacted-awaiting", tags: ["price-pending"], amount: 275, billingDay: 15, cadence: "monthly", currency: "USD", createdAt: monthsAgo(20), payments: [{ date: monthsAgo(0, 14), amount: 275 }], followUp: iso() },
  { name: "Antibes Villas", company: "Antibes Villas SARL", email: "pay@antibesvillas.fr", segment: "maritz-portal", billingStatus: "payment-failed", stage: "need-to-contact", tags: ["email-bouncing", "needs-contact-info"], amount: 640, billingDay: 10, cadence: "monthly", currency: "USD", createdAt: monthsAgo(9), payments: [{ date: monthsAgo(3, 9), amount: 640 }], emailStatus: "bounced" },
  { name: "Old Pier Studios", company: "Old Pier Studios", email: "admin@oldpier.co.uk", segment: "viper-past", billingStatus: "marked-deletion", stage: "marked-deletion", tags: [], amount: 180, billingDay: 20, cadence: "monthly", currency: "USD", createdAt: monthsAgo(30) },
];

function normalise(r) {
  return {
    id: r.id || uid(),
    chargeoverId: (r.chargeoverId || "").toString().trim(),
    name: (r.name || "").trim(),
    company: (r.company || r.name || "").trim(),
    email: (r.email || "").trim(),
    phone: (r.phone || "").trim(),
    // "maritz-viper-portal" was retired into "maritz-portal" — remap lingering rows
    segment: SEGMENTS[r.segment] ? r.segment : (r.segment === "maritz-viper-portal" ? "maritz-portal" : "viper-current"),
    billingStatus: BILLING[r.billingStatus] ? r.billingStatus : "never-charged",
    stage: STAGES[r.stage] ? r.stage : "not-contacted",
    tags: Array.isArray(r.tags) ? r.tags.filter((t) => TAGS[t]) : [],
    amount: Number(r.amount) || 0,
    billingDay: Math.min(28, Math.max(1, Number(r.billingDay) || 1)),
    cadence: CADENCE[r.cadence] ? r.cadence : "monthly",
    currency: SYMBOL[r.currency] ? r.currency : "",
    coBalance: r.coBalance != null ? Number(r.coBalance) || 0 : null, // live from ChargeOver, null = never synced
    // Field-absent (undefined) means this record predates inChargeOver and was
    // never explicitly set — infer true from having a ChargeOver ID rather than
    // silently defaulting to false, so an old cached client state can't wipe it.
    inChargeOver: r.inChargeOver === undefined ? !!(r.chargeoverId && String(r.chargeoverId).trim()) : !!r.inChargeOver,
    workflowHidden: !!r.workflowHidden,
    maritzPortal: !!r.maritzPortal,
    viperCustomer: !!r.viperCustomer,
    portalUrl: (r.portalUrl || "").trim(),
    adminUrl: (r.adminUrl || "").trim(),
    portalUser: (r.portalUser || "").trim(),
    portalPassword: r.portalPassword || "",
    formerCustomer: !!r.formerCustomer,
    userLists: Array.isArray(r.userLists) ? r.userLists : [], // captured portal employee lists, dated for change-tracking
    multiOffice: !!r.multiOffice, // part of a multi-office group (e.g. a "Destination Asia" office)
    officeGroup: (r.officeGroup || "").trim(), // the group brand that links offices together
    priceMode: r.priceMode === "group" ? "group" : "per-office", // per-office billing vs one group price
    // Maritz portal per-company billing choices (prices themselves are global in settings)
    maritzBilling: { cadence: r.maritzBilling?.cadence === "annual" ? "annual" : "monthly", includeSetup: !!r.maritzBilling?.includeSetup },
    lastPaid: (r.lastPaid || "").trim(),
    payments: Array.isArray(r.payments) ? r.payments : [],
    emailStatus: ["bounced", "undelivered"].includes(r.emailStatus) ? r.emailStatus : "ok",
    secondaryContacts: Array.isArray(r.secondaryContacts) ? r.secondaryContacts : [],
    archivedContacts: r.archivedContacts || [],
    candidates: r.candidates || [],
    reminders: r.reminders || {},
    // Notes are dated cards; a legacy `notes` string migrates into the first card once.
    noteCards: Array.isArray(r.noteCards) ? r.noteCards
      : ((r.notes || "").trim() ? [{ id: uid(), at: r.createdAt || iso(), by: "", text: r.notes.trim() }] : []),
    notes: "",
    followUp: r.followUp || "",
    activity: Array.isArray(r.activity) ? r.activity : [],
    createdAt: r.createdAt || iso(),
    archivedClient: !!r.archivedClient,
  };
}

/* ------------------- Claude bounce-recovery lookup ------------------- */
async function findAlternativeContact(client) {
  const r = await fetch("/api/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: client.name, company: client.company, email: client.email }),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { window.location.href = "/login"; return []; }
  if (!r.ok) throw new Error(d.error || "Lookup failed — try again in a moment.");
  return Array.isArray(d.candidates) ? d.candidates : [];
}

/* ------------------------------ Export ------------------------------ */
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}
function exportCsv(clients) {
  const cols = ["chargeoverId", "name", "company", "email", "phone", "segment", "billingStatus", "stage", "tags", "amount", "currency", "cadence", "billingDay", "lastPaid", "periodsBehind", "totalOwed", "followUp", "notes", "emailStatus"];
  const rows = clients.map((c) => cols.map((k) => {
    let v = k === "tags" ? c.tags.join("|") : k === "periodsBehind" ? arrearsPeriods(c) : k === "totalOwed" ? totalOwed(c) : k === "lastPaid" ? (lastPaymentDate(c) ? iso(lastPaymentDate(c)) : "") : k === "notes" ? (c.noteCards || []).map((n) => n.text).join(" | ") : c[k] ?? "";
    v = String(v);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(","));
  download(`viper-clients-${iso()}.csv`, [cols.join(","), ...rows].join("\n"), "text/csv");
}

/* =============================== App =============================== */
export default function CRM({ user }) {
  const [clients, setClients] = useState([]);
  const [settings, setSettings] = useState({
    currency: "USD", businessName: "VIPER", senderName: "Darryl", emailTemplates: {},
    // Global pricing — edited on any Viper/Maritz card, applies to every card of that type.
    viperPricing: { base: 300, tier2: 90, tier3: 80, tier2Min: 4, tier3Min: 10 },
    maritzPricing: { monthly: 40, annual: 400, setupFee: 140 },
    maritzGroupPricing: {}, // per office-group: { [group]: { singleOffice, group } }
  });
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [tab, setTab] = useState("digest");
  const [modal, setModal] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [composeId, setComposeId] = useState(null);
  const [composeType, setComposeType] = useState("reminder");
  const [toast, setToast] = useState("");

  const templates = useMemo(() => getTemplates(settings), [settings]);

  const showToast = useCallback((msg) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // shared by the Comms tab and the per-row email compose dialog
  const logSent = useCallback((id, key, patch, label) => {
    setClients((p) => p.map((c) => {
      if (c.id !== id) return c;
      const reminders = { ...(c.reminders || {}) };
      reminders[key] = { ...(reminders[key] || {}), ...patch };
      const activity = patch.sentAt ? logActivity(c, "email", `${label} marked sent`) : c.activity;
      return { ...c, reminders, activity };
    }));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/state");
        if (r.status === 401) { window.location.href = "/login"; return; }
        const d = await r.json();
        if (Array.isArray(d.clients)) setClients(d.clients.map(normalise));
        if (d.settings) setSettings((s) => ({
          ...s, ...d.settings,
          viperPricing: { ...s.viperPricing, ...(d.settings.viperPricing || {}) },
          maritzPricing: { ...s.maritzPricing, ...(d.settings.maritzPricing || {}) },
          maritzGroupPricing: d.settings.maritzGroupPricing || {},
        }));
      } catch (e) { /* first run / offline — start empty */ }
      finally { setLoaded(true); }
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    setSaveState("saving");
    const t = setTimeout(async () => {
      try {
        const r = await fetch("/api/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clients, settings }),
        });
        if (r.status === 401) { window.location.href = "/login"; return; }
        setSaveState(r.ok ? "saved" : "error");
      } catch { setSaveState("error"); }
    }, 600);
    return () => clearTimeout(t);
  }, [clients, settings, loaded]);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  const active = useMemo(() => clients.filter((c) => !c.archivedClient), [clients]);
  const bounced = active.filter((c) => c.emailStatus !== "ok");

  const addClients = useCallback((rows) => {
    setClients((prev) => {
      const byKey = new Map(prev.map((c) => [c.chargeoverId || (c.email || "").toLowerCase() || c.id, c]));
      for (const r of rows) {
        const clean = normalise(r);
        if (!clean.name && !clean.email) continue;
        const key = clean.chargeoverId || clean.email.toLowerCase();
        if (key && byKey.has(key)) {
          const ex = byKey.get(key);
          Object.assign(ex, clean, { id: ex.id, reminders: ex.reminders, archivedContacts: ex.archivedContacts, candidates: ex.candidates, activity: ex.activity, payments: clean.payments.length ? clean.payments : ex.payments, noteCards: clean.noteCards.length ? [...clean.noteCards, ...(ex.noteCards || [])] : ex.noteCards });
        } else byKey.set(key || clean.id, clean);
      }
      return Array.from(byKey.values());
    });
  }, []);
  const update = useCallback((id, patch) => setClients((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))), []);
  const updateWithLog = useCallback((id, patch, type, text) => {
    setClients((p) => p.map((c) => (c.id === id ? { ...c, ...patch, activity: logActivity(c, type, text) } : c)));
  }, []);

  const applyContact = useCallback((id, cand) => {
    setClients((p) => p.map((c) => {
      if (c.id !== id) return c;
      const archived = [...(c.archivedContacts || [])];
      if (c.email) archived.push({ email: c.email, phone: c.phone, archivedAt: new Date().toISOString(), reason: "bounced — replaced" });
      const tags = c.tags.filter((t) => !["email-bouncing", "needs-contact-info", "contact-found"].includes(t));
      return { ...c, email: cand.email || c.email, phone: cand.phone || c.phone, emailStatus: "ok", archivedContacts: archived, candidates: [], tags, activity: logActivity(c, "contact", `Contact replaced: ${c.email} → ${cand.email} (${cand.source})`) };
    }));
  }, []);
  const recordPayment = useCallback((id, amount, date) => {
    setClients((p) => p.map((c) => {
      if (c.id !== id) return c;
      const payments = [{ date, amount: Number(amount) || 0 }, ...(c.payments || [])];
      return { ...c, payments, lastPaid: date, activity: logActivity(c, "payment", `Payment recorded: ${money(amount, c.currency || settings.currency)} on ${fmtDate(date)}`) };
    }));
  }, [settings.currency]);

  const [sync, setSync] = useState({ busy: false, msg: "" });
  const syncNow = async () => {
    setSync({ busy: true, msg: "" });
    try {
      const r = await fetch("/api/sync/chargeover", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setSync({ busy: false, msg: d.error || "Sync failed." }); return; }
      const sr = await fetch("/api/state");
      const sd = await sr.json();
      if (Array.isArray(sd.clients)) setClients(sd.clients.map(normalise));
      setSync({ busy: false, msg: `ChargeOver synced: ${d.added} added, ${d.updated} updated (${d.customers} customers).` });
    } catch {
      setSync({ busy: false, msg: "Sync failed — try again." });
    }
  };

  if (!loaded) return <div className="flex items-center justify-center" style={{ background: C.paper, minHeight: "100vh", fontFamily: SANS, color: C.sub }}><span style={{ fontSize: 14 }}>Loading your CRM…</span></div>;

  const detail = clients.find((c) => c.id === detailId);
  const compose = clients.find((c) => c.id === composeId);

  return (
    <div style={{ background: C.paper, minHeight: "100vh", fontFamily: SANS, color: C.ink, display: "flex" }}>
      {/* Left navigation panel */}
      <aside style={{ width: 194, flexShrink: 0, backgroundColor: C.panel, backgroundImage: "linear-gradient(to bottom, rgba(255,255,255,1) 0%, rgba(255,255,255,1) 45%, rgba(255,255,255,0) 90%), linear-gradient(rgba(255,255,255,0.82), rgba(255,255,255,0.82)), url(/menu-bg.jpg)", backgroundSize: "cover", backgroundPosition: "center", borderRight: `1px solid ${C.line}`, padding: "22px 12px", display: "flex", flexDirection: "column", gap: 3, position: "sticky", top: 0, height: "100vh" }}>
        <div style={{ padding: "0 6px 20px" }}><Wordmark size={22} /></div>
        <MenuItem icon="add" onClick={() => setModal("add")}>Add client</MenuItem>
        <MenuItem icon="recovery" onClick={() => setTab("recovery")} active={tab === "recovery"}>{`Contact recovery${bounced.length ? ` · ${bounced.length}` : ""}`}</MenuItem>
        <MenuItem icon="mail" onClick={() => setModal("emails")}>Email templates</MenuItem>
        <MenuItem icon="settings" onClick={() => setModal("settings")}>Settings</MenuItem>
        {user.role === "admin" && <MenuItem icon="sync" onClick={syncNow}>{sync.busy ? "Syncing…" : "Sync ChargeOver"}</MenuItem>}
        <MenuItem icon="users" onClick={() => setModal("users")}>{user.role === "admin" ? "Users" : "My account"}</MenuItem>
        <div style={{ marginTop: "auto", paddingTop: 12, borderTop: `1px solid ${C.lineSoft}` }}>
          <div style={{ fontSize: 12, color: C.sub, padding: "0 6px 6px" }}>{user.name || user.email}</div>
          <MenuItem icon="signout" onClick={logout}>Sign out</MenuItem>
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0 }}>
      <div className="mx-auto w-full" style={{ maxWidth: 1180, padding: "clamp(16px, 3vw, 30px)" }}>
        <header style={{ marginBottom: 14 }}>
          <h1 style={{ fontFamily: DISPLAY, fontSize: 20, fontWeight: 600, letterSpacing: "0.01em" }}>Client Billing CRM</h1>
          {sync.msg && <p style={{ fontSize: 12.5, color: C.sub, marginTop: 8 }}>{sync.msg}</p>}
        </header>

        <StatStrip clients={active} settings={settings} bounced={bounced.length} />

        {/* Tab row — actions live on the same line, right-aligned */}
        <nav className="flex items-end" style={{ gap: 3, marginBottom: 16, flexWrap: "wrap", borderBottom: `1px solid ${C.line}` }}>
          {[["digest", "Today"], ["clients", "Clients"], ["workflow", "Workflow"], ["comms", "Emails"]].map(([k, t]) => (
            <Tab key={k} active={tab === k} onClick={() => setTab(k)}>{t}</Tab>
          ))}
          <div className="flex items-center" style={{ gap: 8, marginLeft: "auto", paddingBottom: 6 }}>
            <MiniBtn solid onClick={() => setModal("import")}>Import CSV</MiniBtn>
            <MiniBtn onClick={() => exportCsv(active)}>Export CSV</MiniBtn>
            <span style={{ fontSize: 12, color: saveState === "error" ? C.red : C.faint, minWidth: 56, textAlign: "right" }}>
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : ""}
            </span>
          </div>
        </nav>

        {clients.length === 0 ? (
          <EmptyState onImport={() => setModal("import")} onSample={() => addClients(SAMPLE)} />
        ) : (
          <>
            {tab === "clients" && <ClientsTab clients={clients} settings={settings} templates={templates} onOpen={setDetailId} onEmail={(id, type) => { setComposeId(id); setComposeType(type || "reminder"); }} onUpdate={update} onUpdateWithLog={updateWithLog} />}
            {tab === "workflow" && <WorkflowTab clients={active} onOpen={setDetailId} onStage={(id, stage) => updateWithLog(id, { stage }, "stage", `Stage → ${STAGES[stage].label}`)} onUpdate={update} />}
            {tab === "recovery" && <RecoveryTab bounced={bounced} onApply={applyContact} onUpdate={update} onOpen={setDetailId} />}
            {tab === "comms" && <CommsTab clients={active} settings={settings} templates={templates} onLogSent={logSent} onOpen={setDetailId} onSent={showToast} />}
            {tab === "digest" && <DigestTab clients={active} settings={settings} bounced={bounced.length} onGo={setTab} onOpen={setDetailId} />}
          </>
        )}

        <p style={{ color: C.faint, fontSize: 12, marginTop: 16, lineHeight: 1.5 }}>
          Billing status and payments sync from ChargeOver in production (match key: ChargeOver ID, falling back to email).
          Reminders escalate automatically with periods behind. Export to CSV regularly for a spreadsheet copy.
        </p>
        <p style={{ color: C.faint, fontSize: 11.5, marginTop: 10, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
          © 2026 ViperPro · VIP Event Resources · Software solutions for DMCs and the Meetings & Events industry · sales@vipeventresources.com · +1 435 901 2634
        </p>
      </div>
      </main>

      {detail && <DetailDrawer client={detail} settings={settings} onClose={() => setDetailId(null)} onUpdate={update} onUpdateWithLog={updateWithLog} onRecordPayment={recordPayment} onDelete={(id) => { setClients((p) => p.filter((c) => c.id !== id)); setDetailId(null); }}
        onUpdateSettings={(patch) => setSettings((s) => ({ ...s, ...patch }))} currentUser={user}
        officeSiblings={detail.officeGroup ? clients.filter((c) => c.id !== detail.id && c.officeGroup === detail.officeGroup) : []} onOpen={setDetailId} />}
      {compose && <ComposeModal client={compose} settings={settings} templates={templates} initialType={composeType} onClose={() => setComposeId(null)} onLogSent={logSent} onSent={showToast} />}
      {modal === "import" && <Modal title="Import clients" onClose={() => setModal(null)}><ImportPanel onImport={(r) => { addClients(r); setModal(null); }} onSample={() => { addClients(SAMPLE); setModal(null); }} /></Modal>}
      {modal === "add" && <Modal title="Add client" onClose={() => setModal(null)}><AddPanel onAdd={(r) => { addClients([r]); setModal(null); }} /></Modal>}
      {modal === "settings" && <Modal title="Settings" onClose={() => setModal(null)}><SettingsPanel settings={settings} onSave={(s) => { setSettings(s); setModal(null); }} /></Modal>}
      {modal === "emails" && <Modal title="Email templates" onClose={() => setModal(null)}><EmailTemplatesPanel settings={settings} onSave={setSettings} /></Modal>}
      {modal === "users" && <Modal wide title={user.role === "admin" ? "User management" : "My account"} onClose={() => setModal(null)}><UsersAdmin me={user} embedded /></Modal>}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: C.ink, color: "#fff", fontSize: 13.5, fontWeight: 600, padding: "12px 20px", borderRadius: 10, boxShadow: "0 12px 32px rgba(34,48,76,0.35)", zIndex: 100 }}>
          ✓ {toast}
        </div>
      )}
    </div>
  );
}

// Brand-blue nav glyphs — one per left-menu heading.
function MenuIcon({ name, color }) {
  const p = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", style: { flexShrink: 0 } };
  switch (name) {
    case "add": return <svg {...p}><path d="M12 5v14M5 12h14" /></svg>;
    case "recovery": return <svg {...p}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>;
    case "mail": return <svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>;
    case "settings": return <svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;
    case "sync": return <svg {...p}><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>;
    case "users": return <svg {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
    case "signout": return <svg {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>;
    default: return null;
  }
}
// Left-panel menu button
function MenuItem({ onClick, active, icon, children }) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = C.lineSoft; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
      style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", fontSize: 13.5, fontWeight: 600, color: active ? C.action : C.ink, background: active ? C.lineSoft : "transparent", border: "none", borderRadius: 8, padding: "9px 10px", cursor: "pointer" }}
    >
      {icon && <MenuIcon name={icon} color={C.action} />}
      <span>{children}</span>
    </button>
  );
}

// One email, fully editable, three ways out: copy, real Brevo send, or mark
// sent (for mails sent elsewhere). Shared by the Comms tab and the per-row dialog.
function EmailEditor({ client, settings, type, templates, onLogSent, onDone, onSent }) {
  const tpl = templates[type] || templates.custom;
  const key = `${type}:${periodKey()}`;
  const saved = (client.reminders && client.reminders[key]) || {};
  const subject = saved.subject ?? tpl.subject(client, settings);
  const body = saved.body ?? tpl.body(client, settings);
  const [copied, setCopied] = useState(false);
  const [send, setSend] = useState({ busy: false, err: "" });
  const copy = () => { navigator.clipboard?.writeText(`From: ${FROM_EMAIL}\nSubject: ${subject}\n\n${body}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }); };
  const markSent = (via) => onLogSent(client.id, key, { sentAt: new Date().toISOString(), via, subject, body, label: tpl.label }, tpl.label);
  const sendNow = async () => {
    setSend({ busy: true, err: "" });
    try {
      const r = await fetch("/api/comms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: client.email, name: client.name, subject, body }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setSend({ busy: false, err: d.error || "Send failed." }); return; }
      markSent("brevo");
      setSend({ busy: false, err: "" });
      onSent?.(`Sent to ${client.company || client.name}`);
      onDone?.();
    } catch { setSend({ busy: false, err: "Send failed — try again." }); }
  };
  return (
    <div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="To"><div style={{ fontFamily: MONO, fontSize: 13, color: client.email ? C.ink : C.red, padding: "9px 11px", background: C.lineSoft, borderRadius: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{client.email || "No email on file — add one first"}</div></Field>
        <Field label="From"><div style={{ fontFamily: MONO, fontSize: 13, color: C.sub, padding: "9px 11px", background: C.lineSoft, borderRadius: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{FROM_EMAIL}</div></Field>
      </div>
      <Field label="Subject"><input style={inputStyle} value={subject} onChange={(e) => onLogSent(client.id, key, { subject: e.target.value })} /></Field>
      <Field label="Message"><textarea rows={11} style={{ ...inputStyle, fontFamily: SANS, lineHeight: 1.5, resize: "vertical" }} value={body} onChange={(e) => onLogSent(client.id, key, { body: e.target.value })} /></Field>
      <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
        <button onClick={sendNow} disabled={!client.email || send.busy} style={{ fontSize: 13, fontWeight: 600, padding: "9px 16px", borderRadius: 8, border: "none", background: !client.email || send.busy ? C.grey : C.action, color: "#fff", cursor: !client.email || send.busy ? "default" : "pointer" }}>
          {send.busy ? "Sending…" : saved.sentAt ? "Send again" : "Send via Brevo"}
        </button>
        <GhostBtn onClick={copy}>{copied ? "Copied ✓" : "Copy"}</GhostBtn>
        <GhostBtn onClick={() => { markSent("manual"); onDone?.(); }}>Mark sent</GhostBtn>
        {saved.sentAt && <span style={{ fontSize: 12, color: C.green, fontWeight: 600 }}>✓ Sent {fmtDate(saved.sentAt)}{saved.via === "brevo" ? " · Brevo" : ""}</span>}
        {send.err && <span style={{ fontSize: 12, color: C.red }}>{send.err}</span>}
      </div>
    </div>
  );
}

// Per-client email compose dialog (opened from the list's email icon menu,
// pre-set to whichever template was picked there).
function ComposeModal({ client, settings, templates, initialType, onClose, onLogSent, onSent }) {
  const [type, setType] = useState(initialType || "reminder");
  return (
    <Modal title={`Email · ${client.company || client.name}`} onClose={onClose}>
      <Field label="Template"><MiniSelect value={type} onChange={setType} options={Object.entries(templates).map(([k, v]) => [k, v.label])} /></Field>
      <EmailEditor key={`${client.id}:${type}`} client={client} settings={settings} type={type} templates={templates} onLogSent={onLogSent} onDone={onClose} onSent={onSent} />
    </Modal>
  );
}

/* ---------------------------- Stat strip ---------------------------- */
function StatStrip({ clients, settings, bounced }) {
  const s = useMemo(() => {
    const owedByCur = {}; let overdue = 0, mrr = 0, mrrKnown = 0, notUpToDate = 0, followUps = 0, synced = 0;
    const now = new Date();
    for (const c of clients) {
      const cur = c.currency || settings.currency;
      // Prefer ChargeOver's own balance (live from last sync) over the
      // periods×amount estimate — that estimate is only as good as `amount`,
      // which most imported clients don't have set.
      if (c.coBalance != null) {
        synced++;
        if (c.coBalance > 0) { overdue++; owedByCur[cur] = (owedByCur[cur] || 0) + c.coBalance; }
      } else {
        const behind = periodsBehind(c, now);
        if (behind >= 1) { overdue++; owedByCur[cur] = (owedByCur[cur] || 0) + behind * (Number(c.amount) || 0); }
      }
      if (!["marked-deletion", "never-charged"].includes(c.billingStatus) && c.stage !== "marked-deletion") {
        mrr += monthlyValue(c);
        if (Number(c.amount) > 0) mrrKnown++;
      }
      if (["not-up-to-date", "payment-failed"].includes(c.billingStatus)) notUpToDate++;
      if (needsFollowUp(c, now)) followUps++;
    }
    const owedStr = Object.entries(owedByCur).map(([cur, v]) => money(v, cur)).join(" + ") || money(0, settings.currency);
    return { owedStr, overdue, mrr, mrrKnown, notUpToDate, followUps, synced, total: clients.length };
  }, [clients, settings.currency]);
  return (
    <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginBottom: 14 }}>
      <Stat label="Not up to date" value={String(s.notUpToDate)} sub="per ChargeOver status" accent={s.notUpToDate ? C.red : C.green} />
      <Stat label="Total owed" value={s.owedStr} sub={s.synced ? `${s.overdue} in arrears · ${s.synced}/${s.total} synced` : `${s.overdue} in arrears (run Sync)`} accent={C.red} small={s.owedStr.length > 12} />
      <Stat label="Monthly recurring revenue" value={money(Math.round(s.mrr), settings.currency)} sub={`from ChargeOver · ${s.mrrKnown}/${s.total} known`} accent={C.green} />
      <Stat label="Follow-ups" value={String(s.followUps)} sub="to contact / awaiting reply" accent={s.followUps ? C.amber : C.green} />
      <Stat label="Bounced" value={String(bounced)} sub="contacts to recover" accent={bounced ? C.red : C.green} />
    </section>
  );
}
function Stat({ label, value, sub, accent, small }) {
  return (
    <div style={{ background: C.panel, borderRadius: 10, border: `1px solid ${C.line}`, padding: "8px 10px" }}>
      <div className="flex items-center" style={{ gap: 5, marginBottom: 4 }}>
        <span style={{ width: 5, height: 5, borderRadius: 5, background: accent, flexShrink: 0 }} />
        <span style={{ fontSize: 9, letterSpacing: "0.05em", textTransform: "uppercase", color: C.sub, fontWeight: 600 }}>{label}</span>
      </div>
      <div style={{ fontSize: small ? 12.5 : 16, fontWeight: 600, fontFamily: MONO, letterSpacing: "-0.02em", lineHeight: 1.25 }}>{value}</div>
      <div style={{ fontSize: 10, color: C.faint, marginTop: 1 }}>{sub}</div>
    </div>
  );
}

/* ---------------------------- Clients tab ---------------------------- */
// A funnel icon that appears when a column filter is active.
function Funnel({ color }) {
  return <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden><path d="M3 5h18l-7 8v5l-4 2v-7z" fill={color} /></svg>;
}
// A column heading that IS a filter dropdown. Shows a funnel + turns accent-coloured when active.
function HeaderFilter({ label, value, onChange, options, align = "left" }) {
  const active = value !== "all";
  const justify = align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, justifyContent: justify }}>
      {active && (
        <button onClick={() => onChange("all")} title="Clear this filter" style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex" }}>
          <Funnel color={C.action} />
        </button>
      )}
      <select value={value} onChange={(e) => onChange(e.target.value)} title="Filter this column"
        style={{ maxWidth: "100%", fontSize: 10.5, letterSpacing: "0.04em", textTransform: "uppercase", fontWeight: active ? 700 : 600,
          color: active ? C.action : C.sub, background: "transparent", border: "none", cursor: "pointer", outline: "none", padding: 0,
          appearance: "none", WebkitAppearance: "none", MozAppearance: "none", textAlignLast: align === "right" ? "right" : align === "center" ? "center" : "left" }}>
        <option value="all">{label}</option>
        {options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      <span style={{ fontSize: 10, color: active ? C.action : C.sub, pointerEvents: "none" }}>▾</span>
    </div>
  );
}

// Mail icon → small popover menu to pick which template to send before the
// compose dialog opens, instead of always defaulting to "Payment reminder".
function EmailIconMenu({ client, templates, onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-block" }} onClick={(e) => e.stopPropagation()}>
      <button onClick={() => setOpen((v) => !v)} title="Email this client" aria-label={`Email ${client.company || client.name}`}
        style={{ background: "none", border: "none", cursor: "pointer", color: C.action, padding: 4, display: "inline-flex", borderRadius: 6 }}
        onMouseEnter={(e) => (e.currentTarget.style.background = C.lineSoft)} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{ position: "absolute", right: 0, top: "100%", marginTop: 4, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(34,48,76,0.18)", zIndex: 41, minWidth: 190, overflow: "hidden" }}>
            {Object.entries(templates).map(([k, v]) => (
              <button key={k} onClick={() => { onPick(k); setOpen(false); }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", fontSize: 12.5, fontWeight: 500, background: "none", border: "none", cursor: "pointer", color: C.ink }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.lineSoft)} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                {v.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// A dot + compact select for an editable yes/no client field (In ChargeOver,
// Maritz Portal, Viper Customer, …) — same look everywhere it's used.
function BoolCell({ value, onChange, trueLabel, falseLabel, title }) {
  return (
    <div className="flex items-center" style={{ gap: 6, minWidth: 0, justifyContent: "center" }} onClick={(e) => e.stopPropagation()}>
      <span style={{ width: 6, height: 6, borderRadius: 6, background: value ? C.green : C.faint, flexShrink: 0 }} />
      <select value={value ? "yes" : "no"} onChange={(e) => onChange(e.target.value === "yes")}
        title={title} style={{ fontSize: 12, fontWeight: 600, color: value ? C.green : C.faint, background: "transparent", border: "none", cursor: "pointer", outline: "none", padding: "3px 0", maxWidth: "100%" }}>
        <option value="yes">{trueLabel}</option>
        <option value="no">{falseLabel}</option>
      </select>
    </div>
  );
}

function ClientsTab({ clients, settings, templates, onOpen, onEmail, onUpdate, onUpdateWithLog }) {
  const [seg, setSeg] = useState("all");
  const [bill, setBill] = useState("all");
  const [stage, setStage] = useState("all");
  const [co, setCo] = useState("all");
  const [mp, setMp] = useState("all");
  const [vc, setVc] = useState("all");
  const [owed, setOwed] = useState("all");
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const activeCount = [seg, bill, stage, co, mp, vc, owed].filter((v) => v !== "all").length + (q.trim() ? 1 : 0);
  const clearAll = () => { setSeg("all"); setBill("all"); setStage("all"); setCo("all"); setMp("all"); setVc("all"); setOwed("all"); setQ(""); };
  const list = useMemo(() => {
    let l = clients.filter((c) => (showArchived ? c.archivedClient : !c.archivedClient));
    if (seg !== "all") l = l.filter((c) => c.segment === seg);
    if (bill !== "all") l = l.filter((c) => c.billingStatus === bill);
    if (stage !== "all") l = l.filter((c) => c.stage === stage);
    if (co !== "all") l = l.filter((c) => (co === "yes" ? !!c.inChargeOver : !c.inChargeOver));
    if (mp !== "all") l = l.filter((c) => (mp === "yes" ? !!c.maritzPortal : !c.maritzPortal));
    if (vc !== "all") l = l.filter((c) => (vc === "yes" ? !!c.viperCustomer : !c.viperCustomer));
    if (owed !== "all") l = l.filter((c) => (owed === "overdue" ? arrearsPeriods(c) >= 1 : arrearsPeriods(c) === 0));
    if (q.trim()) {
      const k = q.toLowerCase();
      l = l.filter((c) =>
        c.name.toLowerCase().includes(k) || (c.email || "").toLowerCase().includes(k) ||
        (c.company || "").toLowerCase().includes(k) || (c.chargeoverId || "").toLowerCase().includes(k) ||
        (c.archivedContacts || []).some((a) => (a.email || "").toLowerCase().includes(k)));
    }
    return [...l].sort((a, b) => arrearsPeriods(b) - arrearsPeriods(a) || a.name.localeCompare(b.name));
  }, [clients, seg, bill, stage, co, mp, vc, owed, q, showArchived]);
  const totalActive = clients.filter((c) => !c.archivedClient).length;
  const gridCols = "1.3fr 0.95fr 0.75fr 1fr 1fr 1fr 0.9fr 40px";
  return (
    <div>
      <div className="flex flex-wrap items-center" style={{ gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 12.5, color: C.sub }}>
          {list.length} of {totalActive}
          {activeCount > 0 && <span style={{ color: C.action, fontWeight: 600 }}> · {activeCount} filter{activeCount > 1 ? "s" : ""} active</span>}
        </span>
        {activeCount > 0 && <button onClick={clearAll} style={{ fontSize: 12, fontWeight: 600, color: C.action, background: "none", border: "none", cursor: "pointer" }}>Clear filters</button>}
        <label className="flex items-center" style={{ gap: 6, fontSize: 12.5, color: C.sub, cursor: "pointer", marginLeft: "auto" }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived
        </label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" title="Searches name, company, email, old emails and ChargeOver ID"
          style={{ fontSize: 13, padding: "8px 12px", borderRadius: 8, border: `1px solid ${q.trim() ? C.action : C.line}`, background: C.panel, outline: "none", minWidth: 320 }} />
      </div>
      <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 16px", background: C.lineSoft, borderBottom: `1px solid ${C.line}`, display: "grid", gridTemplateColumns: gridCols, gap: 20, alignItems: "center" }}>
          <HeaderFilter label="Client" value={seg} onChange={setSeg} options={Object.entries(SEGMENTS).map(([k, v]) => [k, v.label])} />
          <HeaderFilter label="Billing" value={bill} onChange={setBill} align="center" options={Object.entries(BILLING).map(([k, v]) => [k, v.label])} />
          <HeaderFilter label="Stage" value={stage} onChange={setStage} align="center" options={STAGE_ORDER.map((k) => [k, STAGES[k].label])} />
          <HeaderFilter label="In ChargeOver" value={co} onChange={setCo} align="center" options={[["yes", "Yes"], ["no", "No"]]} />
          <HeaderFilter label="Maritz Portal" value={mp} onChange={setMp} align="center" options={[["yes", "Yes"], ["no", "No"]]} />
          <HeaderFilter label="Viper Customer" value={vc} onChange={setVc} align="center" options={[["yes", "Yes"], ["no", "No"]]} />
          <HeaderFilter label="Owed / rate" value={owed} onChange={setOwed} align="right" options={[["overdue", "Overdue"], ["current", "Up to date"]]} />
          <span />
        </div>
        {list.map((c) => {
          const behind = arrearsPeriods(c);
          const cur = c.currency || settings.currency;
          return (
            <div key={c.id} role="button" tabIndex={0} onClick={() => onOpen(c.id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(c.id); }} style={{ borderBottom: `1px solid ${C.lineSoft}`, cursor: "pointer", padding: "11px 16px", display: "grid", gridTemplateColumns: gridCols, gap: 20, alignItems: "center", opacity: c.archivedClient ? 0.55 : 1 }}>
              <div style={{ minWidth: 0 }}>
                <div className="flex items-center" style={{ gap: 7, flexWrap: "wrap" }}>
                  <span style={{ width: 6, height: 6, borderRadius: 6, background: SEGMENTS[c.segment].color, flexShrink: 0 }} />
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{c.company || c.name}</span>
                  {c.emailStatus !== "ok" && <MiniPill fg={C.red} bg={C.redBg}>bounced</MiniPill>}
                  {followUpDue(c) && <MiniPill fg={C.amber} bg={C.amberBg}>follow up</MiniPill>}
                  {behind >= 3 && <MiniPill fg="#fff" bg={C.red}>final notice</MiniPill>}
                </div>
                {(c.name || c.chargeoverId) && <div style={{ fontSize: 12, color: C.sub, fontFamily: MONO, marginTop: 2 }}>{c.name}{c.name && c.chargeoverId ? " · " : ""}{c.chargeoverId ? `CO#${c.chargeoverId}` : ""}</div>}
              </div>
              <div style={{ display: "flex", justifyContent: "center", minWidth: 0 }}>
                <select value={c.billingStatus} onClick={(e) => e.stopPropagation()} onChange={(e) => onUpdate(c.id, { billingStatus: e.target.value })}
                  title="Billing status" style={{ fontSize: 11.5, fontWeight: 600, color: BILLING[c.billingStatus].color, background: BILLING[c.billingStatus].bg, border: "none", borderRadius: 20, padding: "3px 9px", cursor: "pointer", outline: "none", maxWidth: "100%" }}>
                  {Object.entries(BILLING).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", justifyContent: "center", minWidth: 0 }}>
                <select value={c.stage} onClick={(e) => e.stopPropagation()} onChange={(e) => onUpdateWithLog(c.id, { stage: e.target.value }, "stage", `Stage → ${STAGES[e.target.value].label}`)}
                  title="Workflow stage" style={{ fontSize: 12.5, fontWeight: 600, color: STAGES[c.stage].color, background: "transparent", border: "none", cursor: "pointer", outline: "none", padding: "3px 0", maxWidth: "100%", textAlignLast: "center" }}>
                  {STAGE_ORDER.map((k) => <option key={k} value={k}>{STAGES[k].label}</option>)}
                </select>
              </div>
              <BoolCell value={c.inChargeOver} onChange={(v) => onUpdate(c.id, { inChargeOver: v })} trueLabel="In ChargeOver" falseLabel="Not in ChargeOver" title="In ChargeOver" />
              <BoolCell value={c.maritzPortal} onChange={(v) => onUpdate(c.id, { maritzPortal: v })} trueLabel="Maritz Portal" falseLabel="Not Maritz" title="Maritz Portal" />
              <BoolCell value={c.viperCustomer} onChange={(v) => onUpdate(c.id, { viperCustomer: v })} trueLabel="Viper Customer" falseLabel="Not Viper" title="Viper Customer" />
              <div style={{ textAlign: "right" }}>
                {behind >= 1
                  ? <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, color: C.red }}>{money(totalOwed(c), cur)}<span style={{ fontSize: 11, color: C.faint, fontWeight: 500 }}> · {behind}p</span></div>
                  : needsReminder(c)
                    ? <div style={{ fontFamily: MONO, fontSize: 13, color: C.red, fontWeight: 600 }}>balance due</div>
                    : <div style={{ fontFamily: MONO, fontSize: 13, color: C.green, fontWeight: 600 }}>current</div>}
                {Number(c.amount) > 0 && <div style={{ fontSize: 11, color: C.faint, fontFamily: MONO }}>{money(c.amount, cur)}/{c.cadence === "annual" ? "yr" : "mo"}</div>}
              </div>
              <div style={{ textAlign: "right" }}>
                <EmailIconMenu client={c} templates={templates} onPick={(type) => onEmail(c.id, type)} />
              </div>
            </div>
          );
        })}
        {list.length === 0 && <div style={{ padding: 32, textAlign: "center", color: C.sub, fontSize: 13 }}>No clients match these filters.</div>}
      </div>
    </div>
  );
}

/* --------------------------- Workflow tab --------------------------- */
function WorkflowTab({ clients, onOpen, onStage, onUpdate }) {
  const [showHidden, setShowHidden] = useState(false);
  const [dragOverStage, setDragOverStage] = useState(null);
  const hiddenCount = clients.filter((c) => c.workflowHidden).length;
  const visible = clients.filter((c) => (showHidden ? c.workflowHidden : !c.workflowHidden));

  const drop = (e, stage) => {
    e.preventDefault();
    setDragOverStage(null);
    const id = e.dataTransfer.getData("text/plain");
    if (id) onStage(id, stage);
  };

  return (
    <div>
      {(hiddenCount > 0 || showHidden) && (
        <label className="flex items-center" style={{ gap: 6, fontSize: 12.5, color: C.sub, cursor: "pointer", marginBottom: 12, width: "fit-content" }}>
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          {showHidden ? `Showing ${hiddenCount} removed from workflow` : `${hiddenCount} removed from workflow — show`}
        </label>
      )}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, alignItems: "start" }}>
        {STAGE_ORDER.map((stage) => {
          const col = visible.filter((c) => c.stage === stage);
          return (
            <div key={stage}
              onDragOver={(e) => { e.preventDefault(); if (dragOverStage !== stage) setDragOverStage(stage); }}
              onDragLeave={() => setDragOverStage((s) => (s === stage ? null : s))}
              onDrop={(e) => drop(e, stage)}
              style={{ background: C.panel, borderRadius: 12, border: `1px solid ${dragOverStage === stage ? C.action : C.line}`, overflow: "hidden" }}>
              <div style={{ padding: "10px 12px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ width: 8, height: 8, borderRadius: 8, background: STAGES[stage].color }} />
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>{STAGES[stage].label}</span>
                <span style={{ fontSize: 11, color: C.faint, marginLeft: "auto", fontFamily: MONO }}>{col.length}</span>
              </div>
              <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6, minHeight: 60 }}>
                {col.map((c) => (
                  <div key={c.id} draggable={!showHidden} onDragStart={(e) => e.dataTransfer.setData("text/plain", c.id)}
                    style={{ position: "relative", background: C.paper, borderRadius: 8, padding: "8px 10px", border: `1px solid ${followUpDue(c) ? C.amber : C.line}`, cursor: showHidden ? "default" : "grab" }}>
                    <button
                      onClick={() => onUpdate(c.id, { workflowHidden: !showHidden })}
                      title={showHidden ? "Add back to workflow" : "Remove from workflow"}
                      aria-label={showHidden ? "Add back to workflow" : "Remove from workflow"}
                      style={{ position: "absolute", top: 4, right: 4, background: "none", border: "none", color: C.faint, fontSize: 13, cursor: "pointer", lineHeight: 1, padding: 4, borderRadius: 6 }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = C.lineSoft)} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                      {showHidden ? "↺" : "✕"}
                    </button>
                    <button onClick={() => onOpen(c.id)} style={{ background: "none", border: "none", padding: 0, paddingRight: 16, cursor: "pointer", textAlign: "left", width: "100%" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{c.company || c.name}</div>
                      <div style={{ fontSize: 11, color: C.sub, fontFamily: MONO }}>{SEGMENTS[c.segment].label}{arrearsPeriods(c) ? ` · ${arrearsPeriods(c)}p behind` : ""}</div>
                      {c.followUp && <div style={{ fontSize: 10.5, color: followUpDue(c) ? C.amber : C.faint, marginTop: 2 }}>Follow up {fmtDate(c.followUp)}</div>}
                    </button>
                    {!showHidden && (
                      <select value={c.stage} onChange={(e) => onStage(c.id, e.target.value)}
                        style={{ marginTop: 6, width: "100%", fontSize: 11, padding: "4px 6px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.panel, color: C.sub, cursor: "pointer" }}>
                        {STAGE_ORDER.map((s) => <option key={s} value={s}>{STAGES[s].label}</option>)}
                      </select>
                    )}
                  </div>
                ))}
                {col.length === 0 && <div style={{ fontSize: 11, color: C.faint, textAlign: "center", padding: "8px 0" }}>—</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------- Recovery tab --------------------------- */
function RecoveryTab({ bounced, onApply, onUpdate, onOpen }) {
  if (bounced.length === 0) return <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 40, textAlign: "center", color: C.sub, fontSize: 14 }}>No bounced or undelivered contacts. When an email bounces in Brevo, set the client's email status to “Bounced” and recover a replacement here.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.5 }}>Claude searches the web for current business contact details and proposes matches with source and confidence. You approve; the old address is archived and stays searchable.</div>
      {bounced.map((c) => <RecoveryRow key={c.id} client={c} onApply={onApply} onUpdate={onUpdate} onOpen={onOpen} />)}
    </div>
  );
}
function RecoveryRow({ client, onApply, onUpdate, onOpen }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async () => {
    setBusy(true); setErr("");
    try {
      const cands = await findAlternativeContact(client);
      onUpdate(client.id, { candidates: cands, tags: cands.length && !client.tags.includes("contact-found") ? [...client.tags, "contact-found"] : client.tags });
      if (!cands.length) setErr("No reliable contact found. Try refining the company name, or add details manually.");
    } catch (e) { setErr(e.message || "Lookup failed — try again in a moment."); }
    finally { setBusy(false); }
  };
  const conf = { high: C.green, medium: C.amber, low: C.grey };
  return (
    <div style={{ background: C.panel, borderRadius: 12, border: `1px solid ${C.line}`, padding: 16 }}>
      <div className="flex flex-wrap items-center justify-between" style={{ gap: 10 }}>
        <div>
          <button onClick={() => onOpen(client.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 15, fontWeight: 700, color: C.ink }}>{client.company || client.name}</button>
          <div style={{ fontSize: 12, color: C.sub, fontFamily: MONO, marginTop: 2 }}><span style={{ textDecoration: "line-through", color: C.red }}>{client.email}</span> · {client.name}</div>
        </div>
        <SolidBtn onClick={run}>{busy ? "Searching…" : client.candidates?.length ? "Search again" : "Find alternative contact"}</SolidBtn>
      </div>
      {err && <div style={{ fontSize: 12, color: C.red, marginTop: 10 }}>{err}</div>}
      {client.candidates?.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {client.candidates.map((cand, i) => (
            <div key={i} className="flex flex-wrap items-center justify-between" style={{ gap: 10, background: C.paper, borderRadius: 8, border: `1px solid ${C.line}`, padding: "10px 12px" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontFamily: MONO, fontWeight: 600 }}>{cand.email || "—"}{cand.phone ? ` · ${cand.phone}` : ""}</div>
                <div style={{ fontSize: 11.5, color: C.sub, marginTop: 2 }}>{cand.note} · source: {cand.source}<span style={{ marginLeft: 8, color: conf[cand.confidence] || C.grey, fontWeight: 600 }}>{cand.confidence} confidence</span></div>
              </div>
              <button onClick={() => onApply(client.id, cand)} style={{ fontSize: 12.5, fontWeight: 600, padding: "8px 14px", borderRadius: 8, border: "none", background: C.action, color: "#fff", cursor: "pointer", whiteSpace: "nowrap" }}>Apply & archive old</button>
            </div>
          ))}
        </div>
      )}
      {client.archivedContacts?.length > 0 && <div style={{ fontSize: 11, color: C.faint, marginTop: 10 }}>Archived: {client.archivedContacts.map((a) => a.email).join(", ")}</div>}
    </div>
  );
}

/* ----------------------------- Comms tab ----------------------------- */
// Queue + editor. WHO to email falls out of the template's natural audience.
// Sent/unsent state is visible per recipient, and sending auto-advances to
// the next unsent.
function CommsTab({ clients, settings, templates, onLogSent, onOpen, onSent }) {
  const [type, setType] = useState("reminder");
  const [selId, setSelId] = useState(null);
  const [q, setQ] = useState("");
  const key = `${type}:${periodKey()}`;

  const [fullAudience, skipped] = useMemo(() => {
    let l;
    if (type === "deletion") {
      l = clients.filter((c) => c.stage === "marked-deletion" || c.billingStatus === "marked-deletion");
    } else {
      l = clients.filter((c) => c.stage !== "marked-deletion");
      if (type === "reminder") l = [...l.filter((c) => needsReminder(c))].sort((a, b) => arrearsPeriods(b) - arrearsPeriods(a));
      if (type === "price") l = l.filter((c) => c.billingStatus === "old-pricing" && !c.tags.includes("price-declined"));
    }
    const before = l.length;
    l = l.filter((c) => !c.tags.includes("opted-out") && c.emailStatus === "ok" && c.email);
    return [l, before - l.length];
  }, [clients, type]);

  // Search narrows the visible queue by company / contact / email.
  const audience = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return fullAudience;
    return fullAudience.filter((c) => (c.company || "").toLowerCase().includes(k) || (c.name || "").toLowerCase().includes(k) || (c.email || "").toLowerCase().includes(k));
  }, [fullAudience, q]);

  useEffect(() => { setSelId(null); }, [type]);
  const sentOf = (c) => c.reminders?.[key]?.sentAt;
  const client = audience.find((c) => c.id === selId) || audience.find((c) => !sentOf(c)) || audience[0];
  const sentCount = fullAudience.filter(sentOf).length;
  const advance = () => {
    if (!client) return;
    const i = audience.findIndex((c) => c.id === client.id);
    const next = audience.slice(i + 1).find((c) => !sentOf(c)) || audience.slice(0, i).find((c) => !sentOf(c));
    if (next) setSelId(next.id);
  };
  const esc = client && type === "reminder" ? escalationOf(client) : null;

  const audienceHint = {
    reminder: "everyone overdue or not up to date in ChargeOver",
    price: "everyone on old pricing",
    deletion: "accounts marked for deletion",
  }[type] || "all contactable clients";

  return (
    <div>
      <div className="flex flex-wrap items-center" style={{ gap: 10, marginBottom: 14 }}>
        <MiniSelect value={type} onChange={setType} options={Object.entries(templates).map(([k, v]) => [k, v.label])} />
        <span style={{ fontSize: 12.5, color: C.sub }}>Audience: {audienceHint}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search companies"
          style={{ fontSize: 13, padding: "7px 11px", borderRadius: 8, border: `1px solid ${q.trim() ? C.action : C.line}`, background: C.panel, outline: "none", minWidth: 180 }} />
        <span style={{ marginLeft: "auto", fontSize: 12.5, color: C.sub, fontFamily: MONO }}>
          {sentCount}/{fullAudience.length} sent this month{skipped ? ` · ${skipped} skipped (opted out / bounced / no email)` : ""}
        </span>
      </div>
      {!client ? (
        <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 40, textAlign: "center", color: C.sub, fontSize: 14 }}>
          {q.trim() && fullAudience.length
            ? `No companies match “${q.trim()}” in this list.`
            : `No eligible recipients${skipped ? ` — ${skipped} were skipped (opted out, bounced, or missing an email)` : " for this selection"}.`}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(210px, 270px) 1fr", gap: 14, alignItems: "start" }}>
          {/* Recipient queue */}
          <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, overflow: "auto", maxHeight: 640 }}>
            {audience.map((c) => {
              const sent = sentOf(c);
              const on = c.id === client.id;
              const behind = arrearsPeriods(c);
              return (
                <button key={c.id} onClick={() => setSelId(c.id)}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 12px", cursor: "pointer", border: "none", borderBottom: `1px solid ${C.lineSoft}`, borderLeft: `3px solid ${on ? C.action : "transparent"}`, background: on ? C.lineSoft : "transparent" }}>
                  <div className="flex items-center justify-between" style={{ gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.company || c.name}</span>
                    {sent && <span style={{ color: C.green, fontSize: 12, flexShrink: 0 }} title={`Sent ${fmtDate(sent)}`}>✓</span>}
                  </div>
                  <div style={{ fontSize: 11, color: C.sub, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {behind >= 1 ? `${money(totalOwed(c), c.currency || settings.currency)} · ${behind}p behind` : BILLING[c.billingStatus].label}
                  </div>
                </button>
              );
            })}
          </div>
          {/* Editor */}
          <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 18 }}>
            <div style={{ marginBottom: 14 }}>
              <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => onOpen?.(client.id)} title="Open client" style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 15, fontWeight: 700, color: C.ink, textDecoration: "underline", textDecorationColor: C.lineSoft, textUnderlineOffset: 3 }}>
                  {client.company || client.name}
                </button>
                {esc && <MiniPill fg={esc.level === 3 ? "#fff" : esc.color} bg={esc.level === 3 ? C.red : C.amberBg}>{esc.label} · {arrearsPeriods(client)}p behind{totalOwed(client) > 0 ? ` · ${money(totalOwed(client), client.currency || settings.currency)}` : ""}</MiniPill>}
              </div>
              <div style={{ fontSize: 12, color: C.sub, fontFamily: MONO, marginTop: 2 }}>{client.name} · {SEGMENTS[client.segment].label}</div>
            </div>
            <EmailEditor key={`${client.id}:${type}`} client={client} settings={settings} type={type} templates={templates} onLogSent={onLogSent} onDone={advance} onSent={onSent} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------- Today tab ----------------------------- */
function DigestTab({ clients, settings, bounced, onGo, onOpen }) {
  const now = new Date();
  const reminderList = clients.filter((c) => needsReminder(c, now) && c.emailStatus === "ok" && !c.tags.includes("opted-out"));
  const finals = reminderList.filter((c) => arrearsPeriods(c, now) >= 3);
  const followUps = clients.filter((c) => needsFollowUp(c, now))
    .sort((a, b) => (followUpDue(b, now) - followUpDue(a, now)) || STAGES[a.stage].order - STAGES[b.stage].order);
  const activeC = clients.filter((c) => !c.archivedClient && !c.formerCustomer);
  const needContact = activeC.filter((c) => c.stage === "need-to-contact");
  const awaitingReply = activeC.filter((c) => c.stage === "contacted-awaiting");
  const pendingContacts = clients.filter((c) => c.candidates?.length > 0);
  const oldPricing = clients.filter((c) => c.billingStatus === "old-pricing" && !c.tags.includes("price-declined"));
  const Row = ({ n, label, tint, to }) => (
    <button onClick={() => onGo(to)} className="flex items-center" style={{ width: "100%", textAlign: "left", gap: 12, background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 14px", cursor: "pointer" }}>
      <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 13, color: "#fff", background: n > 0 ? tint : C.grey, width: 28, height: 28, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{n}</span>
      <span style={{ fontSize: 13.5 }}>{label}</span>
    </button>
  );
  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, alignItems: "start" }}>
      <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 4px", fontFamily: DISPLAY }}>What needs attention</h2>
        <p style={{ fontSize: 13, color: C.sub, marginBottom: 16 }}>Live counts — click through to act. Nothing sends without your review.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Row n={reminderList.length} label="Payment reminders to send" tint={C.red} to="comms" />
          <Row n={finals.length} label="Final notices (3+ periods behind)" tint={C.red} to="comms" />
          <Row n={needContact.length} label="Need to contact" tint={C.amber} to="workflow" />
          <Row n={awaitingReply.length} label="Awaiting reply" tint={C.amber} to="workflow" />
          <Row n={oldPricing.length} label="Old pricing — notices to send" tint={C.amber} to="comms" />
          <Row n={pendingContacts.length} label="Recovered contacts awaiting approval" tint={C.action} to="recovery" />
          <Row n={bounced} label="Bounced contacts to recover" tint={C.red} to="recovery" />
        </div>
      </div>
      <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 20 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Follow-ups</h3>
        <p style={{ fontSize: 11.5, color: C.faint, marginBottom: 10 }}>Clients you need to contact or are awaiting a reply from — plus any with a follow-up date set. Click to open.</p>
        {followUps.length === 0 && <div style={{ fontSize: 12.5, color: C.faint }}>Nothing to follow up — every client is up to date or on hold.</div>}
        {followUps.map((c) => (
          <button key={c.id} onClick={() => onOpen(c.id)} className="flex items-center justify-between" style={{ width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: `1px solid ${C.lineSoft}`, padding: "9px 2px", cursor: "pointer", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.company || c.name}</div>
              <div style={{ fontSize: 11.5, color: STAGES[c.stage].color, fontWeight: 600 }}>{STAGES[c.stage].label}</div>
            </div>
            {followUpDue(c, now)
              ? <span style={{ fontSize: 11, fontFamily: MONO, color: C.amber, whiteSpace: "nowrap" }}>due {fmtDate(c.followUp)}</span>
              : <span style={{ fontSize: 15, color: C.faint }}>›</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/* --------------------------- Detail drawer --------------------------- */
// Live past-charges (invoices) for a client, pulled from ChargeOver on open.
// Invoice state is owned by DetailDrawer (it also feeds the Amount prefill) and passed in.
function PastCharges({ client, state }) {
  const copyText = () => {
    const lines = [`Past charges — ${client.company || client.name}`];
    if (client.coBalance != null) lines.push(`Live balance: ${money(client.coBalance, client.currency)} (as of last sync)`);
    lines.push("");
    for (const inv of state.invoices) {
      const status = inv.paid ? "paid" : inv.overdue ? "overdue" : "open";
      lines.push(`${fmtDate(inv.date)} · #${inv.number} · ${status} · ${inv.currency}${(inv.total || 0).toLocaleString()}`);
    }
    return lines.join("\n");
  };
  return (
    <Section title="Past charges (ChargeOver)" action={state.invoices.length > 0 ? <CopyLink getText={copyText} /> : null}>
      {client.coBalance != null && (
        <div style={{ fontSize: 12.5, marginBottom: 8, color: client.coBalance > 0 ? C.red : C.green, fontWeight: 600 }}>
          Live balance: {money(client.coBalance, client.currency)} <span style={{ color: C.faint, fontWeight: 500 }}>· as of last sync</span>
        </div>
      )}
      {state.loading && <div style={{ fontSize: 12, color: C.faint }}>Loading from ChargeOver…</div>}
      {!state.loading && state.error && <div style={{ fontSize: 12, color: C.faint }}>{state.error === "ChargeOver not connected" ? "Connect ChargeOver to see charges." : "Couldn't load charges — try again."}</div>}
      {!state.loading && !state.error && state.invoices.length === 0 && <div style={{ fontSize: 12, color: C.faint }}>No charges on record.</div>}
      {state.invoices.map((inv) => (
        <div key={inv.id} className="flex items-center justify-between" style={{ fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.lineSoft}`, gap: 8 }}>
          <span style={{ fontFamily: MONO, color: C.sub }}>{fmtDate(inv.date)} · #{inv.number}</span>
          <span className="flex items-center" style={{ gap: 8 }}>
            <MiniPill fg={inv.paid ? C.green : inv.overdue ? C.red : C.amber} bg={inv.paid ? C.greenBg : inv.overdue ? C.redBg : C.amberBg}>{inv.paid ? "paid" : inv.overdue ? "overdue" : "open"}</MiniPill>
            <span style={{ fontFamily: MONO, fontWeight: 600 }}>{inv.currency}{(inv.total || 0).toLocaleString()}</span>
          </span>
        </div>
      ))}
      {state.invoices.length > 0 && <div style={{ fontSize: 11, color: C.faint, marginTop: 6 }}>{state.invoices.length} invoice{state.invoices.length > 1 ? "s" : ""} · live from ChargeOver</div>}
    </Section>
  );
}

function DetailDrawer({ client, settings, onClose, onUpdate, onUpdateWithLog, onRecordPayment, onDelete, onUpdateSettings, officeSiblings = [], onOpen, currentUser }) {
  const set = (patch) => onUpdate(client.id, patch);
  const toggleTag = (t) => set({ tags: client.tags.includes(t) ? client.tags.filter((x) => x !== t) : [...client.tags, t] });
  const [payAmt, setPayAmt] = useState(client.amount);
  const [payDate, setPayDate] = useState(iso());
  const [note, setNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sc, setSc] = useState({ name: "", email: "", phone: "", role: "" });
  const [dtab, setDtab] = useState("info"); // info | billing | portal
  const cur = client.currency || settings.currency;
  const behind = arrearsPeriods(client);
  const sentComms = Object.entries(client.reminders || {}).filter(([, v]) => v.sentAt);

  // ChargeOver invoices — shown in Past charges AND used to prefill Amount.
  const [inv, setInv] = useState({ loading: true, invoices: [], error: "" });
  useEffect(() => {
    if (!client.chargeoverId) { setInv({ loading: false, invoices: [], error: "" }); return; }
    let alive = true;
    setInv({ loading: true, invoices: [], error: "" });
    fetch(`/api/chargeover/invoices?co=${encodeURIComponent(client.chargeoverId)}`)
      .then((r) => r.json())
      .then((d) => { if (alive) setInv({ loading: false, invoices: d.invoices || [], error: d.error || "" }); })
      .catch(() => { if (alive) setInv({ loading: false, invoices: [], error: "load" }); });
    return () => { alive = false; };
  }, [client.chargeoverId]);
  // Prefill Amount from the most recent invoice when no amount is set — stays editable.
  useEffect(() => {
    if (client.amount || !inv.invoices.length) return;
    const latest = [...inv.invoices].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    if (latest && Number(latest.total) > 0) onUpdate(client.id, { amount: Number(latest.total) });
  }, [inv.invoices, client.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div onClick={onClose} className="flex items-center justify-center" style={{ position: "fixed", inset: 0, background: "rgba(34,48,76,0.45)", zIndex: 50, padding: "clamp(12px, 4vh, 40px) 16px" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.paper, width: "100%", maxWidth: 640, maxHeight: "100%", borderRadius: 16, overflow: "auto", boxShadow: "0 30px 80px rgba(34,48,76,0.35)" }}>
        <div style={{ position: "sticky", top: 0, zIndex: 1, background: C.panel, borderBottom: `1px solid ${C.line}` }}>
        <div className="flex items-center justify-between" style={{ padding: "14px 20px 8px", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 21, fontWeight: 700, fontFamily: DISPLAY, letterSpacing: "-0.01em" }}>
              {client.company || client.name}
              {client.archivedClient ? <span style={{ fontSize: 11, fontWeight: 500, color: C.faint, marginLeft: 6, verticalAlign: "middle" }}>· archived</span> : ""}
              {client.formerCustomer ? <span style={{ fontSize: 11, fontWeight: 700, color: C.red, background: C.redBg, padding: "2px 8px", borderRadius: 20, marginLeft: 8, verticalAlign: "middle" }}>No longer a customer</span> : ""}
            </h2>
            {behind >= 1 && <div style={{ fontSize: 12, color: C.red, fontWeight: 600 }}>{behind} period{behind > 1 ? "s" : ""} behind · owes {money(totalOwed(client), cur)}</div>}
          </div>
          {/* Segment status — right-aligned against the card edge */}
          <div className="flex items-center" style={{ gap: 12, flexShrink: 0 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <select value={client.segment} onChange={(e) => set({ segment: e.target.value })} title="Segment"
                style={{ fontSize: 12, fontWeight: 600, color: SEGMENTS[client.segment].color, background: "transparent", border: "none", cursor: "pointer", outline: "none", appearance: "none", WebkitAppearance: "none", MozAppearance: "none", textAlign: "right" }}>
                {Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <span style={{ fontSize: 11, color: SEGMENTS[client.segment].color, pointerEvents: "none" }}>▾</span>
            </span>
            <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, color: C.sub, cursor: "pointer" }}>✕</button>
          </div>
        </div>
        {/* Card tabs: Info / Billing / Portal — same raised-tab design as the main page */}
        <div className="flex items-end" style={{ gap: 3, padding: "6px 20px 0" }}>
          {[["info", "Info"], ["billing", "Billing"], ["portal", "Portal"]].map(([k, t]) => (
            <Tab key={k} active={dtab === k} onClick={() => setDtab(k)}>{t}</Tab>
          ))}
        </div>
        </div>
        <div style={{ padding: "16px 20px 20px" }}>
          {dtab === "info" && (<>
          {/* Identity — billing status sits beside workflow stage */}
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
            <Field label="Contact name"><input style={inputStyle} value={client.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Company"><input style={inputStyle} value={client.company} onChange={(e) => set({ company: e.target.value })} /></Field>
            <Field label="Email"><input style={inputStyle} value={client.email} onChange={(e) => set({ email: e.target.value })} /></Field>
            <Field label="Phone"><input style={inputStyle} value={client.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
            <Field label="ChargeOver ID"><input style={inputStyle} value={client.chargeoverId} onChange={(e) => set({ chargeoverId: e.target.value })} placeholder="for sync matching" /></Field>
            <Field label="Email status">
              <CompactSelect value={client.emailStatus} onChange={(e) => set({ emailStatus: e.target.value })}>
                <option value="ok">Deliverable</option><option value="bounced">Bounced</option><option value="undelivered">Undelivered</option>
              </CompactSelect>
            </Field>
            <Field label="Billing status (ChargeOver)"><CompactSelect value={client.billingStatus} onChange={(e) => set({ billingStatus: e.target.value })}>{Object.entries(BILLING).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</CompactSelect></Field>
            <Field label="Workflow stage"><CompactSelect value={client.stage} onChange={(e) => onUpdateWithLog(client.id, { stage: e.target.value }, "stage", `Stage → ${STAGES[e.target.value].label}`)}>{STAGE_ORDER.map((k) => <option key={k} value={k}>{STAGES[k].label}</option>)}</CompactSelect></Field>
          </div>

          {/* Multi-office group */}
          {client.multiOffice && (
            <div style={{ background: C.panel, borderRadius: 10, border: `1px solid ${C.line}`, padding: "10px 12px", marginBottom: 12 }}>
              <div className="flex items-center justify-between" style={{ gap: 8 }}>
                <span style={{ fontSize: 12.5 }}><span style={{ fontWeight: 700 }}>Multi-office</span> · group <span style={{ fontWeight: 600, color: C.action }}>{client.officeGroup || "—"}</span></span>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: client.priceMode === "group" ? C.action : C.sub }}>{client.priceMode === "group" ? "Group price" : "Per-office"}</span>
              </div>
              {client.priceMode === "group" && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 4 }}>Covered by this group price — {officeSiblings.length} other office{officeSiblings.length === 1 ? "" : "s"}:</div>
                  {officeSiblings.length === 0
                    ? <div style={{ fontSize: 12, color: C.faint }}>No other offices linked to “{client.officeGroup}”.</div>
                    : officeSiblings.map((o) => (
                      <button key={o.id} onClick={() => onOpen?.(o.id)} style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: `1px solid ${C.lineSoft}`, padding: "5px 2px", cursor: "pointer", fontSize: 12.5, color: C.ink }}>
                        {o.company}{o.priceMode === "group" ? "" : <span style={{ color: C.faint }}> · own price {money(o.amount, o.currency || settings.currency)}</span>}
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}

          {/* Notes & follow-up — dated note cards, before tags */}
          <NotesSection client={client} onUpdate={set} userName={currentUser?.name || currentUser?.email || ""} />

          {/* Tags */}
          <div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginTop: 4, marginBottom: 8 }}>Tags</div>
          <div className="flex" style={{ flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
            {Object.entries(TAGS).map(([k, v]) => {
              const on = client.tags.includes(k);
              return <button key={k} onClick={() => toggleTag(k)} style={{ fontSize: 12, fontWeight: 600, padding: "6px 11px", borderRadius: 20, cursor: "pointer", border: `1px solid ${on ? v.color : C.line}`, background: on ? v.color : C.panel, color: on ? "#fff" : C.sub }}>{v.label}</button>;
            })}
          </div>

          {/* Secondary contacts — additional / supplier contacts with phone */}
          <Section title="Additional contacts">
            {(client.secondaryContacts || []).map((s2, i) => (
              <div key={i} className="flex items-center justify-between" style={{ fontSize: 12.5, padding: "5px 0", borderBottom: `1px solid ${C.lineSoft}`, gap: 8 }}>
                <span style={{ minWidth: 0 }}>
                  <strong>{s2.name || "—"}</strong>
                  {s2.email ? <> · <span style={{ fontFamily: MONO, color: C.sub }}>{s2.email}</span></> : null}
                  {s2.phone ? <> · <span style={{ fontFamily: MONO, color: C.sub }}>{s2.phone}</span></> : null}
                  {s2.role ? ` · ${s2.role}` : ""}
                </span>
                <button onClick={() => set({ secondaryContacts: client.secondaryContacts.filter((_, j) => j !== i) })} style={{ background: "none", border: "none", color: C.faint, cursor: "pointer" }}>✕</button>
              </div>
            ))}
            <div className="flex items-end" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              <input style={{ ...inputStyle, flex: 1, minWidth: 80 }} placeholder="Name" value={sc.name} onChange={(e) => setSc({ ...sc, name: e.target.value })} />
              <input style={{ ...inputStyle, flex: 1.3, minWidth: 120 }} placeholder="Email" value={sc.email} onChange={(e) => setSc({ ...sc, email: e.target.value })} />
              <input style={{ ...inputStyle, flex: 1, minWidth: 100 }} placeholder="Phone" value={sc.phone} onChange={(e) => setSc({ ...sc, phone: e.target.value })} />
              <input style={{ ...inputStyle, flex: 0.8, minWidth: 70 }} placeholder="Role" value={sc.role} onChange={(e) => setSc({ ...sc, role: e.target.value })} />
              <GhostBtn onClick={() => { if (sc.name || sc.email || sc.phone) { set({ secondaryContacts: [...(client.secondaryContacts || []), sc] }); setSc({ name: "", email: "", phone: "", role: "" }); } }}>Add</GhostBtn>
            </div>
          </Section>

          {/* Sent comms — a copy of every message sent, newest first */}
          {sentComms.length > 0 && (
            <Section title="Communications sent">
              {[...sentComms].sort((a, b) => new Date(b[1].sentAt) - new Date(a[1].sentAt)).map(([k, v]) => (
                <SentCommRow key={k} tKey={k} v={v} />
              ))}
            </Section>
          )}

          {/* Activity + note logging */}
          <Section title="Activity">
            <div className="flex" style={{ gap: 6, marginBottom: 10 }}>
              <input style={{ ...inputStyle, flex: 1 }} placeholder="Log a note — call, promise, anything" value={note} onChange={(e) => setNote(e.target.value)} />
              <GhostBtn onClick={() => { if (note.trim()) { onUpdateWithLog(client.id, {}, "note", note.trim()); setNote(""); } }}>Log</GhostBtn>
            </div>
            {(client.activity || []).slice(0, 12).map((a, i) => (
              <div key={i} style={{ fontSize: 12, padding: "5px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
                <span style={{ fontFamily: MONO, color: C.faint }}>{fmtDate(a.at)}</span>
                <span style={{ color: C.sub, marginLeft: 8 }}>{a.text}</span>
              </div>
            ))}
            {(client.activity || []).length === 0 && <div style={{ fontSize: 12, color: C.faint }}>No activity yet.</div>}
          </Section>

          {client.archivedContacts?.length > 0 && (
            <Section title="Archived contacts">
              {client.archivedContacts.map((a, i) => <div key={i} style={{ fontSize: 12, color: C.faint, fontFamily: MONO, padding: "3px 0" }}>{a.email} · {a.reason}</div>)}
            </Section>
          )}
          </>)}

          {dtab === "billing" && (<>
          {/* Costing */}
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
            <Field label="Amount">
              <div className="flex items-center" style={{ gap: 6 }}>
                {/* empty string when 0 so there's no stuck leading "0" while typing */}
                <input type="number" placeholder={inv.loading ? "…" : "0"} style={{ ...inputStyle, flex: 1, minWidth: 0 }} value={client.amount === 0 ? "" : client.amount}
                  onChange={(e) => set({ amount: e.target.value === "" ? 0 : Number(e.target.value) })} />
                {client.multiOffice && (
                  <select value={client.priceMode} onChange={(e) => set({ priceMode: e.target.value })} title="Billed per office or one group price"
                    style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, color: C.sub, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 8px", cursor: "pointer", outline: "none" }}>
                    <option value="per-office">Per-office</option>
                    <option value="group">Group price</option>
                  </select>
                )}
              </div>
            </Field>
            <Field label="Currency">
              <CompactSelect value={client.currency || ""} onChange={(e) => set({ currency: e.target.value })}>
                <option value="">Default ({settings.currency})</option><option value="GBP">£ GBP</option><option value="USD">$ USD</option><option value="EUR">€ EUR</option>
              </CompactSelect>
            </Field>
            <Field label="Cadence">
              <CompactSelect value={client.cadence} onChange={(e) => set({ cadence: e.target.value })}>
                {Object.entries(CADENCE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </CompactSelect>
            </Field>
            <Field label="Billing day"><input type="number" min="1" max="28" style={inputStyle} value={client.billingDay} onChange={(e) => set({ billingDay: Number(e.target.value) })} /></Field>
          </div>

          {/* Viper subscription — user count + tiered pricing, for Viper customers */}
          {(client.segment === "viper-current" || client.viperCustomer) && (
            <ViperSubscription client={client} settings={settings} onUpdateSettings={onUpdateSettings} />
          )}

          {/* Maritz portal pricing — shown for Maritz portal clients */}
          {(client.segment === "maritz-portal" || client.maritzPortal) && (
            <MaritzPricing client={client} settings={settings} onUpdate={set} onUpdateSettings={onUpdateSettings} officeSiblings={officeSiblings} />
          )}

          {client.chargeoverId && <PastCharges client={client} state={inv} />}

          {/* Record payment */}
          <Section title="Record payment">
            <div className="flex items-end" style={{ gap: 8, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 90 }}><Field label={`Amount (${SYMBOL[cur]})`}><input type="number" style={inputStyle} value={payAmt} onChange={(e) => setPayAmt(e.target.value)} /></Field></div>
              <div style={{ flex: 1, minWidth: 120 }}><Field label="Date"><input type="date" style={inputStyle} value={payDate} onChange={(e) => setPayDate(e.target.value)} /></Field></div>
              <div style={{ marginBottom: 12 }}><SolidBtn onClick={() => onRecordPayment(client.id, payAmt, payDate)}>Record</SolidBtn></div>
            </div>
            {(client.payments || []).length > 0 && (
              <div style={{ marginTop: 4 }}>
                {(client.payments || []).slice(0, 6).map((p, i) => (
                  <div key={i} className="flex justify-between" style={{ fontSize: 12.5, fontFamily: MONO, padding: "5px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
                    <span style={{ color: C.sub }}>{fmtDate(p.date)}</span><span style={{ fontWeight: 600, color: C.green }}>{money(p.amount, cur)}</span>
                  </div>
                ))}
                {(client.payments || []).length > 6 && <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>+ {(client.payments || []).length - 6} earlier</div>}
              </div>
            )}
          </Section>
          </>)}

          {dtab === "portal" && (<>
          {/* Legacy Viper portal access */}
          <Section title="Viper portal access">
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
              <CredField label="Portal URL" value={client.portalUrl} onChange={(v) => set({ portalUrl: v })} placeholder="https://…" />
              <CredField label="Admin URL" value={client.adminUrl} onChange={(v) => set({ adminUrl: v })} placeholder="https://…" />
              <CredField label="User name" value={client.portalUser} onChange={(v) => set({ portalUser: v })} />
              <CredField label="Password" value={client.portalPassword} onChange={(v) => set({ portalPassword: v })} />
            </div>
            <div className="flex" style={{ gap: 8, marginTop: 4 }}>
              {client.portalUrl && <a href={client.portalUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 600, color: C.action }}>Open portal ↗</a>}
              {client.adminUrl && <a href={client.adminUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 600, color: C.action }}>Open admin ↗</a>}
            </div>
          </Section>

          {/* Portal user lists — captured employee lists, dated for change-tracking */}
          <PortalUsers client={client} onUpdate={(patch) => set(patch)} />
          </>)}

          {/* Archive / delete / former customer — one shared button style, left-aligned */}
          <div className="flex items-center" style={{ gap: 8, marginTop: 20, flexWrap: "wrap", paddingTop: 14, borderTop: `1px solid ${C.lineSoft}` }}>
            <button onClick={() => onUpdateWithLog(client.id, { archivedClient: !client.archivedClient }, "archive", client.archivedClient ? "Client restored" : "Client archived")} style={footBtn()}>
              {client.archivedClient ? "Restore client" : "Archive client"}
            </button>
            <button
              onClick={() => onUpdateWithLog(client.id, { formerCustomer: !client.formerCustomer }, "status", client.formerCustomer ? "Reinstated as customer" : "Marked no longer a customer")}
              title={client.formerCustomer ? "Reinstate as a current customer" : "Mark as no longer a customer"}
              style={footBtn(client.formerCustomer ? null : C.red)}>
              {client.formerCustomer ? "↩ Reinstate customer" : "No longer a customer"}
            </button>
            {!confirmDelete ? (
              <button onClick={() => setConfirmDelete(true)} style={footBtn(C.red)}>Delete permanently…</button>
            ) : (
              <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: C.red }}>This can't be undone — Archive is reversible.</span>
                <button onClick={() => onDelete(client.id)} style={{ ...footBtn(C.red), background: C.red, color: "#fff", border: "none" }}>Confirm delete</button>
                <button onClick={() => setConfirmDelete(false)} style={footBtn()}>Cancel</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Notes & follow-up: the follow-up date lives here, and each saved note becomes
// a dated card stamped with who wrote it, deletable from its corner.
function NotesSection({ client, onUpdate, userName }) {
  const [draft, setDraft] = useState("");
  const cards = client.noteCards || [];
  const save = () => {
    const text = draft.trim();
    if (!text) return;
    onUpdate({ noteCards: [{ id: uid(), at: iso(), by: userName, text }, ...cards] });
    setDraft("");
  };
  return (
    <Section title="Notes & follow-up">
      <div className="flex items-center" style={{ gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.sub, flexShrink: 0 }}>Follow up on</span>
        <input type="date" style={{ ...inputStyle, width: "auto" }} value={client.followUp} onChange={(e) => onUpdate({ followUp: e.target.value })} />
        {client.followUp && <button onClick={() => onUpdate({ followUp: "" })} title="Clear follow-up date" style={{ background: "none", border: "none", color: C.faint, cursor: "pointer", fontSize: 13 }}>✕</button>}
      </div>
      <div className="flex items-end" style={{ gap: 8, marginBottom: cards.length ? 12 : 0 }}>
        <textarea rows={2} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, flex: 1 }} value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder="Context, promises made, anything the next you needs to know" />
        <SolidBtn onClick={save}>Save</SolidBtn>
      </div>
      {cards.map((n) => (
        <div key={n.id} style={{ position: "relative", background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 30px 10px 12px", marginBottom: 8 }}>
          <button onClick={() => onUpdate({ noteCards: cards.filter((x) => x.id !== n.id) })} title="Delete note" aria-label="Delete note"
            style={{ position: "absolute", top: 6, right: 8, background: "none", border: "none", color: C.faint, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 2 }}>✕</button>
          <div style={{ fontSize: 11, color: C.faint, fontFamily: MONO, marginBottom: 4 }}>{fmtDate(n.at)}{n.by ? ` · ${n.by}` : ""}</div>
          <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{n.text}</div>
        </div>
      ))}
    </Section>
  );
}

/* ------------------------------ Shared ------------------------------ */
// One sent-email row in the client card — collapsed to label+date, expands to
// the exact subject/body/channel that went out.
function SentCommRow({ tKey, v }) {
  const [open, setOpen] = useState(false);
  const label = v.label || COMMS[tKey.split(":")[0]]?.label || tKey.split(":")[0];
  return (
    <div style={{ borderBottom: `1px solid ${C.lineSoft}`, padding: "6px 0" }}>
      <button onClick={() => setOpen((o) => !o)} className="flex justify-between items-center" style={{ width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
        <span style={{ fontSize: 12.5 }}>{label} · {tKey.split(":")[1]}{v.via === "brevo" ? " · Brevo" : v.via === "manual" ? " · sent manually" : ""}</span>
        <span style={{ fontFamily: MONO, color: C.sub, fontSize: 12, flexShrink: 0, marginLeft: 8 }}>{fmtDate(v.sentAt)} {open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div style={{ marginTop: 8, background: C.paper, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, fontSize: 12.5 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{v.subject || "(no subject saved)"}</div>
          <div style={{ whiteSpace: "pre-wrap", color: C.sub, lineHeight: 1.5 }}>{v.body || "(message not saved — sent before this was tracked)"}</div>
        </div>
      )}
    </div>
  );
}
function Section({ title, action, children }) {
  return (
    <div style={{ background: C.panel, borderRadius: 12, border: `1px solid ${C.line}`, padding: 14, marginBottom: 14 }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 8, gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}
// Small inline "copy" affordance for section headers.
function CopyLink({ getText, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { const t = getText(); if (!t) return; navigator.clipboard?.writeText(t).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }); };
  return (
    <button onClick={copy} title="Copy to clipboard" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: copied ? C.green : C.action, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      {copied ? "Copied" : label}
    </button>
  );
}

// Columns of a captured portal user list, matching the admin "All Employees" table.
const USERLIST_COLS = ["Name", "Title", "Primary Office", "Admin", "Data Admin", "Terminated", "Expired", "Last Login"];
// Display order puts Last Login first; the rest follow in their original order.
const USERLIST_VIEW = [7, 0, 1, 2, 3, 4, 5, 6];
const LAST_LOGIN_IDX = 7;
// Sort key for "most recent login first" — blanks / "-" sink to the bottom.
function lastLoginTime(u) { const d = parseDate(u && u[LAST_LOGIN_IDX]); return d ? d.getTime() : -Infinity; }
// A user counts as "current" if not terminated and not expired.
function isCurrentUser(u) { const t = u[5], e = u[6]; const blank = (v) => !v || v === "-"; return blank(t) && blank(e); }
// Plain-text block of a user list for pasting into an email to the client.
function userListToText(client, list) {
  const lines = [`${client.company || client.name} — portal users (collected ${fmtDate(list.collectedAt)})`, ""];
  for (const u of list.users || []) {
    const name = u[0] || "";
    const title = u[1] ? ` — ${u[1]}` : "";
    const last = u[7] && u[7] !== "-" ? ` (last login ${u[7]})` : "";
    if (name) lines.push(`• ${name}${title}${last}`);
  }
  lines.push("", `${(list.users || []).length} users`);
  return lines.join("\n");
}
// One captured user list: dated header, copy-for-email, archive/delete, expandable table.
// Rows show Last Login first and sort most-recent-first. Editing a list saves a
// brand-new dated list and archives this one (onSaveEdit).
function UserListBlock({ client, list, onArchive, onDelete, onSaveEdit }) {
  const [open, setOpen] = useState(!list.archived);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState(null); // null = not editing; array = editing
  const copy = () => { navigator.clipboard?.writeText(userListToText(client, list)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }); };
  const rows = draft ?? (list.users || []).slice().sort((a, b) => lastLoginTime(b) - lastLoginTime(a));
  const startEdit = () => { setDraft((list.users || []).map((u) => USERLIST_COLS.map((_, j) => u[j] ?? ""))); setOpen(true); };
  const editCell = (i, viewCol, val) => setDraft((d) => d.map((u, k) => (k === i ? u.map((c, j) => (j === viewCol ? val : c)) : u)));
  const addRow = () => setDraft((d) => [...d, USERLIST_COLS.map(() => "")]);
  const delRow = (i) => setDraft((d) => d.filter((_, k) => k !== i));
  const save = () => { onSaveEdit(draft.filter((u) => u.some((c) => (c || "").trim()))); setDraft(null); };
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", marginBottom: 8, opacity: list.archived ? 0.6 : 1 }}>
      <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => setOpen((o) => !o)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12.5, fontWeight: 700, color: C.ink }}>
          {open ? "▾" : "▸"} Collected {fmtDate(list.collectedAt)}
        </button>
        <span style={{ fontSize: 11.5, color: C.faint }}>{rows.length} users{list.archived ? " · archived" : ""}{draft ? " · editing" : ""}</span>
        <div className="flex items-center" style={{ gap: 6, marginLeft: "auto" }}>
          {draft ? (
            <>
              <button onClick={save} style={{ fontSize: 11.5, fontWeight: 700, color: "#fff", background: C.action, border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}>Save changes</button>
              <button onClick={() => setDraft(null)} style={{ fontSize: 11.5, fontWeight: 600, color: C.sub, background: "none", border: "none", cursor: "pointer" }}>Cancel</button>
            </>
          ) : (
            <>
              <button onClick={copy} title="Copy user list for an email" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: copied ? C.green : C.action, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                {copied ? "Copied" : "Copy"}
              </button>
              {!list.archived && <button onClick={startEdit} style={{ fontSize: 11.5, fontWeight: 600, color: C.action, background: "none", border: "none", cursor: "pointer" }}>Edit</button>}
              <button onClick={onArchive} style={{ fontSize: 11.5, fontWeight: 600, color: C.sub, background: "none", border: "none", cursor: "pointer" }}>{list.archived ? "Unarchive" : "Archive"}</button>
              <button onClick={onDelete} style={{ fontSize: 11.5, fontWeight: 600, color: C.red, background: "none", border: "none", cursor: "pointer" }}>Delete</button>
            </>
          )}
        </div>
      </div>
      {open && (
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11.5 }}>
            <thead><tr>
              {USERLIST_VIEW.map((j) => <th key={j} style={{ textAlign: "left", color: C.sub, fontWeight: 600, padding: "4px 8px", borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{USERLIST_COLS[j]}</th>)}
              {draft && <th style={{ borderBottom: `1px solid ${C.line}` }} />}
            </tr></thead>
            <tbody>
              {rows.map((u, i) => (
                <tr key={i}>
                  {USERLIST_VIEW.map((j) => (
                    <td key={j} style={{ padding: draft ? "2px 4px" : "4px 8px", borderBottom: `1px solid ${C.lineSoft}`, color: u[j] && u[j] !== "-" ? C.ink : C.faint, whiteSpace: "nowrap" }}>
                      {draft
                        ? <input value={u[j] ?? ""} onChange={(e) => editCell(i, j, e.target.value)} style={{ fontSize: 11.5, padding: "3px 5px", borderRadius: 5, border: `1px solid ${C.line}`, background: C.panel, color: C.ink, width: j === LAST_LOGIN_IDX ? 130 : j === 0 ? 130 : 100 }} />
                        : (u[j] && u[j] !== "-" ? u[j] : "—")}
                    </td>
                  ))}
                  {draft && <td style={{ padding: "2px 4px", borderBottom: `1px solid ${C.lineSoft}` }}><button onClick={() => delRow(i)} title="Remove user" style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 13 }}>✕</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {draft && <button onClick={addRow} style={{ marginTop: 8, fontSize: 11.5, fontWeight: 600, color: C.action, background: "none", border: `1px dashed ${C.line}`, borderRadius: 6, padding: "5px 10px", cursor: "pointer" }}>+ Add user</button>}
        </div>
      )}
    </div>
  );
}
function PortalUsers({ client, onUpdate }) {
  const lists = client.userLists || [];
  const setLists = (next) => onUpdate({ userLists: next });
  const active = lists.filter((l) => !l.archived);
  const archived = lists.filter((l) => l.archived);
  const [showArchived, setShowArchived] = useState(false);
  // Editing a list writes a fresh dated list and archives the one that was edited.
  const saveEdit = (list, users) => setLists([
    { id: uid(), collectedAt: iso(), source: "edited", users },
    ...lists.map((l) => (l.id === list.id ? { ...l, archived: true } : l)),
  ]);
  return (
    <Section title="Portal users">
      {active.map((list) => (
        <UserListBlock key={list.id} client={client} list={list}
          onArchive={() => setLists(lists.map((l) => (l.id === list.id ? { ...l, archived: true } : l)))}
          onDelete={() => setLists(lists.filter((l) => l.id !== list.id))}
          onSaveEdit={(users) => saveEdit(list, users)} />
      ))}
      {active.length === 0 && archived.length === 0 && <div style={{ fontSize: 12, color: C.faint }}>No user lists captured yet.</div>}
      {archived.length > 0 && (
        <>
          <button onClick={() => setShowArchived((s) => !s)} style={{ fontSize: 11.5, fontWeight: 600, color: C.sub, background: "none", border: "none", cursor: "pointer", padding: "4px 0" }}>
            {showArchived ? "Hide" : "Show"} {archived.length} archived list{archived.length > 1 ? "s" : ""}
          </button>
          {showArchived && archived.map((list) => (
            <UserListBlock key={list.id} client={client} list={list}
              onArchive={() => setLists(lists.map((l) => (l.id === list.id ? { ...l, archived: false } : l)))}
              onDelete={() => setLists(lists.filter((l) => l.id !== list.id))} />
          ))}
        </>
      )}
    </Section>
  );
}
// Current (non-terminated, non-expired) users in the most recent active list.
function currentUserCount(client) {
  const active = (client.userLists || []).filter((l) => !l.archived);
  if (!active.length) return 0;
  const latest = active.slice().sort((a, b) => new Date(b.collectedAt) - new Date(a.collectedAt))[0];
  return (latest.users || []).filter(isCurrentUser).length;
}
// Tiered monthly Viper price. 1..(tier2Min-1) = flat base; up to (tier3Min-1) = tier2/user; then tier3/user.
function viperMonthly(n, p) {
  if (n <= 0) return 0;
  if (n < p.tier2Min) return Number(p.base) || 0;
  if (n < p.tier3Min) return n * (Number(p.tier2) || 0);
  return n * (Number(p.tier3) || 0);
}
// Viper subscription: current user count + tiered price. Pricing is GLOBAL (settings) — editing here changes every Viper card.
function ViperSubscription({ client, settings, onUpdateSettings }) {
  const p = settings.viperPricing || { base: 300, tier2: 90, tier3: 80, tier2Min: 4, tier3Min: 10 };
  const [edit, setEdit] = useState(false);
  const n = currentUserCount(client);
  const total = viperMonthly(n, p);
  const tier = n <= 0 ? "—" : n < p.tier2Min ? `Base (1–${p.tier2Min - 1} users)` : n < p.tier3Min ? `${p.tier2Min}–${p.tier3Min - 1} users · ${money(p.tier2, "USD")}/user` : `${p.tier3Min}+ users · ${money(p.tier3, "USD")}/user`;
  const setP = (patch) => onUpdateSettings({ viperPricing: { ...p, ...patch } });
  const numIn = (val, on) => <input type="number" value={val} onChange={(e) => on(Number(e.target.value))} style={{ ...inputStyle, padding: "7px 9px" }} />;
  return (
    <Section title="Viper subscription" action={<button onClick={() => setEdit((e) => !e)} style={{ fontSize: 11.5, fontWeight: 600, color: C.action, background: "none", border: "none", cursor: "pointer" }}>{edit ? "Done" : "Edit pricing"}</button>}>
      <div className="flex items-baseline justify-between" style={{ gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, color: C.sub }}>Current users</span>
        <span style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO }}>{n}</span>
      </div>
      <div className="flex items-baseline justify-between" style={{ gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 12.5, color: C.sub }}>Monthly subscription</span>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: MONO, color: C.green }}>{money(total, "USD")}/mo</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.faint }}>{tier}</div>
      {edit && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.lineSoft}` }}>
          <div style={{ fontSize: 11, color: C.amber, fontWeight: 600, marginBottom: 8 }}>Global — applies to every Viper customer.</div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <div><span style={{ fontSize: 11, color: C.sub, display: "block", marginBottom: 3 }}>Base 1–{p.tier2Min - 1} ($/mo)</span>{numIn(p.base, (v) => setP({ base: v }))}</div>
            <div><span style={{ fontSize: 11, color: C.sub, display: "block", marginBottom: 3 }}>{p.tier2Min}–{p.tier3Min - 1} ($/user)</span>{numIn(p.tier2, (v) => setP({ tier2: v }))}</div>
            <div><span style={{ fontSize: 11, color: C.sub, display: "block", marginBottom: 3 }}>{p.tier3Min}+ ($/user)</span>{numIn(p.tier3, (v) => setP({ tier3: v }))}</div>
          </div>
        </div>
      )}
    </Section>
  );
}
// Maritz portal pricing. Single-office prices + setup fee are GLOBAL (settings).
// Multi-office companies get separate Single-office / Group pricing stored per
// office-group in settings — editing updates every linked office in that group.
function MaritzPricing({ client, settings, onUpdate, onUpdateSettings, officeSiblings = [] }) {
  const p = settings.maritzPricing || { monthly: 40, annual: 400, setupFee: 140 };
  const [edit, setEdit] = useState(false);
  const b = client.maritzBilling || { cadence: "monthly", includeSetup: false };
  const setB = (patch) => onUpdate({ maritzBilling: { ...b, ...patch } });
  const setP = (patch) => onUpdateSettings({ maritzPricing: { ...p, ...patch } });
  const base = b.cadence === "annual" ? Number(p.annual) || 0 : Number(p.monthly) || 0;
  const total = base + (b.includeSetup ? Number(p.setupFee) || 0 : 0);
  const numIn = (val, on, ph) => <input type="number" value={val} placeholder={ph} onChange={(e) => on(e.target.value === "" ? "" : Number(e.target.value))} style={{ ...inputStyle, padding: "7px 9px" }} />;

  if (client.multiOffice) {
    const gpAll = settings.maritzGroupPricing || {};
    const gp = gpAll[client.officeGroup] || { singleOffice: "", group: "" };
    const setGp = (patch) => onUpdateSettings({ maritzGroupPricing: { ...gpAll, [client.officeGroup]: { ...gp, ...patch } } });
    return (
      <Section title="Maritz portal pricing">
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>
          Multi-office group <span style={{ fontWeight: 600, color: C.action }}>{client.officeGroup || "—"}</span> · {officeSiblings.length + 1} linked office{officeSiblings.length === 0 ? "" : "s"}. Group pricing applies to all of them.
        </div>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div><span style={{ fontSize: 11.5, color: C.sub, display: "block", marginBottom: 4 }}>Single office ($/mo)</span>{numIn(gp.singleOffice, (v) => setGp({ singleOffice: v }), "TBD")}</div>
          <div><span style={{ fontSize: 11.5, color: C.sub, display: "block", marginBottom: 4 }}>Group price ($/mo)</span>{numIn(gp.group, (v) => setGp({ group: v }), "TBD")}</div>
        </div>
        <div style={{ fontSize: 11, color: C.faint, marginTop: 8 }}>Pricing to be confirmed — placeholders until set.</div>
      </Section>
    );
  }

  return (
    <Section title="Maritz portal pricing" action={<button onClick={() => setEdit((e) => !e)} style={{ fontSize: 11.5, fontWeight: 600, color: C.action, background: "none", border: "none", cursor: "pointer" }}>{edit ? "Done" : "Edit pricing"}</button>}>
      <div className="flex items-center" style={{ gap: 6, marginBottom: 8 }}>
        {["monthly", "annual"].map((cad) => (
          <button key={cad} onClick={() => setB({ cadence: cad })} style={{ fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: `1px solid ${b.cadence === cad ? C.action : C.line}`, background: b.cadence === cad ? C.action : C.panel, color: b.cadence === cad ? "#fff" : C.sub }}>
            {cad === "annual" ? `Annual ${money(p.annual, "USD")}` : `Monthly ${money(p.monthly, "USD")}`}
          </button>
        ))}
      </div>
      <label className="flex items-center" style={{ gap: 8, cursor: "pointer", marginBottom: 8 }}>
        <input type="checkbox" checked={!!b.includeSetup} onChange={(e) => setB({ includeSetup: e.target.checked })} />
        <span style={{ fontSize: 12.5, color: C.ink }}>Add one-time setup fee ({money(p.setupFee, "USD")})</span>
      </label>
      <div className="flex items-baseline justify-between" style={{ gap: 8, paddingTop: 6, borderTop: `1px solid ${C.lineSoft}` }}>
        <span style={{ fontSize: 12.5, color: C.sub }}>Total{b.includeSetup ? " (incl. setup)" : ""}</span>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: MONO, color: C.green }}>{money(total, "USD")}{b.includeSetup ? "" : b.cadence === "annual" ? "/yr" : "/mo"}</span>
      </div>
      {edit && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.lineSoft}` }}>
          <div style={{ fontSize: 11, color: C.amber, fontWeight: 600, marginBottom: 8 }}>Global — applies to every single-office Maritz portal client.</div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <div><span style={{ fontSize: 11, color: C.sub, display: "block", marginBottom: 3 }}>Monthly ($)</span>{numIn(p.monthly, (v) => setP({ monthly: v }))}</div>
            <div><span style={{ fontSize: 11, color: C.sub, display: "block", marginBottom: 3 }}>Annual ($)</span>{numIn(p.annual, (v) => setP({ annual: v }))}</div>
            <div><span style={{ fontSize: 11, color: C.sub, display: "block", marginBottom: 3 }}>Setup fee ($)</span>{numIn(p.setupFee, (v) => setP({ setupFee: v }))}</div>
          </div>
        </div>
      )}
    </Section>
  );
}
function Pill({ fg, bg, children }) { return <span style={{ fontSize: 11.5, fontWeight: 600, color: fg, background: bg, padding: "3px 9px", borderRadius: 20, display: "inline-block" }}>{children}</span>; }
function MiniPill({ fg, bg, children }) { return <span style={{ fontSize: 10, fontWeight: 700, color: fg, background: bg, padding: "1px 7px", borderRadius: 10 }}>{children}</span>; }
// Raised "real tab" look, shared by the main page and the client card: the
// active tab lifts up and fuses with the content background (C.paper);
// inactive tabs sit lower and darker on a recessed base.
function Tab({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 13.5, fontWeight: 600, padding: active ? "10px 18px 11px" : "8px 16px", cursor: "pointer",
      border: `1px solid ${C.line}`, borderBottom: "none",
      borderRadius: "10px 10px 0 0",
      background: active ? C.paper : C.line,
      color: active ? C.ink : C.sub,
      marginBottom: -1, position: "relative", top: active ? 0 : 2,
      boxShadow: active ? "0 -3px 6px rgba(34,48,76,0.08)" : "inset 0 -4px 6px -4px rgba(34,48,76,0.22)",
      transition: "all 0.12s ease-out", zIndex: active ? 2 : 1,
    }}>
      {children}
    </button>
  );
}
function MiniBtn({ solid, onClick, children }) { return <button onClick={onClick} style={{ fontSize: 12, fontWeight: 600, padding: "6px 11px", borderRadius: 7, cursor: "pointer", border: solid ? "none" : `1px solid ${C.line}`, background: solid ? C.action : C.panel, color: solid ? "#fff" : C.ink }}>{children}</button>; }
function SolidBtn({ onClick, children }) { return <button onClick={onClick} style={{ fontSize: 13, fontWeight: 600, padding: "9px 16px", borderRadius: 8, cursor: "pointer", border: "none", background: C.action, color: "#fff" }}>{children}</button>; }
function GhostBtn({ onClick, children }) { return <button onClick={onClick} style={{ fontSize: 13, fontWeight: 600, padding: "9px 14px", borderRadius: 8, cursor: "pointer", border: `1px solid ${C.line}`, background: C.panel, color: C.ink }}>{children}</button>; }
function MiniSelect({ value, onChange, options }) { return <select value={value} onChange={(e) => onChange(e.target.value)} style={{ fontSize: 13, padding: "8px 11px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, color: C.ink, cursor: "pointer", maxWidth: 220 }}>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>; }
// A select whose box hugs its content instead of stretching full-width, so
// the dropdown arrow sits right next to the text instead of way out at the
// edge of a wide box.
function CompactSelect({ value, onChange, children }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 11px", background: C.panel }}>
      <select value={value} onChange={onChange} style={{ border: "none", outline: "none", background: "transparent", appearance: "none", WebkitAppearance: "none", MozAppearance: "none", fontSize: 14, color: C.ink, cursor: "pointer" }}>
        {children}
      </select>
      <span style={{ fontSize: 11, color: C.sub, pointerEvents: "none" }}>▾</span>
    </div>
  );
}
function ToggleSwitch({ checked, onChange, label }) {
  return (
    <label className="flex items-center" style={{ gap: 10, cursor: "pointer", userSelect: "none" }}>
      <span onClick={() => onChange(!checked)} style={{ position: "relative", width: 36, height: 20, borderRadius: 20, background: checked ? C.action : C.line, flexShrink: 0, transition: "background 0.15s" }}>
        <span style={{ position: "absolute", top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: 16, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.25)", transition: "left 0.15s" }} />
      </span>
      {label && <span style={{ fontSize: 13, color: C.ink }}>{label}</span>}
    </label>
  );
}
function Field({ label, children }) { return <label style={{ display: "block", marginBottom: 10 }}><span style={{ fontSize: 12, fontWeight: 600, color: C.sub, display: "block", marginBottom: 4 }}>{label}</span>{children}</label>; }
// Editable credential field with a one-tap copy button (copies just this value).
function CredField({ label, value, onChange, placeholder }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { if (!value) return; navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }); };
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: C.sub, display: "block", marginBottom: 5 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
        <input style={{ ...inputStyle, fontFamily: MONO, fontSize: 13 }} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        <button type="button" onClick={copy} title={`Copy ${label.toLowerCase()}`} aria-label={`Copy ${label.toLowerCase()}`} disabled={!value}
          style={{ flexShrink: 0, width: 36, borderRadius: 8, border: `1px solid ${C.line}`, background: copied ? C.greenBg : C.panel, color: copied ? C.green : value ? C.sub : C.faint, cursor: value ? "pointer" : "default", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          {copied
            ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
        </button>
      </div>
    </label>
  );
}
const inputStyle = { width: "100%", fontSize: 14, padding: "9px 11px", borderRadius: 8, border: `1px solid ${C.line}`, outline: "none", boxSizing: "border-box", color: C.ink, background: C.panel };
// Uniform footer button on the client card; pass an accent for destructive actions.
const footBtn = (accent) => ({ fontSize: 12.5, fontWeight: 600, color: accent || C.ink, background: C.panel, border: `1px solid ${accent ? accent + "66" : C.line}`, borderRadius: 8, padding: "8px 14px", cursor: "pointer" });

function EmptyState({ onImport, onSample }) {
  return (
    <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}` }}>
      <div style={{ padding: "56px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>No clients yet</div>
        <div style={{ fontSize: 13, color: C.sub, maxWidth: 380, margin: "0 auto 18px" }}>Import your client CSV, or load sample data to explore arrears tracking, escalating reminders, the workflow board and contact recovery.</div>
        <div className="flex justify-center" style={{ gap: 8 }}><SolidBtn onClick={onImport}>Import CSV</SolidBtn><GhostBtn onClick={onSample}>Load sample data</GhostBtn></div>
      </div>
    </div>
  );
}

function ImportPanel({ onImport, onSample }) {
  const [text, setText] = useState(""); const [error, setError] = useState("");
  const handle = (raw) => {
    setError("");
    // JSON backup restore
    if (raw.trim().startsWith("{")) {
      try { const d = JSON.parse(raw); if (Array.isArray(d.clients)) { onImport(d.clients); return; } } catch (e) { /* fall through to CSV */ }
    }
    const parsed = Papa.parse(raw.trim(), { header: true, skipEmptyLines: true });
    if (!parsed.data?.length) { setError("No rows found — check the header row."); return; }
    const rows = parsed.data.map((r) => {
      const g = (keys) => { for (const k of Object.keys(r)) if (keys.includes(k.trim().toLowerCase())) return r[k]; return ""; };
      return {
        chargeoverId: g(["chargeoverid", "chargeover id", "customer id", "co id"]),
        name: g(["name", "client", "contact"]), company: g(["company", "organisation", "organization"]),
        email: g(["email", "e-mail"]), phone: g(["phone", "tel", "mobile"]),
        segment: g(["segment", "group"]), billingStatus: g(["billingstatus", "billing status", "billing"]),
        stage: g(["stage", "workflow"]), amount: g(["amount", "monthly", "value"]),
        currency: g(["currency"]), cadence: g(["cadence", "frequency"]),
        billingDay: g(["billingday", "billing day", "day"]), lastPaid: g(["lastpaid", "last paid"]),
        emailStatus: g(["emailstatus", "email status"]), notes: g(["notes", "note"]), followUp: g(["followup", "follow up"]),
        tags: (g(["tags"]) || "").split("|").filter(Boolean),
      };
    });
    onImport(rows);
  };
  return (
    <div>
      <p style={{ fontSize: 13, color: C.sub, marginBottom: 10 }}>Paste CSV (or a JSON backup) or choose a file. Recognised columns:</p>
      <code style={{ display: "block", fontFamily: MONO, fontSize: 11, background: C.lineSoft, padding: "10px 12px", borderRadius: 8, marginBottom: 14, overflowX: "auto" }}>chargeoverId, name, company, email, phone, segment, billingStatus, stage, tags, amount, currency, cadence, billingDay, lastPaid, followUp, notes, emailStatus</code>
      <input type="file" accept=".csv,.json,text/csv,application/json" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => handle(String(r.result)); r.readAsText(f); }} style={{ fontSize: 13, marginBottom: 14, color: C.sub }} />
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="name,email,segment,billingStatus,amount,billingDay" style={{ width: "100%", fontFamily: MONO, fontSize: 12, padding: 12, borderRadius: 8, border: `1px solid ${C.line}`, resize: "vertical", outline: "none", boxSizing: "border-box" }} />
      {error && <p style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{error}</p>}
      <div className="flex items-center justify-between" style={{ marginTop: 16 }}>
        <button onClick={onSample} style={{ fontSize: 13, color: C.action, background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Load sample instead</button>
        <SolidBtn onClick={() => handle(text)}>Import</SolidBtn>
      </div>
      <p style={{ fontSize: 11.5, color: C.faint, marginTop: 12, lineHeight: 1.5 }}>Matching key: ChargeOver ID first, then email — re-importing updates existing clients. Unknown values fall back to safe defaults.</p>
    </div>
  );
}
function AddPanel({ onAdd }) {
  const [f, setF] = useState({ name: "", company: "", email: "", chargeoverId: "", segment: "viper-current", billingStatus: "never-charged", amount: "", billingDay: "1", cadence: "monthly", currency: "", inChargeOver: false });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Contact name"><input style={inputStyle} value={f.name} onChange={set("name")} /></Field>
        <Field label="Company"><input style={inputStyle} value={f.company} onChange={set("company")} /></Field>
        <Field label="Email"><input style={inputStyle} value={f.email} onChange={set("email")} /></Field>
        <Field label="ChargeOver ID"><input style={inputStyle} value={f.chargeoverId} onChange={set("chargeoverId")} /></Field>
        <Field label="Amount"><input type="number" style={inputStyle} value={f.amount} onChange={set("amount")} /></Field>
        <Field label="Billing day"><input type="number" min="1" max="28" style={inputStyle} value={f.billingDay} onChange={set("billingDay")} /></Field>
        <Field label="Cadence"><select style={inputStyle} value={f.cadence} onChange={set("cadence")}>{Object.entries(CADENCE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        <Field label="Currency"><select style={inputStyle} value={f.currency} onChange={set("currency")}><option value="">Default</option><option value="GBP">£ GBP</option><option value="USD">$ USD</option><option value="EUR">€ EUR</option></select></Field>
      </div>
      <Field label="Segment"><select style={inputStyle} value={f.segment} onChange={set("segment")}>{Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
      <Field label="Billing status"><select style={inputStyle} value={f.billingStatus} onChange={set("billingStatus")}>{Object.entries(BILLING).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
      <div style={{ margin: "14px 0" }}><ToggleSwitch checked={f.inChargeOver} onChange={(v) => setF({ ...f, inChargeOver: v })} label="Already in ChargeOver" /></div>
      <div className="flex justify-end" style={{ marginTop: 8 }}><SolidBtn onClick={() => onAdd(f)}>Add client</SolidBtn></div>
    </div>
  );
}
function SettingsPanel({ settings, onSave }) {
  const [s, setS] = useState(settings); const set = (k) => (e) => setS({ ...s, [k]: e.target.value });
  return (
    <div>
      <Field label="Business name"><input style={inputStyle} value={s.businessName} onChange={set("businessName")} /></Field>
      <Field label="Sender name"><input style={inputStyle} value={s.senderName} onChange={set("senderName")} /></Field>
      <Field label="Default currency"><select style={inputStyle} value={s.currency} onChange={set("currency")}><option value="GBP">£ GBP</option><option value="USD">$ USD</option><option value="EUR">€ EUR</option></select></Field>
      <div className="flex justify-end" style={{ marginTop: 8 }}><SolidBtn onClick={() => onSave(s)}>Save</SolidBtn></div>
    </div>
  );
}

// Realistic starting text when editing a built-in template — its subject/body
// are functions (escalation-aware), so seed the editor with real generated
// copy for a representative client rather than trying to reverse-tokenize it.
const EXAMPLE_CLIENT = {
  name: "Alex Morgan", company: "Example Co", amount: 500, currency: "USD", cadence: "monthly",
  billingDay: 1, createdAt: monthsAgo(3), lastPaid: monthsAgo(2), payments: [],
  billingStatus: "not-up-to-date", stage: "need-to-contact", tags: [],
};
function slugify(label, existing) {
  const base = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "template";
  let key = base, n = 2;
  while (BUILTIN_COMMS_KEYS.includes(key) || existing[key]) key = `${base}-${n++}`;
  return key;
}
// Strip an HTML email down to readable plain text for the CRM's text templates.
function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n").split("\n").map((l) => l.trim()).join("\n").trim();
}

function EmailTemplatesPanel({ settings, onSave }) {
  const custom = settings.emailTemplates || {};
  const [editingKey, setEditingKey] = useState(null); // a real key, or "__new__"
  const [form, setForm] = useState({ label: "", subject: "", body: "" });
  const [brevo, setBrevo] = useState(null); // null | {loading} | {templates} | {error}
  const allKeys = [...BUILTIN_COMMS_KEYS, ...Object.keys(custom).filter((k) => !BUILTIN_COMMS_KEYS.includes(k))];

  const loadBrevo = async () => {
    setBrevo({ loading: true });
    try {
      const r = await fetch("/api/comms/brevo-templates");
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) { setBrevo({ error: d.error || "Couldn't load Brevo templates." }); return; }
      setBrevo({ templates: d.templates || [] });
    } catch { setBrevo({ error: "Couldn't reach the server." }); }
  };
  const importOne = (t) => {
    const label = t.name || "Imported template";
    const key = slugify(label, custom);
    onSave({ ...settings, emailTemplates: { ...custom, [key]: { label, subject: t.subject || "", body: htmlToText(t.html) } } });
  };

  const startEdit = (key) => {
    const ov = custom[key];
    const base = BUILTIN_COMMS_KEYS.includes(key) ? COMMS[key] : null;
    setForm({
      label: ov?.label || base?.label || key,
      subject: ov?.subject ?? (base ? base.subject(EXAMPLE_CLIENT, settings) : ""),
      body: ov?.body ?? (base ? base.body(EXAMPLE_CLIENT, settings) : ""),
    });
    setEditingKey(key);
  };
  const startNew = () => { setForm({ label: "", subject: "", body: "" }); setEditingKey("__new__"); };
  const save = () => {
    const label = form.label.trim();
    if (!label || !form.subject.trim() || !form.body.trim()) return;
    const key = editingKey === "__new__" ? slugify(label, custom) : editingKey;
    onSave({ ...settings, emailTemplates: { ...custom, [key]: { label, subject: form.subject, body: form.body } } });
    setEditingKey(null);
  };
  const resetToDefault = (key) => {
    const next = { ...custom }; delete next[key];
    onSave({ ...settings, emailTemplates: next });
    setEditingKey(null);
  };
  const remove = (key) => {
    const next = { ...custom }; delete next[key];
    onSave({ ...settings, emailTemplates: next });
    if (editingKey === key) setEditingKey(null);
  };

  if (editingKey) {
    const builtin = BUILTIN_COMMS_KEYS.includes(editingKey);
    return (
      <div>
        <Field label="Name"><input style={inputStyle} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
        <Field label="Subject"><input style={inputStyle} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
        <Field label="Message"><textarea rows={11} style={{ ...inputStyle, fontFamily: SANS, lineHeight: 1.5, resize: "vertical" }} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
        <p style={{ fontSize: 11.5, color: C.faint, marginBottom: 14, lineHeight: 1.5 }}>
          Placeholders, filled in per client when sent: {TEMPLATE_TOKENS.map((t) => `{{${t}}}`).join("  ")}
          {builtin && editingKey === "reminder" && " — note: the built-in payment reminder normally escalates its wording as an account falls further behind (reminder → second reminder → final notice). Saving here replaces all of that with this one fixed message."}
        </p>
        <div className="flex items-center justify-between" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="flex" style={{ gap: 8 }}>
            <SolidBtn onClick={save}>Save</SolidBtn>
            <GhostBtn onClick={() => setEditingKey(null)}>Cancel</GhostBtn>
          </div>
          {builtin && custom[editingKey] && <button onClick={() => resetToDefault(editingKey)} style={{ fontSize: 12.5, color: C.sub, background: "none", border: "none", cursor: "pointer" }}>Reset to default wording</button>}
        </div>
      </div>
    );
  }

  // Brevo import picker
  if (brevo) {
    return (
      <div>
        <div className="flex items-center justify-between" style={{ marginBottom: 12, gap: 8 }}>
          <div style={{ fontSize: 13, color: C.sub }}>Import your Brevo transactional templates. HTML is converted to editable text.</div>
          <GhostBtn onClick={() => setBrevo(null)}>← Back</GhostBtn>
        </div>
        {brevo.loading && <div style={{ fontSize: 13, color: C.faint }}>Loading from Brevo…</div>}
        {brevo.error && <div style={{ fontSize: 13, color: C.red }}>{brevo.error}</div>}
        {brevo.templates?.length === 0 && <div style={{ fontSize: 13, color: C.faint }}>No templates found in this Brevo account.</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(brevo.templates || []).map((t) => (
            <div key={t.id} className="flex items-center justify-between" style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 14px", gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</div>
                <div style={{ fontSize: 11, color: C.faint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.subject || "(no subject)"}{t.active ? "" : " · inactive"}</div>
              </div>
              <ImportBtn onImport={() => importOne(t)} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: C.sub, marginBottom: 14 }}>These feed the Comms tab and the per-client email button. Edit the built-in ones or add your own.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        {allKeys.map((key) => {
          const builtin = BUILTIN_COMMS_KEYS.includes(key);
          const label = custom[key]?.label || (builtin ? COMMS[key].label : key);
          const deletable = !builtin || !!custom[key]; // custom, or an edited built-in (resets)
          return (
            <div key={key} className="flex items-center justify-between" style={{ position: "relative", background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 34px 10px 14px", gap: 8 }}>
              {deletable && (
                <button onClick={() => (builtin ? resetToDefault(key) : remove(key))} title={builtin ? "Reset to default wording" : "Delete template"} aria-label={builtin ? "Reset template" : "Delete template"}
                  style={{ position: "absolute", top: 6, right: 8, background: "none", border: "none", color: C.faint, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 2 }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = C.red)} onMouseLeave={(e) => (e.currentTarget.style.color = C.faint)}>✕</button>
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: 11, color: C.faint }}>{builtin ? "Built-in" : "Custom"}{custom[key] && builtin ? " · edited" : ""}</div>
              </div>
              <div className="flex" style={{ gap: 6, flexShrink: 0 }}>
                <GhostBtn onClick={() => startEdit(key)}>Edit</GhostBtn>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex" style={{ gap: 8, flexWrap: "wrap" }}>
        <SolidBtn onClick={startNew}>+ New email type</SolidBtn>
        <GhostBtn onClick={loadBrevo}>Import from Brevo</GhostBtn>
      </div>
    </div>
  );
}
// Import button that flips to a checkmark once used, so you can see what you've already pulled in.
function ImportBtn({ onImport }) {
  const [done, setDone] = useState(false);
  return (
    <button onClick={() => { onImport(); setDone(true); }} style={{ fontSize: 12.5, fontWeight: 600, padding: "7px 13px", borderRadius: 8, border: `1px solid ${done ? C.green : C.line}`, background: done ? C.greenBg : C.panel, color: done ? C.green : C.action, cursor: "pointer", flexShrink: 0 }}>
      {done ? "Imported ✓" : "Import"}
    </button>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div onClick={onClose} className="flex items-center justify-center" style={{ position: "fixed", inset: 0, background: "rgba(34,48,76,0.45)", padding: 16, zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.panel, borderRadius: 16, width: "100%", maxWidth: wide ? 900 : 540, maxHeight: "88vh", overflow: "auto", boxShadow: "0 24px 60px rgba(34,48,76,0.25)" }}>
        <div className="flex items-center justify-between" style={{ padding: "18px 20px", borderBottom: `1px solid ${C.line}` }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, fontFamily: DISPLAY }}>{title}</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, color: C.sub, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}
