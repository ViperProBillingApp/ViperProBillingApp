/* Money math shared by the UI (crm.jsx), the daily cron, and reports.
   Extracted from crm.jsx so the digest email can never disagree with the
   screen — duplicated MRR logic is exactly how the daily-inflation bug
   happened. Pure functions only: no React, no colors, no fetch. */

export const SYMBOL = { GBP: "£", USD: "$", EUR: "€" };
export const CADENCE = { monthly: { label: "Monthly", months: 1 }, annual: { label: "Annual", months: 12 } };

function pad(n) { return String(n).padStart(2, "0"); }
export function iso(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function parseDate(s) { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
function monthIndex(d) { return d.getFullYear() * 12 + d.getMonth(); }

// A group member whose billing is carried by the group's master card:
// it owes nothing itself and never gets reminders.
export function coveredByGroup(c) {
  return !!(c.multiOffice && c.priceMode === "group" && !c.groupBillingMaster);
}

export function lastPaymentDate(c) {
  let best = parseDate(c.lastPaid);
  for (const p of c.payments || []) { const d = parseDate(p.date); if (d && (!best || d > best)) best = d; }
  return best;
}

// How many billing periods is this client behind? 0 = current.
// Single source of truth for "who owes what" — do not duplicate elsewhere.
export function periodsBehind(c, now = new Date()) {
  if (coveredByGroup(c)) return 0; // billed via the group's master card
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

// What's actually owed RIGHT NOW. ChargeOver pre-generates upcoming invoices,
// so the raw customer balance can include charges that aren't due yet — the
// sync stores the overdue-only figure in coOverdue, which wins when present.
export function owedBalance(c) { return c.coOverdue != null ? c.coOverdue : c.coBalance; }

// Real ChargeOver balance beats the calendar-based guess whenever we have one —
// dividing it by the recorded rate gives "how many periods' worth is owed"
// without depending on billingDay/lastPaid bookkeeping being accurate. This is
// what makes "final notice" and "total owed" trustworthy for synced clients.
export function arrearsPeriods(c, now = new Date()) {
  if (coveredByGroup(c)) return 0;
  const owed = owedBalance(c);
  if (owed != null && Number(c.amount) > 0) {
    if (owed <= 0) return 0;
    return Math.max(1, Math.min(24, Math.round(owed / Number(c.amount))));
  }
  return periodsBehind(c, now);
}

export function totalOwed(c, now = new Date()) {
  if (coveredByGroup(c)) return 0;
  const owed = owedBalance(c);
  if (owed != null) return Math.max(0, owed);
  return periodsBehind(c, now) * (Number(c.amount) || 0);
}

// Who needs a payment reminder. periodsBehind only works once we know recurring
// amounts — the ChargeOver billing status is the reliable signal for CSV-imported
// clients, so either counts.
export function needsReminder(c, now = new Date()) {
  if (coveredByGroup(c)) return false;
  if (["never-charged", "marked-deletion"].includes(c.billingStatus) || c.stage === "marked-deletion") return false;
  return arrearsPeriods(c, now) >= 1 || ["not-up-to-date", "payment-failed"].includes(c.billingStatus);
}

export function monthlyValue(c) { return coveredByGroup(c) ? 0 : (Number(c.amount) || 0) / (CADENCE[c.cadence]?.months || 1); }

// Compare calendar dates as "YYYY-MM-DD" strings, not Date objects — a
// date-only string parses as UTC midnight, which can read as "not due yet"
// or "already due" depending on the browser's timezone offset from UTC.
export function followUpDue(c, now = new Date()) { return !!c.followUp && c.followUp <= iso(now); }

// Who needs a follow-up. An explicit follow-up date that's due always counts;
// otherwise it's derived from the workflow — "need to contact" and "contacted ·
// awaiting reply" are the stages where the ball is in your court. Skips
// archived / former clients.
const FOLLOWUP_STAGES = ["need-to-contact", "contacted-awaiting"];
export function needsFollowUp(c, now = new Date()) {
  if (c.archivedClient || c.formerCustomer) return false;
  return followUpDue(c, now) || FOLLOWUP_STAGES.includes(c.stage);
}

export function fmtMoney(a, cur = "GBP") {
  return `${SYMBOL[cur] || "£"}${(Number(a) || 0).toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// The one KPI aggregation. Every card, digest line, and snapshot row comes
// from this — same loop the Today tab's StatStrip runs.
// `clients` should already exclude archived cards (pass the same `active`
// list the tabs use).
export function computeKpis(clients, settings = {}, now = new Date()) {
  const owedByCur = {};
  let overdue = 0, mrr = 0, mrrKnown = 0, notUpToDate = 0, followUps = 0, synced = 0, active = 0, finalNotice = 0;
  const bySegment = {}, byStage = {};
  for (const c of clients) {
    const cur = c.currency || settings.currency || "GBP";
    bySegment[c.segment] = (bySegment[c.segment] || 0) + 1;
    byStage[c.stage] = (byStage[c.stage] || 0) + 1;
    // Prefer ChargeOver's own balance (live from last sync) over the
    // periods×amount estimate — that estimate is only as good as `amount`,
    // which most imported clients don't have set.
    if (coveredByGroup(c)) {
      if (c.coBalance != null) synced++;
      // billed via group master — its own balance never counts as owed
    } else if (c.coBalance != null) {
      synced++;
      const owed = owedBalance(c);
      if (owed > 0) { overdue++; owedByCur[cur] = (owedByCur[cur] || 0) + owed; }
    } else {
      const behind = periodsBehind(c, now);
      if (behind >= 1) { overdue++; owedByCur[cur] = (owedByCur[cur] || 0) + behind * (Number(c.amount) || 0); }
    }
    if (!["marked-deletion", "never-charged"].includes(c.billingStatus) && c.stage !== "marked-deletion") {
      mrr += monthlyValue(c);
      if (Number(c.amount) > 0) { mrrKnown++; active++; }
    }
    if (["not-up-to-date", "payment-failed"].includes(c.billingStatus)) notUpToDate++;
    if (needsFollowUp(c, now)) followUps++;
    if (arrearsPeriods(c, now) >= 3) finalNotice++;
  }
  const totalOwedAll = Object.values(owedByCur).reduce((a, b) => a + b, 0);
  return {
    date: iso(now),
    mrr: Math.round(mrr), arr: Math.round(mrr * 12), mrrKnown,
    totalOwed: Math.round(totalOwedAll * 100) / 100, owedByCur,
    overdue, notUpToDate, finalNotice, followUps, synced,
    activeClients: active, totalClients: clients.length,
    bySegment, byStage,
  };
}

// Clients owing the most, for the digest and the Reports action list.
export function topOwed(clients, n = 10, now = new Date()) {
  return clients
    .map((c) => ({ c, owed: totalOwed(c, now) }))
    .filter((x) => x.owed > 0)
    .sort((a, b) => b.owed - a.owed)
    .slice(0, n);
}
