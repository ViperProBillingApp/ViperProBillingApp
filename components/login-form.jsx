"use client";
import { useState } from "react";
import { C, SANS, DISPLAY, MONO, Wordmark } from "../lib/brand.js";

const inputStyle = {
  width: "100%", fontSize: 15, padding: "11px 13px", borderRadius: 9,
  border: `1px solid ${C.line}`, outline: "none", background: C.panel, color: C.ink,
};

export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
      if (!r.ok) {
        setError(d.error || "Sign in failed — try again.");
        setBusy(false);
        return;
      }
      window.location.href = "/";
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
          <p style={{ color: C.sub, fontSize: 14, marginTop: 8 }}>Client CRM · staff sign in</p>
        </div>
        <form onSubmit={submit} style={{ background: C.panel, borderRadius: 16, border: `1px solid ${C.line}`, padding: 26, boxShadow: "0 10px 30px rgba(34,48,76,0.07)" }}>
          <label style={{ display: "block", marginBottom: 14 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, display: "block", marginBottom: 6 }}>Email</span>
            <input style={inputStyle} type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label style={{ display: "block", marginBottom: 18 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, display: "block", marginBottom: 6 }}>Password</span>
            <input style={inputStyle} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <p style={{ color: C.red, fontSize: 13, marginBottom: 14 }}>{error}</p>}
          <button type="submit" disabled={busy} style={{
            width: "100%", fontSize: 15, fontWeight: 600, padding: "12px 16px", borderRadius: 9,
            border: "none", background: C.brand, color: C.brandInk, cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.7 : 1, fontFamily: DISPLAY, letterSpacing: "0.02em",
          }}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <p style={{ color: C.faint, fontSize: 12, marginTop: 14, textAlign: "center" }}>
            Forgotten your password? Ask an administrator to reset it.
          </p>
        </form>
        <p style={{ color: C.faint, fontSize: 12, marginTop: 18, textAlign: "center", fontFamily: MONO }}>
          VIP Event Resources · theviperpro.com
        </p>
      </div>
    </div>
  );
}
