// Creates the first admin user. Usage: node scripts/seed.mjs [email] [password]
import { getDb } from "../lib/db.js";
import { hashPassword, generatePassword } from "../lib/auth-core.js";

const email = process.argv[2] || "roffey@gmail.com";
const password = process.argv[3] || generatePassword();

const db = await getDb();
const { rows } = await db.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [email]);
if (rows[0]) {
  console.log(`User ${email} already exists — nothing to do.`);
  process.exit(0);
}
await db.query(
  "INSERT INTO users (email, name, hash, role) VALUES ($1, $2, $3, 'admin')",
  [email, "Darryl", hashPassword(password)]
);
console.log(`Admin created: ${email}`);
console.log(`Password: ${password}`);
console.log("Sign in and change it under Users → Change my password.");
process.exit(0);
