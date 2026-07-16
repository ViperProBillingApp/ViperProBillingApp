"use client";
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import Papa from "papaparse";
import { C, SANS, DISPLAY, MONO, Wordmark } from "../lib/brand.js";
import { SYMBOL, CADENCE, coveredByGroup, lastPaymentDate, periodsBehind, owedBalance, arrearsPeriods, totalOwed, needsReminder, monthlyValue, followUpDue, needsFollowUp, computeKpis, topOwed, csvSafe, csvSafeRow } from "../lib/metrics.js";
import UsersAdmin from "./users-admin.jsx";

/* ================================================================== *
 * ViperPro — Client CRM & Collections
 * Ported from the artifact prototype (viper-crm-v2.jsx).
 * Storage: /api/state (SQLite-backed, whole-state, debounced saves).
 * Contact recovery: /api/recover (server-side Claude web search).
 * ================================================================== */

/* ------------------------------ Axes ------------------------------ */
const SEGMENTS = {
  "viper-current": { label: "Viper Customer", color: "#0E766E" },
  "viper-past": { label: "Past Viper Customer", color: "#8A94A6" },
  "viper-maritz": { label: "Viper & Maritz Customer", color: "#7A5AA6" }, // Viper customer with free Maritz portal — only viper pricing applies
  "maritz-portal": { label: "Maritz - Viper Portal", color: "#3B5BA5" },
};
const BILLING = {
  "current-pricing": { label: "Up to date · current pricing", color: C.green, bg: C.greenBg },
  "old-pricing": { label: "Up to date · old pricing", color: C.amber, bg: C.amberBg },
  "not-up-to-date": { label: "Not up to date", color: C.red, bg: C.redBg },
  "needs-co-update": { label: "Need to update in ChargeOver", color: "#3B5BA5", bg: "#E7EDF8" },
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
// Tasks board (Workflow tab): lanes, category labels, and the account-edit flag
// that also shows on client cards (mirrors the red/green Maritz-edit workflow).
const TASK_LANES = [["todo", "To do"], ["doing", "Doing"], ["done", "Done"]];
const LANE_COLOR = { todo: "#8A94A6", doing: "#3B5BA5", done: C.green };
const TASK_LABELS = {
  campaign: { label: "Campaign", fg: C.action, bg: "#E7EDF8" },
  data: { label: "Data ops", fg: "#6D5BA6", bg: "#EEEBF7" },
  outreach: { label: "Custom outreach", fg: C.amber, bg: C.amberBg },
  onboarding: { label: "Onboarding", fg: C.green, bg: C.greenBg },
};
const CLIENT_FLAGS = {
  approved: { label: "Approved", fg: C.green, bg: C.greenBg },
  edit: { label: "Needs edit", fg: C.amber, bg: C.amberBg },
  remove: { label: "Remove", fg: C.red, bg: C.redBg },
};
const initialsOf = (s) => {
  const t = (s || "").trim();
  if (!t) return "?";
  const p = t.split(/[\s@.]+/).filter(Boolean);
  return ((p[0]?.[0] || "") + (p[1]?.[0] || "")).toUpperCase() || t.slice(0, 2).toUpperCase();
};
function Avatar({ email, staffByEmail = {}, size = 20 }) {
  if (!email) return null;
  const name = staffByEmail[email] || email;
  return (
    <span title={name} style={{ width: size, height: size, borderRadius: "50%", background: "#E7EDF8", color: C.action, fontSize: size * 0.5, fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      {initialsOf(name)}
    </span>
  );
}
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

// Group pricing tiers by linked-office count (monthly / annual, editable globally).
const GROUP_TIER_DEFAULTS = { t1m: 40, t1y: 400, t2m: 100, t2y: 1000, t3m: 150, t3y: 1500, t4m: 200, t4y: 2000 };
function groupTierFor(count, t = GROUP_TIER_DEFAULTS) {
  if (count <= 1) return { m: t.t1m, y: t.t1y, label: "Single office" };
  if (count <= 5) return { m: t.t2m, y: t.t2y, label: "2–5 offices" };
  if (count <= 10) return { m: t.t3m, y: t.t3y, label: "6–10 offices" };
  return { m: t.t4m, y: t.t4y, label: "11+ offices" };
}

// Money math (periodsBehind, owedBalance, totalOwed, …) lives in lib/metrics.js —
// shared with the daily-digest cron so the email can never disagree with the UI.
function escalationOf(c) {
  const n = arrearsPeriods(c);
  if (n >= 3) return { level: 3, label: "Final notice", color: C.red };
  if (n === 2) return { level: 2, label: "Second reminder", color: C.amber };
  if (n === 1) return { level: 1, label: "Reminder", color: C.amber };
  return null;
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
    stageAt: r.stageAt || "", // when the stage last changed — drives the 10-day awaiting-reply bounce-back
    tags: Array.isArray(r.tags) ? r.tags.filter((t) => TAGS[t]) : [],
    amount: Number(r.amount) || 0,
    billingDay: Math.min(28, Math.max(1, Number(r.billingDay) || 1)),
    cadence: CADENCE[r.cadence] ? r.cadence : "monthly",
    currency: SYMBOL[r.currency] ? r.currency : "",
    coBalance: r.coBalance != null ? Number(r.coBalance) || 0 : null, // live from ChargeOver, null = never synced
    coAmountAt: r.coAmountAt || "", // when the recurring amount was last read from CO billing packages
    coOverdue: r.coOverdue != null ? Number(r.coOverdue) || 0 : null, // overdue-only balance; null = not synced yet
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
    adminUser: (r.adminUser || "").trim(),       // Viper admin login
    adminPassword: r.adminPassword || "",
    maritzPortalUrl: (r.maritzPortalUrl || "").trim(),   // Maritz portal access
    maritzAdminUrl: (r.maritzAdminUrl || "").trim(),
    maritzPortalUser: (r.maritzPortalUser || "").trim(),
    maritzPortalPassword: r.maritzPortalPassword || "",
    maritzAdminUser: (r.maritzAdminUser || "").trim(),
    maritzAdminPassword: r.maritzAdminPassword || "",
    maritzUserLists: Array.isArray(r.maritzUserLists) ? r.maritzUserLists : [], // captured Maritz portal users, dated
    formerCustomer: !!r.formerCustomer,
    userLists: Array.isArray(r.userLists) ? r.userLists : [], // captured portal employee lists, dated for change-tracking
    multiOffice: !!r.multiOffice, // part of a multi-office group (e.g. a "Destination Asia" office)
    officeGroup: (r.officeGroup || "").trim(), // the group brand that links offices together
    emailPrimaryOnly: !!r.emailPrimaryOnly, // group master: email only this card's contact, not every office's
    viperCadence: r.viperCadence === "annual" ? "annual" : "monthly", // Viper subscription: monthly vs annual-in-advance pricing
    priceMode: r.priceMode === "group" ? "group" : "per-office", // per-office billing vs one group price
    groupBillingMaster: !!r.groupBillingMaster, // the ONE office that carries the group price
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
    owner: (r.owner || "").trim(), // assigned staff (email) — shown on workflow cards
    flag: CLIENT_FLAGS[r.flag] ? r.flag : "", // account-edit flag (approved/edit/remove)
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
    v = csvSafe(String(v)); // F-09: neutralise formula injection before quoting
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
    viperPricing: { base: 300, tier2: 90, tier3: 80, tier2Min: 4, tier3Min: 10, baseY: 3000, tier2Y: 900, tier3Y: 800 },
    maritzPricing: { monthly: 40, annual: 400, setupFee: 500 },
    maritzGroupTiers: { ...GROUP_TIER_DEFAULTS }, // group pricing by office count — global
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

  // Server-state revision this tab last loaded or saved. Saves send it; the
  // API rejects a save carrying an older rev so this tab can't wipe newer data.
  const revRef = React.useRef(0);
  // F-08 Phase 2: last-persisted snapshot for per-client diff saves. Maps
  // client id -> JSON.stringify(client); the save effect sends only clients that
  // differ, plus ids that vanished. settingsBaseRef holds the settings snapshot.
  const baselineRef = React.useRef(new Map());
  const settingsBaseRef = React.useRef("");
  const setBaseline = useCallback((cs, st) => {
    baselineRef.current = new Map((cs || []).map((c) => [c.id, JSON.stringify(c)]));
    settingsBaseRef.current = JSON.stringify(st || {});
  }, []);

  // Signed-in user's signature image — shown in the compose editors; the send
  // route appends it server-side to every outgoing email.
  const [signatureImage, setSignatureImage] = useState("");
  useEffect(() => {
    fetch("/api/users/me").then((r) => r.json()).then((d) => setSignatureImage(d.user?.signature_image || "")).catch(() => {});
  }, []);

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
      // sends carry a ref to the stored copy so Activity can show the email
      const activity = patch.sentAt ? [{ at: new Date().toISOString(), type: "email", text: `${label} sent`, ref: key }, ...(c.activity || [])].slice(0, 200)
        : patch.sentAt === null ? logActivity(c, "email", `${label || "Email"} unmarked as sent`)
        : c.activity;
      return { ...c, reminders, activity };
    }));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/state");
        if (r.status === 401) { window.location.href = "/login"; return; }
        const d = await r.json();
        const loadedClients = Array.isArray(d.clients) ? d.clients.map(normalise) : [];
        if (Array.isArray(d.clients)) setClients(loadedClients);
        // Baseline the diff-save against exactly what we loaded, so the first
        // save only sends genuine edits — not the whole set.
        baselineRef.current = new Map(loadedClients.map((c) => [c.id, JSON.stringify(c)]));
        if (d.settings) setSettings((s) => {
          const merged = {
            ...s, ...d.settings,
            viperPricing: { ...s.viperPricing, ...(d.settings.viperPricing || {}) },
            maritzPricing: { ...s.maritzPricing, ...(d.settings.maritzPricing || {}) },
            maritzGroupTiers: { ...GROUP_TIER_DEFAULTS, ...(d.settings.maritzGroupTiers || {}) },
          };
          settingsBaseRef.current = JSON.stringify(merged); // baseline settings where the merged value exists
          return merged;
        });
        revRef.current = d.rev || 0;
      } catch (e) { /* first run / offline — start empty */ }
      finally { setLoaded(true); }
    })();
  }, []);

  // Deep-link support so a client can be opened in its own tab/window: the row
  // is a real link to ?client=<id>; on load we open that drawer, and we keep
  // the URL in sync as the drawer opens/closes (without a page reload).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("client");
    if (id) setDetailId(id);
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (detailId) url.searchParams.set("client", detailId);
    else url.searchParams.delete("client");
    window.history.replaceState(null, "", url);
  }, [detailId]);

  // Workflow automations, run once per session after load:
  // 1. A due follow-up date pulls the card into "Need to contact" (and back onto the board).
  // 2. "Contacted · awaiting reply" with no stage change for 10 days returns to
  //    "Need to contact", logging the last communication date.
  useEffect(() => {
    if (!loaded) return;
    const now = new Date();
    const MS10 = 10 * 86400000;
    setClients((p) => {
      let changed = false;
      const next = p.map((c) => {
        if (c.archivedClient || c.formerCustomer) return c;
        if (followUpDue(c, now) && !["need-to-contact", "contacted-awaiting", "marked-deletion"].includes(c.stage)) {
          changed = true;
          return { ...c, stage: "need-to-contact", stageAt: now.toISOString(), followUp: "", workflowHidden: false, activity: logActivity(c, "stage", `Follow-up date ${fmtDate(c.followUp)} reached, moved to Need to contact`) };
        }
        if (c.stage === "contacted-awaiting") {
          const t = parseDate(c.stageAt) || parseDate(c.createdAt);
          if (t && now - t >= MS10) {
            changed = true;
            const lastComm = Object.values(c.reminders || {}).map((v) => v.sentAt).filter(Boolean).sort().pop();
            return { ...c, stage: "need-to-contact", stageAt: now.toISOString(), activity: logActivity(c, "stage", `No reply in 10 days, returned to Need to contact${lastComm ? ` · last communication ${fmtDate(lastComm)}` : ""}`) };
          }
        }
        return c;
      });
      return changed ? next : p;
    });
  }, [loaded]);

  // F-08 Phase 2: diff-based save. Send only clients that changed since the last
  // persisted snapshot, plus ids that vanished — never the whole array. The
  // server merges the diff into current state, so a stale tab physically cannot
  // wipe clients it didn't touch (the two historical data-loss incidents).
  useEffect(() => {
    if (!loaded) return;
    if (saveState === "stale") return; // out-of-date tab must never overwrite newer server data
    setSaveState("saving");
    const t = setTimeout(async () => {
      const base = baselineRef.current;
      const curIds = new Set(clients.map((c) => c.id));
      const upserts = clients.filter((c) => base.get(c.id) !== JSON.stringify(c)); // new or changed
      const deletes = [...base.keys()].filter((id) => !curIds.has(id));
      const settingsStr = JSON.stringify(settings);
      const settingsChanged = settingsStr !== settingsBaseRef.current;
      if (!upserts.length && !deletes.length && !settingsChanged) { setSaveState("saved"); return; }
      try {
        const r = await fetch("/api/clients/batch", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ upserts, deletes, settings: settingsChanged ? settings : undefined, rev: revRef.current }),
        });
        if (r.status === 401) { window.location.href = "/login"; return; }
        if (r.status === 409) { setSaveState("stale"); return; }
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.rev) {
          revRef.current = d.rev;
          // Advance the baseline only on confirmed success, so a failed save re-sends.
          baselineRef.current = new Map(clients.map((c) => [c.id, JSON.stringify(c)]));
          settingsBaseRef.current = settingsStr;
        }
        setSaveState(r.ok ? "saved" : "error");
      } catch { setSaveState("error"); }
    }, 600);
    return () => clearTimeout(t);
  }, [clients, settings, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // stable identity so memoized rows don't re-render when unrelated state changes
  const openCompose = useCallback((id, type) => { setComposeId(id); setComposeType(type || "reminder"); }, []);
  const updateWithLog = useCallback((id, patch, type, text) => {
    setClients((p) => p.map((c) => {
      if (c.id !== id) return c;
      // Stage changes stamp stageAt (10-day bounce-back clock); reaching
      // "Up to date" also removes the card from the workflow board.
      const stageExtras = patch.stage && patch.stage !== c.stage
        ? { stageAt: new Date().toISOString(), ...(patch.stage === "up-to-date" ? { workflowHidden: true } : {}) }
        : {};
      return { ...c, ...patch, ...stageExtras, activity: logActivity(c, type, text) };
    }));
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
      const synced = Array.isArray(sd.clients) ? sd.clients.map(normalise) : [];
      if (Array.isArray(sd.clients)) setClients(synced);
      revRef.current = sd.rev || 0; // sync bumped the rev; adopt it so saves keep flowing
      baselineRef.current = new Map(synced.map((c) => [c.id, JSON.stringify(c)])); // re-baseline against synced data
      setSync({ busy: false, msg: `ChargeOver synced: ${d.added} added, ${d.updated} updated (${d.customers} customers).` });
    } catch {
      setSync({ busy: false, msg: "Sync failed — try again." });
    }
  };

  if (!loaded) return <div className="flex items-center justify-center" style={{ background: C.paper, minHeight: "100vh", fontFamily: SANS, color: C.sub }}><span style={{ fontSize: 14 }}>Loading your CRM…</span></div>;

  const detail = clients.find((c) => c.id === detailId);
  const compose = clients.find((c) => c.id === composeId);

  return (
    <div className="crm-root" style={{ background: C.paper, minHeight: "100dvh", fontFamily: SANS, color: C.ink, display: "flex" }}>
      {/* Left navigation panel — becomes a horizontal top bar under 768px (see globals.css) */}
      <aside className="crm-aside" style={{ width: 194, flexShrink: 0, backgroundColor: C.panel, backgroundImage: "linear-gradient(to bottom, rgba(255,255,255,1) 0%, rgba(255,255,255,1) 45%, rgba(255,255,255,0) 90%), linear-gradient(rgba(255,255,255,0.82), rgba(255,255,255,0.82)), url(/menu-bg.jpg)", backgroundSize: "cover", backgroundPosition: "center", borderRight: `1px solid ${C.line}`, padding: "22px 12px", display: "flex", flexDirection: "column", gap: 3, position: "sticky", top: 0, height: "100vh" }}>
        <div style={{ display: "flex", justifyContent: "center", padding: "2px 6px 22px" }}><Wordmark size={27} /></div>
        <MenuItem icon="add" onClick={() => setModal("add")}>Add client</MenuItem>
        <MenuItem icon="recovery" onClick={() => setTab("recovery")} active={tab === "recovery"}>{`Contact recovery${bounced.length ? ` · ${bounced.length}` : ""}`}</MenuItem>
        <MenuItem icon="mail" onClick={() => setModal("emails")}>Email templates</MenuItem>
        <MenuItem icon="pricing" onClick={() => setModal("pricing")}>Pricing</MenuItem>
        <MenuItem icon="portal" onClick={() => setModal("viper")}>Viper Customers</MenuItem>
        <MenuItem icon="onboarding" onClick={() => setModal("onboarding")}>Maritz Onboarding</MenuItem>
        <MenuItem icon="settings" onClick={() => setModal("settings")}>Settings</MenuItem>
        {user.role === "admin" && <MenuItem icon="sync" onClick={syncNow}>{sync.busy ? "Syncing…" : "Sync ChargeOver"}</MenuItem>}
        <MenuItem icon="users" onClick={() => setModal("users")}>{user.role === "admin" ? "Users" : "My account"}</MenuItem>
        <div className="crm-aside-footer" style={{ marginTop: "auto", paddingTop: 12, borderTop: `1px solid ${C.lineSoft}` }}>
          <div style={{ fontSize: 12, color: C.sub, padding: "0 6px 6px" }}>{user.name || user.email}</div>
          <MenuItem icon="signout" onClick={logout}>Sign out</MenuItem>
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0 }}>
      <div className="mx-auto w-full" style={{ maxWidth: 1180, padding: "clamp(16px, 3vw, 30px)" }}>
        {saveState === "stale" && (
          <div className="flex items-center justify-between" style={{ gap: 12, background: C.redBg, border: `1px solid ${C.red}33`, borderRadius: 10, padding: "10px 14px", marginBottom: 14 }}>
            <span style={{ fontSize: 13, color: C.red, fontWeight: 600 }}>
              This tab is out of date. The data changed elsewhere (another tab, a sync, or a bounce webhook), so changes here are not being saved.
            </span>
            <button onClick={() => window.location.reload()} style={{ flexShrink: 0, fontSize: 12.5, fontWeight: 600, color: "#fff", background: C.red, border: "none", borderRadius: 8, padding: "7px 14px", cursor: "pointer" }}>
              Reload latest
            </button>
          </div>
        )}

        {/* Metrics box + tab row share one continuous #F8FAFD background (no gap
            between them); the metrics keep their original boxed padding. */}
        <div style={{ background: "#F8FAFD", borderBottom: `1px solid ${C.line}`, borderRadius: "12px 12px 0 0", marginBottom: 16, overflow: "hidden" }}>
          <div style={{ padding: "14px 16px 4px" }}>
            <header style={{ marginBottom: 12 }}>
              <h1 style={{ fontFamily: DISPLAY, fontSize: 20, fontWeight: 600, letterSpacing: "0.01em" }}>Client Billing CRM</h1>
              {sync.msg && <p style={{ fontSize: 12.5, color: C.sub, marginTop: 8 }}>{sync.msg}</p>}
            </header>
            <StatStrip clients={active} settings={settings} bounced={bounced.length} />
          </div>
          {/* Tab row — actions live on the same line, right-aligned. Inline
              display so the right-alignment holds even if the .flex utility
              class isn't emitted by the CSS build. */}
          <nav className="flex items-end" style={{ display: "flex", alignItems: "flex-end", gap: 3, flexWrap: "wrap", padding: "0 12px" }}>
            {[["digest", "Today"], ["clients", "Clients"], ["workflow", "Workflow"], ["comms", "Emails"], ["reports", "Reports"]].map(([k, t]) => (
              <Tab key={k} active={tab === k} onClick={() => setTab(k)}>{t}</Tab>
            ))}
            <div className="flex items-center" style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", paddingBottom: 6 }}>
              <MiniBtn solid onClick={() => setModal("import")}>Import CSV</MiniBtn>
              <MiniBtn onClick={() => exportCsv(active)}>Export CSV</MiniBtn>
              <span style={{ fontSize: 12, color: saveState === "error" || saveState === "stale" ? C.red : C.faint, minWidth: 56, textAlign: "right" }}>
                {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : saveState === "stale" ? "Not saving" : ""}
              </span>
            </div>
          </nav>
        </div>

        {clients.length === 0 ? (
          <EmptyState onImport={() => setModal("import")} onSample={() => addClients(SAMPLE)} />
        ) : (
          <>
            {tab === "clients" && <ClientsTab clients={clients} settings={settings} templates={templates} onOpen={setDetailId} onEmail={openCompose} onUpdate={update} onUpdateWithLog={updateWithLog} />}
            {/* Archived former customers still surface on the board while marked for deletion */}
            {tab === "workflow" && <WorkflowTab clients={clients.filter((c) => !c.archivedClient || c.stage === "marked-deletion")} allClients={clients} user={user} onOpen={setDetailId} onStage={(id, stage) => updateWithLog(id, { stage }, "stage", `Stage → ${STAGES[stage].label}`)} onUpdate={update} />}
            {tab === "recovery" && <RecoveryTab bounced={bounced} onApply={applyContact} onUpdate={update} onOpen={setDetailId} />}
            {tab === "comms" && <CommsTab clients={active} settings={settings} templates={templates} onLogSent={logSent} onOpen={setDetailId} onSent={showToast} signatureImage={signatureImage} onUpdateWithLog={updateWithLog} />}
            {tab === "digest" && <DigestTab clients={active} settings={settings} bounced={bounced.length} onGo={setTab} onOpen={setDetailId} />}
            {tab === "reports" && <ReportsTab clients={active} settings={settings} onOpen={setDetailId} />}
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
        onDeleteAny={(id) => { setClients((p) => p.filter((c) => c.id !== id)); if (detailId === id) setDetailId(null); }}
        onUpdateSettings={(patch) => setSettings((s) => ({ ...s, ...patch }))} currentUser={user}
        officeSiblings={detail.officeGroup ? clients.filter((c) => c.id !== detail.id && c.officeGroup === detail.officeGroup) : []} allClients={clients} onOpen={setDetailId}
        onEmail={openCompose} onAddClient={(rec) => setClients((p) => [...p, normalise(rec)])} />}
      {compose && <ComposeModal client={compose} settings={settings} templates={templates} initialType={composeType} onClose={() => setComposeId(null)} onLogSent={logSent} onSent={showToast} signatureImage={signatureImage} onUpdateWithLog={updateWithLog}
        officeSiblings={compose.officeGroup ? clients.filter((o) => o.id !== compose.id && o.officeGroup === compose.officeGroup) : []} />}
      {modal === "import" && <Modal title="Import clients" onClose={() => setModal(null)}><ImportPanel onImport={(r) => { addClients(r); setModal(null); }} onSample={() => { addClients(SAMPLE); setModal(null); }} /></Modal>}
      {modal === "add" && <Modal title="Add client" onClose={() => setModal(null)}><AddPanel onAdd={(r) => { addClients([r]); setModal(null); }} /></Modal>}
      {modal === "settings" && <Modal title="Settings" onClose={() => setModal(null)}><SettingsPanel settings={settings} onSave={(s) => { setSettings(s); setModal(null); }} /></Modal>}
      {modal === "emails" && <Modal title="Email templates" onClose={() => setModal(null)}><EmailTemplatesPanel settings={settings} onSave={setSettings} user={user} /></Modal>}
      {modal === "onboarding" && <Modal wide title="Maritz Onboarding — adding a new office" onClose={() => setModal(null)}><MaritzOnboarding /></Modal>}
      {modal === "pricing" && <Modal wide title="Pricing" onClose={() => setModal(null)}><PricingPanel settings={settings} onSave={setSettings} /></Modal>}
      {modal === "viper" && <Modal wide title="Viper Customers — portal logins" onClose={() => setModal(null)}><ViperCustomers clients={clients} onSync={(id, patch) => updateWithLog(id, patch, "portal", "Viper portal login updated from Viper Customers")} /></Modal>}
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
    case "onboarding": return <svg {...p}><path d="M9 2h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2V3a1 1 0 0 1 1-1z" /><path d="M9 12l2 2 4-4" /></svg>;
    case "pricing": return <svg {...p}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><circle cx="7" cy="7" r="1.2" fill={color} stroke="none" /></svg>;
    case "portal": return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01" /><path d="M8 14h5" /></svg>;
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

// Reference checklist for standing up a new Maritz office (transcribed from the
// team's process notes). Static content — no state, no saving.
const ONBOARDING_STEPS = [
  { where: "Admin Site › Offices", text: "Create a new office.", note: "This just creates the Office for access to Viper — you'll create the supplier company profile in a later step." },
  { where: "Admin Site › Employees", text: "Set up users on the new office:", subs: [
    "Add a new user (if needed). In the Permissions tab, be sure to add the “Vendor” permission so they have the restricted view.",
    "Add any additional users — new or existing — to the new office.",
    "Add the Site Administrator to the new office.",
  ] },
  { where: "Viper Site › Maritz HQ office", text: "Log in as the “siteadmin” user and go to the Destinations tab. For each Destination the new office needs to be linked to, open the Destination, select the new office under the list of linked Offices, then click Save." },
  { where: "Viper Site › Maritz HQ office", text: "Log out of the Maritz HQ office." },
  { where: "Viper Site › new office", text: "Log in as the “siteadmin” user, go to the Suppliers tab and add a new Supplier with the desired name (it usually matches the Office name). This creates the profile that suppliers can log in and edit." },
  { where: "Viper Site › new supplier profile", text: "Add the Destination(s) to the new profile, since vendors cannot edit their approved Maritz destinations." },
  { where: "Script", text: "Run the script to add the new Tariff folders to the new office." },
];
function MaritzOnboarding() {
  return (
    <div>
      <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.5, marginBottom: 16 }}>
        The process for adding a new Maritz office. Work top to bottom — each step notes which site and tab it happens on.
      </p>
      <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        {ONBOARDING_STEPS.map((s, i) => (
          <li key={i} className="flex" style={{ gap: 12, background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px" }}>
            <span style={{ flexShrink: 0, width: 24, height: 24, borderRadius: "50%", background: C.action, color: "#fff", fontSize: 12.5, fontWeight: 700, fontFamily: MONO, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.02em", color: "#3B5BA5", marginBottom: 3 }}>{s.where}</div>
              <div style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.5 }}>{s.text}</div>
              {s.subs && (
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5 }}>
                  {s.subs.map((sub, j) => <li key={j} style={{ fontSize: 13, color: C.sub, lineHeight: 1.5 }}>{sub}</li>)}
                </ul>
              )}
              {s.note && <div style={{ fontSize: 12, color: C.faint, fontStyle: "italic", marginTop: 6 }}>{s.note}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// Central editor for the three GLOBAL pricing objects. Edits write straight to
// settings.viperPricing / .maritzPricing / .maritzGroupTiers — the same objects
// the client-card pricing sections read, so cards update live everywhere.
function PricingPanel({ settings, onSave }) {
  const vp = { base: 300, tier2: 90, tier3: 80, tier2Min: 4, tier3Min: 10, baseY: 3000, tier2Y: 900, tier3Y: 800, ...(settings.viperPricing || {}) };
  const mp = { monthly: 40, annual: 400, setupFee: 500, ...(settings.maritzPricing || {}) };
  const gt = { ...GROUP_TIER_DEFAULTS, ...(settings.maritzGroupTiers || {}) };
  const setVp = (k, v) => onSave((s) => ({ ...s, viperPricing: { ...vp, ...(s.viperPricing || {}), [k]: v } }));
  const setMp = (k, v) => onSave((s) => ({ ...s, maritzPricing: { ...mp, ...(s.maritzPricing || {}), [k]: v } }));
  const setGt = (k, v) => onSave((s) => ({ ...s, maritzGroupTiers: { ...gt, ...(s.maritzGroupTiers || {}), [k]: v } }));
  // plain-function input (not a component) so focus is preserved across edits
  const num = (val, on) => <input type="number" value={val ?? ""} onChange={(e) => on(e.target.value === "" ? 0 : Number(e.target.value))} style={{ ...inputStyle, padding: "8px 10px" }} />;
  const Head = ({ children }) => <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>{children}</span>;
  const rowLbl = { fontSize: 12.5, color: C.ink, fontWeight: 500 };
  const section = { marginBottom: 22 };
  const secTitle = { fontSize: 14, fontWeight: 700, fontFamily: DISPLAY, marginBottom: 4 };
  const secSub = { fontSize: 12, color: C.sub, marginBottom: 12 };

  return (
    <div>
      <p style={{ fontSize: 12.5, color: C.amber, fontWeight: 600, marginBottom: 18 }}>
        These prices are global — editing here updates the pricing shown on every matching client card, and vice-versa.
      </p>

      {/* Viper subscription */}
      <div style={section}>
        <div style={secTitle}>Viper subscription</div>
        <div style={secSub}>Per-user tiers, monthly and annual-in-advance. Applies to every Viper customer card.</div>
        <div className="grid" style={{ gridTemplateColumns: "1.4fr 1fr 1fr", gap: "8px 10px", alignItems: "center" }}>
          <Head>Tier</Head><Head>Monthly ($)</Head><Head>Annual ($)</Head>
          <span style={rowLbl}>1–{vp.tier2Min - 1} users (flat)</span>{num(vp.base, (v) => setVp("base", v))}{num(vp.baseY, (v) => setVp("baseY", v))}
          <span style={rowLbl}>{vp.tier2Min}–{vp.tier3Min - 1} users (per user)</span>{num(vp.tier2, (v) => setVp("tier2", v))}{num(vp.tier2Y, (v) => setVp("tier2Y", v))}
          <span style={rowLbl}>{vp.tier3Min}+ users (per user)</span>{num(vp.tier3, (v) => setVp("tier3", v))}{num(vp.tier3Y, (v) => setVp("tier3Y", v))}
        </div>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "8px 10px", alignItems: "center", marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.lineSoft}` }}>
          <span style={rowLbl}>Tier 2 starts at (users)</span>{num(vp.tier2Min, (v) => setVp("tier2Min", v))}
          <span style={rowLbl}>Tier 3 starts at (users)</span>{num(vp.tier3Min, (v) => setVp("tier3Min", v))}
        </div>
      </div>

      {/* Maritz portal pricing */}
      <div style={section}>
        <div style={secTitle}>Maritz portal pricing</div>
        <div style={secSub}>Single-office Maritz portal price. Applies to every single-office Maritz card.</div>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: "8px 10px", alignItems: "center" }}>
          <div><Head>Monthly ($)</Head>{num(mp.monthly, (v) => setMp("monthly", v))}</div>
          <div><Head>Annual ($)</Head>{num(mp.annual, (v) => setMp("annual", v))}</div>
          <div><Head>One-time setup fee ($)</Head>{num(mp.setupFee, (v) => setMp("setupFee", v))}</div>
        </div>
      </div>

      {/* Maritz multi-office (group) pricing */}
      <div style={{ ...section, marginBottom: 4 }}>
        <div style={secTitle}>Maritz multi-office pricing</div>
        <div style={secSub}>Group tiers by office count. Applies to every multi-office group billing card.</div>
        <div className="grid" style={{ gridTemplateColumns: "1.4fr 1fr 1fr", gap: "8px 10px", alignItems: "center" }}>
          <Head>Group size</Head><Head>Monthly ($)</Head><Head>Annual ($)</Head>
          {[["Single office", "t1m", "t1y"], ["2–5 offices", "t2m", "t2y"], ["6–10 offices", "t3m", "t3y"], ["11+ offices", "t4m", "t4y"]].map(([lbl, mk, yk]) => (
            <React.Fragment key={mk}>
              <span style={rowLbl}>{lbl}</span>{num(gt[mk], (v) => setGt(mk, v))}{num(gt[yk], (v) => setGt(yk, v))}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

// One email, fully editable, three ways out: copy, real Brevo send, or mark
// sent (for mails sent elsewhere). Shared by the Comms tab and the per-row dialog.
function EmailEditor({ client, settings, type, templates, onLogSent, onDone, onSent, signatureImage, onUpdateWithLog, officeSiblings = [] }) {
  const tpl = templates[type] || templates.custom;
  const key = `${type}:${periodKey()}`;
  const saved = (client.reminders && client.reminders[key]) || {};
  // Group master: fan out to every contact (main + additional) across all
  // offices — unless the card's "primary contact only" box is ticked.
  const recipients = useMemo(() => {
    if (!(client.multiOffice && client.priceMode === "group" && client.groupBillingMaster) || client.emailPrimaryOnly) return null;
    const seen = new Set();
    const list = [];
    [client, ...officeSiblings].forEach((o) => {
      [{ name: o.name, email: o.email }, ...(o.secondaryContacts || [])].forEach((p) => {
        const e = (p.email || "").trim().toLowerCase();
        if (!e || !/^\S+@\S+\.\S+$/.test(e) || seen.has(e)) return;
        seen.add(e);
        list.push({ email: e, name: p.name || "" });
      });
    });
    return list.length > 1 ? list : null;
  }, [client, officeSiblings]);
  // Editable address fields. To pre-fills with the client (or the whole group's
  // contacts); CC offers the company's other contacts or free-typed addresses.
  const [toStr, setToStr] = useState(() => (recipients ? recipients.map((r) => r.email).join(", ") : client.email || ""));
  const [ccStr, setCcStr] = useState("");
  const [fromStr, setFromStr] = useState(FROM_EMAIL);
  const parseEmails = (s) => [...new Set(String(s).split(/[,;\n ]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^\S+@\S+\.\S+$/.test(x)))];
  const contactOptions = useMemo(() => {
    const seen = new Set();
    const out = [];
    [client, ...officeSiblings].forEach((o) => {
      [{ name: o.name, email: o.email }, ...(o.secondaryContacts || [])].forEach((p) => {
        const e = (p.email || "").trim().toLowerCase();
        if (!e || !/^\S+@\S+\.\S+$/.test(e) || seen.has(e)) return;
        seen.add(e);
        out.push({ name: (p.name || "").trim(), email: e });
      });
    });
    return out;
  }, [client, officeSiblings]);
  const inUse = new Set([...parseEmails(toStr), ...parseEmails(ccStr)]);
  const ccOptions = contactOptions.filter((c) => !inUse.has(c.email));
  const subject = saved.subject ?? tpl.subject(client, settings);
  const body = saved.body ?? tpl.body(client, settings);
  const [copied, setCopied] = useState(false);
  const [send, setSend] = useState({ busy: false, err: "" });
  const copy = () => { navigator.clipboard?.writeText(`From: ${fromStr}\nTo: ${toStr}${ccStr.trim() ? `\nCc: ${ccStr}` : ""}\nSubject: ${subject}\n\n${body}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }); };
  const markSent = (via) => {
    const now = new Date().toISOString();
    // Sent = contacted: leave the email queue and start the 10-day reply clock.
    onLogSent(client.id, key, { sentAt: now, via, subject, body, label: tpl.label, dismissedAt: now }, tpl.label);
    if (client.stage !== "marked-deletion") {
      onUpdateWithLog?.(client.id, { stage: "contacted-awaiting", stageAt: now }, "stage", "Email sent — Contacted · awaiting reply");
    }
  };
  const sendNow = async () => {
    const toList = parseEmails(toStr);
    const ccList = parseEmails(ccStr);
    if (!toList.length) { setSend({ busy: false, err: "No valid recipient email in To." }); return; }
    setSend({ busy: true, err: "" });
    try {
      const r = await fetch("/api/comms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipients: toList.map((e) => ({ email: e })),
          ...(ccList.length ? { cc: ccList.map((e) => ({ email: e })) } : {}),
          ...(fromStr.trim().toLowerCase() !== FROM_EMAIL.toLowerCase() ? { from: fromStr.trim() } : {}),
          subject, body,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setSend({ busy: false, err: d.error || "Send failed." }); return; }
      markSent("brevo");
      setSend({ busy: false, err: "" });
      onSent?.(`Sent to ${client.company || client.name}${toList.length + ccList.length > 1 ? ` (${toList.length + ccList.length} recipients)` : ""}`);
      onDone?.();
    } catch { setSend({ busy: false, err: "Send failed — try again." }); }
  };
  return (
    <div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label={recipients ? `To · all contacts across ${officeSiblings.length + 1} offices` : "To"}>
          <input style={{ ...inputStyle, fontFamily: MONO, fontSize: 13 }} value={toStr} onChange={(e) => setToStr(e.target.value)} placeholder="email, email…" />
        </Field>
        <Field label="From">
          <input style={{ ...inputStyle, fontFamily: MONO, fontSize: 13 }} value={fromStr} onChange={(e) => setFromStr(e.target.value)} title="Must be a sender address verified in Brevo" />
        </Field>
      </div>
      <Field label="CC">
        <div className="flex items-center" style={{ gap: 8 }}>
          <input style={{ ...inputStyle, fontFamily: MONO, fontSize: 13, flex: 1 }} value={ccStr} onChange={(e) => setCcStr(e.target.value)} placeholder="Add emails, comma separated" />
          {ccOptions.length > 0 && (
            <select value="" title="Add one of this company's contacts to CC"
              onChange={(e) => { const v = e.target.value; if (v) setCcStr((s) => (s.trim() ? s.trim().replace(/,$/, "") + ", " : "") + v); }}
              style={{ fontSize: 12.5, padding: "9px 8px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, color: C.action, fontWeight: 600, cursor: "pointer", maxWidth: 200 }}>
              <option value="">+ contact…</option>
              {ccOptions.map((c) => <option key={c.email} value={c.email}>{c.name ? `${c.name} — ${c.email}` : c.email}</option>)}
            </select>
          )}
        </div>
      </Field>
      <Field label="Subject"><input style={inputStyle} value={subject} onChange={(e) => onLogSent(client.id, key, { subject: e.target.value })} /></Field>
      <Field label="Message"><textarea rows={8} style={{ ...inputStyle, fontFamily: SANS, lineHeight: 1.4, resize: "vertical" }} value={body} onChange={(e) => onLogSent(client.id, key, { body: e.target.value })} /></Field>
      {/* Sender's signature — appended automatically by the send route */}
      {signatureImage ? (
        <div className="flex items-center" style={{ gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: C.sub, flexShrink: 0 }}>Signature ·</span>
          <img src={signatureImage} alt="your email signature" style={{ maxHeight: 40, maxWidth: 220, display: "block", background: "#fff", border: `1px solid ${C.lineSoft}`, borderRadius: 6, padding: 3 }} />
          <span style={{ fontSize: 11, color: C.faint }}>added automatically</span>
        </div>
      ) : (
        <p style={{ fontSize: 11.5, color: C.faint, marginBottom: 10 }}>No signature image on your user card yet — emails send without one. Add it under Users → your card.</p>
      )}
      <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
        <button onClick={sendNow} disabled={!toStr.trim() || send.busy} style={{ fontSize: 13, fontWeight: 600, padding: "9px 16px", borderRadius: 8, border: "none", background: !toStr.trim() || send.busy ? C.grey : C.action, color: "#fff", cursor: !toStr.trim() || send.busy ? "default" : "pointer" }}>
          {send.busy ? "Sending…" : saved.sentAt ? "Send again" : "Send via Brevo"}
        </button>
        <GhostBtn onClick={copy}>{copied ? "Copied ✓" : "Copy"}</GhostBtn>
        {saved.sentAt && <span style={{ fontSize: 12, color: C.green, fontWeight: 600 }}>✓ Sent {fmtDate(saved.sentAt)}{saved.via === "brevo" ? " · Brevo" : ""}</span>}
        {saved.sentAt && (
          <button onClick={() => onLogSent(client.id, key, { sentAt: null, via: null, dismissedAt: null }, tpl.label)}
            style={{ background: "none", border: "none", padding: 0, fontSize: 12, color: C.sub, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}>
            Undo
          </button>
        )}
        {send.err && <span style={{ fontSize: 12, color: C.red }}>{send.err}</span>}
      </div>
      {/* Post-send follow-through: set statuses without leaving the queue */}
      {saved.sentAt && onUpdateWithLog && (
        <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap", marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.lineSoft}` }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: C.sub }}>Billing status</span>
          <MiniSelect value={client.billingStatus} onChange={(v) => onUpdateWithLog(client.id, { billingStatus: v }, "status", `Billing status → ${BILLING[v].label}`)}
            options={Object.entries(BILLING).map(([k, v]) => [k, v.label])} />
          <span style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginLeft: 6 }}>Workflow</span>
          <MiniSelect value={client.stage} onChange={(v) => onUpdateWithLog(client.id, { stage: v }, "stage", `Stage → ${STAGES[v].label}`)}
            options={STAGE_ORDER.map((k) => [k, STAGES[k].label])} />
        </div>
      )}
    </div>
  );
}

// Per-client email compose dialog (opened from the list's email icon menu,
// pre-set to whichever template was picked there).
function ComposeModal({ client, settings, templates, initialType, onClose, onLogSent, onSent, signatureImage, onUpdateWithLog, officeSiblings = [] }) {
  const [type, setType] = useState(initialType || "reminder");
  return (
    <Modal title={`Email · ${client.company || client.name}`} onClose={onClose}>
      <Field label="Template"><MiniSelect value={type} onChange={setType} options={Object.entries(templates).map(([k, v]) => [k, v.label])} /></Field>
      <EmailEditor key={`${client.id}:${type}`} client={client} settings={settings} type={type} templates={templates} onLogSent={onLogSent} onDone={onClose} onSent={onSent} signatureImage={signatureImage} onUpdateWithLog={onUpdateWithLog} officeSiblings={officeSiblings} />
    </Modal>
  );
}

/* ---------------------------- Stat strip ---------------------------- */
function StatStrip({ clients, settings, bounced }) {
  const s = useMemo(() => {
    // One aggregation for the strip, the Reports tab, and the digest cron — lib/metrics.js.
    const k = computeKpis(clients, settings);
    const owedStr = Object.entries(k.owedByCur).map(([cur, v]) => money(v, cur)).join(" + ") || money(0, settings.currency);
    return { ...k, owedStr, total: k.totalClients };
  }, [clients, settings.currency]);
  return (
    <section className="grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginBottom: 14 }}>
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

/* ---------------------------- Reports tab ---------------------------- */
// Tiny inline sparkline — trends don't warrant a chart library at this size.
function Spark({ data, color, w = 240, h = 48 }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 4 - ((v - min) / span) * (h - 8)}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block", maxWidth: "100%" }} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
const AGE_BUCKETS = [
  { key: "current", label: "Not yet due", max: 0 },
  { key: "b30", label: "1–30 days", max: 30 },
  { key: "b60", label: "31–60 days", max: 60 },
  { key: "b90", label: "61–90 days", max: 90 },
  { key: "b120", label: "91–120 days", max: 120 },
  { key: "b120p", label: "120+ days", max: Infinity },
];
function ageBucketOf(days) { return AGE_BUCKETS.find((b) => days <= b.max) || AGE_BUCKETS[5]; }

function ReportsTab({ clients, settings, onOpen }) {
  const k = useMemo(() => computeKpis(clients, settings), [clients, settings]);
  const owed = useMemo(() => topOwed(clients, 15), [clients]);
  const byCo = useMemo(() => { const m = {}; for (const c of clients) if (c.chargeoverId) m[c.chargeoverId] = c; return m; }, [clients]);
  const [snaps, setSnaps] = useState(null);
  const [ar, setAr] = useState(null); // null → not requested · "loading" · {invoices} · {error}
  useEffect(() => {
    fetch("/api/reports").then((r) => r.json()).then((d) => setSnaps(d.snapshots || [])).catch(() => setSnaps([]));
  }, []);
  const cur = settings.currency;
  const panel = { background: C.panel, borderRadius: 12, border: `1px solid ${C.line}`, padding: 14 };
  const h2 = { fontFamily: DISPLAY, fontSize: 15, fontWeight: 600, marginBottom: 8 };
  const th = { textAlign: "left", color: C.sub, fontWeight: 600, fontSize: 11, padding: "4px 10px 4px 0", borderBottom: `1px solid ${C.line}`, textTransform: "uppercase", letterSpacing: "0.04em" };
  const td = { padding: "5px 10px 5px 0", borderBottom: `1px solid ${C.lineSoft}`, fontSize: 12.5 };

  const loadAr = () => {
    setAr("loading");
    fetch("/api/reports/ar").then((r) => r.json()).then((d) => setAr(d.error ? { error: d.error } : d)).catch((e) => setAr({ error: String(e) }));
  };
  const arRows = useMemo(() => {
    if (!ar?.invoices) return null;
    const today = new Date();
    return ar.invoices.map((inv) => {
      const due = parseDate(inv.dueDate);
      const days = due ? Math.floor((today - due) / 86400000) : 0;
      const client = byCo[inv.customerId];
      return { ...inv, days: Math.max(0, days), bucket: ageBucketOf(Math.max(0, days)), client };
    }).sort((a, b) => b.days - a.days || b.balance - a.balance);
  }, [ar, byCo]);
  const exportAr = () => {
    const csv = Papa.unparse(arRows.map((r) => csvSafeRow({
      client: r.client ? (r.client.company || r.client.name) : `CO customer ${r.customerId}`,
      invoice: r.number, invoiceDate: r.date, dueDate: r.dueDate,
      total: r.total, balance: r.balance, daysOverdue: r.days, bucket: r.bucket.label,
    })));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `ar-ageing-${iso()}.csv`;
    a.click();
  };

  return (
    <div className="grid" style={{ gap: 12 }}>
      {/* KPI cards — every figure comes from computeKpis, same as the header strip */}
      <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        <Stat label="Monthly recurring revenue" value={money(k.mrr, cur)} sub={`billing packages · ${k.mrrKnown}/${k.totalClients} amounts known`} accent={C.green} />
        <Stat label="Annual recurring revenue" value={money(k.arr, cur)} sub="MRR × 12" accent={C.green} />
        <Stat label="Total owed" value={money(k.totalOwed, cur)} sub={`${k.overdue} clients in arrears`} accent={k.totalOwed ? C.red : C.green} />
        <Stat label="Final notice" value={String(k.finalNotice)} sub="3+ periods behind" accent={k.finalNotice ? C.red : C.green} />
        <Stat label="Not up to date" value={String(k.notUpToDate)} sub="per ChargeOver status" accent={k.notUpToDate ? C.red : C.green} />
        <Stat label="Follow-ups" value={String(k.followUps)} sub="to contact / awaiting reply" accent={k.followUps ? C.amber : C.green} />
        <Stat label="Active paying clients" value={String(k.activeClients)} sub={`of ${k.totalClients} cards`} accent={C.action} />
        <Stat label="ChargeOver synced" value={`${k.synced}/${k.totalClients}`} sub="cards with a live balance" accent={C.action} />
      </section>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        {/* Trends from daily snapshots */}
        <section style={panel}>
          <div style={h2}>Trends</div>
          {snaps === null ? <div style={{ fontSize: 12, color: C.faint }}>Loading…</div>
            : snaps.length < 2 ? (
              <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.5 }}>
                Trends build from the daily 06:30 snapshot job. {snaps.length === 0 ? "No snapshots yet — lines appear after it has run for a couple of days." : "One snapshot so far — lines appear tomorrow."}
              </div>
            ) : (
              <div className="grid" style={{ gap: 10 }}>
                <div>
                  <div style={{ fontSize: 11, color: C.sub, marginBottom: 2 }}>MRR · {money(snaps[snaps.length - 1].mrr, cur)}</div>
                  <Spark data={snaps.map((s) => s.mrr)} color={C.green} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: C.sub, marginBottom: 2 }}>Total owed · {money(snaps[snaps.length - 1].totalOwed, cur)}</div>
                  <Spark data={snaps.map((s) => s.totalOwed)} color={C.red} />
                </div>
                <div style={{ fontSize: 10.5, color: C.faint }}>{snaps.length} daily snapshots since {fmtDate(snaps[0].date)}</div>
              </div>
            )}
        </section>

        {/* Composition */}
        <section style={panel}>
          <div style={h2}>Clients by segment</div>
          {Object.entries(SEGMENTS).map(([key, s]) => (
            <div key={key} className="flex items-center" style={{ gap: 8, padding: "3px 0", fontSize: 12.5 }}>
              <span style={{ width: 7, height: 7, borderRadius: 7, background: s.color, flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{s.label}</span>
              <span style={{ fontFamily: MONO, fontWeight: 600 }}>{k.bySegment[key] || 0}</span>
            </div>
          ))}
          <div style={{ ...h2, marginTop: 12 }}>Workflow stages</div>
          {STAGE_ORDER.map((key) => (
            <div key={key} className="flex items-center" style={{ gap: 8, padding: "3px 0", fontSize: 12.5 }}>
              <span style={{ width: 7, height: 7, borderRadius: 7, background: STAGES[key].color, flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{STAGES[key].label}</span>
              <span style={{ fontFamily: MONO, fontWeight: 600 }}>{k.byStage[key] || 0}</span>
            </div>
          ))}
        </section>
      </div>

      {/* Largest balances — the chase list */}
      <section style={panel}>
        <div style={h2}>Largest outstanding balances</div>
        {owed.length === 0 ? <div style={{ fontSize: 12.5, color: C.sub }}>No outstanding balances.</div> : (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr><th style={th}>Client</th><th style={th}>Segment</th><th style={th}>Behind</th><th style={{ ...th, textAlign: "right" }}>Owed</th></tr></thead>
            <tbody>
              {owed.map(({ c, owed: o }) => (
                <tr key={c.id} onClick={() => onOpen(c.id)} style={{ cursor: "pointer" }} title="Open client">
                  <td style={{ ...td, fontWeight: 600 }}>{c.company || c.name}</td>
                  <td style={td}>{SEGMENTS[c.segment]?.label || c.segment}</td>
                  <td style={td}>{arrearsPeriods(c)} period{arrearsPeriods(c) === 1 ? "" : "s"}</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: MONO, fontWeight: 600, color: C.red }}>{money(totalOwed(c), c.currency || cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* AR ageing — live from ChargeOver, loaded on demand */}
      <section style={panel}>
        <div className="flex items-center" style={{ gap: 10, marginBottom: 8 }}>
          <div style={{ ...h2, marginBottom: 0, flex: 1 }}>Invoice ageing</div>
          {arRows && <MiniBtn onClick={exportAr}>Export CSV</MiniBtn>}
          {ar === null && <MiniBtn solid onClick={loadAr}>Load from ChargeOver</MiniBtn>}
        </div>
        {ar === null && <div style={{ fontSize: 12.5, color: C.sub }}>Fetches every unpaid invoice with its due date. On demand — it queries ChargeOver directly.</div>}
        {ar === "loading" && <div style={{ fontSize: 12.5, color: C.sub }}>Fetching open invoices…</div>}
        {ar?.error && <div style={{ fontSize: 12.5, color: C.red }}>{ar.error}</div>}
        {arRows && (
          <>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginBottom: 12 }}>
              {AGE_BUCKETS.map((b) => {
                const rows = arRows.filter((r) => r.bucket.key === b.key);
                const sum = rows.reduce((a, r) => a + r.balance, 0);
                return <Stat key={b.key} label={b.label} value={money(sum, cur)} sub={`${rows.length} invoice${rows.length === 1 ? "" : "s"}`} accent={b.key === "current" ? C.green : b.key === "b30" ? C.amber : C.red} />;
              })}
            </div>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr><th style={th}>Client</th><th style={th}>Invoice</th><th style={th}>Due</th><th style={th}>Days over</th><th style={{ ...th, textAlign: "right" }}>Balance</th></tr></thead>
              <tbody>
                {arRows.slice(0, 200).map((r, i) => (
                  <tr key={`${r.number}-${i}`} onClick={r.client ? () => onOpen(r.client.id) : undefined} style={{ cursor: r.client ? "pointer" : "default" }}>
                    <td style={{ ...td, fontWeight: 600, color: r.client ? C.ink : C.faint }}>{r.client ? (r.client.company || r.client.name) : `CO customer ${r.customerId} — no card`}</td>
                    <td style={{ ...td, fontFamily: MONO }}>{r.number}</td>
                    <td style={td}>{fmtDate(r.dueDate)}</td>
                    <td style={{ ...td, fontFamily: MONO, color: r.days > 30 ? C.red : r.days > 0 ? C.amber : C.sub }}>{r.days || "—"}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: MONO, fontWeight: 600 }}>{r.currency}{r.balance.toLocaleString("en-GB", { maximumFractionDigits: 2 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {arRows.length > 200 && <div style={{ fontSize: 10.5, color: C.faint, marginTop: 6 }}>Showing 200 of {arRows.length} — export the CSV for the full list.</div>}
          </>
        )}
      </section>
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
  // Menu is portalled to <body> with fixed coords: absolute positioning gets
  // trapped by the archived rows' opacity stacking context and clipped by the
  // table's overflow, so it wouldn't overlay the rows below.
  const [menu, setMenu] = useState(null); // null | {top, right}
  const toggle = (e) => {
    if (menu) { setMenu(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  };
  return (
    <div style={{ position: "relative", display: "inline-block" }} onClick={(e) => e.stopPropagation()}>
      <button onClick={toggle} title="Email this client" aria-label={`Email ${client.company || client.name}`}
        style={{ background: "none", border: "none", cursor: "pointer", color: C.action, padding: 4, display: "inline-flex", borderRadius: 6 }}
        onMouseEnter={(e) => (e.currentTarget.style.background = C.lineSoft)} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>
      </button>
      {menu && createPortal(
        <>
          <div onClick={() => setMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 120 }} />
          <div style={{ position: "fixed", top: menu.top, right: menu.right, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(34,48,76,0.18)", zIndex: 121, minWidth: 190, overflow: "hidden" }}>
            {Object.entries(templates).map(([k, v]) => (
              <button key={k} onClick={() => { onPick(k); setMenu(null); }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", fontSize: 12.5, fontWeight: 500, background: "none", border: "none", cursor: "pointer", color: C.ink }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.lineSoft)} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                {v.label}
              </button>
            ))}
          </div>
        </>,
        document.body
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

// One client row, memoized: with hundreds of clients, typing in the detail
// drawer only re-renders the edited client's row instead of the whole table.
const ClientRow = React.memo(function ClientRow({ c, settings, templates, gridCols, onOpen, onEmail, onUpdate, onUpdateWithLog }) {
  const behind = arrearsPeriods(c);
  const cur = c.currency || settings.currency;
  // Plain left-click opens the drawer in-page; right/cmd/middle-click on the
  // company-name link lets the browser open ?client=<id> in a new tab/window.
  const openInPage = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
    e.preventDefault();
    onOpen(c.id);
  };
  return (
    <div role="button" tabIndex={0} onClick={openInPage} onKeyDown={(e) => { if (e.key === "Enter") onOpen(c.id); }} style={{ borderBottom: `1px solid ${C.lineSoft}`, cursor: "pointer", padding: "11px 16px", display: "grid", gridTemplateColumns: gridCols, gap: 20, alignItems: "center", opacity: c.archivedClient ? 0.55 : 1 }}>
      <div style={{ minWidth: 0 }}>
        <div className="flex items-center" style={{ gap: 7, flexWrap: "wrap" }}>
          <span style={{ width: 6, height: 6, borderRadius: 6, background: SEGMENTS[c.segment].color, flexShrink: 0 }} />
          <a href={`?client=${c.id}`} onClick={openInPage} title={`${c.company || c.name} — right-click to open in a new tab`} style={{ fontSize: 14, fontWeight: 600, color: "inherit", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{c.company || c.name}</a>
          {c.emailStatus !== "ok" && <MiniPill fg={C.red} bg={C.redBg}>bounced</MiniPill>}
          {followUpDue(c) && <MiniPill fg={C.amber} bg={C.amberBg}>follow up</MiniPill>}
          {behind >= 3 && <MiniPill fg="#fff" bg={C.red}>final notice</MiniPill>}
          {c.priceMode === "group" && c.groupBillingMaster && <MiniPill fg="#3B5BA5" bg="#E7EDF8">group card</MiniPill>}
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
        {coveredByGroup(c)
          ? <div style={{ fontFamily: MONO, fontSize: 13, color: C.faint, fontWeight: 600 }} title="Billed via the group card">via group</div>
          : behind >= 1
            ? <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, color: C.red }}>{money(totalOwed(c), cur)}<span style={{ fontSize: 11, color: C.faint, fontWeight: 500 }}> · {behind}p</span></div>
            : needsReminder(c)
              ? <div style={{ fontFamily: MONO, fontSize: 13, color: C.red, fontWeight: 600 }}>balance due</div>
              : <div style={{ fontFamily: MONO, fontSize: 13, color: C.green, fontWeight: 600 }}>current</div>}
        {!coveredByGroup(c) && Number(c.amount) > 0 && <div style={{ fontSize: 11, color: C.faint, fontFamily: MONO }}>{money(c.amount, cur)}/{c.cadence === "annual" ? "yr" : "mo"}</div>}
      </div>
      <div style={{ textAlign: "right" }}>
        <EmailIconMenu client={c} templates={templates} onPick={(type) => onEmail(c.id, type)} />
      </div>
    </div>
  );
});

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
  const [showOffices, setShowOffices] = useState(false); // grouped offices live behind this toggle
  const activeCount = [seg, bill, stage, co, mp, vc, owed].filter((v) => v !== "all").length + (q.trim() ? 1 : 0);
  const clearAll = () => { setSeg("all"); setBill("all"); setStage("all"); setCo("all"); setMp("all"); setVc("all"); setOwed("all"); setQ(""); };
  const list = useMemo(() => {
    let l = clients.filter((c) => (showArchived ? c.archivedClient : !c.archivedClient));
    // Offices covered by a group card stay off the main list — the group card
    // represents them. The Multi-offices toggle flips to showing just them.
    l = l.filter((c) => (showOffices ? c.multiOffice && !c.groupBillingMaster : !coveredByGroup(c)));
    if (seg !== "all") l = l.filter((c) => c.segment === seg);
    if (bill !== "all") l = l.filter((c) => c.billingStatus === bill);
    if (stage !== "all") l = l.filter((c) => c.stage === stage);
    if (co !== "all") l = l.filter((c) => (co === "yes" ? !!c.inChargeOver : !c.inChargeOver));
    if (mp !== "all") l = l.filter((c) => (mp === "yes" ? !!c.maritzPortal : !c.maritzPortal));
    if (vc !== "all") l = l.filter((c) => (vc === "past" ? c.segment === "viper-past" : vc === "yes" ? !!c.viperCustomer : !c.viperCustomer));
    if (owed !== "all") l = l.filter((c) => (owed === "overdue" ? arrearsPeriods(c) >= 1 : arrearsPeriods(c) === 0));
    if (q.trim()) {
      const k = q.toLowerCase();
      l = l.filter((c) =>
        c.name.toLowerCase().includes(k) || (c.email || "").toLowerCase().includes(k) ||
        (c.company || "").toLowerCase().includes(k) || (c.chargeoverId || "").toLowerCase().includes(k) ||
        (c.archivedContacts || []).some((a) => (a.email || "").toLowerCase().includes(k)));
    }
    return [...l].sort((a, b) => arrearsPeriods(b) - arrearsPeriods(a) || a.name.localeCompare(b.name));
  }, [clients, seg, bill, stage, co, mp, vc, owed, q, showArchived, showOffices]);
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
        <label className="flex items-center" title="Show the individual offices that sit inside multi-office groups" style={{ gap: 6, fontSize: 12.5, color: C.sub, cursor: "pointer" }}>
          <input type="checkbox" checked={showOffices} onChange={(e) => setShowOffices(e.target.checked)} /> Multi-offices
        </label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" title="Searches name, company, email, old emails and ChargeOver ID"
          style={{ fontSize: 13, padding: "8px 12px", borderRadius: 8, border: `1px solid ${q.trim() ? C.action : C.line}`, background: C.panel, outline: "none", minWidth: 320 }} />
      </div>
      <div className="crm-table" style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 16px", background: C.lineSoft, borderBottom: `1px solid ${C.line}`, display: "grid", gridTemplateColumns: gridCols, gap: 20, alignItems: "center" }}>
          <HeaderFilter label="Client" value={seg} onChange={setSeg} options={Object.entries(SEGMENTS).map(([k, v]) => [k, v.label])} />
          <HeaderFilter label="Billing" value={bill} onChange={setBill} align="center" options={Object.entries(BILLING).map(([k, v]) => [k, v.label])} />
          <HeaderFilter label="Stage" value={stage} onChange={setStage} align="center" options={STAGE_ORDER.map((k) => [k, STAGES[k].label])} />
          <HeaderFilter label="In ChargeOver" value={co} onChange={setCo} align="center" options={[["yes", "Yes"], ["no", "No"]]} />
          <HeaderFilter label="Maritz Portal" value={mp} onChange={setMp} align="center" options={[["yes", "Yes"], ["no", "No"]]} />
          <HeaderFilter label="Viper Customer" value={vc} onChange={setVc} align="center" options={[["yes", "Yes"], ["no", "No"], ["past", "Past Viper Customer"]]} />
          <HeaderFilter label="Owed / rate" value={owed} onChange={setOwed} align="right" options={[["overdue", "Overdue"], ["current", "Up to date"]]} />
          <span />
        </div>
        {list.map((c) => (
          <ClientRow key={c.id} c={c} settings={settings} templates={templates} gridCols={gridCols}
            onOpen={onOpen} onEmail={onEmail} onUpdate={onUpdate} onUpdateWithLog={onUpdateWithLog} />
        ))}
        {list.length === 0 && <div style={{ padding: 32, textAlign: "center", color: C.sub, fontSize: 13 }}>No clients match these filters.</div>}
      </div>
    </div>
  );
}

/* --------------------------- Workflow tab --------------------------- */
function WorkflowTab({ clients, allClients, user, onOpen, onStage, onUpdate }) {
  const [board, setBoard] = useState("stages"); // stages | tasks
  const [mine, setMine] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [dragOverStage, setDragOverStage] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [staff, setStaff] = useState([]);
  useEffect(() => {
    fetch("/api/tasks").then((r) => r.json()).then((d) => setTasks(d.tasks || [])).catch(() => {});
    fetch("/api/staff").then((r) => r.json()).then((d) => setStaff(d.staff || [])).catch(() => {});
  }, []);
  const staffByEmail = useMemo(() => Object.fromEntries(staff.map((s) => [s.email, s.name || s.email])), [staff]);
  const taskCount = useMemo(() => { const m = {}; for (const t of tasks) if (t.client_id && t.lane !== "done") m[t.client_id] = (m[t.client_id] || 0) + 1; return m; }, [tasks]);

  const hiddenCount = clients.filter((c) => c.workflowHidden).length;
  let visible = clients.filter((c) => (showHidden ? c.workflowHidden : !c.workflowHidden) && !coveredByGroup(c));
  if (mine) visible = visible.filter((c) => c.owner === user.email);

  const drop = (e, stage) => {
    e.preventDefault();
    setDragOverStage(null);
    const id = e.dataTransfer.getData("text/plain");
    if (id) onStage(id, stage);
  };
  const segBtn = (key, label) => (
    <button onClick={() => setBoard(key)} style={{ padding: "6px 14px", fontSize: 13, fontWeight: 600, border: "none", background: board === key ? C.brand : "transparent", color: board === key ? C.brandInk : C.sub, cursor: "pointer" }}>{label}</button>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 9, overflow: "hidden" }}>
          {segBtn("stages", "Client stages")}
          {segBtn("tasks", "Tasks")}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.sub, cursor: "pointer" }}>
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> My cards
        </label>
      </div>

      {board === "tasks" ? (
        <TasksBoard tasks={tasks} setTasks={setTasks} staff={staff} staffByEmail={staffByEmail} clients={allClients} user={user} onOpen={onOpen} mine={mine} />
      ) : (
      <>
      {(hiddenCount > 0 || showHidden) && (
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.sub, cursor: "pointer", marginBottom: 12, width: "fit-content" }}>
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          {showHidden ? `Showing ${hiddenCount} removed from workflow` : `${hiddenCount} removed from workflow — show`}
        </label>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, alignItems: "start" }}>
        {/* "Up to date" cards leave the board automatically, so no column for it —
            EXCEPT in the removed-from-workflow view, where most hidden cards live */}
        {STAGE_ORDER.filter((s) => showHidden || s !== "up-to-date").map((stage) => {
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
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{c.company || c.name}</span>
                        {c.flag && <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 20, background: CLIENT_FLAGS[c.flag].bg, color: CLIENT_FLAGS[c.flag].fg }}>{CLIENT_FLAGS[c.flag].label}</span>}
                      </div>
                      <div style={{ fontSize: 11, color: C.sub, fontFamily: MONO }}>{SEGMENTS[c.segment].label}{arrearsPeriods(c) ? ` · ${arrearsPeriods(c)}p behind` : ""}</div>
                      {c.followUp && <div style={{ fontSize: 10.5, color: followUpDue(c) ? C.amber : C.faint, marginTop: 2 }}>Follow up {fmtDate(c.followUp)}</div>}
                      {c.stage === "contacted-awaiting" && (() => {
                        const t = parseDate(c.stageAt) || parseDate(c.createdAt);
                        const left = t ? Math.max(0, 10 - Math.floor((Date.now() - t) / 86400000)) : 10;
                        return <div style={{ fontSize: 10.5, color: left <= 2 ? C.amber : C.faint, marginTop: 2 }}>Contacted {fmtDate(c.stageAt || c.createdAt)} · returns to Need to contact in {left}d</div>;
                      })()}
                      {(c.owner || taskCount[c.id]) && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5 }}>
                          {taskCount[c.id] > 0 && <span style={{ fontSize: 10.5, color: C.sub }}>{taskCount[c.id]} task{taskCount[c.id] > 1 ? "s" : ""}</span>}
                          <span style={{ flex: 1 }} />
                          {c.owner && <Avatar email={c.owner} staffByEmail={staffByEmail} size={18} />}
                        </div>
                      )}
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
      </>
      )}
    </div>
  );
}

/* Tasks board — free-form project/campaign cards in To do / Doing / Done lanes,
   each optionally owned, labelled, dated, and linked to a client. */
function TasksBoard({ tasks, setTasks, staff, staffByEmail, clients, user, onOpen, mine }) {
  const [dragOver, setDragOver] = useState(null);
  const [editing, setEditing] = useState(null);
  const [addingLane, setAddingLane] = useState(null);
  const [draft, setDraft] = useState("");
  const clientById = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c])), [clients]);
  const shown = mine ? tasks.filter((t) => t.owner === user.email) : tasks;

  const api = async (url, method, body) => {
    const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return r.ok ? r.json().catch(() => null) : null;
  };
  const create = async (lane) => {
    const title = draft.trim();
    setAddingLane(null); setDraft("");
    if (!title) return;
    const d = await api("/api/tasks", "POST", { title, lane, owner: user.email });
    if (d?.task) setTasks((t) => [d.task, ...t]);
  };
  const save = async (id, body) => {
    const d = await api(`/api/tasks/${id}`, "PATCH", body);
    if (d?.task) setTasks((t) => t.map((x) => (x.id === id ? d.task : x)));
  };
  const move = async (id, lane) => {
    setTasks((t) => t.map((x) => (x.id === id ? { ...x, lane } : x))); // optimistic
    save(id, { lane });
  };
  const del = async (id) => { setTasks((t) => t.filter((x) => x.id !== id)); setEditing(null); await api(`/api/tasks/${id}`, "DELETE"); };
  const drop = (e, lane) => { e.preventDefault(); setDragOver(null); const id = e.dataTransfer.getData("text/plain"); if (id) move(id, lane); };

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, alignItems: "start" }}>
        {TASK_LANES.map(([lane, label]) => {
          const col = shown.filter((t) => t.lane === lane);
          return (
            <div key={lane}
              onDragOver={(e) => { e.preventDefault(); if (dragOver !== lane) setDragOver(lane); }}
              onDragLeave={() => setDragOver((s) => (s === lane ? null : s))}
              onDrop={(e) => drop(e, lane)}
              style={{ background: C.panel, borderRadius: 12, border: `1px solid ${dragOver === lane ? C.action : C.line}`, overflow: "hidden" }}>
              <div style={{ padding: "10px 12px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ width: 8, height: 8, borderRadius: 8, background: LANE_COLOR[lane] }} />
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>{label}</span>
                <span style={{ fontSize: 11, color: C.faint, marginLeft: "auto", fontFamily: MONO }}>{col.length}</span>
              </div>
              <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6, minHeight: 60 }}>
                {col.map((t) => (
                  <TaskCard key={t.id} task={t} client={clientById[t.client_id]} staffByEmail={staffByEmail}
                    onOpen={() => setEditing(t)} onClient={onOpen}
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)} />
                ))}
                {addingLane === lane ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <textarea autoFocus rows={2} value={draft} onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); create(lane); } if (e.key === "Escape") { setAddingLane(null); setDraft(""); } }}
                      placeholder="Task title — Enter to add" style={{ ...inputStyle, fontSize: 12.5, resize: "vertical" }} />
                    <div style={{ display: "flex", gap: 6 }}>
                      <MiniBtn solid onClick={() => create(lane)}>Add</MiniBtn>
                      <MiniBtn onClick={() => { setAddingLane(null); setDraft(""); }}>Cancel</MiniBtn>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setAddingLane(lane); setDraft(""); }}
                    style={{ background: "none", border: "none", textAlign: "left", fontSize: 12, color: C.faint, cursor: "pointer", padding: "4px 2px" }}>+ Add a card</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {editing && <TaskModal task={editing} staff={staff} clients={clients} onClose={() => setEditing(null)}
        onSave={(body) => { save(editing.id, body); setEditing(null); }} onDelete={() => del(editing.id)} />}
    </>
  );
}

