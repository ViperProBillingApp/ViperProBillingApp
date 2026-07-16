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

// Read an image file as a data URL, downscaled so it stores comfortably.
// jpeg for photos (headshots), png for graphics (signatures, transparency).
function readImage(file, maxDim, asPng) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        if (scale === 1 && fr.result.length < 500_000) return resolve(fr.result);
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(img.width * scale));
        cv.height = Math.max(1, Math.round(img.height * scale));
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        resolve(asPng ? cv.toDataURL("image/png") : cv.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("Not a readable image."));
      img.src = fr.result;
    };
    fr.onerror = () => reject(new Error("Couldn't read the file."));
    fr.readAsDataURL(file);
  });
}

// Circular headshot with an upload control underneath.
function Headshot({ src, size = 56, onPick, onClear }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flexShrink: 0 }}>
      <div style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", background: C.lineSoft, border: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {src
          ? <img src={src} alt="headshot" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke={C.faint} strokeWidth="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" /></svg>}
      </div>
      {onPick && (
        <div style={{ display: "flex", gap: 6 }}>
          <label style={{ fontSize: 10.5, fontWeight: 600, color: C.brand, cursor: "pointer" }}>
            {src ? "Change" : "Upload"}
            <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onPick(f); }} />
          </label>
          {src && onClear && <button onClick={onClear} style={{ fontSize: 10.5, fontWeight: 600, color: C.faint, background: "none", border: "none", cursor: "pointer", padding: 0 }}>Remove</button>}
        </div>
      )}
    </div>
  );
}

// Signature image upload + preview. Appended to the bottom of every outgoing email this user sends.
function SignatureUpload({ src, onPick, onClear }) {
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 5 }}>Email signature image</div>
      {src
        ? <img src={src} alt="email signature" style={{ maxWidth: 220, maxHeight: 80, display: "block", borderRadius: 6, border: `1px solid ${C.lineSoft}`, background: "#fff", padding: 4 }} />
        : <div style={{ fontSize: 12, color: C.faint }}>None — outgoing emails go out without a signature image.</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 5 }}>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: C.brand, cursor: "pointer" }}>
          {src ? "Replace" : "Upload"}
          <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onPick(f); }} />
        </label>
        {src && <button onClick={onClear} style={{ fontSize: 11.5, fontWeight: 600, color: C.faint, background: "none", border: "none", cursor: "pointer", padding: 0 }}>Remove</button>}
      </div>
    </div>
  );
}

export default function UsersAdmin({ me, embedded = false }) {
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

  const body = (
    <>
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

      {!isAdmin && <MyProfile onCall={call} />}

      <ChangePassword onCall={call} onDone={() => setNotice({ title: "Your password was updated." })} />

      <TwoFactor onCall={call} onNotice={setNotice} />

      {isAdmin && <AuditLog onCall={call} />}

      <p style={{ color: C.faint, fontSize: 11.5, marginTop: 8 }}>
        Deactivating a user keeps their account but blocks sign-in and ends their sessions. Delete is permanent.
        Signature images are added to the bottom of every outgoing client email that user sends.
      </p>
    </>
  );

  // Embedded: rendered inside the CRM's centered floating window — no page chrome.
  if (embedded) return <div style={{ fontFamily: SANS, color: C.ink }}>{body}</div>;

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
        {body}
      </div>
    </div>
  );
}

