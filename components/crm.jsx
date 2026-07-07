"use client";
import React, { useState, useEffect, useMemo, useCallback } from "react";
import Papa from "papaparse";
import { C, SANS, DISPLAY, MONO, Wordmark } from "../lib/brand.js";

/* ================================================================== *
 * ViperPro — Client CRM & Collections
 * Ported from the artifact prototype (viper-crm-v2.jsx).
 * Storage: /api/state (SQLite-backed, whole-state, debounced saves).
 * Contact recovery: /api/recover (server-side Claude web search).
 * ================================================================== */

const SYMBOL = { GBP: "£", USD: "$", EUR: "€" };

/* ------------------------------ Axes ------------------------------ */
const SEGMENTS = {
  "viper-current": { label: "Viper — current", color: "#0E766E" },
  "viper-past": { label: "Viper — past", color: "#8A94A6" },
  "maritz-portal": { label: "Maritz — Viper Portal", color: "#3B5BA5" },
  "maritz-viper-portal": { label: "Maritz - Portal", color: "#7A4FB5" },
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
  const last = lastPaymentDate(c);
  const anchor = last || parseDate(c.createdAt) || now;
  let diff = monthIndex(now) - monthIndex(anchor);
  if (last) {
    // current period not yet due if we're before the billing day
    if (now.getDate() < day) diff -= 1;
    return Math.max(0, Math.min(24, Math.floor(diff / cad)));
  }
  // never paid: the first period falls due on the first billing day after creation
  let owed = Math.floor(diff / cad) + (now.getDate() >= day ? 1 : 0);
  return Math.max(0, Math.min(24, owed));
}
function totalOwed(c, now = new Date()) { return periodsBehind(c, now) * (Number(c.amount) || 0); }
function isOverdue(c, now = new Date()) { return periodsBehind(c, now) >= 1; }
function escalationOf(c) {
  const n = periodsBehind(c);
  if (n >= 3) return { level: 3, label: "Final notice", color: C.red };
  if (n === 2) return { level: 2, label: "Second reminder", color: C.amber };
  if (n === 1) return { level: 1, label: "Reminder", color: C.amber };
  return null;
}
function monthlyValue(c) { return (Number(c.amount) || 0) / (CADENCE[c.cadence]?.months || 1); }
function followUpDue(c, now = new Date()) { const d = parseDate(c.followUp); return d && d <= now; }
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
      if (e?.level === 3) return `Final notice — outstanding balance of ${money(totalOwed(c), c.currency || s.currency)}`;
      if (e?.level === 2) return `Second reminder — ${monthName()} payment outstanding`;
      return `Payment reminder — ${monthName()}`;
    },
    body: (c, s) => {
      const cur = c.currency || s.currency;
      const owed = money(totalOwed(c), cur);
      const n = periodsBehind(c);
      const e = escalationOf(c);
      if (e?.level === 3) return `Hi ${firstName(c.name)},

Despite previous reminders, your account shows an outstanding balance of ${owed} covering ${n} billing periods.

Please arrange payment within 7 days, or get in touch to discuss a payment plan. If we don't hear from you, we may have to suspend service while the account is resolved — which we'd much rather avoid.

If you believe this is in error, reply and we'll sort it straight away.

${SIGNATURE}`;
      if (e?.level === 2) return `Hi ${firstName(c.name)},

Following up on my earlier note — your balance of ${owed} (${n} billing periods) is still showing as outstanding.

If there's an issue with the invoice or you'd like to spread the payment, just reply and we'll work something out. Otherwise you can settle it at your convenience.

${SIGNATURE}`;
      return `Hi ${firstName(c.name)},

A quick reminder that your ${monthName()} payment of ${money(c.amount, cur)} is currently showing as outstanding.

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

/* ---------------------------- Sample data ---------------------------- */
const SAMPLE = [
  { name: "Harbourside Events", company: "Harbourside Events Ltd", email: "accounts@harbourside.co", segment: "viper-current", billingStatus: "not-up-to-date", stage: "need-to-contact", tags: ["price-pending"], amount: 480, billingDay: 1, cadence: "monthly", currency: "USD", createdAt: monthsAgo(8), payments: [{ date: monthsAgo(2, 3), amount: 480 }], notes: "Promised payment after their summer program — chase if nothing by mid-month." },
  { name: "Marina Bay Group", company: "Marina Bay Group", email: "finance@marinabay.com", phone: "+1 435 555 0110", segment: "maritz-viper-portal", billingStatus: "current-pricing", stage: "up-to-date", tags: ["vip"], amount: 950, billingDay: 5, cadence: "monthly", currency: "USD", createdAt: monthsAgo(14), payments: [{ date: iso(), amount: 950 }, { date: monthsAgo(1), amount: 950 }] },
  { name: "Cannes Lettings Ltd", company: "Cannes Lettings", email: "hello@canneslettings.fr", segment: "maritz-portal", billingStatus: "not-up-to-date", stage: "not-contacted", tags: [], amount: 3600, billingDay: 3, cadence: "annual", currency: "EUR", createdAt: monthsAgo(26), payments: [{ date: monthsAgo(14, 3), amount: 3600 }], emailStatus: "bounced" },
  { name: "Dickey & Co", company: "Dickey & Co", email: "billing@dickeyco.uk", segment: "viper-current", billingStatus: "current-pricing", stage: "up-to-date", tags: [], amount: 320, billingDay: 28, cadence: "monthly", currency: "GBP", createdAt: monthsAgo(6), payments: [{ date: monthsAgo(1, 27), amount: 320 }] },
  { name: "Newquay Coast Rentals", company: "Newquay Coast Rentals", email: "team@newquaycoast.co.uk", segment: "maritz-portal", billingStatus: "old-pricing", stage: "contacted-awaiting", tags: ["price-pending"], amount: 275, billingDay: 15, cadence: "monthly", currency: "USD", createdAt: monthsAgo(20), payments: [{ date: monthsAgo(0, 14), amount: 275 }], followUp: iso() },
  { name: "Antibes Villas", company: "Antibes Villas SARL", email: "pay@antibesvillas.fr", segment: "maritz-viper-portal", billingStatus: "payment-failed", stage: "need-to-contact", tags: ["email-bouncing", "needs-contact-info"], amount: 640, billingDay: 10, cadence: "monthly", currency: "USD", createdAt: monthsAgo(9), payments: [{ date: monthsAgo(3, 9), amount: 640 }], emailStatus: "bounced" },
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
    segment: SEGMENTS[r.segment] ? r.segment : "viper-current",
    billingStatus: BILLING[r.billingStatus] ? r.billingStatus : "never-charged",
    stage: STAGES[r.stage] ? r.stage : "not-contacted",
    tags: Array.isArray(r.tags) ? r.tags.filter((t) => TAGS[t]) : [],
    amount: Number(r.amount) || 0,
    billingDay: Math.min(28, Math.max(1, Number(r.billingDay) || 1)),
    cadence: CADENCE[r.cadence] ? r.cadence : "monthly",
    currency: SYMBOL[r.currency] ? r.currency : "",
    lastPaid: (r.lastPaid || "").trim(),
    payments: Array.isArray(r.payments) ? r.payments : [],
    emailStatus: ["bounced", "undelivered"].includes(r.emailStatus) ? r.emailStatus : "ok",
    secondaryContacts: Array.isArray(r.secondaryContacts) ? r.secondaryContacts : [],
    archivedContacts: r.archivedContacts || [],
    candidates: r.candidates || [],
    reminders: r.reminders || {},
    notes: r.notes || "",
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
    let v = k === "tags" ? c.tags.join("|") : k === "periodsBehind" ? periodsBehind(c) : k === "totalOwed" ? totalOwed(c) : k === "lastPaid" ? (lastPaymentDate(c) ? iso(lastPaymentDate(c)) : "") : c[k] ?? "";
    v = String(v);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(","));
  download(`viper-clients-${iso()}.csv`, [cols.join(","), ...rows].join("\n"), "text/csv");
}
function exportBackup(clients, settings) {
  download(`viper-crm-backup-${iso()}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), settings, clients }, null, 2), "application/json");
}

