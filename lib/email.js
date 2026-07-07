// Transactional email via Brevo. Gated on BREVO_API_KEY — returns false if
// email isn't configured yet, so callers can fall back gracefully.
const FROM = { email: "accounting@vipeventresources.com", name: "ViperPro Accounting Team" };

export async function sendResetEmail(to, name, link) {
  const key = process.env.BREVO_API_KEY;
  if (!key) return false;
  const hi = name ? `Hi ${name},` : "Hi,";
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: FROM,
      to: [{ email: to, name: name || undefined }],
      subject: "Reset your ViperPro password",
      htmlContent: `<p>${hi}</p>
<p>Someone requested a password reset for your ViperPro account. Use the link below to set a new password. It expires in one hour.</p>
<p><a href="${link}">Reset your password</a></p>
<p>If you didn't request this, you can ignore this email — your password won't change.</p>
<p>Best,<br>ViperPro Accounting Team</p>`,
    }),
  });
  return r.ok;
}
