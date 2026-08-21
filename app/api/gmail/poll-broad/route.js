import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { gmailConfigured, listRecentInboundIds, getMessageMetadata, getMessage } from "../../../../lib/gmail.js";
import { runGmailPoll } from "../../../../lib/gmailPoll.js";

export const maxDuration = 60;

// Whole-mailbox scan, not just crm-replies-labeled mail — approved explicitly
// (2026-08-21) as a permanent widening of the poller, not just the one-off
// manual sweep it started as. dropUnmatched: true, unlike the labeled poller:
// almost everything this lists is personal/unrelated mail that was never
// going to reach a human triage queue, so only genuinely client-matched
// messages get stored at all.
const WINDOW_DAYS = 1;
const MAX_PER_POLL = 40;

async function runBroadPoll() {
  const db = await getDb();
  const candidateIds = await listRecentInboundIds(WINDOW_DAYS);
  const result = await runGmailPoll(db, {
    candidateIds, fetchFull: getMessage, fetchMetadata: getMessageMetadata,
    dropUnmatched: true, maxPerPoll: MAX_PER_POLL,
  });
  if (result.stageMoveError) console.error("gmail poll-broad: stage move failed:", result.stageMoveError);
  return { ok: true, ...result };
}

// Vercel Cron — runs on a schedule regardless of whether the CRM is open.
export async function GET(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!gmailConfigured()) return NextResponse.json({ error: "Gmail is not configured." }, { status: 501 });
  try {
    return NextResponse.json(await runBroadPoll());
  } catch (e) {
    console.error("gmail poll-broad failed:", e?.message || e);
    return NextResponse.json({ error: "Gmail is unavailable — check the integration." }, { status: 502 });
  }
}

// Manual trigger — admins only, for forcing a run without waiting for the cron.
export async function POST() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (me.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });
  if (!gmailConfigured()) return NextResponse.json({ error: "Gmail is not configured." }, { status: 501 });
  try {
    return NextResponse.json(await runBroadPoll());
  } catch (e) {
    console.error("gmail poll-broad failed:", e?.message || e);
    return NextResponse.json({ error: "Gmail is unavailable — check the integration." }, { status: 502 });
  }
}
