"use client";
import { useEffect, useState } from "react";
import { C, SANS, DISPLAY, MONO, Wordmark } from "../lib/brand.js";

const inputStyle = {
  width: "100%", fontSize: 14, padding: "9px 11px", borderRadius: 8,
  border: `1px solid ${C.line}`, outline: "none", background: C.panel, color: C.ink, boxSizing: "border-box",
};
const btn = (solid) => ({
  fontSize: 13, fontWeight: 600, padding: "9px 15px", borderRadius: 8, cursor: "pointer",
  border: solid ? "none" : `1px solid ${C.line}`,
  background: solid ? C.brand : C.panel, color: solid ? C.brandInk : C.ink,
});
function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: C.sub, display: "block", marginBottom: 5 }}>{label}</span>
      {children}
    </label>
  );
}
function Card({ title, children }) {
  return (
    <section style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 20, marginBottom: 16 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14, fontFamily: DISPLAY }}>{title}</h2>
      {children}
    </section>
  );
}

export default function UsersAdmin({ me }) {
  const isAdmin = me.role === "admin";
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null); // {title, detail}

  const load = async () => {
    if (!isAdmin) return;
    const r = await fetch("/api/users");
    const d = await r.json();
    if (r.ok) setUsers(d.users);
    else setError(d.error || "Couldn't load users.");
  };
  useEffect(() => { load(); }, []);

  const call = async (url, method, body) => {
    setError("");
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setError(d.error || "That didn't work."); return null; }
    return d;
  };

  return (
    <div style={{ minHeight: "100vh", background: C.paper, fontFamily: SANS, color: C.ink }}>
      <div className="mx-auto w-full" style={{ maxWidth: 860, padding: "clamp(16px, 3vw, 30px)" }}>
        <header className="flex flex-wrap items-center justify-between" style={{ gap: 12, marginBottom: 20 }}>
          <div>
            <Wordmark size={24} sub={isAdmin ? "User management" : "Your account"} />
            <p style={{ color: C.sub, fontSize: 13, marginTop: 4 }}>
              Signed in as {me.name || me.email} · {me.role === "admin" ? "admin" : "view only"}
            </p>
          </div>
          <div className="flex" style={{ gap: 8 }}>
            <button style={btn(false)} onClick={() => (window.location.href = "/")}>← Back to CRM</button>
          </div>
        </header>

        {error && (
          <div style={{ background: C.redBg, color: C.red, borderRadius: 10, padding: "10px 14px", fontSize: 13.5, marginBottom: 14 }}>
            {error}
          </div>
        )}
        {notice && (
          <div style={{ background: C.greenBg, borderRadius: 10, padding: "12px 14px", fontSize: 13.5, marginBottom: 14 }}>
            <strong style={{ color: C.green }}>{notice.title}</strong>
            {notice.detail && (
              <span style={{ marginLeft: 8 }}>
                Temporary password: <code style={{ fontFamily: MONO, fontWeight: 600, background: C.panel, padding: "2px 8px", borderRadius: 6, border: `1px solid ${C.line}` }}>{notice.detail}</code>
                {" "}— shown once, hand it over securely and have them change it.
              </span>
            )}
            <button onClick={() => setNotice(null)} style={{ marginLeft: 10, background: "none", border: "none", color: C.sub, cursor: "pointer", fontSize: 12.5 }}>dismiss</button>
          </div>
        )}

        {isAdmin && <AddUser onCall={call} onDone={(d) => { load(); setNotice({ title: `${d.user.email} created.`, detail: d.tempPassword }); }} />}

        {isAdmin && (
          <Card title="Staff access">
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(310px, 1fr))", gap: 12 }}>
              {users.map((u) => (
                <StaffCard key={u.id} u={u} self={u.id === me.id} onCall={call} onChanged={load} onNotice={setNotice} />
              ))}
            </div>
            {users.length === 0 && <p style={{ color: C.faint, fontSize: 13 }}>Loading…</p>}
          </Card>
        )}

        <ChangePassword onCall={call} onDone={() => setNotice({ title: "Your password was updated." })} />

        <p style={{ color: C.faint, fontSize: 11.5, marginTop: 8 }}>
          Deactivating a user keeps their account but blocks sign-in and ends their sessions. Delete is permanent.
        </p>
      </div>
    </div>
  );
}

