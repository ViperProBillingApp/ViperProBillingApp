// Money formatting + KPI currency bucketing. No DB needed — pure functions.
//
// Why this exists: a third of the client cards carry no `currency` at all, and
// the fallback used to be GBP. Real USD balances printed as "£900" and the
// cron digest bucketed them into a phantom GBP total. Guard the fallback.
import assert from "node:assert/strict";
import { fmtMoney, computeKpis, SYMBOL, owesNow, contributesMrr, isNotUpToDate, needsFollowUp } from "../lib/metrics.js";

// --- fmtMoney fallback ---
assert.equal(fmtMoney(900, "USD"), "$900");
assert.equal(fmtMoney(900, "GBP"), "£900");
assert.equal(fmtMoney(900, "EUR"), "€900");
// The cases that bit us: no currency, empty string, unknown code.
assert.equal(fmtMoney(900), "$900", "no currency must fall back to USD, not GBP");
assert.equal(fmtMoney(900, ""), "$900", "empty currency must fall back to USD");
assert.equal(fmtMoney(900, "XYZ"), "$900", "unknown currency must fall back to USD");
assert.equal(fmtMoney(1234.5, "USD"), "$1,234.5");
assert.equal(fmtMoney(null), "$0");

// --- KPI bucketing ---
const client = (over = {}) => ({
  id: over.id || "x", segment: "viper-current", stage: "up-to-date", billingStatus: "current-pricing",
  tags: [], amount: 0, cadence: "monthly", currency: "", coBalance: null, coOverdue: null,
  payments: [], reminders: {}, emailStatus: "ok", ...over,
});

// A currency-less client owing money buckets under USD, not GBP.
const k = computeKpis([client({ id: "a", currency: "", coBalance: 900, coOverdue: 900 })], {});
assert.equal(k.owedByCur.GBP, undefined, "currency-less clients must not create a GBP bucket");
assert.ok(k.owedByCur.USD > 0, "currency-less owed balance belongs in the USD bucket");

// An explicit currency still wins over the fallback.
const k2 = computeKpis([client({ id: "b", currency: "EUR", coBalance: 500, coOverdue: 500 })], {});
assert.ok(k2.owedByCur.EUR > 0, "an explicit currency must be honoured");
assert.equal(k2.owedByCur.USD, undefined);

// settings.currency sits between the two.
const k3 = computeKpis([client({ id: "c", currency: "", coBalance: 100, coOverdue: 100 })], { currency: "GBP" });
assert.ok(k3.owedByCur.GBP > 0, "settings.currency must still override the USD fallback");

assert.deepEqual(Object.keys(SYMBOL).sort(), ["EUR", "GBP", "USD"]);

// --- StatStrip drill-down agrees with the tile ---
// Clicking a metric filters the Clients grid with these predicates. If they ever
// stop matching computeKpis, the tile says one number and the grid shows another.
const book = [
  client({ id: "1", billingStatus: "not-up-to-date", coBalance: 900, coOverdue: 900, amount: 400 }),
  client({ id: "2", billingStatus: "payment-failed", coBalance: 0, coOverdue: 0, amount: 250 }),
  client({ id: "3", billingStatus: "current-pricing", coBalance: 0, coOverdue: 0, amount: 300 }),
  client({ id: "4", billingStatus: "never-charged", coBalance: 0, coOverdue: 0, amount: 0 }),
  client({ id: "5", billingStatus: "marked-deletion", stage: "marked-deletion", coBalance: 500, coOverdue: 500, amount: 100 }),
  client({ id: "6", billingStatus: "current-pricing", stage: "need-to-contact", coBalance: 0, coOverdue: 0, amount: 200 }),
];
const kpi = computeKpis(book, { currency: "USD" });
assert.equal(book.filter(isNotUpToDate).length, kpi.notUpToDate, "'Not up to date' tile vs drill-down");
assert.equal(book.filter((c) => owesNow(c)).length, kpi.overdue, "'Total owed' tile vs drill-down");
assert.equal(book.filter(contributesMrr).length, kpi.mrrKnown, "'MRR' tile vs drill-down");
assert.equal(book.filter((c) => needsFollowUp(c)).length, kpi.followUps, "'Follow-ups' tile vs drill-down");

// A group-covered office never counts as owing — it's chased via the master card.
assert.equal(owesNow(client({ multiOffice: true, priceMode: "group", groupBillingMaster: false, coBalance: 900, coOverdue: 900 })), false,
  "offices covered by a group card must not appear under 'owing money'");
// …but the master card that actually gets billed does.
assert.equal(owesNow(client({ multiOffice: true, priceMode: "group", groupBillingMaster: true, coBalance: 900, coOverdue: 900 })), true,
  "the group billing master still owes");

console.log("check-money: ok");
