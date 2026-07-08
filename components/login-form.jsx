"use client";
import { useState } from "react";
import { C, SANS, DISPLAY, MONO, Wordmark } from "../lib/brand.js";

const inputStyle = {
  width: "100%", fontSize: 15, padding: "11px 13px", borderRadius: 9,
  border: `1px solid ${C.line}`, outline: "none", background: C.panel, color: C.ink,
};
const cardStyle = { background: C.panel, borderRadius: 16, border: `1px solid ${C.line}`, padding: 26, boxShadow: "0 10px 30px rgba(34,48,76,0.07)" };
const primaryBtn = (busy) => ({
  width: "100%", fontSize: 15, fontWeight: 600, padding: "12px 16px", borderRadius: 9,
  border: "none", background: C.brand, color: C.brandInk, cursor: busy ? "default" : "pointer",
  opacity: busy ? 0.7 : 1, fontFamily: DISPLAY, letterSpacing: "0.02em",
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
      if (!r.ok) { setError(d.error || "Sign in failed — try again."); setBusy(false); return; }
      window.location.href = "/";
    } catch {
      setError("Couldn't reach the server — try again.");
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
      setError("Couldn't reach the server — try again.");
    }
    setBusy(false);
  };

  const goForgot = () => { setMode("forgot"); setError(""); setSent(null); setPassword(""); };
  const goSignin = () => { setMode("signin"); setError(""); setSent(null); };

  return (
    <div className="flex items-center justify-center" style={{ minHeight: "100vh", backgroundColor: C.paper, backgroundImage: "linear-gradient(rgba(255,255,255,0.7), rgba(255,255,255,0.7)), url(/login-bg.gif)", backgroundSize: "cover", backgroundPosition: "center", fontFamily: SANS, color: C.ink, padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        {mode === "signin" && (
          <form onSubmit={submit} style={cardStyle}>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <Wordmark size={32} />
              <p style={{ color: C.sub, fontSize: 13.5, marginTop: 7 }}>Client Billing CRM · staff sign in</p>
            </div>
            <label style={{ display: "block", marginBottom: 14 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, display: "block", marginBottom: 6 }}>Email</span>
              <input style={inputStyle} type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label style={{ display: "block", marginBottom: 18 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, display: "block", marginBottom: 6 }}>Password</span>
              <input style={inputStyle} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <p style={{ color: C.red, fontSize: 13, marginBottom: 14 }}>{error}</p>}
            <button type="submit" disabled={busy} style={primaryBtn(busy)}>{busy ? "Signing in…" : "Sign in"}</button>
            <div style={{ textAlign: "center", marginTop: 14 }}>
              <button type="button" onClick={goForgot} style={linkStyle}>Forgot your password?</button>
            </div>
          </form>
        )}

        {mode === "forgot" && (sent ? (
          <div style={cardStyle}>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <Wordmark size={32} />
              <p style={{ color: C.sub, fontSize: 13.5, marginTop: 7 }}>Reset your password</p>
            </div>
            {sent.emailConfigured ? (
              <>
                <p style={{ fontSize: 14, color: C.ink, marginBottom: 6 }}>Check your email.</p>
                <p style={{ fontSize: 13, color: C.sub }}>If an account exists for that address, we've sent a link to reset your password. It expires in one hour.</p>
              </>
            ) : (
              <>
                <p style={{ fontSize: 14, color: C.ink, marginBottom: 6 }}>Email isn't set up yet.</p>
                <p style={{ fontSize: 13, color: C.sub }}>Self-service reset needs email sending to be configured. For now, ask an administrator to reset your password from User management.</p>
              </>
            )}
            <button type="button" onClick={goSignin} style={{ ...linkStyle, marginTop: 16 }}>← Back to sign in</button>
          </div>
        ) : (
          <form onSubmit={requestReset} style={cardStyle}>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <Wordmark size={32} />
              <p style={{ color: C.sub, fontSize: 13.5, marginTop: 7 }}>Reset your password</p>
            </div>
            <p style={{ fontSize: 13, color: C.sub, marginBottom: 16 }}>Enter your email and we'll send you a link to set a new password.</p>
            <label style={{ display: "block", marginBottom: 18 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, display: "block", marginBottom: 6 }}>Email</span>
              <input style={inputStyle} type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            {error && <p style={{ color: C.red, fontSize: 13, marginBottom: 14 }}>{error}</p>}
            <button type="submit" disabled={busy} style={primaryBtn(busy)}>{busy ? "Sending…" : "Send reset link"}</button>
            <div style={{ textAlign: "center", marginTop: 14 }}>
              <button type="button" onClick={goSignin} style={linkStyle}>← Back to sign in</button>
            </div>
          </form>
        ))}

        <p style={{ color: C.faint, fontSize: 12, marginTop: 18, textAlign: "center", fontFamily: MONO }}>
          VIP Event Resources · theviperpro.com
        </p>
      </div>
    </div>
  );
}
