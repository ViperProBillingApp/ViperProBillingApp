import pg from "pg";

const { Pool } = pg;
let dbPromise;

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
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
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
  REVOKE ALL ON kv, users, sessions, password_resets FROM anon, authenticated;
`;

// getDb() returns a Promise<Pool> — schema init runs once, memoized.
// Postgres (Supabase). ssl:rejectUnauthorized:false is the standard shape
// for connecting without bundling Supabase's CA chain.
export function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        // Serverless (Vercel): 1 connection per function instance so cold-start
        // fan-out doesn't exhaust the Supabase pooler. Long-running host: normal pool.
        max: process.env.VERCEL ? 1 : 10,
        idleTimeoutMillis: 10_000,
      });
      await pool.query(SCHEMA_SQL);
      return pool;
    })();
  }
  return dbPromise;
}
