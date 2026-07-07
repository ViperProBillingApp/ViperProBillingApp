// Creates the first admin user. Usage: node scripts/seed.mjs [email] [password]
import { getDb } from "../lib/db.js";
import { hashPassword, generatePassword } from "../lib/auth-core.js";

const email = process.argv[2] || "roffey@gmail.com";
const password = process.argv[3] || generatePassword();

const db = getDb();
const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
if (existing) {
  console.log(`User ${email} already exists — nothing to do.`);
  process.exit(0);
}
db.prepare("INSERT INTO users (email, name, hash, role) VALUES (?, ?, ?, 'admin')").run(
  email,
  "Darryl",
  hashPassword(password)
);
console.log(`Admin created: ${email}`);
console.log(`Password: ${password}`);
console.log("Sign in and change it under Users → Change my password.");