// Non-admins manage their own headshot + signature here (admins do it on their staff card).
function MyProfile({ onCall }) {
  const [meInfo, setMeInfo] = useState(null);
  const load = async () => { const d = await onCall("/api/users/me", "GET"); if (d) setMeInfo(d.user); };
  useEffect(() => { load(); }, []);
  const patch = async (p) => { if (await onCall("/api/users/me", "PATCH", p)) load(); };
  if (!meInfo) return null;
  return (
    <Card title="My profile">
      <div className="flex" style={{ gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Headshot src={meInfo.headshot} size={72}
          onPick={async (f) => patch({ headshot: await readImage(f, 256, false) })}
          onClear={() => patch({ headshot: null })} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <SignatureUpload src={meInfo.signature_image}
            onPick={async (f) => patch({ signature_image: await readImage(f, 720, true) })}
            onClear={() => patch({ signature_image: null })} />
        </div>
      </div>
    </Card>
  );
}

function StaffCard({ u, self, onCall, onChanged, onNotice }) {
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [revealed, setRevealed] = useState(null); // fetched on demand (F-01)
  const [f, setF] = useState({ name: u.name, email: u.email, password: "" });
  // F-01: passwords aren't shipped in the users list — reveal one on demand, audited.
  const toggleReveal = async () => {
    if (showPw) { setShowPw(false); return; }
    if (revealed === null) {
      const d = await onCall(`/api/users/${u.id}/password`, "GET");
      if (!d) return;
      setRevealed(d.visible_password || "");
    }
    setShowPw(true);
  };

  const smallBtn = {
    fontSize: 12.5, fontWeight: 600, padding: "7px 12px", borderRadius: 8,
    border: `1px solid ${C.line}`, background: C.panel, color: C.ink, cursor: "pointer",
  };
  // self edits go through /me (works for any role); others need the admin route
  const patchImages = async (p) => {
    if (await onCall(self ? "/api/users/me" : `/api/users/${u.id}`, "PATCH", p)) onChanged();
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

      <div className="flex" style={{ gap: 12, alignItems: "flex-start" }}>
        <Headshot src={u.headshot} size={56}
          onPick={async (f2) => patchImages({ headshot: await readImage(f2, 256, false) })}
          onClear={() => patchImages({ headshot: null })} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, paddingRight: 28 }}>
            {u.name || "—"}{self && <span style={{ color: C.faint, fontWeight: 500 }}> (you)</span>}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 12, color: C.sub, marginTop: 2, marginBottom: 10 }}>{u.email}</div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 12.5, minHeight: 22 }}>
        <span style={{ color: C.sub, fontWeight: 600 }}>Password</span>
        {u.has_password ? (
          <>
            <code style={{ fontFamily: MONO, fontWeight: 600, background: C.panel, padding: "2px 8px", borderRadius: 6, border: `1px solid ${C.line}`, letterSpacing: showPw ? 0 : 2 }}>
              {showPw ? revealed : "••••••••"}
            </code>
            <button onClick={toggleReveal} style={{ background: "none", border: "none", color: C.brand, cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0 }}>
              {showPw ? "Hide" : "Show"}
            </button>
          </>
        ) : (
          <span style={{ color: C.faint }} title="This user set their own password before password display existed. Use Reset password to assign a new visible one.">set by user — Reset to reveal</span>
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

      <div style={{ marginBottom: 12 }}>
        <SignatureUpload src={u.signature_image}
          onPick={async (f2) => patchImages({ signature_image: await readImage(f2, 720, true) })}
          onClear={() => patchImages({ signature_image: null })} />
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
  const [f, setF] = useState({ email: "", name: "", role: "admin", password: "" });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Card title="Add a user">
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        <Field label="Name"><input style={inputStyle} value={f.name} onChange={set("name")} /></Field>
        <Field label="Email"><input style={inputStyle} type="email" value={f.email} onChange={set("email")} /></Field>
        <Field label="Role">
          <select style={{ ...inputStyle, cursor: "pointer" }} value={f.role} onChange={set("role")}>
            <option value="admin">Admin</option>
            <option value="staff">View only</option>
          </select>
        </Field>
        <Field label="Password (blank = generate one)"><input style={inputStyle} value={f.password} onChange={set("password")} placeholder="auto-generate" /></Field>
      </div>
      <div className="flex justify-end">
        <button
          style={btn(true)}
          onClick={async () => {
            const d = await onCall("/api/users", "POST", { ...f, password: f.password || undefined });
            if (d) { setF({ email: "", name: "", role: "admin", password: "" }); onDone(d); }
          }}
        >
          Create user
        </button>
      </div>
    </Card>
  );
}

// F-02: TOTP two-factor enrollment. start → show secret → confirm code → enabled.
function TwoFactor({ onCall, onNotice }) {
  const [enabled, setEnabled] = useState(null); // null until loaded
  const [enroll, setEnroll] = useState(null);   // { secret, otpauth } during setup
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const load = async () => { const d = await onCall("/api/users/me", "GET"); if (d) setEnabled(!!d.user.totp_enabled); };
  useEffect(() => { load(); }, []);
  if (enabled === null) return null;
  return (
    <Card title="Two-factor authentication">
      {enabled ? (
        <>
          <p style={{ fontSize: 13.5, color: C.sub, marginBottom: 12 }}>
            <strong style={{ color: C.green }}>On.</strong> Sign-in requires a code from your authenticator app.
          </p>
          <div className="flex" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 200px" }}>
              <Field label="Current password to turn off"><input style={inputStyle} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
            </div>
            <button style={{ ...btn(false), color: C.red }} onClick={async () => {
              if (await onCall("/api/users/me/totp", "POST", { action: "disable", password: pw })) { setPw(""); onNotice({ title: "Two-factor turned off." }); load(); }
            }}>Turn off</button>
          </div>
        </>
      ) : enroll ? (
        <>
          <p style={{ fontSize: 13.5, color: C.sub, marginBottom: 10 }}>Add this key to your authenticator app (Google Authenticator, 1Password, Authy), then enter the 6-digit code it shows.</p>
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: C.sub }}>Setup key</span>
            <code style={{ display: "block", fontFamily: MONO, fontSize: 14, fontWeight: 600, background: C.paper, padding: "10px 12px", borderRadius: 8, border: `1px solid ${C.line}`, marginTop: 4, wordBreak: "break-all" }}>{enroll.secret}</code>
          </div>
          <div className="flex" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 160px" }}>
              <Field label="6-digit code"><input style={{ ...inputStyle, fontFamily: MONO, letterSpacing: 3 }} inputMode="numeric" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></Field>
            </div>
            <button style={btn(true)} onClick={async () => {
              if (await onCall("/api/users/me/totp", "POST", { action: "enable", code })) { setEnroll(null); setCode(""); onNotice({ title: "Two-factor is on." }); load(); }
            }}>Confirm</button>
            <button style={btn(false)} onClick={() => { setEnroll(null); setCode(""); }}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 13.5, color: C.sub, marginBottom: 12 }}>Off. Add a second factor so a stolen password isn't enough to sign in.</p>
          <button style={btn(true)} onClick={async () => { const d = await onCall("/api/users/me/totp", "POST", { action: "start" }); if (d) setEnroll(d); }}>Set up two-factor</button>
        </>
      )}
    </Card>
  );
}

