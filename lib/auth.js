import { cookies } from "next/headers";
import { userForToken, SESSION_COOKIE } from "./auth-core.js";

export * from "./auth-core.js";

export async function getSessionUser() {
  const jar = await cookies();
  return userForToken(jar.get(SESSION_COOKIE)?.value);
}
