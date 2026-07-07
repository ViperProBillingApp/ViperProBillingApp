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

export default function ResetForm({ token }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/auth/reset-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || "Couldn't reset your password."); setBusy(false); return; }
      setDone(true);
    } catch {
      setError("Couldn't reach the server — try again.");
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-center" style={{ minHeight: "100vh", background: C.paper, fontFamily: SANS, color: C.ink, padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <Wordmark size={34} />
          <p style={{ color: C.sub, fontSize: 14, marginTop: 8 }}>Set a new password</p>
        </div>

        {!token ? (
          <div style={cardStyle}>
            <p style={{ fontSize: 14, color: C.ink, marginBottom: 6 }}>This reset link is missing or invalid.</p>
            <p style={{ fontSize: 13, color: C.sub }}>Request a new one from the sign-in page.</p>
            <a href="/login" style={{ display: "inline-block", marginTop: 14, fontSize: 13.5, fontWeight: 600, color: C.action, textDecoration: "none" }}>← Back to sign in</a>
          </div>
        ) : done ? (
          <div style={cardStyle}>
            <p style={{ fontSize: 14, color: C.ink, marginBottom: 6 }}>Your password has been updated.</p>
            <p style={{ fontSize: 13, color: C.sub, marginBottom: 16 }}>You've been signed out everywhere — sign in with your new password.</p>
            <a href="/login" style={{ ...primaryBtn(false), display: "block", textAlign: "center", textDecoration: "none" }}>Go to sign in</a>
          </div>
        ) : (
          <form onSubmit={submit} style={cardStyle}>
            <label style={{ display: "block", marginBottom: 14 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, display: "block", marginBottom: 6 }}>New password</span>
              <input style={inputStyle} type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label style={{ display: "block", marginBottom: 18 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, display: "block", marginBottom: 6 }}>Confirm new password</span>
              <input style={inputStyle} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {error && <p style={{ color: C.red, fontSize: 13, marginBottom: 14 }}>{error}</p>}
            <button type="submit" disabled={busy} style={primaryBtn(busy)}>{busy ? "Saving…" : "Set new password"}</button>
          </form>
        )}
        <p style={{ color: C.faint, fontSize: 12, marginTop: 18, textAlign: "center", fontFamily: MONO }}>
          VIP Event Resources · theviperpro.com
        </p>
      </div>
    </div>
  );
}
