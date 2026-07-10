// Transactional email via Brevo. Gated on BREVO_API_KEY — returns false if
// email isn't configured yet, so callers can fall back gracefully.
const FROM = { email: "accounting@vipeventresources.com", name: "ViperPro Accounting Team" };

// `to` is one recipient ({email, name} or plain email string) or an array of them.
async function brevoSend(to, name, subject, htmlContent) {
  const key = process.env.BREVO_API_KEY;
  if (!key) return false;
  const list = (Array.isArray(to) ? to : [{ email: to, name }])
    .map((r) => (typeof r === "string" ? { email: r } : r))
    .map((r) => ({ email: r.email, name: r.name || undefined }));
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: FROM, to: list, subject, htmlContent }),
  });
  return r.ok;
}

// Plain-text client email (Comms tab). Escapes HTML, preserves paragraphs.
// signatureImage: sender's uploaded signature (data-URL image), appended below the message.
// `to` may be a single email or an array of {email, name} (group office sends).
export function sendClientEmail(to, name, subject, text, signatureImage) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = esc(String(text)).trim().split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("\n");
  if (signatureImage) html += `\n<p><img src="${signatureImage}" alt="signature" style="max-width:360px;height:auto"></p>`;
  return brevoSend(to, name, subject, html);
}

export function sendResetEmail(to, name, link) {
  const hi = name ? `Hi ${name},` : "Hi,";
  return brevoSend(to, name, "Reset your ViperPro password", `<p>${hi}</p>
<p>Someone requested a password reset for your ViperPro account. Use the link below to set a new password. It expires in one hour.</p>
<p><a href="${link}">Reset your password</a></p>
<p>If you didn't request this, you can ignore this email — your password won't change.</p>
<p>Best,<br>ViperPro Accounting Team</p>`);
}

// Invite / "email login" — sends a staff member their username + a set-password link.
export function sendInviteEmail(to, name, link) {
  const hi = name ? `Hi ${name},` : "Hi,";
  return brevoSend(to, name, "Your ViperPro Client Billing CRM login", `<p>${hi}</p>
<p>You've been given access to the ViperPro Client Billing CRM.</p>
<p><strong>Sign in at:</strong> <a href="https://viper-pro-billing-app.vercel.app/login">viper-pro-billing-app.vercel.app</a><br>
<strong>Your username:</strong> ${to}</p>
<p>Set your password using the link below to finish setting up your account. It expires in one hour.</p>
<p><a href="${link}">Set your password</a></p>
<p>Best,<br>ViperPro Accounting Team</p>`);
}
