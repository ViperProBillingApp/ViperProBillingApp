import { redirect } from "next/navigation";
import { getSessionUser } from "../lib/auth.js";
import CRM from "../components/crm.jsx";

export default async function Home() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return <CRM user={{ id: user.id, name: user.name, email: user.email, role: user.role }} />;
}
