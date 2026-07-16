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
// CO balance ÷ rate gives arrears periods
assert.equal(arrearsPeriods({ ...base, coOverdue: 300 }), 3);

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
