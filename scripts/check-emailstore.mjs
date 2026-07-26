// DB-backed check for the email_messages store. Uses throwaway ids, cleaned up
// in `finally`. Skips entirely when DATABASE_URL is unset. Run: npm run check
import assert from "node:assert";

if (!process.env.DATABASE_URL) {
  console.log("check-emailstore: skipped (no DATABASE_URL)");
  process.exit(0);
}

const { getDb } = await import("../lib/db.js");
const { saveMessages, listReplies, markHandled, assignToClient, outboundMessageIdIndex } =
  await import("../lib/emailstore.js");

const db = await getDb();
const A = "test-msg-a-" + Date.now();
const B = "test-msg-b-" + Date.now();
const C = "test-msg-c-" + Date.now();

let failure = null;
try {
  const row = (id, over = {}) => ({
    id, threadId: "test-thread", clientId: "test-client", direction: "in",
    fromEmail: "someone@example.com", toEmail: "droffey@vipeventresources.com",
    subject: "Re: invoice", snippet: "thanks", bodyText: "thanks",
    messageIdHdr: `<${id}@example.com>`, referencesHdr: "",
    sentAt: new Date().toISOString(), matchMethod: "token", matchConf: "high",
    ...over,
  });

  await saveMessages(db, [row(A)]);
  let got = await listReplies(db, { scope: "all", clientId: "test-client" });
  assert.strictEqual(got.length, 1, "saved row is listed");
  assert.strictEqual(got[0].subject, "Re: invoice", "fields round trip");

  // idempotent: same Gmail id twice must not duplicate
  await saveMessages(db, [row(A)]);
  got = await listReplies(db, { scope: "all", clientId: "test-client" });
  assert.strictEqual(got.length, 1, "re-saving the same message id is a no-op");

  // unhandled → handled
  got = await listReplies(db, { scope: "unhandled", clientId: "test-client" });
  assert.strictEqual(got.length, 1, "starts unhandled");
  await markHandled(db, A, "staff@vipeventresources.com");
  got = await listReplies(db, { scope: "unhandled", clientId: "test-client" });
  assert.strictEqual(got.length, 0, "handled rows leave the unhandled list");

  // unmatched → assigned
  await saveMessages(db, [row(B, { clientId: null, matchMethod: null, matchConf: "low" })]);
  got = await listReplies(db, { scope: "unmatched" });
  assert.ok(got.some((r) => r.id === B), "unmatched row appears in the unmatched list");
  await assignToClient(db, B, "test-client");
  got = await listReplies(db, { scope: "unmatched" });
  assert.ok(!got.some((r) => r.id === B), "assigning removes it from unmatched");

  // outbound index: header-matching tier of the reply cascade reads this
  await saveMessages(db, [row(C, {
    direction: "out", clientId: "test-client", messageIdHdr: `<${C}@example.com>`,
  })]);
  const index = await outboundMessageIdIndex(db);
  assert.strictEqual(index.get(`<${C}@example.com>`), "test-client", "outbound row is indexed by its Message-ID header");

  console.log("check-emailstore: OK");
} catch (e) {
  failure = e;
} finally {
  // cleanup must not mask the original failure
  await db.query("DELETE FROM email_messages WHERE id = ANY($1)", [[A, B, C]]).catch((e) => console.error("cleanup failed:", e.message));
  if (failure) { console.error(failure); process.exit(1); }
  process.exit(0);
}