/* =============================== App =============================== */
export default function CRM({ user }) {
  const [clients, setClients] = useState([]);
  const [settings, setSettings] = useState({ currency: "USD", businessName: "VIPER", senderName: "Darryl" });
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [tab, setTab] = useState("digest");
  const [modal, setModal] = useState(null);
  const [detailId, setDetailId] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/state");
        if (r.status === 401) { window.location.href = "/login"; return; }
        const d = await r.json();
        if (Array.isArray(d.clients)) setClients(d.clients.map(normalise));
        if (d.settings) setSettings((s) => ({ ...s, ...d.settings }));
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
          Object.assign(ex, clean, { id: ex.id, reminders: ex.reminders, archivedContacts: ex.archivedContacts, candidates: ex.candidates, activity: ex.activity, payments: clean.payments.length ? clean.payments : ex.payments, notes: clean.notes || ex.notes });
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

  return (
    <div style={{ background: C.paper, minHeight: "100vh", fontFamily: SANS, color: C.ink }}>
      <div className="mx-auto w-full" style={{ maxWidth: 1180, padding: "clamp(16px, 3vw, 30px)" }}>
        <header style={{ marginBottom: 18 }}>
          <div className="flex flex-wrap items-center justify-between" style={{ gap: 12 }}>
            <div>
              <Wordmark size={24} sub="Client Billing CRM" />
              <p style={{ color: C.sub, fontSize: 13, marginTop: 6 }}>
                VIP Event Resources · theviperpro.com · <span style={{ fontFamily: MONO }}>{monthName()}</span>
              </p>
            </div>
            <div className="flex items-center" style={{ gap: 10 }}>
              <span style={{ fontSize: 12.5, color: C.sub }}>{user.name || user.email}</span>
              <GhostBtn onClick={logout}>Sign out</GhostBtn>
              <span style={{ fontSize: 12, color: saveState === "error" ? C.red : C.faint, minWidth: 56, textAlign: "right" }}>
                {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : ""}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center" style={{ gap: 8, marginTop: 14 }}>
            <GhostBtn onClick={() => (window.location.href = "/users")}>{user.role === "admin" ? "Users" : "Account"}</GhostBtn>
            <GhostBtn onClick={() => setModal("add")}>Add client</GhostBtn>
            <GhostBtn onClick={() => setModal("settings")}>Settings</GhostBtn>
            {user.role === "admin" && <GhostBtn onClick={syncNow}>{sync.busy ? "Syncing…" : "Sync ChargeOver"}</GhostBtn>}
            <GhostBtn onClick={() => exportBackup(clients, settings)}>Backup</GhostBtn>
            <div className="flex items-center" style={{ gap: 6, marginLeft: "auto" }}>
              <MiniBtn solid onClick={() => setModal("import")}>Import CSV</MiniBtn>
              <MiniBtn onClick={() => exportCsv(active)}>Export CSV</MiniBtn>
            </div>
          </div>
          {sync.msg && <p style={{ fontSize: 12.5, color: C.sub, marginTop: 8 }}>{sync.msg}</p>}
        </header>

        <StatStrip clients={active} settings={settings} bounced={bounced.length} />

        <nav className="flex" style={{ gap: 2, marginBottom: 16, flexWrap: "wrap", borderBottom: `1px solid ${C.line}` }}>
          {[["digest", "Daily digest"], ["clients", "Clients"], ["workflow", "Workflow"], ["recovery", `Contact recovery${bounced.length ? ` · ${bounced.length}` : ""}`], ["comms", "Comms"]].map(([k, t]) => (
            <Tab key={k} active={tab === k} onClick={() => setTab(k)}>{t}</Tab>
          ))}
        </nav>

        {clients.length === 0 ? (
          <EmptyState onImport={() => setModal("import")} onSample={() => addClients(SAMPLE)} />
        ) : (
          <>
            {tab === "clients" && <ClientsTab clients={clients} settings={settings} onOpen={setDetailId} />}
            {tab === "workflow" && <WorkflowTab clients={active} onOpen={setDetailId} onStage={(id, stage) => updateWithLog(id, { stage }, "stage", `Stage → ${STAGES[stage].label}`)} />}
            {tab === "recovery" && <RecoveryTab bounced={bounced} onApply={applyContact} onUpdate={update} onOpen={setDetailId} />}
            {tab === "comms" && <CommsTab clients={active} settings={settings} onLogSent={(id, key, patch, label) => {
              setClients((p) => p.map((c) => {
                if (c.id !== id) return c;
                const reminders = { ...(c.reminders || {}) };
                reminders[key] = { ...(reminders[key] || {}), ...patch };
                const activity = patch.sentAt ? logActivity(c, "email", `${label} marked sent`) : c.activity;
                return { ...c, reminders, activity };
              }));
            }} />}
            {tab === "digest" && <DigestTab clients={active} settings={settings} bounced={bounced.length} onGo={setTab} onOpen={setDetailId} />}
          </>
        )}

        <p style={{ color: C.faint, fontSize: 12, marginTop: 16, lineHeight: 1.5 }}>
          Billing status and payments sync from ChargeOver in production (match key: ChargeOver ID, falling back to email).
          Reminders escalate automatically with periods behind. Export regularly — CSV for spreadsheets, Backup for a full restore file.
        </p>
        <p style={{ color: C.faint, fontSize: 11.5, marginTop: 10, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
          © 2026 ViperPro · VIP Event Resources · Software solutions for DMCs and the Meetings & Events industry · sales@vipeventresources.com · +1 435 901 2634
        </p>
      </div>

      {detail && <DetailDrawer client={detail} settings={settings} onClose={() => setDetailId(null)} onUpdate={update} onUpdateWithLog={updateWithLog} onRecordPayment={recordPayment} onDelete={(id) => { setClients((p) => p.filter((c) => c.id !== id)); setDetailId(null); }} />}
      {modal === "import" && <Modal title="Import clients" onClose={() => setModal(null)}><ImportPanel onImport={(r) => { addClients(r); setModal(null); }} onSample={() => { addClients(SAMPLE); setModal(null); }} /></Modal>}
      {modal === "add" && <Modal title="Add client" onClose={() => setModal(null)}><AddPanel onAdd={(r) => { addClients([r]); setModal(null); }} /></Modal>}
      {modal === "settings" && <Modal title="Settings" onClose={() => setModal(null)}><SettingsPanel settings={settings} onSave={(s) => { setSettings(s); setModal(null); }} /></Modal>}
    </div>
  );
}

/* ---------------------------- Stat strip ---------------------------- */
function StatStrip({ clients, settings, bounced }) {
  const s = useMemo(() => {
    const owedByCur = {}; let overdue = 0, mrr = 0, oldPricing = 0, followUps = 0;
    const now = new Date();
    for (const c of clients) {
      const cur = c.currency || settings.currency;
      const behind = periodsBehind(c, now);
      if (behind >= 1) { overdue++; owedByCur[cur] = (owedByCur[cur] || 0) + behind * (Number(c.amount) || 0); }
      if (!["marked-deletion", "never-charged"].includes(c.billingStatus) && c.stage !== "marked-deletion") mrr += monthlyValue(c);
      if (c.billingStatus === "old-pricing") oldPricing++;
      if (followUpDue(c, now)) followUps++;
    }
    const owedStr = Object.entries(owedByCur).map(([cur, v]) => money(v, cur)).join(" + ") || money(0, settings.currency);
    return { owedStr, overdue, mrr, oldPricing, followUps };
  }, [clients, settings.currency]);
  return (
    <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 18 }}>
      <Stat label="Total owed" value={s.owedStr} sub={`${s.overdue} clients in arrears`} accent={C.red} small={s.owedStr.length > 12} />
      <Stat label="Monthly Recurring Revenue (active)" value={money(Math.round(s.mrr), settings.currency)} sub="normalised monthly" accent={C.green} />
      <Stat label="Follow-ups due" value={String(s.followUps)} sub="scheduled to chase today" accent={s.followUps ? C.amber : C.green} />
      <Stat label="On old pricing" value={String(s.oldPricing)} sub="increase candidates" accent={C.amber} />
      <Stat label="Bounced" value={String(bounced)} sub="contacts to recover" accent={bounced ? C.red : C.green} />
    </section>
  );
}
function Stat({ label, value, sub, accent, small }) {
  return (
    <div style={{ background: C.panel, borderRadius: 12, border: `1px solid ${C.line}`, padding: "13px 15px" }}>
      <div className="flex items-center" style={{ gap: 7, marginBottom: 7 }}>
        <span style={{ width: 6, height: 6, borderRadius: 6, background: accent }} />
        <span style={{ fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: C.sub, fontWeight: 600 }}>{label}</span>
      </div>
      <div style={{ fontSize: small ? 15 : 21, fontWeight: 600, fontFamily: MONO, letterSpacing: "-0.02em", lineHeight: 1.3 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: C.faint, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

/* ---------------------------- Clients tab ---------------------------- */
function ClientsTab({ clients, settings, onOpen }) {
  const [seg, setSeg] = useState("all");
  const [bill, setBill] = useState("all");
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const list = useMemo(() => {
    let l = clients.filter((c) => (showArchived ? c.archivedClient : !c.archivedClient));
    if (seg !== "all") l = l.filter((c) => c.segment === seg);
    if (bill !== "all") l = l.filter((c) => c.billingStatus === bill);
    if (q.trim()) {
      const k = q.toLowerCase();
      l = l.filter((c) =>
        c.name.toLowerCase().includes(k) || (c.email || "").toLowerCase().includes(k) ||
        (c.company || "").toLowerCase().includes(k) || (c.chargeoverId || "").toLowerCase().includes(k) ||
        (c.archivedContacts || []).some((a) => (a.email || "").toLowerCase().includes(k)));
    }
    return [...l].sort((a, b) => periodsBehind(b) - periodsBehind(a) || a.name.localeCompare(b.name));
  }, [clients, seg, bill, q, showArchived]);
  return (
    <div>
      <div className="flex flex-wrap items-center" style={{ gap: 10, marginBottom: 12 }}>
        <MiniSelect value={seg} onChange={setSeg} options={[["all", "All segments"], ...Object.entries(SEGMENTS).map(([k, v]) => [k, v.label])]} />
        <MiniSelect value={bill} onChange={setBill} options={[["all", "All billing"], ...Object.entries(BILLING).map(([k, v]) => [k, v.label])]} />
        <label className="flex items-center" style={{ gap: 6, fontSize: 12.5, color: C.sub, cursor: "pointer" }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived
        </label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search (incl. old emails & ChargeOver ID)"
          style={{ fontSize: 13, padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, outline: "none", minWidth: 220, marginLeft: "auto" }} />
      </div>
      <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 16px", background: C.lineSoft, borderBottom: `1px solid ${C.line}`, fontSize: 10.5, letterSpacing: "0.05em", textTransform: "uppercase", color: C.sub, fontWeight: 600, display: "grid", gridTemplateColumns: "1.5fr 1.3fr 0.9fr 0.9fr", gap: 12 }}>
          <span>Client</span><span>Billing</span><span>Stage</span><span style={{ textAlign: "right" }}>Owed / rate</span>
        </div>
        {list.map((c) => {
          const behind = periodsBehind(c);
          const cur = c.currency || settings.currency;
          return (
            <button key={c.id} onClick={() => onOpen(c.id)} style={{ width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: `1px solid ${C.lineSoft}`, cursor: "pointer", padding: "11px 16px", display: "grid", gridTemplateColumns: "1.5fr 1.3fr 0.9fr 0.9fr", gap: 12, alignItems: "center", opacity: c.archivedClient ? 0.55 : 1 }}>
              <div>
                <div className="flex items-center" style={{ gap: 7, flexWrap: "wrap" }}>
                  <span style={{ width: 6, height: 6, borderRadius: 6, background: SEGMENTS[c.segment].color }} />
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{c.name}</span>
                  {c.emailStatus !== "ok" && <MiniPill fg={C.red} bg={C.redBg}>bounced</MiniPill>}
                  {followUpDue(c) && <MiniPill fg={C.amber} bg={C.amberBg}>follow up</MiniPill>}
                  {behind >= 3 && <MiniPill fg="#fff" bg={C.red}>final notice</MiniPill>}
                </div>
                <div style={{ fontSize: 12, color: C.sub, fontFamily: MONO, marginTop: 2 }}>{c.email || "no email"}{c.chargeoverId ? ` · CO#${c.chargeoverId}` : ""}</div>
              </div>
              <div><Pill fg={BILLING[c.billingStatus].color} bg={BILLING[c.billingStatus].bg}>{BILLING[c.billingStatus].label}</Pill></div>
              <div style={{ fontSize: 12.5, color: STAGES[c.stage].color, fontWeight: 600 }}>{STAGES[c.stage].label}</div>
              <div style={{ textAlign: "right" }}>
                {behind >= 1
                  ? <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, color: C.red }}>{money(behind * c.amount, cur)}<span style={{ fontSize: 11, color: C.faint, fontWeight: 500 }}> · {behind}p</span></div>
                  : <div style={{ fontFamily: MONO, fontSize: 13, color: C.green, fontWeight: 600 }}>current</div>}
                <div style={{ fontSize: 11, color: C.faint, fontFamily: MONO }}>{money(c.amount, cur)}/{c.cadence === "annual" ? "yr" : "mo"}</div>
              </div>
            </button>
          );
        })}
        {list.length === 0 && <div style={{ padding: 32, textAlign: "center", color: C.sub, fontSize: 13 }}>No clients match these filters.</div>}
      </div>
    </div>
  );
}

/* --------------------------- Workflow tab --------------------------- */
function WorkflowTab({ clients, onOpen, onStage }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, alignItems: "start" }}>
      {STAGE_ORDER.map((stage) => {
        const col = clients.filter((c) => c.stage === stage);
        return (
          <div key={stage} style={{ background: C.panel, borderRadius: 12, border: `1px solid ${C.line}`, overflow: "hidden" }}>
            <div style={{ padding: "10px 12px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 8, height: 8, borderRadius: 8, background: STAGES[stage].color }} />
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>{STAGES[stage].label}</span>
              <span style={{ fontSize: 11, color: C.faint, marginLeft: "auto", fontFamily: MONO }}>{col.length}</span>
            </div>
            <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6, minHeight: 40 }}>
              {col.map((c) => (
                <div key={c.id} style={{ background: C.paper, borderRadius: 8, padding: "8px 10px", border: `1px solid ${followUpDue(c) ? C.amber : C.line}` }}>
                  <button onClick={() => onOpen(c.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", width: "100%" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{c.name}</div>
                    <div style={{ fontSize: 11, color: C.sub, fontFamily: MONO }}>{SEGMENTS[c.segment].label}{periodsBehind(c) ? ` · ${periodsBehind(c)}p behind` : ""}</div>
                    {c.followUp && <div style={{ fontSize: 10.5, color: followUpDue(c) ? C.amber : C.faint, marginTop: 2 }}>Follow up {fmtDate(c.followUp)}</div>}
                  </button>
                  <select value={c.stage} onChange={(e) => onStage(c.id, e.target.value)}
                    style={{ marginTop: 6, width: "100%", fontSize: 11, padding: "4px 6px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.panel, color: C.sub, cursor: "pointer" }}>
                    {STAGE_ORDER.map((s) => <option key={s} value={s}>{STAGES[s].label}</option>)}
                  </select>
                </div>
              ))}
              {col.length === 0 && <div style={{ fontSize: 11, color: C.faint, textAlign: "center", padding: "8px 0" }}>—</div>}
            </div>
          </div>
        );
      })}
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
          <button onClick={() => onOpen(client.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 15, fontWeight: 700, color: C.ink }}>{client.name}</button>
          <div style={{ fontSize: 12, color: C.sub, fontFamily: MONO, marginTop: 2 }}><span style={{ textDecoration: "line-through", color: C.red }}>{client.email}</span> · {client.company}</div>
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
function CommsTab({ clients, settings, onLogSent }) {
  const [type, setType] = useState("reminder");
  const [seg, setSeg] = useState("all");
  const [bill, setBill] = useState("all");
  const [idx, setIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const key = `${type}:${periodKey()}`;

  const audience = useMemo(() => {
    let l = clients.filter((c) => !c.tags.includes("opted-out") && c.emailStatus === "ok");
    // deletion notices go TO accounts marked for deletion; every other type excludes them
    if (type === "deletion") l = l.filter((c) => c.stage === "marked-deletion" || c.billingStatus === "marked-deletion");
    else l = l.filter((c) => c.stage !== "marked-deletion");
    if (type === "reminder") l = l.filter((c) => isOverdue(c) && !["never-charged", "marked-deletion"].includes(c.billingStatus));
    if (seg !== "all") l = l.filter((c) => c.segment === seg);
    if (bill !== "all") l = l.filter((c) => c.billingStatus === bill);
    if (type === "reminder") l = [...l].sort((a, b) => periodsBehind(b) - periodsBehind(a));
    return l;
  }, [clients, type, seg, bill]);

  useEffect(() => { setIdx(0); }, [type, seg, bill]);
  const client = audience[Math.min(idx, Math.max(0, audience.length - 1))];
  const saved = (client?.reminders && client.reminders[key]) || {};
  const subject = saved.subject ?? (client ? COMMS[type].subject(client, settings) : "");
  const body = saved.body ?? (client ? COMMS[type].body(client, settings) : "");
  const esc = client && type === "reminder" ? escalationOf(client) : null;
  const copy = () => { navigator.clipboard?.writeText(`From: ${FROM_EMAIL}\nSubject: ${subject}\n\n${body}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }); };

  return (
    <div>
      <div className="flex flex-wrap items-center" style={{ gap: 10, marginBottom: 14 }}>
        <MiniSelect value={type} onChange={setType} options={Object.entries(COMMS).map(([k, v]) => [k, v.label])} />
        <MiniSelect value={seg} onChange={setSeg} options={[["all", "All segments"], ...Object.entries(SEGMENTS).map(([k, v]) => [k, v.label])]} />
        <MiniSelect value={bill} onChange={setBill} options={[["all", "All billing"], ...Object.entries(BILLING).map(([k, v]) => [k, v.label])]} />
        <span style={{ marginLeft: "auto", fontSize: 12.5, color: C.sub }}>{audience.length} in audience · opted-out, bounced & deletion excluded</span>
      </div>
      {!client ? (
        <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 40, textAlign: "center", color: C.sub, fontSize: 14 }}>No eligible recipients for this selection.</div>
      ) : (
        <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 18 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
            <div>
              <div className="flex items-center" style={{ gap: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 700 }}>{client.name}</span>
                {esc && <MiniPill fg={esc.level === 3 ? "#fff" : esc.color} bg={esc.level === 3 ? C.red : C.amberBg}>{esc.label} · {periodsBehind(client)}p behind · {money(totalOwed(client), client.currency || settings.currency)}</MiniPill>}
                {saved.sentAt && <MiniPill fg={C.green} bg={C.greenBg}>sent {fmtDate(saved.sentAt)}</MiniPill>}
              </div>
              <div style={{ fontSize: 12, color: C.sub, fontFamily: MONO, marginTop: 2 }}>{client.email} · {SEGMENTS[client.segment].label}</div>
            </div>
            <div className="flex items-center" style={{ gap: 6 }}>
              <button disabled={idx === 0} onClick={() => setIdx((i) => Math.max(0, i - 1))} style={navBtn(idx === 0)}>←</button>
              <span style={{ fontSize: 12, color: C.sub, fontFamily: MONO }}>{idx + 1}/{audience.length}</span>
              <button disabled={idx >= audience.length - 1} onClick={() => setIdx((i) => Math.min(audience.length - 1, i + 1))} style={navBtn(idx >= audience.length - 1)}>→</button>
            </div>
          </div>
          <Field label="From"><div style={{ fontFamily: MONO, fontSize: 13, color: C.sub, padding: "9px 11px", background: C.lineSoft, borderRadius: 8 }}>{FROM_EMAIL}</div></Field>
          <Field label="Subject"><input style={inputStyle} value={subject} onChange={(e) => onLogSent(client.id, key, { subject: e.target.value })} /></Field>
          <Field label="Message"><textarea rows={12} style={{ ...inputStyle, fontFamily: SANS, lineHeight: 1.5, resize: "vertical" }} value={body} onChange={(e) => onLogSent(client.id, key, { body: e.target.value })} /></Field>
          <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
            <GhostBtn onClick={copy}>{copied ? "Copied ✓" : "Copy for Brevo"}</GhostBtn>
            <button onClick={() => onLogSent(client.id, key, { sentAt: new Date().toISOString() }, COMMS[type].label)} style={{ fontSize: 13, fontWeight: 600, padding: "9px 16px", borderRadius: 8, border: "none", background: C.action, color: "#fff", cursor: "pointer" }}>
              {saved.sentAt ? "Marked sent ✓" : "Mark sent"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------- Digest tab ----------------------------- */
function DigestTab({ clients, settings, bounced, onGo, onOpen }) {
  const now = new Date();
  const overdueList = clients.filter((c) => isOverdue(c, now) && c.emailStatus === "ok" && !c.tags.includes("opted-out") && !["never-charged"].includes(c.billingStatus));
  const finals = overdueList.filter((c) => periodsBehind(c, now) >= 3);
  const followUps = clients.filter((c) => followUpDue(c, now));
  const pendingContacts = clients.filter((c) => c.candidates?.length > 0);
  const oldPricing = clients.filter((c) => c.billingStatus === "old-pricing" && !c.tags.includes("price-declined"));
  const Row = ({ n, label, tint, to }) => (
    <button onClick={() => onGo(to)} className="flex items-center justify-between" style={{ width: "100%", textAlign: "left", background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", cursor: "pointer" }}>
      <span style={{ fontSize: 13.5 }}>{label}</span>
      <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 15, color: tint }}>{n}</span>
    </button>
  );
  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, alignItems: "start" }}>
      <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: C.sub, fontWeight: 600 }}>Preview · daily approval email</div>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: "6px 0 4px", fontFamily: DISPLAY }}>Today's outbound queue</h2>
        <p style={{ fontSize: 13, color: C.sub, marginBottom: 16 }}>In production this lands in your inbox each morning. Nothing sends until you approve.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Row n={overdueList.length} label="Payment reminders ready" tint={C.red} to="comms" />
          <Row n={finals.length} label="Final notices (3+ periods behind)" tint={C.red} to="comms" />
          <Row n={followUps.length} label="Follow-ups due today" tint={C.amber} to="workflow" />
          <Row n={oldPricing.length} label="Old pricing — notices to send" tint={C.amber} to="comms" />
          <Row n={pendingContacts.length} label="Recovered contacts awaiting approval" tint={C.action} to="recovery" />
          <Row n={bounced} label="Bounced contacts to recover" tint={C.red} to="recovery" />
        </div>
      </div>
      {followUps.length > 0 && (
        <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 20 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Follow-ups due</h3>
          {followUps.map((c) => (
            <button key={c.id} onClick={() => onOpen(c.id)} className="flex items-center justify-between" style={{ width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: `1px solid ${C.lineSoft}`, padding: "9px 2px", cursor: "pointer" }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink }}>{c.name}</div>
                <div style={{ fontSize: 11.5, color: C.sub }}>{c.notes ? c.notes.slice(0, 60) + (c.notes.length > 60 ? "…" : "") : STAGES[c.stage].label}</div>
              </div>
              <span style={{ fontSize: 11, fontFamily: MONO, color: C.amber, whiteSpace: "nowrap" }}>{fmtDate(c.followUp)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------- Detail drawer --------------------------- */
function DetailDrawer({ client, settings, onClose, onUpdate, onUpdateWithLog, onRecordPayment, onDelete }) {
  const set = (patch) => onUpdate(client.id, patch);
  const toggleTag = (t) => set({ tags: client.tags.includes(t) ? client.tags.filter((x) => x !== t) : [...client.tags, t] });
  const [payAmt, setPayAmt] = useState(client.amount);
  const [payDate, setPayDate] = useState(iso());
  const [note, setNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sc, setSc] = useState({ name: "", email: "", role: "" });
  const cur = client.currency || settings.currency;
  const behind = periodsBehind(client);
  const sentComms = Object.entries(client.reminders || {}).filter(([, v]) => v.sentAt);

  return (
    <div onClick={onClose} className="flex justify-end" style={{ position: "fixed", inset: 0, background: "rgba(34,48,76,0.45)", zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.paper, width: "100%", maxWidth: 520, height: "100%", overflow: "auto", boxShadow: "-20px 0 60px rgba(34,48,76,0.25)" }}>
        <div className="flex items-center justify-between" style={{ padding: "16px 20px", borderBottom: `1px solid ${C.line}`, background: C.panel, position: "sticky", top: 0, zIndex: 1 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700 }}>{client.name}{client.archivedClient ? " · archived" : ""}</h2>
            {behind >= 1 && <div style={{ fontSize: 12, color: C.red, fontWeight: 600 }}>{behind} period{behind > 1 ? "s" : ""} behind · owes {money(totalOwed(client), cur)}</div>}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, color: C.sub, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ padding: 20 }}>
          {/* Identity & billing */}
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Contact name"><input style={inputStyle} value={client.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Company"><input style={inputStyle} value={client.company} onChange={(e) => set({ company: e.target.value })} /></Field>
            <Field label="Email"><input style={inputStyle} value={client.email} onChange={(e) => set({ email: e.target.value })} /></Field>
            <Field label="Phone"><input style={inputStyle} value={client.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
            <Field label="ChargeOver ID"><input style={inputStyle} value={client.chargeoverId} onChange={(e) => set({ chargeoverId: e.target.value })} placeholder="for sync matching" /></Field>
            <Field label="Email status">
              <select style={inputStyle} value={client.emailStatus} onChange={(e) => set({ emailStatus: e.target.value })}>
                <option value="ok">Deliverable</option><option value="bounced">Bounced</option><option value="undelivered">Undelivered</option>
              </select>
            </Field>
            <Field label="Amount"><input type="number" style={inputStyle} value={client.amount} onChange={(e) => set({ amount: Number(e.target.value) })} /></Field>
            <Field label="Currency">
              <select style={inputStyle} value={client.currency || ""} onChange={(e) => set({ currency: e.target.value })}>
                <option value="">Default ({settings.currency})</option><option value="GBP">£ GBP</option><option value="USD">$ USD</option><option value="EUR">€ EUR</option>
              </select>
            </Field>
            <Field label="Cadence">
              <select style={inputStyle} value={client.cadence} onChange={(e) => set({ cadence: e.target.value })}>
                {Object.entries(CADENCE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </Field>
            <Field label="Billing day"><input type="number" min="1" max="28" style={inputStyle} value={client.billingDay} onChange={(e) => set({ billingDay: Number(e.target.value) })} /></Field>
          </div>
          <Field label="Segment"><select style={inputStyle} value={client.segment} onChange={(e) => set({ segment: e.target.value })}>{Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
          <Field label="Billing status (ChargeOver)"><select style={inputStyle} value={client.billingStatus} onChange={(e) => set({ billingStatus: e.target.value })}>{Object.entries(BILLING).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
          <Field label="Workflow stage"><select style={inputStyle} value={client.stage} onChange={(e) => onUpdateWithLog(client.id, { stage: e.target.value }, "stage", `Stage → ${STAGES[e.target.value].label}`)}>{STAGE_ORDER.map((k) => <option key={k} value={k}>{STAGES[k].label}</option>)}</select></Field>
          <Field label="Follow up on"><input type="date" style={inputStyle} value={client.followUp} onChange={(e) => set({ followUp: e.target.value })} /></Field>

          {/* Tags */}
          <div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginTop: 4, marginBottom: 8 }}>Tags</div>
          <div className="flex" style={{ flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
            {Object.entries(TAGS).map(([k, v]) => {
              const on = client.tags.includes(k);
              return <button key={k} onClick={() => toggleTag(k)} style={{ fontSize: 12, fontWeight: 600, padding: "6px 11px", borderRadius: 20, cursor: "pointer", border: `1px solid ${on ? v.color : C.line}`, background: on ? v.color : C.panel, color: on ? "#fff" : C.sub }}>{v.label}</button>;
            })}
          </div>

          {/* Notes */}
          <Field label="Notes">
            <textarea rows={3} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }} value={client.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Context, promises made, anything the next you needs to know" />
          </Field>

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

          {/* Secondary contacts */}
          <Section title="Additional contacts">
            {(client.secondaryContacts || []).map((s2, i) => (
              <div key={i} className="flex items-center justify-between" style={{ fontSize: 12.5, padding: "5px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
                <span><strong>{s2.name}</strong> · <span style={{ fontFamily: MONO, color: C.sub }}>{s2.email}</span>{s2.role ? ` · ${s2.role}` : ""}</span>
                <button onClick={() => set({ secondaryContacts: client.secondaryContacts.filter((_, j) => j !== i) })} style={{ background: "none", border: "none", color: C.faint, cursor: "pointer" }}>✕</button>
              </div>
            ))}
            <div className="flex items-end" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              <input style={{ ...inputStyle, flex: 1, minWidth: 90 }} placeholder="Name" value={sc.name} onChange={(e) => setSc({ ...sc, name: e.target.value })} />
              <input style={{ ...inputStyle, flex: 1.4, minWidth: 130 }} placeholder="Email" value={sc.email} onChange={(e) => setSc({ ...sc, email: e.target.value })} />
              <input style={{ ...inputStyle, flex: 1, minWidth: 80 }} placeholder="Role" value={sc.role} onChange={(e) => setSc({ ...sc, role: e.target.value })} />
              <GhostBtn onClick={() => { if (sc.name || sc.email) { set({ secondaryContacts: [...(client.secondaryContacts || []), sc] }); setSc({ name: "", email: "", role: "" }); } }}>Add</GhostBtn>
            </div>
          </Section>

          {/* Sent comms */}
          {sentComms.length > 0 && (
            <Section title="Communications sent">
              {sentComms.map(([k, v]) => (
                <div key={k} className="flex justify-between" style={{ fontSize: 12.5, padding: "5px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
                  <span>{COMMS[k.split(":")[0]]?.label || k} · {k.split(":")[1]}</span>
                  <span style={{ fontFamily: MONO, color: C.sub }}>{fmtDate(v.sentAt)}</span>
                </div>
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

          {/* Archive / delete */}
          <div className="flex" style={{ gap: 8, marginTop: 22, flexWrap: "wrap" }}>
            <GhostBtn onClick={() => onUpdateWithLog(client.id, { archivedClient: !client.archivedClient }, "archive", client.archivedClient ? "Client restored" : "Client archived")}>
              {client.archivedClient ? "Restore client" : "Archive client"}
            </GhostBtn>
            {!confirmDelete ? (
              <button onClick={() => setConfirmDelete(true)} style={{ fontSize: 12.5, color: C.red, background: "none", border: `1px solid ${C.redBg}`, borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}>Delete permanently…</button>
            ) : (
              <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: C.red }}>This can't be undone — Archive is reversible.</span>
                <button onClick={() => onDelete(client.id)} style={{ fontSize: 12.5, fontWeight: 600, color: "#fff", background: C.red, border: "none", borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}>Confirm delete</button>
                <button onClick={() => setConfirmDelete(false)} style={{ fontSize: 12.5, color: C.sub, background: "none", border: "none", cursor: "pointer" }}>Cancel</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Shared ------------------------------ */
function Section({ title, children }) {
  return (
    <div style={{ background: C.panel, borderRadius: 12, border: `1px solid ${C.line}`, padding: 14, marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.ink, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
function Pill({ fg, bg, children }) { return <span style={{ fontSize: 11.5, fontWeight: 600, color: fg, background: bg, padding: "3px 9px", borderRadius: 20, display: "inline-block" }}>{children}</span>; }
function MiniPill({ fg, bg, children }) { return <span style={{ fontSize: 10, fontWeight: 700, color: fg, background: bg, padding: "1px 7px", borderRadius: 10 }}>{children}</span>; }
function Tab({ active, onClick, children }) { return <button onClick={onClick} style={{ fontSize: 13.5, fontWeight: 600, padding: "9px 14px", cursor: "pointer", border: "none", background: "transparent", color: active ? C.ink : C.sub, borderBottom: `2px solid ${active ? C.action : "transparent"}`, marginBottom: -1 }}>{children}</button>; }
function MiniBtn({ solid, onClick, children }) { return <button onClick={onClick} style={{ fontSize: 12, fontWeight: 600, padding: "6px 11px", borderRadius: 7, cursor: "pointer", border: solid ? "none" : `1px solid ${C.line}`, background: solid ? C.action : C.panel, color: solid ? "#fff" : C.ink }}>{children}</button>; }
function SolidBtn({ onClick, children }) { return <button onClick={onClick} style={{ fontSize: 13, fontWeight: 600, padding: "9px 16px", borderRadius: 8, cursor: "pointer", border: "none", background: C.action, color: "#fff" }}>{children}</button>; }
function GhostBtn({ onClick, children }) { return <button onClick={onClick} style={{ fontSize: 13, fontWeight: 600, padding: "9px 14px", borderRadius: 8, cursor: "pointer", border: `1px solid ${C.line}`, background: C.panel, color: C.ink }}>{children}</button>; }
function MiniSelect({ value, onChange, options }) { return <select value={value} onChange={(e) => onChange(e.target.value)} style={{ fontSize: 13, padding: "8px 11px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, color: C.ink, cursor: "pointer", maxWidth: 220 }}>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>; }
function Field({ label, children }) { return <label style={{ display: "block", marginBottom: 12 }}><span style={{ fontSize: 12, fontWeight: 600, color: C.sub, display: "block", marginBottom: 5 }}>{label}</span>{children}</label>; }
const inputStyle = { width: "100%", fontSize: 14, padding: "9px 11px", borderRadius: 8, border: `1px solid ${C.line}`, outline: "none", boxSizing: "border-box", color: C.ink, background: C.panel };
function navBtn(d) { return { fontSize: 14, width: 34, height: 34, borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, color: d ? C.faint : C.ink, cursor: d ? "default" : "pointer", opacity: d ? 0.5 : 1 }; }

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
  const [f, setF] = useState({ name: "", company: "", email: "", chargeoverId: "", segment: "viper-current", billingStatus: "never-charged", amount: "", billingDay: "1", cadence: "monthly", currency: "" });
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
function Modal({ title, onClose, children }) {
  return (
    <div onClick={onClose} className="flex items-center justify-center" style={{ position: "fixed", inset: 0, background: "rgba(34,48,76,0.45)", padding: 16, zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.panel, borderRadius: 16, width: "100%", maxWidth: 540, maxHeight: "88vh", overflow: "auto", boxShadow: "0 24px 60px rgba(34,48,76,0.25)" }}>
        <div className="flex items-center justify-between" style={{ padding: "18px 20px", borderBottom: `1px solid ${C.line}` }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, fontFamily: DISPLAY }}>{title}</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, color: C.sub, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}
