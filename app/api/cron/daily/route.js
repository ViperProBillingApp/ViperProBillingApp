import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { computeKpis, topOwed, fmtMoney, arrearsPeriods } from "../../../../lib/metrics.js";
import { sendDigestEmail } from "../../../../lib/email.js";
import { snapshotState, gcExpired } from "../../../../lib/security.js";
import { readState } from "../../../../lib/clients.js";

export const maxDuration = 60;

// Runs at 06:30, after the 06:00 ChargeOver sync, so the digest reads fresh
// balances. Backup + KPI snapshot (the Reports tab's trend data) run every
// day; the digest email only goes out on Mondays (weekly), unless forceEmail
// (the admin's "run digest now" button).
// Idempotent on date — a re-run the same day does nothing.
async function runDaily(forceEmail = false) {
  const db = await getDb();
  // F-04 + F-14: automated state backup and expired-row housekeeping, first,
  // so a later failure in the digest still leaves us with a fresh snapshot.
  const backup = await snapshotState().catch((e) => ({ backed: false, reason: e.message }));
  await gcExpired().catch((e) => console.error("gc failed:", e.message));

  const state = await readState(db); // F-08 Phase 3: clients from rows
  const active = (state.clients || []).filter((c) => !c.archivedClient); // same filter the UI tabs use
  const k = computeKpis(active, state.settings || {});

  const snapRow = await db.query("SELECT value FROM kv WHERE key = 'snapshots'");
  const snapshots = snapRow.rows[0] ? JSON.parse(snapRow.rows[0].value) : [];
  if (snapshots.length && snapshots[snapshots.length - 1].date === k.date) {
    return { ok: true, alreadyRan: k.date, backup }; // backup/GC still ran above
  }
  snapshots.push(k);
  // ponytail: one JSON array, capped at 2 years of daily rows; move to a table if it ever hurts
  await db.query(
    "INSERT INTO kv (key, value) VALUES ('snapshots', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [JSON.stringify(snapshots.slice(-750))]
  );

  const { rows: staff } = await db.query("SELECT email, name FROM users WHERE active = true");
  if (!staff.length) return { ok: true, snapshot: k.date, emailed: false, reason: "no active staff", backup };
  if (!forceEmail && new Date().getUTCDay() !== 1) {
    return { ok: true, snapshot: k.date, emailed: false, reason: "weekly digest — emails Mondays only", backup };
  }

  const cur = (state.settings || {}).currency || "GBP";
  const owed = topOwed(active, 10);
  const kpi = (label, value) => `<tr><td style="padding:4px 16px 4px 0;color:#58585A">${label}</td><td style="padding:4px 0;font-weight:600">${value}</td></tr>`;
  const html = `<p>Good morning — here is where things stand as of ${k.date}.</p>
<table style="border-collapse:collapse">
${kpi("Total owed", fmtMoney(k.totalOwed, cur))}
${kpi("Clients in arrears", String(k.overdue))}
${kpi("Final notice (3+ periods)", String(k.finalNotice))}
${kpi("Not up to date (ChargeOver)", String(k.notUpToDate))}
${kpi("Follow-ups waiting", String(k.followUps))}
${kpi("Monthly recurring revenue", fmtMoney(k.mrr, cur))}
${kpi("Active paying clients", `${k.activeClients} of ${k.totalClients}`)}
</table>
${owed.length ? `<p style="margin-top:16px"><strong>Largest balances</strong></p>
<table style="border-collapse:collapse">${owed.map(({ c, owed: o }) =>
    `<tr><td style="padding:3px 16px 3px 0">${(c.company || c.name || "—").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</td><td style="padding:3px 16px 3px 0;font-weight:600">${fmtMoney(o, c.currency || cur)}</td><td style="padding:3px 0;color:#58585A">${arrearsPeriods(c)} period${arrearsPeriods(c) === 1 ? "" : "s"} behind</td></tr>`).join("")}
</table>` : "<p>No outstanding balances. Nothing to chase today.</p>"}
<p style="margin-top:16px"><a href="https://viper-pro-billing-app.vercel.app">Open ViperPro</a></p>
<p>Best,<br>ViperPro Accounting Team</p>`;

  const emailed = await sendDigestEmail(staff.map((u) => ({ email: u.email, name: u.name || "" })), `ViperPro weekly digest — ${fmtMoney(k.totalOwed, cur)} owed, ${k.overdue} in arrears`, html);
  return { ok: true, snapshot: k.date, emailed, recipients: staff.length, backup };
}

export async function GET(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runDaily());
  } catch (e) {
    return NextResponse.json({ error: String(e.message) }, { status: 502 });
  }
}

// Manual "run digest now" — admins only, same job; always emails regardless of weekday.
export async function POST() {
  const me = await getSessionUser();
  if (!me || me.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  try {
    return NextResponse.json(await runDaily(true));
  } catch (e) {
    return NextResponse.json({ error: String(e.message) }, { status: 502 });
  }
}
