import { redirect } from "next/navigation";
import { getSessionUser } from "../../lib/auth.js";
import LoginForm from "../../components/login-form.jsx";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/");
  return <LoginForm />;
}
