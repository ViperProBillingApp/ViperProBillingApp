import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db.js";
import { getSessionUser } from "../../../../lib/auth.js";
import { gmailConfigured, listRecentMessages, getMessage, labelExists } from "../../../../lib/gmail.js";
import { runGmailPoll } from "../../../../lib/gmailPoll.js";

export const maxDuration = 60;

// Fetch+store bound per invocation — see runGmailPoll. Unmatched-but-labeled
// mail is kept (dropUnmatched: false): anything reaching this label already
// carries a reply token or was manually labeled, so it's always worth a
// human's look even when auto-matching can't place it.
const MAX_PER_POLL = 25;

// Pull recent labelled mail, match it to clients, store it. Called on CRM load
// and on an interval while a tab is open. Idempotent: re-ingesting a message is
// a no-op because the Gmail message id is the primary key.
export async function POST() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!gmailConfigured()) return NextResponse.json({ error: "Gmail is not configured." }, { status: 501 });

  let hasLabel;
  try {
    hasLabel = await labelExists();
  } catch (e) {
    console.error("gmail labelExists failed:", e?.message || e);
    return NextResponse.json({ error: "Gmail is unavailable — check the integration." }, { status: 502 });
  }
  if (!hasLabel) {
    return NextResponse.json(
      { error: "The crm-replies Gmail label is missing — replies cannot be collected." },
      { status: 502 }
    );
  }

  const db = await getDb();
  let msgIds;
  try {
    msgIds = await listRecentMessages();
  } catch (e) {
    console.error("gmail list failed:", e?.message || e);
    return NextResponse.json({ error: "Gmail is unavailable — check the integration." }, { status: 502 });
  }

  let result;
  try {
    result = await runGmailPoll(db, { candidateIds: msgIds, fetchFull: getMessage, fetchMetadata: null, dropUnmatched: false, maxPerPoll: MAX_PER_POLL });
  } catch (e) {
    console.error("gmail poll failed:", e?.message || e);
    return NextResponse.json({ error: "Gmail is unavailable — check the integration." }, { status: 502 });
  }
  if (result.stageMoveError) console.error("gmail poll: stage move failed:", result.stageMoveError);

  return NextResponse.json({ ok: true, ...result });
}