function AuditLog({ onCall }) {
  const [events, setEvents] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open && !events) onCall("/api/audit?limit=200", "GET").then((d) => d && setEvents(d.events)); }, [open]);
  const when = (ts) => new Date(Number(ts)).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <Card title="Audit log">
      {!open ? (
        <button style={btn(false)} onClick={() => setOpen(true)}>Show recent activity</button>
      ) : events === null ? (
        <p style={{ fontSize: 13, color: C.faint }}>Loading…</p>
      ) : events.length === 0 ? (
        <p style={{ fontSize: 13, color: C.faint }}>No events recorded yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
            <thead><tr>{["When", "Who", "Action", "Detail", "IP"].map((h) => <th key={h} style={{ textAlign: "left", color: C.sub, fontWeight: 600, padding: "4px 10px 4px 0", borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td style={{ padding: "4px 10px 4px 0", borderBottom: `1px solid ${C.lineSoft}`, whiteSpace: "nowrap", fontFamily: MONO, color: C.sub }}>{when(e.ts)}</td>
                  <td style={{ padding: "4px 10px 4px 0", borderBottom: `1px solid ${C.lineSoft}`, whiteSpace: "nowrap" }}>{e.actor_email || "—"}</td>
                  <td style={{ padding: "4px 10px 4px 0", borderBottom: `1px solid ${C.lineSoft}`, whiteSpace: "nowrap", fontFamily: MONO }}>{e.action}</td>
                  <td style={{ padding: "4px 10px 4px 0", borderBottom: `1px solid ${C.lineSoft}` }}>{[e.entity && `${e.entity} ${e.entity_id}`, e.detail].filter(Boolean).join(" · ")}</td>
                  <td style={{ padding: "4px 10px 4px 0", borderBottom: `1px solid ${C.lineSoft}`, whiteSpace: "nowrap", fontFamily: MONO, color: C.faint }}>{e.ip || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ChangePassword({ onCall, onDone }) {
  const [hasPw, setHasPw] = useState(false);
  const [current, setCurrent] = useState(null); // fetched on demand (F-01)
  const [showCur, setShowCur] = useState(false);
  const [next, setNext] = useState("");
  const load = async () => { const d = await onCall("/api/users/me", "GET"); if (d) { setHasPw(!!d.user.has_password); setCurrent(null); setShowCur(false); } };
  useEffect(() => { load(); }, []);
  // F-01: own password revealed on demand, audited — not shipped with /me.
  const toggleCur = async () => {
    if (showCur) { setShowCur(false); return; }
    if (current === null) { const d = await onCall("/api/users/me/password", "GET"); if (!d) return; setCurrent(d.visible_password || ""); }
    setShowCur(true);
  };
  return (
    <Card title="Change my password">
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <Field label="Current password">
          <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 38 }}>
            {hasPw ? (
              <>
                <code style={{ fontFamily: MONO, fontWeight: 600, fontSize: 13, background: C.panel, padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line}`, letterSpacing: showCur ? 0 : 2 }}>
                  {showCur ? current : "••••••••"}
                </code>
                <button onClick={toggleCur} style={{ background: "none", border: "none", color: C.brand, cursor: "pointer", fontSize: 12.5, fontWeight: 600, padding: 0 }}>
                  {showCur ? "Hide" : "Show"}
                </button>
              </>
            ) : (
              <span style={{ fontSize: 12.5, color: C.faint }}>Not on record — set a new one below and it will show here.</span>
            )}
          </div>
        </Field>
        <Field label="New password (min 8 characters)"><input style={inputStyle} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end">
        <button
          style={btn(true)}
          onClick={async () => {
            const d = await onCall("/api/users/me/password", "POST", { next });
            if (d) { setNext(""); setShowCur(false); load(); onDone(); }
          }}
        >
          Update password
        </button>
      </div>
    </Card>
  );
}