function TaskCard({ task, client, staffByEmail, onOpen, onClient, onDragStart }) {
  const lbl = TASK_LABELS[task.label];
  const overdue = task.due && task.lane !== "done" && new Date(task.due) < new Date(new Date().toDateString());
  return (
    <div draggable onDragStart={onDragStart} onClick={onOpen}
      style={{ background: C.paper, borderRadius: 8, border: `1px solid ${overdue ? C.red : C.line}`, padding: "8px 9px", cursor: "pointer" }}>
      {lbl && <span style={{ display: "inline-block", fontSize: 10.5, fontWeight: 600, padding: "1px 7px", borderRadius: 20, background: lbl.bg, color: lbl.fg }}>{lbl.label}</span>}
      <div style={{ fontSize: 12.5, marginTop: lbl ? 5 : 0, color: C.ink, lineHeight: 1.3, opacity: task.lane === "done" ? 0.6 : 1, textDecoration: task.lane === "done" ? "line-through" : "none" }}>{task.title}</div>
      {task.note && <div style={{ fontSize: 10.5, color: C.sub, marginTop: 3, lineHeight: 1.3 }}>{task.note}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7 }}>
        {client && (
          <button onClick={(e) => { e.stopPropagation(); onClient(client.id); }} title="Open client"
            style={{ fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 6, background: "#E7EDF8", color: C.action, border: "none", cursor: "pointer", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {client.company || client.name}
          </button>
        )}
        <span style={{ flex: 1 }} />
        {task.due && <span style={{ fontSize: 10, color: overdue ? C.red : C.faint }}>{fmtDate(task.due)}</span>}
        {task.owner && <Avatar email={task.owner} staffByEmail={staffByEmail} size={18} />}
      </div>
    </div>
  );
}

function TaskModal({ task, staff, clients, onClose, onSave, onDelete }) {
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note || "");
  const [owner, setOwner] = useState(task.owner || "");
  const [label, setLabel] = useState(task.label || "");
  const [due, setDue] = useState(task.due || "");
  const [clientId, setClientId] = useState(task.client_id || "");
  const [confirmDel, setConfirmDel] = useState(false);
  return (
    <Modal title="Task" onClose={onClose}>
      <Field label="Title"><input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Note"><textarea rows={2} style={{ ...inputStyle, resize: "vertical" }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional detail — contact, next step…" /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Owner">
          <select style={inputStyle} value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Unassigned</option>
            {staff.map((s) => <option key={s.email} value={s.email}>{s.name || s.email}</option>)}
          </select>
        </Field>
        <Field label="Label">
          <select style={inputStyle} value={label} onChange={(e) => setLabel(e.target.value)}>
            <option value="">None</option>
            {Object.entries(TASK_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Due date"><input type="date" style={inputStyle} value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="Linked client"><ClientPicker clients={clients} value={clientId} onChange={setClientId} /></Field>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
        {confirmDel ? (
          <>
            <span style={{ fontSize: 12, color: C.red }}>Delete this task?</span>
            <button onClick={onDelete} style={{ fontSize: 12.5, fontWeight: 600, padding: "8px 12px", borderRadius: 8, border: "none", background: C.red, color: "#fff", cursor: "pointer" }}>Delete</button>
            <button onClick={() => setConfirmDel(false)} style={{ fontSize: 12.5, color: C.sub, background: "none", border: "none", cursor: "pointer" }}>Cancel</button>
          </>
        ) : (
          <button onClick={() => setConfirmDel(true)} style={{ fontSize: 12.5, fontWeight: 600, color: C.red, background: "none", border: "none", cursor: "pointer" }}>Delete task</button>
        )}
        <span style={{ flex: 1 }} />
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <SolidBtn onClick={() => title.trim() && onSave({ title: title.trim(), note, owner, label, due, clientId })}>Save</SolidBtn>
      </div>
    </Modal>
  );
}

// Type-ahead picker for linking a task to a client (there are hundreds).
function ClientPicker({ clients, value, onChange }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const selected = clients.find((c) => c.id === value);
  const matches = q.trim() ? clients.filter((c) => (c.company || c.name || "").toLowerCase().includes(q.toLowerCase())).slice(0, 8) : [];
  if (selected && !open) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 38 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, padding: "3px 8px", borderRadius: 6, background: "#E7EDF8", color: C.action, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected.company || selected.name}</span>
        <button onClick={() => onChange("")} title="Unlink" style={{ background: "none", border: "none", color: C.faint, cursor: "pointer", fontSize: 13 }}>✕</button>
        <button onClick={() => setOpen(true)} style={{ background: "none", border: "none", color: C.action, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>change</button>
      </div>
    );
  }
  return (
    <div style={{ position: "relative" }}>
      <input style={inputStyle} value={q} autoFocus={open} onChange={(e) => { setQ(e.target.value); setOpen(true); }} placeholder="Search clients…" />
      {open && matches.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, marginTop: 4, zIndex: 5, overflow: "hidden", boxShadow: "0 8px 24px rgba(34,48,76,0.14)" }}>
          {matches.map((c) => (
            <button key={c.id} onClick={() => { onChange(c.id); setQ(""); setOpen(false); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 11px", fontSize: 12.5, background: "none", border: "none", cursor: "pointer", color: C.ink }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.lineSoft)} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              {c.company || c.name}
            </button>
          ))}
        </div>
      )}
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
        <div className="flex items-center" style={{ gap: 8 }}>
          <SolidBtn onClick={run}>{busy ? "Searching…" : client.candidates?.length ? "Search again" : "Find alternative contact"}</SolidBtn>
          <button onClick={() => onUpdate(client.id, { emailStatus: "ok", candidates: [], activity: logActivity(client, "contact", "Removed from contact recovery — email marked deliverable") })}
            title="Remove from this list (marks the email deliverable again)" aria-label="Remove from recovery list"
            style={{ background: "none", border: "none", color: C.faint, fontSize: 16, cursor: "pointer", lineHeight: 1, padding: 4, borderRadius: 6 }}
            onMouseEnter={(e) => (e.currentTarget.style.color = C.red)} onMouseLeave={(e) => (e.currentTarget.style.color = C.faint)}>
            ✕
          </button>
        </div>
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
// Latest email sent to this client THIS PERIOD, any template type — the queue's
// "already emailed" signal (per-type keys alone hide sends made with other templates).
function periodSent(c) {
  const suffix = `:${periodKey()}`;
  let best = null;
  for (const [k, v] of Object.entries(c.reminders || {})) {
    if (!v?.sentAt || !k.endsWith(suffix)) continue;
    if (!best || v.sentAt > best.sentAt) best = v;
  }
  return best;
}
function CommsTab({ clients, settings, templates, onLogSent, onOpen, onSent, signatureImage, onUpdateWithLog }) {
  const [type, setType] = useState("reminder");
  const [selId, setSelId] = useState(null);
  const [aud, setAud] = useState("auto"); // auto | bill:<status> | grp:maritz | grp:viper
  const [q, setQ] = useState("");
  const [view, setView] = useState("compose"); // compose | sent
  const [sq, setSq] = useState("");
  const [mailView, setMailView] = useState(null); // {c, mail} — popup of a sent email
  const key = `${type}:${periodKey()}`;

  // Every sent email across all clients, newest first — the tab's sent archive.
  const sentEmails = useMemo(() =>
    clients.flatMap((c) => Object.entries(c.reminders || {})
      .filter(([, v]) => v.sentAt)
      .map(([k, v]) => ({ c, k, v })))
      .sort((a, b) => new Date(b.v.sentAt) - new Date(a.v.sentAt)),
    [clients]);
  const sentFiltered = useMemo(() => {
    const k = sq.trim().toLowerCase();
    if (!k) return sentEmails;
    return sentEmails.filter(({ c, v }) =>
      [c.company, c.name, c.email, v.subject, v.body, v.label].some((s) => (s || "").toLowerCase().includes(k)));
  }, [sentEmails, sq]);

  const [fullAudience, skipped] = useMemo(() => {
    let l;
    if (aud !== "auto") {
      // Explicit audience: a billing status, or a customer group.
      l = clients.filter((c) =>
        aud === "grp:maritz" ? c.maritzPortal :
        aud === "grp:viper" ? c.viperCustomer :
        // billable multi-office entities: group cards + independently billed offices
        aud === "grp:multi" ? c.multiOffice && (c.groupBillingMaster || c.priceMode !== "group") :
        c.billingStatus === aud.slice(5));
      l = [...l].sort((a, b) => arrearsPeriods(b) - arrearsPeriods(a) || (a.company || a.name).localeCompare(b.company || b.name));
    } else if (type === "deletion") {
      l = clients.filter((c) => c.stage === "marked-deletion" || c.billingStatus === "marked-deletion");
    } else {
      l = clients.filter((c) => c.stage !== "marked-deletion");
      if (type === "reminder") l = [...l.filter((c) => needsReminder(c))].sort((a, b) => arrearsPeriods(b) - arrearsPeriods(a));
      if (type === "price") l = l.filter((c) => c.billingStatus === "old-pricing" && !c.tags.includes("price-declined"));
    }
    // Emailed-this-period cards (any template) stay listed marked "Email sent";
    // "Done" without sending removes the card for the selected email type.
    l = l.filter((c) => periodSent(c) || !c.reminders?.[key]?.dismissedAt);
    const before = l.length;
    l = l.filter((c) => !c.tags.includes("opted-out") && c.emailStatus === "ok" && c.email);
    l = [...l.filter((c) => !periodSent(c)), ...l.filter((c) => periodSent(c))];
    return [l, before - l.length];
  }, [clients, type, aud, key]);

  // Search narrows the visible queue by company / contact / email.
  const audience = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return fullAudience;
    return fullAudience.filter((c) => (c.company || "").toLowerCase().includes(k) || (c.name || "").toLowerCase().includes(k) || (c.email || "").toLowerCase().includes(k));
  }, [fullAudience, q]);

  useEffect(() => { setSelId(null); }, [type]);
  const sentOf = (c) => periodSent(c)?.sentAt;
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

  if (view === "sent") {
    const shown = sentFiltered.slice(0, 150);
    return (
      <div>
        <div className="flex flex-wrap items-center" style={{ gap: 10, marginBottom: 14 }}>
          <GhostBtn onClick={() => setView("compose")}>← Back to compose</GhostBtn>
          <input value={sq} onChange={(e) => setSq(e.target.value)} placeholder="Search sent emails" autoFocus
            style={{ fontSize: 13, padding: "7px 11px", borderRadius: 8, border: `1px solid ${sq.trim() ? C.action : C.line}`, background: C.panel, outline: "none", minWidth: 220 }} />
          <span style={{ marginLeft: "auto", fontSize: 12.5, color: C.sub, fontFamily: MONO }}>
            {sq.trim() ? `${sentFiltered.length} of ${sentEmails.length}` : sentEmails.length} sent
          </span>
        </div>
        {shown.length === 0 ? (
          <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 40, textAlign: "center", color: C.sub, fontSize: 14 }}>
            {sq.trim() ? `No sent emails match “${sq.trim()}”.` : "No emails sent yet — copies appear here after you send."}
          </div>
        ) : (
          <div style={{ maxWidth: 760 }}>
            {shown.map(({ c, k, v }) => (
              <div key={`${c.id}:${k}`} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "8px 14px 4px", marginBottom: 8 }}>
                <button onClick={() => onOpen?.(c.id)} title="Open client"
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 13, fontWeight: 700, color: C.ink, textDecoration: "underline", textDecorationColor: C.lineSoft, textUnderlineOffset: 3 }}>
                  {c.company || c.name}
                </button>
                <SentCommRow tKey={k} v={v} />
              </div>
            ))}
            {sentFiltered.length > shown.length && (
              <p style={{ fontSize: 12, color: C.faint, textAlign: "center", margin: "12px 0 0" }}>Showing the {shown.length} most recent — search to narrow the rest.</p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center" style={{ gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 12.5, color: C.sub }}>Audience</span>
        <MiniSelect value={aud} onChange={setAud} options={[
          ["auto", `Suggested: ${audienceHint}`],
          ...Object.entries(BILLING).map(([k, v]) => [`bill:${k}`, v.label]),
          ["grp:maritz", "Maritz Portal customers"],
          ["grp:viper", "Viper Customers"],
          ["grp:multi", "Multi-office"],
        ]} />
        <MiniSelect value={type} onChange={setType} options={Object.entries(templates).map(([k, v]) => [k, v.label])} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search companies"
          style={{ fontSize: 13, padding: "7px 11px", borderRadius: 8, border: `1px solid ${q.trim() ? C.action : C.line}`, background: C.panel, outline: "none", minWidth: 180 }} />
        <span style={{ marginLeft: "auto", fontSize: 12.5, color: C.sub, fontFamily: MONO }}>
          {sentCount}/{fullAudience.length} sent this month{skipped ? ` · ${skipped} skipped (opted out / bounced / no email)` : ""}
        </span>
        <GhostBtn onClick={() => setView("sent")}>Sent emails ({sentEmails.length})</GhostBtn>
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
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 12px", cursor: "pointer", border: "none", borderBottom: `1px solid ${C.lineSoft}`, background: on ? "#E3EAF5" : "transparent", boxShadow: on ? `inset 0 0 0 1px ${C.accent}` : "none", opacity: sent ? 0.75 : 1 }}>
                  <div className="flex items-center justify-between" style={{ gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.company || c.name}</span>
                    {sent && <span style={{ color: C.green, fontSize: 12, flexShrink: 0 }} title={`Sent ${fmtDate(sent)}`}>✓</span>}
                  </div>
                  <div style={{ fontSize: 11, color: sent ? C.green : C.sub, fontWeight: sent ? 600 : 400, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {sent ? (
                      <span role="button" tabIndex={0} title="View the email that was sent"
                        onClick={(e) => { e.stopPropagation(); setMailView({ c, mail: periodSent(c) }); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setMailView({ c, mail: periodSent(c) }); } }}
                        style={{ cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}>
                        Email sent · {fmtDate(sent)}
                      </span>
                    ) : behind >= 1 ? `${money(totalOwed(c), c.currency || settings.currency)} · ${behind}p behind` : BILLING[c.billingStatus].label}
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
                <button onClick={() => {
                  onLogSent(client.id, key, { dismissedAt: new Date().toISOString() });
                  onUpdateWithLog?.(client.id, { stage: "contacted-awaiting" }, "stage", "Done in Emails, moved to Contacted · awaiting reply");
                  advance();
                }} title="Remove from this list and mark Contacted · awaiting reply"
                  style={{ marginLeft: "auto", fontSize: 13, fontWeight: 600, padding: "7px 14px", borderRadius: 8, border: "none", background: C.green, color: "#fff", cursor: "pointer" }}>
                  Done ✓
                </button>
              </div>
              <div style={{ fontSize: 12, color: C.sub, fontFamily: MONO, marginTop: 2 }}>{client.name} · {SEGMENTS[client.segment].label}</div>
            </div>
            {/* Sending auto-dismisses the card, so move straight to the next recipient. */}
            <EmailEditor key={`${client.id}:${type}`} client={client} settings={settings} type={type} templates={templates} onLogSent={onLogSent} onDone={advance} onSent={onSent} signatureImage={signatureImage} onUpdateWithLog={onUpdateWithLog}
              officeSiblings={client.officeGroup ? clients.filter((o) => o.id !== client.id && o.officeGroup === client.officeGroup) : []} />
          </div>
        </div>
      )}
      {mailView && (
        <Modal title={`${mailView.mail?.label || "Email"} · ${mailView.c.company || mailView.c.name}`} onClose={() => setMailView(null)}>
          <div style={{ fontSize: 12, color: C.sub, fontFamily: MONO, marginBottom: 10 }}>
            Sent {fmtDate(mailView.mail?.sentAt)}{mailView.mail?.via === "brevo" ? " · Brevo" : ""} · to {mailView.c.email || "—"}
          </div>
          <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{mailView.mail?.subject || "(no subject saved)"}</div>
            <div style={{ fontSize: 13, whiteSpace: "pre-wrap", color: C.sub, lineHeight: 1.5 }}>{mailView.mail?.body || "(message not saved)"}</div>
          </div>
        </Modal>
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
      const status = (inv.status || (inv.paid ? "Paid" : inv.overdue ? "Overdue" : "Open")).toLowerCase();
      lines.push(`${fmtDate(inv.date)} · #${inv.number} · ${status} · ${inv.currency}${(inv.total || 0).toLocaleString()}`);
    }
    return lines.join("\n");
  };
  return (
    <Section title="Past charges (ChargeOver)" action={state.invoices.length > 0 ? <CopyLink getText={copyText} /> : null}>
      {/* upcoming invoice from the active ChargeOver billing package */}
      {state.next?.date && (
        <div className="flex items-baseline justify-between" style={{ gap: 8, background: "#E7EDF8", borderRadius: 8, padding: "8px 12px", marginBottom: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "#3B5BA5" }}>Next invoice · {fmtDate(state.next.date)}</span>
          <span style={{ fontSize: 14, fontWeight: 700, fontFamily: MONO, color: "#3B5BA5" }}>{money(state.next.amount, client.currency || "USD")}</span>
        </div>
      )}
      {client.coBalance != null && (
        <div style={{ fontSize: 12.5, marginBottom: 8, color: owedBalance(client) > 0 ? C.red : C.green, fontWeight: 600 }}>
          Live balance: {money(client.coBalance, client.currency)}
          <span style={{ color: C.faint, fontWeight: 500 }}>
            {" "}· as of last sync{client.coOverdue != null && client.coBalance > client.coOverdue ? ` · ${money(client.coBalance - client.coOverdue, client.currency)} of this is an upcoming invoice, not yet due` : ""}
          </span>
        </div>
      )}
      {state.loading && <div style={{ fontSize: 12, color: C.faint }}>Loading from ChargeOver…</div>}
      {!state.loading && state.error && <div style={{ fontSize: 12, color: C.faint }}>{state.error === "ChargeOver not connected" ? "Connect ChargeOver to see charges." : "Couldn't load charges — try again."}</div>}
      {!state.loading && !state.error && state.invoices.length === 0 && <div style={{ fontSize: 12, color: C.faint }}>No charges on record.</div>}
      {state.invoices.map((inv) => (
        <div key={inv.id} className="flex items-center justify-between" style={{ fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.lineSoft}`, gap: 8 }}>
          <span style={{ fontFamily: MONO, color: C.sub }}>{fmtDate(inv.date)} · #{inv.number}</span>
          <span className="flex items-center" style={{ gap: 8 }}>
            <MiniPill
              fg={inv.voided ? C.faint : inv.paid ? C.green : inv.overdue ? C.red : C.amber}
              bg={inv.voided ? C.greyBg : inv.paid ? C.greenBg : inv.overdue ? C.redBg : C.amberBg}>
              {(inv.status || (inv.paid ? "Paid" : inv.overdue ? "Overdue" : "Open")).toLowerCase()}
            </MiniPill>
            <span style={{ fontFamily: MONO, fontWeight: 600 }}>{inv.currency}{(inv.total || 0).toLocaleString()}</span>
          </span>
        </div>
      ))}
      {state.invoices.length > 0 && <div style={{ fontSize: 11, color: C.faint, marginTop: 6 }}>{state.invoices.length} invoice{state.invoices.length > 1 ? "s" : ""} · live from ChargeOver</div>}
    </Section>
  );
}

// F-01: secret fields aren't shipped in the bulk load — the drawer fetches them
// on open (audited) and hydrates its client, so pricing/portal display + edits
// all work. Editing a secret keeps the local copy in sync so the hydrated view
// reflects it; the server preserves stored secrets on save regardless.
const SECRET_FIELDS = ["portalPassword", "adminPassword", "maritzPortalPassword", "maritzAdminPassword", "maritzUserLists", "userLists"];
function DetailDrawer({ client: rawClient, settings, onClose, onUpdate, onUpdateWithLog, onRecordPayment, onDelete, onDeleteAny, onUpdateSettings, officeSiblings = [], allClients = [], onOpen, onEmail, onAddClient, currentUser }) {
  const drawerTemplates = getTemplates(settings);
  const [staff, setStaff] = useState([]);
  useEffect(() => { fetch("/api/staff").then((r) => r.json()).then((d) => setStaff(d.staff || [])).catch(() => {}); }, []);
  const [secrets, setSecrets] = useState(null);
  useEffect(() => {
    let alive = true;
    setSecrets(null);
    fetch(`/api/clients/${rawClient.id}/secrets`).then((r) => r.json()).then((d) => { if (alive) setSecrets(d.secrets || {}); }).catch(() => { if (alive) setSecrets({}); });
    return () => { alive = false; };
  }, [rawClient.id]);
  const client = useMemo(() => (secrets ? { ...rawClient, ...secrets } : rawClient), [rawClient, secrets]);
  const set = (patch) => {
    onUpdate(rawClient.id, patch);
    const sp = {};
    for (const k of SECRET_FIELDS) if (k in patch) sp[k] = patch[k];
    if (Object.keys(sp).length) setSecrets((s) => ({ ...(s || {}), ...sp }));
  };
  const [showGroup, setShowGroup] = useState(false);
  // Apply a group-offices selection: the offices become covered members and
  // billing lives on a dedicated "<Name> (Group)" master card — reused if the
  // group already has one, created with a FRESH billing history otherwise.
  const applyGroup = (name, ids) => {
    // managing from the group card itself: members are just the ticked offices
    const isMaster = client.multiOffice && client.priceMode === "group" && client.groupBillingMaster;
    const memberIds = isMaster ? ids : [client.id, ...ids];
    // unchecked former members revert to standalone
    officeSiblings.filter((o) => !ids.includes(o.id)).forEach((o) =>
      onUpdate(o.id, { officeGroup: "", multiOffice: false, priceMode: "per-office", groupBillingMaster: false }));
    // every member joins covered — old office-masters get demoted too
    memberIds.forEach((id) => onUpdate(id, { officeGroup: name, multiOffice: true, priceMode: "group", groupBillingMaster: false }));
    const tiers = { ...GROUP_TIER_DEFAULTS, ...(settings.maritzGroupTiers || {}) };
    const tier = groupTierFor(memberIds.length, tiers);
    const existingMaster = isMaster ? client
      : allClients.find((c) => c.groupBillingMaster && c.priceMode === "group" && (c.officeGroup || "").trim().toLowerCase() === name.trim().toLowerCase() && !memberIds.includes(c.id));
    if (existingMaster) {
      onUpdateWithLog(existingMaster.id, { officeGroup: name, multiOffice: true, priceMode: "group", groupBillingMaster: true, amount: existingMaster.cadence === "annual" ? tier.y : tier.m },
        "group", `Group updated: ${memberIds.length} offices under “${name}”`);
      onOpen?.(existingMaster.id);
    } else if (onAddClient) {
      const master = {
        id: uid(),
        name: client.name || "", email: client.email || "", phone: "",
        company: `${name} (Group)`,
        segment: "maritz-portal", billingStatus: "never-charged", stage: "not-contacted",
        tags: [], amount: tier.m, billingDay: 1, cadence: "monthly", currency: "",
        maritzPortal: true, viperCustomer: false, inChargeOver: false,
        multiOffice: true, officeGroup: name, priceMode: "group", groupBillingMaster: true, emailPrimaryOnly: false,
        secondaryContacts: [], payments: [], reminders: {}, noteCards: [], followUp: "", emailStatus: "ok",
        activity: [{ at: new Date().toISOString(), type: "group", text: `Group billing card created for ${memberIds.length} “${name}” offices — new billing history starts here` }],
        createdAt: iso(),
      };
      onAddClient(master);
      onOpen?.(master.id);
    }
  };
  // Group pricing has ONE active price: choosing "Group" here makes THIS card
  // the group's billing master (amount auto-set from the office-count tier) and
  // puts every sibling into covered mode; "Per-office" reactivates everyone.
  const setPricingMode = (mode) => {
    if (!client.multiOffice) { set({ priceMode: mode }); return; }
    if (mode === "group") {
      const tier = groupTierFor(officeSiblings.length + 1, settings.maritzGroupTiers || GROUP_TIER_DEFAULTS);
      onUpdate(client.id, { priceMode: "group", groupBillingMaster: true, amount: client.cadence === "annual" ? tier.y : tier.m });
      officeSiblings.forEach((o) => onUpdate(o.id, { priceMode: "group", groupBillingMaster: false }));
    } else {
      // Per-office dissolves the group: every office reverts to a standalone
      // single office (no longer grouped), billed on its own.
      onUpdate(client.id, { priceMode: "per-office", groupBillingMaster: false, multiOffice: false, officeGroup: "" });
      officeSiblings.forEach((o) => onUpdate(o.id, { priceMode: "per-office", groupBillingMaster: false, multiOffice: false, officeGroup: "" }));
    }
  };
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
      .then((d) => { if (alive) setInv({ loading: false, invoices: d.invoices || [], next: d.next || null, error: d.error || "" }); })
      .catch(() => { if (alive) setInv({ loading: false, invoices: [], error: "load" }); });
    return () => { alive = false; };
  }, [client.chargeoverId]);
  // Prefill Amount from the most recent invoice when no amount is set — stays editable.
  useEffect(() => {
    // Once the sync has read the client's CO billing packages, that amount is
    // authoritative — amount 0 then means "no active recurring package", and
    // prefilling from an old invoice would re-poison the MRR metric.
    if (client.amount || client.coAmountAt || !inv.invoices.length) return;
    // voided / written-off invoices never drive the recurring amount
    const latest = [...inv.invoices].filter((i) => !i.voided).sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    if (latest && Number(latest.total) > 0) onUpdate(client.id, { amount: Number(latest.total) });
  }, [inv.invoices, client.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // Backdrops close on a press that STARTS on them — not onClick, which also
    // fires when a text-selection drag from inside ends past the panel edge
    // (the "abrupt close while selecting" bug). Same fix in confirm + Modal.
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} className="flex items-center justify-center" style={{ position: "fixed", inset: 0, background: "rgba(34,48,76,0.45)", zIndex: 50, padding: "clamp(12px, 4vh, 40px) 16px" }}>
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
            {/* Office inside a group: one click back to the group billing card */}
            {client.multiOffice && !client.groupBillingMaster && (() => {
              const master = officeSiblings.find((o) => o.groupBillingMaster);
              return master ? (
                <button onClick={() => onOpen?.(master.id)}
                  style={{ background: "#E7EDF8", border: "none", color: "#3B5BA5", fontSize: 11.5, fontWeight: 700, padding: "3px 10px", borderRadius: 20, cursor: "pointer", marginTop: 4 }}>
                  ← Back to {master.company || client.officeGroup} group
                </button>
              ) : null;
            })()}
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
            {onEmail && <EmailIconMenu client={client} templates={drawerTemplates} onPick={(type) => onEmail(client.id, type)} />}
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
            <Field label="Owner">
              <CompactSelect value={client.owner || ""} onChange={(e) => set({ owner: e.target.value })}>
                <option value="">Unassigned</option>
                {staff.map((s) => <option key={s.email} value={s.email}>{s.name || s.email}</option>)}
              </CompactSelect>
            </Field>
            <Field label="Flag">
              <CompactSelect value={client.flag || ""} onChange={(e) => set({ flag: e.target.value })}>
                <option value="">None</option>
                {Object.entries(CLIENT_FLAGS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </CompactSelect>
            </Field>
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
            {(client.activity || []).slice(0, 12).map((a, i) => <ActivityRow key={i} a={a} client={client} />)}
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
              {/* empty string when 0 so there's no stuck leading "0" while typing */}
              <input type="number" placeholder={inv.loading ? "…" : "0"} disabled={coveredByGroup(client)}
                title={coveredByGroup(client) ? "Billing is handled by the group card" : undefined}
                style={{ ...inputStyle, opacity: coveredByGroup(client) ? 0.5 : 1 }} value={client.amount === 0 ? "" : client.amount}
                onChange={(e) => set({ amount: e.target.value === "" ? 0 : Number(e.target.value) })} />
            </Field>
            {client.multiOffice ? (
              <Field label="Pricing">
                <CompactSelect value={client.priceMode} onChange={(e) => setPricingMode(e.target.value)}>
                  <option value="per-office">Per-office</option>
                  <option value="group">Group</option>
                </CompactSelect>
              </Field>
            ) : (
              <Field label="Currency">
                <CompactSelect value={client.currency || ""} onChange={(e) => set({ currency: e.target.value })}>
                  <option value="">Default ({settings.currency})</option><option value="GBP">£ GBP</option><option value="USD">$ USD</option><option value="EUR">€ EUR</option>
                </CompactSelect>
              </Field>
            )}
            {client.multiOffice && (
              <Field label="Currency">
                <CompactSelect value={client.currency || ""} onChange={(e) => set({ currency: e.target.value })}>
                  <option value="">Default ({settings.currency})</option><option value="GBP">£ GBP</option><option value="USD">$ USD</option><option value="EUR">€ EUR</option>
                </CompactSelect>
              </Field>
            )}
            <Field label="Cadence">
              <CompactSelect value={client.cadence} onChange={(e) => set({ cadence: e.target.value })}>
                {Object.entries(CADENCE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </CompactSelect>
            </Field>
            <Field label="Billing day"><input type="number" min="1" max="28" style={inputStyle} value={client.billingDay} onChange={(e) => set({ billingDay: Number(e.target.value) })} /></Field>
          </div>

          {/* Multi-office group billing: membership, tiers, master/covered states */}
          {client.multiOffice ? (
            <GroupBilling client={client} settings={settings} officeSiblings={officeSiblings}
              onUpdate={onUpdate} onUpdateSettings={onUpdateSettings} onOpen={onOpen} onDeleteAny={onDeleteAny}
              onManage={() => setShowGroup(true)} />
          ) : (
            <Section title="Multi-office">
              <div className="flex items-center justify-between" style={{ gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5, color: C.sub }}>Part of a chain? Group offices to bill them together.</span>
                <SolidBtn onClick={() => setShowGroup(true)}>Group offices</SolidBtn>
              </div>
              {/* single office billed at group rates (e.g. Eventis): flips the card
                  to group billing and hides Maritz portal pricing */}
              <label className="flex items-center" style={{ gap: 7, fontSize: 12.5, color: C.ink, cursor: "pointer", marginTop: 10 }}>
                <input type="checkbox" checked={false}
                  onChange={() => onUpdateWithLog(client.id, { multiOffice: true, priceMode: "group", groupBillingMaster: true, officeGroup: client.officeGroup || client.company || client.name }, "status", "Multi-office billing switched on — pays group rates")} />
                Multi-office billing — pay group rates (replaces Maritz portal pricing)
              </label>
            </Section>
          )}
          {showGroup && (
            <GroupOfficesModal client={client} allClients={allClients} officeSiblings={officeSiblings}
              onClose={() => setShowGroup(false)}
              onSave={(name, ids) => { applyGroup(name, ids); setShowGroup(false); }} />
          )}

          {/* Pricing section follows the SEGMENT (top-right dropdown), not the
              relationship flags — many cards are both Maritz and Viper. */}
          {["viper-current", "viper-past", "viper-maritz"].includes(client.segment) && (
            <ViperSubscription client={client} settings={settings} onUpdateSettings={onUpdateSettings} onUpdate={set} />
          )}

          {/* Maritz portal pricing — single-office clients (groups price via GroupBilling) */}
          {!client.multiOffice && client.segment === "maritz-portal" && (
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
              <CredField label="Admin user name" value={client.adminUser} onChange={(v) => set({ adminUser: v })} />
              <CredField label="Admin password" value={client.adminPassword} onChange={(v) => set({ adminPassword: v })} />
            </div>
            <div className="flex" style={{ gap: 8, marginTop: 4 }}>
              {client.portalUrl && <a href={client.portalUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 600, color: C.action }}>Open portal ↗</a>}
              {client.adminUrl && <a href={client.adminUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 600, color: C.action }}>Open admin ↗</a>}
            </div>
          </Section>

          {/* Maritz portal access — same layout + copy buttons as Viper */}
          <Section title="Maritz portal access">
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
              <CredField label="Portal URL" value={client.maritzPortalUrl} onChange={(v) => set({ maritzPortalUrl: v })} placeholder="https://…" />
              <CredField label="Admin URL" value={client.maritzAdminUrl} onChange={(v) => set({ maritzAdminUrl: v })} placeholder="https://…" />
              <CredField label="User name" value={client.maritzPortalUser} onChange={(v) => set({ maritzPortalUser: v })} />
              <CredField label="Password" value={client.maritzPortalPassword} onChange={(v) => set({ maritzPortalPassword: v })} />
              <CredField label="Admin user name" value={client.maritzAdminUser} onChange={(v) => set({ maritzAdminUser: v })} />
              <CredField label="Admin password" value={client.maritzAdminPassword} onChange={(v) => set({ maritzAdminPassword: v })} />
            </div>
            <div className="flex" style={{ gap: 8, marginTop: 4 }}>
              {client.maritzPortalUrl && <a href={client.maritzPortalUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 600, color: C.action }}>Open portal ↗</a>}
              {client.maritzAdminUrl && <a href={client.maritzAdminUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 600, color: C.action }}>Open admin ↗</a>}
            </div>
            <MaritzUsers client={client} />
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
              onClick={() => client.formerCustomer
                ? onUpdateWithLog(client.id, { formerCustomer: false, archivedClient: false, stage: "not-contacted" }, "status", "Reinstated as customer")
                : onUpdateWithLog(client.id, { formerCustomer: true, archivedClient: true, stage: "marked-deletion", workflowHidden: false }, "status", "No longer a customer — archived, marked for deletion")}
              title={client.formerCustomer ? "Reinstate as a current customer" : "Archive this card and mark it for deletion in the workflow"}
              style={footBtn(client.formerCustomer ? null : C.red)}>
              {client.formerCustomer ? "↩ Reinstate customer" : "No longer a customer"}
            </button>
            <button onClick={() => setConfirmDelete(true)} style={footBtn(C.red)}>Delete permanently…</button>
          </div>
          {/* Centered confirm — a small dialog so it's never cut off at the drawer's foot */}
          {confirmDelete && (
            <div onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmDelete(false); }} className="flex items-center justify-center" style={{ position: "fixed", inset: 0, background: "rgba(34,48,76,0.5)", zIndex: 60, padding: 16 }}>
              <div onClick={(e) => e.stopPropagation()} style={{ background: C.panel, borderRadius: 14, padding: "20px 22px", width: "100%", maxWidth: 380, boxShadow: "0 24px 60px rgba(34,48,76,0.32)" }}>
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: DISPLAY, marginBottom: 6 }}>Delete permanently?</div>
                <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.5, marginBottom: 18 }}>
                  <strong style={{ color: C.ink }}>{client.company || client.name}</strong> will be removed for good. This can't be undone — Archive is the reversible option.
                </div>
                <div className="flex items-center justify-end" style={{ gap: 8 }}>
                  <button onClick={() => setConfirmDelete(false)} style={footBtn()}>Cancel</button>
                  <button onClick={() => onDelete(client.id)} style={{ ...footBtn(C.red), background: C.red, color: "#fff", border: "none" }}>Delete permanently</button>
                </div>
              </div>
            </div>
          )}
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
// One Activity line. Email sends carry a ref into client.reminders — those
// rows get a "View email" link that expands the exact copy that went out.
function ActivityRow({ a, client }) {
  const [open, setOpen] = useState(false);
  const mail = a.ref ? client.reminders?.[a.ref] : null;
  const viewable = mail && (mail.subject || mail.body);
  return (
    <div style={{ fontSize: 12, padding: "5px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
      <span style={{ fontFamily: MONO, color: C.faint }}>{fmtDate(a.at)}</span>
      <span style={{ color: C.sub, marginLeft: 8 }}>{a.text}</span>
      {viewable && (
        <button onClick={() => setOpen((o) => !o)}
          style={{ background: "none", border: "none", padding: 0, marginLeft: 8, fontSize: 12, fontWeight: 600, color: C.action, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}>
          {open ? "Hide email ▴" : "View email ▾"}
        </button>
      )}
      {open && viewable && (
        <div style={{ marginTop: 6, background: C.paper, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, fontSize: 12.5 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{mail.subject || "(no subject saved)"}</div>
          <div style={{ whiteSpace: "pre-wrap", color: C.sub, lineHeight: 1.5 }}>{mail.body || "(message not saved)"}</div>
        </div>
      )}
    </div>
  );
}
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
// "Administrator, Site" is the portal's built-in system account — never billable,
// never counted, never included in copied lists.
function isSiteAdmin(u) { return ((u && u[0]) || "").toLowerCase().replace(/[^a-z]/g, "") === "administratorsite"; }
// A user counts as "current" if not terminated and not expired.
function isCurrentUser(u) {
  if (isSiteAdmin(u)) return false;
  const t = u[5], e = u[6]; const blank = (v) => !v || v === "-"; return blank(t) && blank(e);
}
// Plain-text block of a user list for pasting into an email to the client.
function userListToText(client, list) {
  const lines = [`${client.company || client.name} — portal users (collected ${fmtDate(list.collectedAt)})`, ""];
  let count = 0;
  for (const u of list.users || []) {
    if (isSiteAdmin(u)) continue;
    const name = u[0] || "";
    const title = u[1] ? ` — ${u[1]}` : "";
    const last = u[7] && u[7] !== "-" ? ` (last login ${u[7]})` : "";
    if (name) { lines.push(`• ${name}${title}${last}`); count++; }
  }
  lines.push("", `${count} users`);
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
        <span style={{ fontSize: 11.5, color: C.faint }}>{rows.filter((u) => !isSiteAdmin(u)).length} users{list.archived ? " · archived" : ""}{draft ? " · editing" : ""}</span>
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
// Same tiers, annual-in-advance rates.
function viperAnnual(n, p) {
  if (n <= 0) return 0;
  if (n < p.tier2Min) return Number(p.baseY) || 0;
  if (n < p.tier3Min) return n * (Number(p.tier2Y) || 0);
  return n * (Number(p.tier3Y) || 0);
}
// Viper subscription: current user count + tiered price, monthly or annual-in-
// advance per client. Pricing is GLOBAL (settings) — editing changes every Viper card.
function ViperSubscription({ client, settings, onUpdateSettings, onUpdate }) {
  const p = settings.viperPricing || { base: 300, tier2: 90, tier3: 80, tier2Min: 4, tier3Min: 10, baseY: 3000, tier2Y: 900, tier3Y: 800 };
  const [edit, setEdit] = useState(false);
  const n = currentUserCount(client);
  const annual = client.viperCadence === "annual";
  const total = annual ? viperAnnual(n, p) : viperMonthly(n, p);
  const per = annual ? { flat: p.baseY, t2: p.tier2Y, t3: p.tier3Y, unit: "/user/yr" } : { flat: p.base, t2: p.tier2, t3: p.tier3, unit: "/user/mo" };
  const tier = n <= 0 ? "—"
    : n < p.tier2Min ? `Base (1–${p.tier2Min - 1} users, flat)`
    : n < p.tier3Min ? `${p.tier2Min}–${p.tier3Min - 1} users · ${money(per.t2, "USD")}${per.unit}`
    : `${p.tier3Min}+ users · ${money(per.t3, "USD")}${per.unit}`;
  const setP = (patch) => onUpdateSettings({ viperPricing: { ...p, ...patch } });
  const numIn = (val, on) => <input type="number" value={val} onChange={(e) => on(Number(e.target.value))} style={{ ...inputStyle, padding: "7px 9px" }} />;
  return (
    <Section title="Viper subscription" action={<button onClick={() => setEdit((e) => !e)} style={{ fontSize: 11.5, fontWeight: 600, color: C.action, background: "none", border: "none", cursor: "pointer" }}>{edit ? "Done" : "Edit pricing"}</button>}>
      {/* Monthly / Annual toggle — per client */}
      <div className="flex items-center" style={{ gap: 4, marginBottom: 10 }}>
        {[["monthly", "Monthly"], ["annual", "Annual"]].map(([k, label]) => {
          const on = (client.viperCadence || "monthly") === k;
          return (
            <button key={k} onClick={() => onUpdate?.({ viperCadence: k })}
              style={{ fontSize: 12, fontWeight: 600, padding: "5px 14px", borderRadius: 20, cursor: "pointer", border: `1px solid ${on ? C.action : C.line}`, background: on ? C.action : C.panel, color: on ? "#fff" : C.sub }}>
              {label}
            </button>
          );
        })}
      </div>
      <div className="flex items-baseline justify-between" style={{ gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, color: C.sub }}>Current users</span>
        <span style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO }}>{n}</span>
      </div>
      <div className="flex items-baseline justify-between" style={{ gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 12.5, color: C.sub }}>{annual ? "Annual subscription · paid in advance" : "Monthly subscription"}</span>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: MONO, color: C.green }}>{money(total, "USD")}{annual ? "/yr" : "/mo"}</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.faint }}>{tier}</div>
      {edit && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.lineSoft}` }}>
          <div style={{ fontSize: 11, color: C.amber, fontWeight: 600, marginBottom: 8 }}>Global — applies to every Viper customer.</div>
          <div className="grid" style={{ gridTemplateColumns: "auto 1fr 1fr", gap: "6px 8px", alignItems: "center" }}>
            <span />
            <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>Monthly ($)</span>
            <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>Annual ($)</span>
            <span style={{ fontSize: 11.5, color: C.sub }}>1–{p.tier2Min - 1} users (flat)</span>
            {numIn(p.base, (v) => setP({ base: v }))}
            {numIn(p.baseY, (v) => setP({ baseY: v }))}
            <span style={{ fontSize: 11.5, color: C.sub }}>{p.tier2Min}–{p.tier3Min - 1} users (per user)</span>
            {numIn(p.tier2, (v) => setP({ tier2: v }))}
            {numIn(p.tier2Y, (v) => setP({ tier2Y: v }))}
            <span style={{ fontSize: 11.5, color: C.sub }}>{p.tier3Min}+ users (per user)</span>
            {numIn(p.tier3, (v) => setP({ tier3: v }))}
            {numIn(p.tier3Y, (v) => setP({ tier3Y: v }))}
          </div>
        </div>
      )}
    </Section>
  );
}
// Multi-office group billing. One office is the group's billing card (master)
// carrying the single active group price from the office-count tier; every
// other office is "covered" — no amount due, no reminders, banner to the master.
// Icon with a hover bubble (styled tooltip) — used in the group office list.
function IconTip({ label, onClick, children }) {
  const [hov, setHov] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
      <button onClick={onClick} aria-label={label}
        style={{ border: "none", cursor: "pointer", color: hov ? C.action : C.sub, padding: 3, display: "inline-flex", borderRadius: 6, background: hov ? C.lineSoft : "transparent" }}>
        {children}
      </button>
      {hov && (
        <span style={{ position: "absolute", bottom: "calc(100% + 6px)", right: 0, whiteSpace: "nowrap", background: C.ink, color: "#fff", fontSize: 11, fontWeight: 600, padding: "4px 8px", borderRadius: 6, boxShadow: "0 6px 16px rgba(34,48,76,0.28)", zIndex: 5, pointerEvents: "none" }}>
          {label}
        </span>
      )}
    </span>
  );
}
function GroupBilling({ client, settings, officeSiblings = [], onUpdate, onUpdateSettings, onOpen, onDeleteAny, onManage }) {
  const tiers = { ...GROUP_TIER_DEFAULTS, ...(settings.maritzGroupTiers || {}) };
  const [edit, setEdit] = useState(false);
  const [copiedNames, setCopiedNames] = useState(false);
  // Just the grouped company names, one per line.
  const copyNames = () => {
    const names = [client, ...officeSiblings].map((o) => o.company || o.name).filter(Boolean);
    navigator.clipboard?.writeText(names.join("\n")).then(() => { setCopiedNames(true); setTimeout(() => setCopiedNames(false), 1600); });
  };
  const count = officeSiblings.length + 1;
  const tier = groupTierFor(count, tiers);
  const isGroup = client.priceMode === "group";
  const master = isGroup && client.groupBillingMaster;
  const masterCard = isGroup && !master ? officeSiblings.find((o) => o.groupBillingMaster) : null;
  const annual = client.cadence === "annual";
  const suggested = annual ? tier.y : tier.m;
  const setT = (k, v) => onUpdateSettings({ maritzGroupTiers: { ...tiers, [k]: v } });
  const removeFromGroup = (o) => onUpdate(o.id, { officeGroup: "", multiOffice: false, priceMode: "per-office", groupBillingMaster: false });
  const numIn = (val, on) => <input type="number" value={val} onChange={(e) => on(Number(e.target.value))} style={{ ...inputStyle, padding: "6px 8px", fontSize: 13 }} />;

  // Covered member: everything billing points at the group card.
  if (isGroup && !master) {
    return (
      <Section title={`Multi-office · ${client.officeGroup || "group"}`}>
        <div style={{ background: "#E7EDF8", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "#3B5BA5" }}>
          <span style={{ fontWeight: 700 }}>Billing handled by the group card</span>
          {masterCard && <> · <button onClick={() => onOpen?.(masterCard.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#3B5BA5", fontWeight: 700, textDecoration: "underline", fontSize: 12.5 }}>{masterCard.company}</button></>}
          . This office owes nothing on its own.
        </div>
      </Section>
    );
  }

  return (
    <Section title={master ? `Group billing card · ${client.officeGroup || "group"}` : `Multi-office · ${client.officeGroup || "group"}`}
      action={<span className="flex items-center" style={{ gap: 12 }}>
        <button onClick={copyNames} title="Copy the grouped company names, one per line" style={{ fontSize: 11.5, fontWeight: 600, color: copiedNames ? C.green : C.action, background: "none", border: "none", cursor: "pointer" }}>{copiedNames ? "Copied ✓" : "Copy names"}</button>
        {master && <button onClick={() => setEdit((e) => !e)} style={{ fontSize: 11.5, fontWeight: 600, color: C.action, background: "none", border: "none", cursor: "pointer" }}>{edit ? "Done" : "Edit tiers"}</button>}
      </span>}>
      {master ? (
        <>
          <div className="flex items-baseline justify-between" style={{ gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 12.5, color: C.sub }}>Group price · {tier.label} ({count} office{count === 1 ? "" : "s"})</span>
            <span style={{ fontSize: 16, fontWeight: 700, fontFamily: MONO, color: C.green }}>{money(suggested, "USD")}{annual ? "/yr" : "/mo"}</span>
          </div>
          {Number(client.amount) !== suggested && (
            <button onClick={() => onUpdate(client.id, { amount: suggested })}
              style={{ fontSize: 11.5, fontWeight: 600, color: C.action, background: C.paper, border: `1px solid ${C.line}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", marginBottom: 6 }}>
              Apply tier price to Amount ({money(suggested, "USD")})
            </button>
          )}
          <label className="flex items-center" style={{ gap: 7, fontSize: 12.5, color: C.ink, cursor: "pointer", margin: "4px 0 6px", width: "fit-content" }}
            title="Ticked: emails go only to this card's contact. Unticked: emails go to every contact of every office in the group.">
            <input type="checkbox" checked={!!client.emailPrimaryOnly} onChange={(e) => onUpdate(client.id, { emailPrimaryOnly: e.target.checked })} />
            Email primary contact only
          </label>
        </>
      ) : (
        <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 8 }}>
          Each office is billed on its own amount. Switch Pricing to <span style={{ fontWeight: 700 }}>Group</span> to make this the group's billing card — {money(suggested, "USD")}{annual ? "/yr" : "/mo"} at {count} office{count === 1 ? "" : "s"} ({tier.label}).
        </div>
      )}

      {/* Linked offices — open, remove from group, or delete */}
      <div style={{ fontSize: 11.5, fontWeight: 600, color: C.sub, margin: "8px 0 4px" }}>{master ? "Offices covered by this group price" : "Offices in this group"}</div>
      {officeSiblings.length === 0 && <div style={{ fontSize: 12, color: C.faint }}>No other offices linked to “{client.officeGroup}”.</div>}
      {officeSiblings.map((o) => (
        <div key={o.id} className="flex items-center" style={{ gap: 8, padding: "6px 8px", background: C.paper, border: `1px solid ${C.lineSoft}`, borderRadius: 8, marginBottom: 4 }}>
          <button onClick={() => onOpen?.(o.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: C.ink, textAlign: "left", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title="Open this office">
            {o.company}
          </button>
          <button onClick={() => onOpen?.(o.id)} title={`${o.inChargeOver ? "In ChargeOver" : "Not in ChargeOver"} · ${BILLING[o.billingStatus]?.label || ""} — open office`}
            style={{ background: o.inChargeOver ? C.greenBg : C.greyBg, color: o.inChargeOver ? C.green : C.faint, border: "none", fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 20, cursor: "pointer", flexShrink: 0 }}>
            {o.inChargeOver ? "CO ✓" : "no CO"}
          </button>
          {o.groupBillingMaster && <MiniPill fg="#3B5BA5" bg="#E7EDF8">group card</MiniPill>}
          <IconTip label="Remove from Grouping" onClick={() => removeFromGroup(o)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 12h8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" /></svg>
          </IconTip>
        </div>
      ))}
      {onManage && (
        <button onClick={onManage}
          style={{ marginTop: 6, width: "100%", fontSize: 12, fontWeight: 600, color: C.action, background: C.paper, border: `1px dashed ${C.line}`, borderRadius: 8, padding: "7px 10px", cursor: "pointer" }}>
          + Group offices — add or remove
        </button>
      )}

      {master && edit && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.lineSoft}` }}>
          <div style={{ fontSize: 11, color: C.amber, fontWeight: 600, marginBottom: 8 }}>Global — applies to every office group.</div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: C.sub }} />
            <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>Monthly ($)</span>
            <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>Annual ($)</span>
            {[["Single office", "t1m", "t1y"], ["2–5 offices", "t2m", "t2y"], ["6–10 offices", "t3m", "t3y"], ["11+ offices", "t4m", "t4y"]].map(([lbl, mk, yk]) => (
              <React.Fragment key={mk}>
                <span style={{ fontSize: 11.5, color: C.sub }}>{lbl}</span>
                {numIn(tiers[mk], (v) => setT(mk, v))}
                {numIn(tiers[yk], (v) => setT(yk, v))}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

// Maritz portal pricing. Single-office prices + setup fee are GLOBAL (settings).
// Pick companies to group as offices under one name — search + tick boxes.
// Existing members arrive pre-ticked; unticking removes them on save.
function GroupOfficesModal({ client, allClients = [], officeSiblings = [], onSave, onClose }) {
  const [name, setName] = useState(client.officeGroup || client.company || "");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(() => new Set(officeSiblings.map((o) => o.id)));
  const toggle = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return allClients
      .filter((c) => c.id !== client.id && !c.archivedClient && !c.formerCustomer)
      .filter((c) => !k || [c.company, c.name, c.email].some((s) => (s || "").toLowerCase().includes(k)))
      .sort((a, b) => (a.company || a.name || "").localeCompare(b.company || b.name || ""));
  }, [allClients, client.id, q]);
  return (
    <Modal title="Group offices" onClose={onClose}>
      <p style={{ fontSize: 12.5, color: C.sub, marginBottom: 12 }}>
        Tick the companies that belong with <span style={{ fontWeight: 700, color: C.ink }}>{client.company || client.name}</span>. They'll share one group for billing.
      </p>
      <Field label="Group name"><input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Destination Asia" /></Field>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search companies" autoFocus
        style={{ ...inputStyle, marginBottom: 8 }} />
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, maxHeight: 300, overflow: "auto", marginBottom: 12 }}>
        {list.length === 0 && <div style={{ padding: 16, fontSize: 12.5, color: C.faint, textAlign: "center" }}>No companies match “{q.trim()}”.</div>}
        {list.map((c) => (
          <label key={c.id} className="flex items-center" style={{ gap: 9, padding: "7px 11px", borderBottom: `1px solid ${C.lineSoft}`, cursor: "pointer", background: sel.has(c.id) ? "#F0F4FA" : "transparent" }}>
            <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.company || c.name}</span>
            {c.officeGroup && c.officeGroup !== client.officeGroup && <MiniPill fg={C.amber} bg={C.amberBg}>in “{c.officeGroup}”</MiniPill>}
          </label>
        ))}
      </div>
      <div className="flex items-center justify-between" style={{ gap: 8 }}>
        <span style={{ fontSize: 12, color: C.sub, fontFamily: MONO }}>{sel.size + 1} office{sel.size ? "s" : ""} in group</span>
        <div className="flex items-center" style={{ gap: 8 }}>
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
          <SolidBtn disabled={!name.trim() || sel.size === 0} onClick={() => onSave(name.trim(), [...sel])}>
            Group {sel.size + 1} offices
          </SolidBtn>
        </div>
      </div>
    </Modal>
  );
}

function MaritzPricing({ client, settings, onUpdate, onUpdateSettings, officeSiblings = [] }) {
  const p = settings.maritzPricing || { monthly: 40, annual: 400, setupFee: 500 };
  const [edit, setEdit] = useState(false);
  const b = client.maritzBilling || { includeSetup: false };
  const setB = (patch) => onUpdate({ maritzBilling: { ...b, ...patch } });
  const setP = (patch) => onUpdateSettings({ maritzPricing: { ...p, ...patch } });
  // price follows the card's billing Cadence field (synced from ChargeOver)
  const cadence = client.cadence === "annual" ? "annual" : "monthly";
  const base = cadence === "annual" ? Number(p.annual) || 0 : Number(p.monthly) || 0;
  const total = base + (b.includeSetup ? Number(p.setupFee) || 0 : 0);
  const numIn = (val, on, ph) => <input type="number" value={val} placeholder={ph} onChange={(e) => on(e.target.value === "" ? "" : Number(e.target.value))} style={{ ...inputStyle, padding: "7px 9px" }} />;

  return (
    <Section title="Maritz portal pricing" action={<button onClick={() => setEdit((e) => !e)} style={{ fontSize: 11.5, fontWeight: 600, color: C.action, background: "none", border: "none", cursor: "pointer" }}>{edit ? "Done" : "Edit pricing"}</button>}>
      <div className="flex items-center" style={{ gap: 6, marginBottom: 8 }}>
        {["monthly", "annual"].map((cad) => (
          <button key={cad} onClick={() => onUpdate({ cadence: cad })} style={{ fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: `1px solid ${cadence === cad ? C.action : C.line}`, background: cadence === cad ? C.action : C.panel, color: cadence === cad ? "#fff" : C.sub }}>
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
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: MONO, color: C.green }}>{money(total, "USD")}{b.includeSetup ? "" : cadence === "annual" ? "/yr" : "/mo"}</span>
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
function SolidBtn({ onClick, disabled, children }) { return <button onClick={onClick} disabled={disabled} style={{ fontSize: 13, fontWeight: 600, padding: "9px 16px", borderRadius: 8, cursor: disabled ? "default" : "pointer", border: "none", background: disabled ? C.grey : C.action, color: "#fff" }}>{children}</button>; }
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
// Read-only table of the Maritz portal users captured from the admin site
// (latest dated list). Each username/password has a click-to-copy cell.
function MaritzUsers({ client }) {
  const lists = (client.maritzUserLists || []).filter((l) => !l.archived);
  const [copied, setCopied] = useState("");
  const [q, setQ] = useState("");
  if (!lists.length) return null;
  const list = lists.slice().sort((a, b) => new Date(b.collectedAt) - new Date(a.collectedAt))[0];
  const k = q.trim().toLowerCase();
  const shown = k ? list.users.filter((u) => u.some((c) => (c || "").toLowerCase().includes(k))) : list.users;
  const cp = (v, kk) => { if (!v) return; navigator.clipboard?.writeText(v).then(() => { setCopied(kk); setTimeout(() => setCopied(""), 1200); }); };
  const cell = (v, kk) => (
    <td onClick={() => cp(v, kk)} title={v ? "Click to copy" : ""} style={{ padding: "4px 8px", fontFamily: MONO, cursor: v ? "pointer" : "default", color: copied === kk ? C.green : C.ink, borderBottom: `1px solid ${C.lineSoft}`, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{copied === kk ? "copied ✓" : (v || "—")}</td>
  );
  return (
    <div style={{ marginTop: 12 }}>
      <div className="flex items-center justify-between" style={{ gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: C.sub }}>Portal users · collected {fmtDate(list.collectedAt)} · {k ? `${shown.length}/${list.users.length}` : list.users.length}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users"
          style={{ fontSize: 12, padding: "5px 9px", borderRadius: 7, border: `1px solid ${k ? C.action : C.line}`, background: C.panel, outline: "none", minWidth: 150 }} />
      </div>
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead><tr style={{ background: C.lineSoft }}>{["Name", "Username", "Password"].map((h) => <th key={h} style={{ textAlign: "left", padding: "5px 8px", color: C.sub, fontWeight: 600 }}>{h}</th>)}</tr></thead>
          <tbody>
            {shown.map((u, i) => <tr key={i}>{cell(u[0], `n${i}`)}{cell(u[1], `u${i}`)}{cell(u[2], `p${i}`)}</tr>)}
            {shown.length === 0 && <tr><td colSpan={3} style={{ padding: "8px", color: C.faint, textAlign: "center" }}>No users match “{q.trim()}”.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
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
// What each template token means — {{company}} is the CLIENT's company;
// {{businessName}} is YOUR business (from Settings). Not the same thing.
const TOKEN_HINTS = {
  firstName: "client contact's first name", name: "client contact's full name",
  company: "the client's company", businessName: "your business name (from Settings)",
  monthName: "current month, e.g. July 2026", amount: "client's recurring amount",
  owed: "total currently owed", periods: "billing periods behind",
  cadence: "monthly / annual", signature: "standard sign-off",
};

function EmailTemplatesPanel({ settings, onSave, user }) {
  const custom = settings.emailTemplates || {};
  const [editingKey, setEditingKey] = useState(null); // a real key, or "__new__"
  const [form, setForm] = useState({ label: "", subject: "", body: "" });
  const bodyRef = React.useRef(null);
  const [test, setTest] = useState({ busy: false, msg: "", err: false });
  const allKeys = [...BUILTIN_COMMS_KEYS, ...Object.keys(custom).filter((k) => !BUILTIN_COMMS_KEYS.includes(k))];

  // Click a placeholder chip → insert at the cursor position in the message body.
  const insertToken = (t) => {
    const tok = `{{${t}}}`;
    const el = bodyRef.current;
    setForm((f) => {
      const s = el?.selectionStart ?? f.body.length;
      const e = el?.selectionEnd ?? s;
      const body = f.body.slice(0, s) + tok + f.body.slice(e);
      requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(s + tok.length, s + tok.length); } });
      return { ...f, body };
    });
  };

  // Send the draft to the signed-in staff member, filled with example data.
  const sendTest = async () => {
    if (!user?.email) { setTest({ busy: false, msg: "No email on your account.", err: true }); return; }
    setTest({ busy: true, msg: "", err: false });
    const tokens = templateTokens(EXAMPLE_CLIENT, settings);
    try {
      const r = await fetch("/api/comms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: user.email, name: user.name || "", subject: `[Test] ${tokenize(form.subject, tokens)}`, body: tokenize(form.body, tokens) }),
      });
      const d = await r.json().catch(() => ({}));
      setTest({ busy: false, msg: r.ok ? `Test sent to ${user.email}` : (d.error || "Send failed."), err: !r.ok });
    } catch { setTest({ busy: false, msg: "Send failed. Try again.", err: true }); }
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
        <Field label="Message"><textarea ref={bodyRef} rows={11} style={{ ...inputStyle, fontFamily: SANS, lineHeight: 1.5, resize: "vertical" }} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
        {/* Placeholder chips — click to insert at the cursor in the message */}
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11.5, color: C.sub, fontWeight: 600, marginBottom: 6 }}>Placeholders — click to insert, filled in per client when sent:</div>
          <div className="flex" style={{ flexWrap: "wrap", gap: 5 }}>
            {TEMPLATE_TOKENS.map((t) => (
              <button key={t} onClick={() => insertToken(t)} title={TOKEN_HINTS[t] || t}
                style={{ fontSize: 11.5, fontFamily: MONO, fontWeight: 600, color: C.action, background: C.paper, border: `1px solid ${C.line}`, borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}>
                {`{{${t}}}`}
              </button>
            ))}
          </div>
        </div>
        <p style={{ fontSize: 11, color: C.faint, marginBottom: 14, lineHeight: 1.5 }}>
          {"{{company}}"} is the client's company; {"{{businessName}}"} is your own business name from Settings.
          {builtin && editingKey === "reminder" && " Note: the built-in payment reminder normally escalates its wording as an account falls further behind (reminder → second reminder → final notice). Saving here replaces all of that with this one fixed message."}
        </p>
        <div className="flex items-center justify-between" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="flex" style={{ gap: 8 }}>
            <SolidBtn onClick={save}>Save</SolidBtn>
            <GhostBtn onClick={() => setEditingKey(null)}>Cancel</GhostBtn>
            {builtin && custom[editingKey] && <button onClick={() => resetToDefault(editingKey)} style={{ fontSize: 12.5, color: C.sub, background: "none", border: "none", cursor: "pointer" }}>Reset to default wording</button>}
          </div>
          <div className="flex items-center" style={{ gap: 8 }}>
            {test.msg && <span style={{ fontSize: 12, color: test.err ? C.red : C.green, fontWeight: 600 }}>{test.msg}</span>}
            <GhostBtn onClick={sendTest}>{test.busy ? "Sending…" : "Send test email"}</GhostBtn>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between" style={{ gap: 12, marginBottom: 14 }}>
        <p style={{ fontSize: 13, color: C.sub }}>These feed the Comms tab and the per-client email button. Edit the built-in ones or add your own.</p>
        <div style={{ flexShrink: 0 }}><SolidBtn onClick={startNew}>+ New email type</SolidBtn></div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
    </div>
  );
}

// Small square copy-to-clipboard button used in the Viper grid.
function CopyIcon({ value, title }) {
  const [ok, setOk] = useState(false);
  const copy = () => { if (!value) return; navigator.clipboard?.writeText(value).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }); };
  return (
    <button type="button" onClick={copy} title={title || "Copy"} aria-label={title || "Copy"} disabled={!value}
      style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 6, border: `1px solid ${C.line}`, background: ok ? C.greenBg : C.panel, color: ok ? C.green : value ? C.sub : C.faint, cursor: value ? "pointer" : "default", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      {ok ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
          : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
    </button>
  );
}

// Viper portal logins — inline-editable grid inside the modal. Every field
// autosaves on blur (PATCH); links open in a new tab; passwords/URLs have copy
// buttons. Passwords are encrypted at rest server-side (lib/crypto).
// Edits also propagate onto the matching client card's Portal tab (onSync),
// matched by portal-URL host first, company name second.
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function ViperCustomers({ clients = [], onSync }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [note, setNote] = useState("");

  // Push this row's login details onto matching client card(s) via the normal
  // card-save pipeline (diff save + encryption + audit) — no second write path.
  const syncToCards = (cust) => {
    if (!onSync) return;
    const h = hostOf(cust.portalUrl);
    let m = h ? clients.filter((c) => hostOf(c.portalUrl) === h) : [];
    if (!m.length) { const n = normName(cust.name); m = n ? clients.filter((c) => normName(c.company || c.name) === n) : []; }
    const patch = {};
    if (cust.portalUrl) patch.portalUrl = cust.portalUrl;
    if (cust.adminUrl) patch.adminUrl = cust.adminUrl;
    if (cust.adminUser) patch.adminUser = cust.adminUser;
    if (cust.adminPw) patch.adminPassword = cust.adminPw;
    if (!m.length || !Object.keys(patch).length) return;
    m.forEach((c) => onSync(c.id, patch));
    setNote(`Updated ${m.length} client card${m.length > 1 ? "s" : ""} (${m.map((c) => c.company || c.name).join(", ")})`);
    setTimeout(() => setNote(""), 3500);
  };

  useEffect(() => {
    fetch("/api/viper-customers").then((r) => r.json()).then((d) => setRows(d.customers || [])).catch(() => setRows([]));
  }, []);

  const add = async (body = { name: "New customer" }) => {
    const r = await fetch("/api/viper-customers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.customer) {
      setRows((p) => [...p, d.customer].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())));
      if (d.customer.portalUrl || d.customer.adminUrl) syncToCards(d.customer);
    }
    return d.customer;
  };
  const patch = (id, field, value) => {
    setRows((p) => p.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  };
  const save = (id, field, value) => {
    fetch(`/api/viper-customers/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [field]: value }) });
    const row = rows.find((c) => c.id === id);
    if (row) syncToCards({ ...row, [field]: value });
  };
  const remove = async (id) => {
    if (!confirm("Remove this customer?")) return;
    setRows((p) => p.filter((c) => c.id !== id));
    fetch(`/api/viper-customers/${id}`, { method: "DELETE" });
  };
  if (rows === null) return <div style={{ padding: 20, fontSize: 13, color: C.sub }}>Loading…</div>;

  const k = q.trim().toLowerCase();
  const shown = k ? rows.filter((c) => [c.name, c.portalUrl, c.adminUrl, c.adminUser].some((v) => (v || "").toLowerCase().includes(k))) : rows;

  return (
    <div>
      <div className="flex items-center justify-between" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers"
          style={{ fontSize: 13, padding: "7px 11px", borderRadius: 8, border: `1px solid ${k ? C.action : C.line}`, background: C.panel, outline: "none", minWidth: 200 }} />
        <div className="flex items-center" style={{ gap: 8 }}>
          {note && <span style={{ fontSize: 12, fontWeight: 600, color: C.green }}>✓ {note}</span>}
          <span style={{ fontSize: 12, color: C.faint }}>{shown.length} of {rows.length}</span>
          <MiniBtn solid onClick={() => add()}>+ Add customer</MiniBtn>
        </div>
      </div>

      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        <div style={{ minWidth: 900 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1.9fr 1.9fr 1fr 1.2fr 34px", gap: 8, padding: "8px 12px", background: C.lineSoft, fontSize: 11, fontWeight: 700, color: C.sub, letterSpacing: "0.02em", textTransform: "uppercase", position: "sticky", top: 0 }}>
            <span>Client name</span><span>Portal URL</span><span>Admin URL</span><span>Admin user</span><span>Admin password</span><span />
          </div>
          {shown.map((c) => <ViperRow key={c.id} c={c} onChange={patch} onSave={save} onRemove={remove} />)}
          {shown.length === 0 && <div style={{ padding: 24, textAlign: "center", fontSize: 13, color: C.faint }}>{rows.length === 0 ? "No customers yet — add one to get started." : `No match for “${q.trim()}”.`}</div>}
        </div>
      </div>
    </div>
  );
}

function ViperRow({ c, onChange, onSave, onRemove }) {
  const cell = { fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: `1px solid ${C.line}`, background: C.panel, outline: "none", width: "100%", boxSizing: "border-box", color: C.ink };
  const link = (url) => url && (
    <a href={url} target="_blank" rel="noopener noreferrer" title="Open in new tab"
      style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 6, border: `1px solid ${C.line}`, background: C.panel, color: C.action, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6M10 14L21 3" /></svg>
    </a>
  );
  const F = (field, mono) => (
    <input value={c[field] || ""} onChange={(e) => onChange(c.id, field, e.target.value)} onBlur={(e) => onSave(c.id, field, e.target.value)}
      style={{ ...cell, ...(mono ? { fontFamily: MONO, fontSize: 12 } : {}) }} />
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1.9fr 1.9fr 1fr 1.2fr 34px", gap: 8, padding: "7px 12px", alignItems: "center", borderTop: `1px solid ${C.lineSoft}` }}>
      {F("name")}
      <div className="flex items-center" style={{ gap: 5 }}>{F("portalUrl", true)}<CopyIcon value={c.portalUrl} title="Copy portal URL" />{link(c.portalUrl)}</div>
      <div className="flex items-center" style={{ gap: 5 }}>{F("adminUrl", true)}<CopyIcon value={c.adminUrl} title="Copy admin URL" />{link(c.adminUrl)}</div>
      {F("adminUser", true)}
      <div className="flex items-center" style={{ gap: 5 }}>{F("adminPw", true)}<CopyIcon value={c.adminPw} title="Copy password" /></div>
      <button type="button" onClick={() => onRemove(c.id)} title="Remove" aria-label="Remove customer"
        style={{ width: 26, height: 26, borderRadius: 6, border: `1px solid ${C.line}`, background: C.panel, color: C.red, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
      </button>
    </div>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} className="flex items-center justify-center" style={{ position: "fixed", inset: 0, background: "rgba(34,48,76,0.45)", padding: 16, zIndex: 50 }}>
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
