import { redirect } from "next/navigation";
import { getSessionUser } from "../../lib/auth.js";
import UsersAdmin from "../../components/users-admin.jsx";

export default async function UsersPage() {
  const me = await getSessionUser();
  if (!me) redirect("/login");
  return <UsersAdmin me={{ id: me.id, name: me.name, email: me.email, role: me.role }} />;
}
