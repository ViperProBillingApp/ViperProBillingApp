import ResetForm from "../../components/reset-form.jsx";

export default async function ResetPage({ searchParams }) {
  const { token } = await searchParams;
  return <ResetForm token={token || ""} />;
}
