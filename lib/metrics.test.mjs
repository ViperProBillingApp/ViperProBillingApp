// Run: node lib/metrics.test.mjs — the one check that fails if the money math breaks.
import assert from "node:assert";
import { periodsBehind, arrearsPeriods, totalOwed, monthlyValue, computeKpis, topOwed } from "./metrics.js";

const base = { billingStatus: "current-pricing", stage: "up-to-date", cadence: "monthly", amount: 100, billingDay: 1 };

// coOverdue wins over coBalance (CO pre-generates upcoming invoices)
assert.equal(totalOwed({ ...base, coBalance: 500, coOverdue: 200 }), 200);
// annual client is NOT 12 months of MRR — the bug that inflated MRR daily
assert.equal(monthlyValue({ ...base, cadence: "annual", amount: 1200 }), 100);
// group-covered member owes nothing and adds no MRR
const covered = { ...base, multiOffice: true, priceMode: "group", coBalance: 400 };
assert.equal(totalOwed(covered), 0);
assert.equal(monthlyValue(covered), 0);
// never-charged clients aren't behind
assert.equal(periodsBehind({ ...base, billingStatus: "never-charged", lastPaid: "2024-01-01" }), 0);
// CO balance ÷ rate gives arrears periods (fallback when no invoice count)
assert.equal(arrearsPeriods({ ...base, coOverdue: 300 }), 3);
// The overdue-invoice COUNT beats balance ÷ rate: one $900 invoice ($400 fee +
// $500 one-time setup) is 1 period behind, not round(900/400) = 2
assert.equal(arrearsPeriods({ ...base, amount: 400, coOverdue: 900, coOverdueCount: 1 }), 1);
// count still capped, zero-owed still 0, and a real multi-invoice case counts each
assert.equal(arrearsPeriods({ ...base, coOverdue: 0, coOverdueCount: 0 }), 0);
assert.equal(arrearsPeriods({ ...base, coOverdue: 300, coOverdueCount: 3 }), 3);
// owed but count says 0 (stale mix) — never show "0 behind" while money is owed
assert.equal(arrearsPeriods({ ...base, coOverdue: 50, coOverdueCount: 0 }), 1);

// group-covered offices don't get stage-derived follow-ups (the master card does)...
import { needsFollowUp } from "./metrics.js";
const office = { ...base, multiOffice: true, priceMode: "group", stage: "need-to-contact" };
assert.equal(needsFollowUp(office), false);
// ...but an explicit follow-up date on an office is deliberate and still honoured
assert.equal(needsFollowUp({ ...office, followUp: "2020-01-01" }), true);
// the group master itself still follows the normal stage rules
assert.equal(needsFollowUp({ ...office, groupBillingMaster: true }), true);

const kpis = computeKpis([
  { ...base, segment: "viper-current", coBalance: 250, coOverdue: 250, currency: "USD" },
  { ...base, segment: "viper-current", cadence: "annual", amount: 1200, coBalance: 0 },
  { ...base, segment: "maritz-portal", billingStatus: "never-charged", amount: 0 },
], { currency: "GBP" });
assert.equal(kpis.mrr, 200);              // 100 monthly + 1200/12 annual, never-charged excluded
assert.equal(kpis.arr, 2400);
assert.equal(kpis.overdue, 1);
assert.equal(kpis.totalOwed, 250);
assert.deepEqual(kpis.owedByCur, { USD: 250 });
assert.equal(kpis.bySegment["viper-current"], 2);
assert.equal(kpis.activeClients, 2);

const top = topOwed([{ ...base, coOverdue: 50 }, { ...base, coOverdue: 900 }, { ...base, coOverdue: 0 }]);
assert.equal(top.length, 2);
assert.equal(top[0].owed, 900);

console.log("metrics: all checks passed");