function StaffCard({ u, self, onCall, onChanged, onNotice }) {
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [f, setF] = useState({ name: u.name, email: u.email, password: "" });

  const smallBtn = {
    fontSize: 12.5, fontWeight: 600, padding: "7px 12px", borderRadius: 8,
    border: `1px solid ${C.line}`, background: C.panel, color: C.ink, cursor: "pointer",
  };

  const save = async () => {
    const d = await onCall(`/api/users/${u.id}`, "PATCH", {
      name: f.name,
      email: f.email,
      password: f.password || undefined,
    });
    if (d) {
      setEditing(false);
      setF((x) => ({ ...x, password: "" }));
      onChanged();
      if (f.password) onNotice({ title: `Password updated for ${f.email}.` });
    }
  };

  return (
    <div style={{ position: "relative", background: C.paper, borderRadius: 12, border: `1px solid ${C.line}`, padding: "14px 16px", opacity: u.active ? 1 : 0.65 }}>
      {!self && (confirmRemove ? (
        <div style={{ position: "absolute", top: 10, right: 12, fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ color: C.red, fontWeight: 600 }}>Remove?</span>
          <button onClick={async () => { if (await onCall(`/api/users/${u.id}`, "DELETE")) onChanged(); }} style={{ ...smallBtn, padding: "3px 10px", fontSize: 12, background: C.red, border: "none", color: "#fff" }}>Yes</button>
          <button onClick={() => setConfirmRemove(false)} style={{ ...smallBtn, padding: "3px 10px", fontSize: 12 }}>No</button>
        </div>
      ) : (
        <button title="Remove user" aria-label={`Remove ${u.email}`} onClick={() => setConfirmRemove(true)} style={{ position: "absolute", top: 8, right: 10, background: "none", border: "none", color: C.faint, fontSize: 15, cursor: "pointer", lineHeight: 1, padding: 4 }}>✕</button>
      ))}

      <div style={{ fontWeight: 700, fontSize: 14.5, paddingRight: 28 }}>
        {u.name || "—"}{self && <span style={{ color: C.faint, fontWeight: 500 }}> (you)</span>}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 12, color: C.sub, marginTop: 2, marginBottom: 10 }}>{u.email}</div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 12.5, minHeight: 22 }}>
        <span style={{ color: C.sub, fontWeight: 600 }}>Password</span>
        {u.visible_password ? (
          <>
            <code style={{ fontFamily: MONO, fontWeight: 600, background: C.panel, padding: "2px 8px", borderRadius: 6, border: `1px solid ${C.line}`, letterSpacing: showPw ? 0 : 2 }}>
              {showPw ? u.visible_password : "••••••••"}
            </code>
            <button onClick={() => setShowPw((v) => !v)} style={{ background: "none", border: "none", color: C.brand, cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0 }}>
              {showPw ? "Hide" : "Show"}
            </button>
          </>
        ) : (
          <span style={{ color: C.faint }} title="This user set their own password, so it can't be shown. Use Reset password to assign a new visible one.">set by user — Reset to reveal</span>
        )}
      </div>

      <div className="flex items-center flex-wrap" style={{ gap: 8, marginBottom: 12 }}>
        <select
          value={u.role}
          disabled={self}
          onChange={async (e) => { if (await onCall(`/api/users/${u.id}`, "PATCH", { role: e.target.value })) onChanged(); }}
          style={{ ...inputStyle, width: "auto", padding: "6px 9px", fontSize: 13, background: C.panel, cursor: self ? "default" : "pointer" }}
        >
          <option value="staff">View only</option>
          <option value="admin">Admin</option>
        </select>
        <button
          disabled={self}
          title={self ? "You can't block yourself" : u.active ? "Block sign-in" : "Restore access"}
          onClick={async () => { if (await onCall(`/api/users/${u.id}`, "PATCH", { active: !u.active })) onChanged(); }}
          style={{
            fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 20, cursor: self ? "default" : "pointer",
            border: "none", background: u.active ? C.greenBg : C.redBg, color: u.active ? C.green : C.red,
          }}
        >
          {u.active ? "Active" : "Blocked"}
        </button>
      </div>

      {editing ? (
        <div>
          <Field label="Name"><input style={inputStyle} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Email"><input style={inputStyle} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="New password (blank = keep current)"><input style={inputStyle} type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="min 8 characters" /></Field>
          <div className="flex" style={{ gap: 6 }}>
            <button onClick={save} style={{ ...smallBtn, background: C.brand, border: "none", color: C.brandInk }}>Save</button>
            <button onClick={() => { setEditing(false); setF({ name: u.name, email: u.email, password: "" }); }} style={smallBtn}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap" style={{ gap: 6 }}>
          <button onClick={() => setEditing(true)} style={smallBtn}>Edit</button>
          <button
            onClick={async () => {
              const d = await onCall(`/api/users/${u.id}/invite`, "POST");
              if (d) onNotice({ title: `Login setup email sent to ${d.email}.` });
            }}
            style={smallBtn}
            title="Email this user their username and a link to set their password"
          >
            Email login
          </button>
          <button
            onClick={async () => {
              const d = await onCall(`/api/users/${u.id}/reset`, "POST");
              if (d) onNotice({ title: `Password reset for ${u.email}.`, detail: d.tempPassword });
            }}
            style={smallBtn}
          >
            Reset password
          </button>
        </div>
      )}
    </div>
  );
}

function AddUser({ onCall, onDone }) {
  const [f, setF] = useState({ email: "", name: "", role: "staff", password: "" });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Card title="Add a user">
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        <Field label="Name"><input style={inputStyle} value={f.name} onChange={set("name")} /></Field>
        <Field label="Email"><input style={inputStyle} type="email" value={f.email} onChange={set("email")} /></Field>
        <Field label="Role">
          <select style={{ ...inputStyle, cursor: "pointer" }} value={f.role} onChange={set("role")}>
            <option value="staff">View only</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <Field label="Password (blank = generate one)"><input style={inputStyle} value={f.password} onChange={set("password")} placeholder="auto-generate" /></Field>
      </div>
      <div className="flex justify-end">
        <button
          style={btn(true)}
          onClick={async () => {
            const d = await onCall("/api/users", "POST", { ...f, password: f.password || undefined });
            if (d) { setF({ email: "", name: "", role: "staff", password: "" }); onDone(d); }
          }}
        >
          Create user
        </button>
      </div>
    </Card>
  );
}

function ChangePassword({ onCall, onDone }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  return (
    <Card title="Change my password">
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <Field label="Current password"><input style={inputStyle} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password (min 8 characters)"><input style={inputStyle} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end">
        <button
          style={btn(true)}
          onClick={async () => {
            const d = await onCall("/api/users/me/password", "POST", { current, next });
            if (d) { setCurrent(""); setNext(""); onDone(); }
          }}
        >
          Update password
        </button>
      </div>
    </Card>
  );
}
