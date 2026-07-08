"use client";
import { useState } from "react";
import { C, SANS, DISPLAY, MONO, Wordmark } from "../lib/brand.js";

const inputStyle = {
  width: "100%", fontSize: 15, padding: "11px 13px", borderRadius: 9,
  border: `1px solid ${C.line}`, outline: "none", background: C.panel, color: C.ink,
  transition: "border-color 0.15s, box-shadow 0.15s",
};
const primaryBtn = (busy) => ({
  width: "100%", fontSize: 15, fontWeight: 600, padding: "12px 16px", borderRadius: 9,
  border: "none", background: C.brand, color: C.brandInk, cursor: busy ? "default" : "pointer",
  opacity: busy ? 0.7 : 1, fontFamily: DISPLAY, letterSpacing: "0.02em",
  transition: "transform 0.1s ease-out",
});
const linkStyle = { background: "none", border: "none", padding: 0, fontSize: 12.5, color: C.action, cursor: "pointer", fontWeight: 600 };

export default function LoginForm() {
  const [mode, setMode] = useState("signin"); // signin | forgot
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null); // null | {emailConfigured}

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || "Sign in failed. Try again."); setBusy(false); return; }
      window.location.href = "/";
    } catch {
      setError("Couldn't reach the server. Try again.");
      setBusy(false);
    }
  };

  const requestReset = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/reset-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const d = await r.json().catch(() => ({}));
      setSent({ emailConfigured: d.emailConfigured });
    } catch {
      setError("Couldn't reach the server. Try again.");
    }
    setBusy(false);
  };

  const goForgot = () => { setMode("forgot"); setError(""); setSent(null); setPassword(""); };
  const goSignin = () => { setMode("signin"); setError(""); setSent(null); };

  return (
    <div className="flex" style={{ minHeight: "100dvh", background: C.panel, fontFamily: SANS, color: C.ink }}>
      {/* Brand media panel: the animated loop lives full-bleed here instead of
          being veiled behind the form. Hidden on mobile, static under reduced motion. */}
      <div className="login-media" aria-hidden="true" />

      {/* Form panel */}
      <div className="login-form-panel flex items-center justify-center" style={{ padding: "48px 24px" }}>
        <div style={{ width: "100%", maxWidth: 360 }}>
          <div style={{ marginBottom: 28 }}>
            <Wordmark size={30} />
            <p style={{ color: C.sub, fontSize: 14, marginTop: 10 }}>
              {mode === "signin" ? "Client Billing CRM. Staff sign in." : "Reset your password"}
            </p>
          </div>

          {mode === "signin" && (
            <form onSubmit={submit}>
              <label style={{ display: "block", marginBottom: 14 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, display: "block", marginBottom: 6 }}>Email</span>
                <input className="login-input" style={inputStyle} type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label style={{ display: "block", marginBottom: 18 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, display: "block", marginBottom: 6 }}>Password</span>
                <input className="login-input" style={inputStyle} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              {error && <p style={{ color: C.red, fontSize: 13, marginBottom: 14 }}>{error}</p>}
              <button type="submit" disabled={busy} className="login-btn" style={primaryBtn(busy)}>{busy ? "Signing in…" : "Sign in"}</button>
              <div style={{ marginTop: 16 }}>
                <button type="button" onClick={goForgot} style={linkStyle}>Forgot your password?</button>
              </div>
            </form>
          )}

          {mode === "forgot" && (sent ? (
            <div>
              {sent.emailConfigured ? (
                <>
                  <p style={{ fontSize: 14, color: C.ink, marginBottom: 6 }}>Check your email.</p>
                  <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.5 }}>If an account exists for that address, we've sent a link to reset your password. It expires in one hour.</p>
                </>
              ) : (
                <>
                  <p style={{ fontSize: 14, color: C.ink, marginBottom: 6 }}>Email isn't set up yet.</p>
                  <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.5 }}>Self-service reset needs email sending to be configured. For now, ask an administrator to reset your password from User management.</p>
                </>
              )}
              <button type="button" onClick={goSignin} style={{ ...linkStyle, marginTop: 16 }}>← Back to sign in</button>
            </div>
          ) : (
            <form onSubmit={requestReset}>
              <p style={{ fontSize: 13, color: C.sub, marginBottom: 16, lineHeight: 1.5 }}>Enter your email and we'll send you a link to set a new password.</p>
              <label style={{ display: "block", marginBottom: 18 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, display: "block", marginBottom: 6 }}>Email</span>
                <input className="login-input" style={inputStyle} type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              {error && <p style={{ color: C.red, fontSize: 13, marginBottom: 14 }}>{error}</p>}
              <button type="submit" disabled={busy} className="login-btn" style={primaryBtn(busy)}>{busy ? "Sending…" : "Send reset link"}</button>
              <div style={{ marginTop: 16 }}>
                <button type="button" onClick={goSignin} style={linkStyle}>← Back to sign in</button>
              </div>
            </form>
          ))}

          <p style={{ color: C.faint, fontSize: 12, marginTop: 32, paddingTop: 16, borderTop: `1px solid ${C.lineSoft}`, fontFamily: MONO }}>
            VIP Event Resources · theviperpro.com
          </p>
        </div>
      </div>
    </div>
  );
}
