import pg from "pg";
import fs from "node:fs";

const { Pool } = pg;
let dbPromise;

// F-12: verify the DB server cert when a CA is provided. Supabase presents a
// self-signed cert (its own private CA), so strict verification against the
// system trust store fails — it needs Supabase's CA. Set DATABASE_CA to the CA
// (PEM text or a file path; download it from Supabase → Settings → Database →
// SSL) to turn on verification. Unset keeps the prior behaviour (encrypted but
// unverified) so nothing breaks until the CA is supplied.
function dbSsl() {
  const ca = process.env.DATABASE_CA;
  if (ca) {
    const cert = ca.includes("BEGIN CERTIFICATE") ? ca : fs.readFileSync(ca, "utf8");
    return { ca: cert, rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff',
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- ponytail: internal staff tool - admin wants to see/hand over the login it
  -- assigns. Kept only while admin-assigned; cleared the moment the user sets
  -- their own password (self-change or reset link). Not a substitute for hash.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS visible_password TEXT;
  -- data-URL images: circular headshot on the user card, and an email
  -- signature image appended to every outgoing client email from this user
  ALTER TABLE users ADD COLUMN IF NOT EXISTS headshot TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_image TEXT;
  -- TOTP two-factor: base32 secret (pending until confirmed), enabled flag.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  );
  -- absolute cap on a session regardless of activity (idle-rolling extends
  -- expires_at, this bounds the total lifetime).
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;
  -- Append-only audit trail (F-03). Routes only ever INSERT.
  CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    ts BIGINT NOT NULL,
    actor_id INTEGER,
    actor_email TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    entity TEXT NOT NULL DEFAULT '',
    entity_id TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);
  -- DB-backed rate limiting (serverless-safe).
  CREATE TABLE IF NOT EXISTS rate_hits (
    id BIGSERIAL PRIMARY KEY,
    k TEXT NOT NULL,
    ts BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rate_hits_k_ts_idx ON rate_hits (k, ts);
  -- Automated nightly state snapshots (F-04).
  CREATE TABLE IF NOT EXISTS state_backups (
    id BIGSERIAL PRIMARY KEY,
    created_at BIGINT NOT NULL,
    value TEXT NOT NULL
  );
  -- F-08 Phase 1: per-client rows, one jsonb per client. Populated as a DARK
  -- SHADOW — every blob write mirrors into here, but nothing reads it yet, so
  -- the kv 'state' blob stays the sole source of truth. Cutover is a later phase.
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at BIGINT NOT NULL DEFAULT 0
  );
  -- Preserve the array order the blob had, so reading from rows doesn't reshuffle
  -- the order-dependent UI lists (Today follow-ups, Workflow columns).
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS ord INTEGER;
  -- Free-form project/campaign tasks for the Workflow tab's Tasks board.
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    lane TEXT NOT NULL DEFAULT 'todo',        -- todo | doing | done
    owner TEXT NOT NULL DEFAULT '',            -- staff email
    client_id TEXT NOT NULL DEFAULT '',        -- optional link to a client card
    label TEXT NOT NULL DEFAULT '',            -- category chip (campaign/data/outreach/…)
    note TEXT NOT NULL DEFAULT '',
    due TEXT NOT NULL DEFAULT '',              -- ISO date
    created_at BIGINT NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT ''
  );
  -- Trello-style checklist per task: JSON [[text, done], …] in a text column.
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS checklist TEXT NOT NULL DEFAULT '';
  -- Viper portal accounts (the siteadmin logins we hold for each Viper site).
  -- admin_pw is encrypted at rest via lib/crypto (dormant without ENCRYPTION_KEY).
  CREATE TABLE IF NOT EXISTS viper_customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    portal_url TEXT NOT NULL DEFAULT '',
    admin_url TEXT NOT NULL DEFAULT '',
    admin_user TEXT NOT NULL DEFAULT '',
    admin_pw TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    used BOOLEAN NOT NULL DEFAULT false
  );
  -- Security: the app talks to Postgres directly as the table owner (which
  -- bypasses RLS), so these tables never need row policies for the app to work.
  -- But Supabase also exposes the public schema through its anon-key REST API —
  -- enabling RLS with NO policies (+ revoking grants) slams that door shut so
  -- the whole client DB and the users/sessions tables aren't world-readable.
  ALTER TABLE kv ENABLE ROW LEVEL SECURITY;
  ALTER TABLE users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
  ALTER TABLE rate_hits ENABLE ROW LEVEL SECURITY;
  ALTER TABLE state_backups ENABLE ROW LEVEL SECURITY;
  ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
  ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE viper_customers ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON kv, users, sessions, password_resets, audit_log, rate_hits, state_backups, clients, tasks, viper_customers FROM anon, authenticated;
`;

// getDb() returns a Promise<Pool> — schema init runs once, memoized.
// Postgres (Supabase). TLS verification is controlled by dbSsl()/DATABASE_CA (F-12).
export function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: dbSsl(),
        // Serverless (Vercel): 1 connection per function instance so cold-start
        // fan-out doesn't exhaust the Supabase pooler. Long-running host: normal pool.
        max: process.env.VERCEL ? 1 : 10,
        idleTimeoutMillis: 10_000,
      });
      await pool.query(SCHEMA_SQL);
      return pool;
    })().catch((e) => { dbPromise = undefined; throw e; }); // don't cache a failed init — next call retries
  }
  return dbPromise;
}
