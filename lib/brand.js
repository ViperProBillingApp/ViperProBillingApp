/* ViperPro brand tokens — "grey ink, periwinkle accent"
   Core: Slate 700 #58585A (text) · Blue 400 #98B6E0 (accent)
   Blue scale (sampled from ViperPro_Brand_Guidelines_2026_Updated.pdf p.5):
   800 #2F548C · 700 #3F6CAE · 600 #5E86C2 · 400 #98B6E0 · 100 #E9F0FA
   Slate: 950 #232325 · 900 #2E2E30 · 700 #58585A · 500 #8A8A8F · 200 #E4E4E7

   Looks (themes): every token below is a CSS variable, so switching look is
   one attribute on <html> (data-theme) — no re-render of the data, and pages
   outside the CRM (login, reset, users) follow along for free. Each look's
   raw values live in THEME_TOKENS; `themeCss()` emits them for layout.jsx.
   To add a look: add an entry to THEMES + THEME_TOKENS with every key. */

// `layout` picks the app shell (classic = side rail, studio = top pill bar);
// `dark` flags looks whose surfaces are dark (native controls follow).
export const THEMES = [
  { id: "classic", label: "Classic", desc: "The original glass-and-gradient look", layout: "classic", dark: false, swatch: ["#EEF2F8", "#1D4586", "#98B6E0"] },
  { id: "studio", label: "Studio", desc: "Rounded cards, dark navy panels, pill navigation", layout: "studio", dark: false, swatch: ["#F4F6FA", "#16213A", "#2F548C"] },
  { id: "midnight", label: "Studio Dark", desc: "Studio after hours: deep navy with a soft blue glow", layout: "studio", dark: true, swatch: ["#0B0F17", "#1A2335", "#5E86C2"] },
];
export const themeInfo = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
export const DEFAULT_THEME = "studio";
export const THEME_STORAGE_KEY = "vp-look";

const CLASSIC = {
  // colours
  paper: "#EEF2F8", panel: "#FFFFFF", ink: "#26262A", sub: "#58585A", faint: "#71767F", // faint darkened from #8A8F98 — 4.6:1 on white, passes AA for the small text it colours
  line: "#DFE4EC", lineSoft: "#EBEFF5", brand: "#22304C", brandInk: "#F3F6FB",
  action: "#426190", accent: "#98B6E0", accentSoft: "#E7EDF8",
  green: "#2E8A64", greenBg: "#E7F4EE", amber: "#9C6F17", amberBg: "#FAF0DB",
  red: "#C6473E", redBg: "#FBE9E7", grey: "#6B7078", greyBg: "#EEF0F3",
  // Trello-blue "work surface" gradient — Workflow board, What needs attention, Clients header, app header
  boardGradient: "linear-gradient(155deg, #16305F 0%, #1D4586 45%, #2A62B8 100%)",
  hero: "linear-gradient(155deg, #16305F 0%, #1D4586 45%, #2A62B8 100%)",
  // categorical colours (segments, stages, tags) — meaning, not decoration;
  // dark looks lift them so they still read on dark surfaces
  catBlue: "#3B5BA5", catTeal: "#0E766E", catPlum: "#7A5AA6", catViolet: "#7A4FB5", catLilac: "#8A5CD1", catSlate: "#8A94A6",
  // page backdrop behind the app, and native-control colour scheme
  pageBg: "#EEF2F8", scheme: "light",
  // fonts
  fSans: '"Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  fDisplay: '"Jost", "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif',
  fMono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
  // shape
  rs: "1", rBtn: "8px", rCtl: "8px",
  shCard: "none", shPop: "0 8px 24px rgba(34,48,76,0.18)",
};

// Studio — after the Finnova-style dashboard reference, rebuilt in Viper
// colours: the reference's violet becomes Blue 800, its near-black panels
// become a deep navy cut from the same blue, and Blue 400 periwinkle is the
// accent (chart bars, highlights, icon tints on dark).
const STUDIO = {
  paper: "#F4F6FA", panel: "#FFFFFF", ink: "#1D2230", sub: "#58585A", faint: "#6F7380",
  line: "#E3E7EE", lineSoft: "#EEF1F6", brand: "#16213A", brandInk: "#F3F6FB",
  action: "#2F548C", accent: "#98B6E0", accentSoft: "#E9F0FA",
  green: "#23805A", greenBg: "#E3F4EC", amber: "#A26C12", amberBg: "#FBF0DB",
  red: "#C4453C", redBg: "#FAE5E3", grey: "#6B6E78", greyBg: "#EEF0F4",
  boardGradient: "linear-gradient(160deg, #141D31 0%, #1A2742 100%)",
  hero: "linear-gradient(135deg, #2F548C 0%, #3F6CAE 100%)",
  catBlue: "#3B5BA5", catTeal: "#0E766E", catPlum: "#7A5AA6", catViolet: "#7A4FB5", catLilac: "#8A5CD1", catSlate: "#8A94A6",
  pageBg: "linear-gradient(180deg, #E6EBF3 0%, #EDF0F6 100%)", scheme: "light",
  fSans: '"Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  fDisplay: '"Jost", "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif',
  // Money and counts in the reference read as clean sans figures, not a
  // typewriter mono — tabular-nums (globals.css) keeps columns aligned.
  fMono: '"Hanken Grotesk", ui-sans-serif, system-ui, sans-serif',
  rs: "1.6", rBtn: "999px", rCtl: "14px",
  shCard: "0 1px 2px rgba(22,33,58,0.04), 0 8px 24px -12px rgba(22,33,58,0.12)",
  shPop: "0 18px 48px -12px rgba(22,33,58,0.28)",
};

// Studio Dark — the second reference (near-black dashboard with a blue halo)
// in Viper colours. Action steps up to Blue 600 because Blue 800 disappears
// on navy; status colours are the brand's soft semantics lifted for dark.
const MIDNIGHT = {
  ...STUDIO,
  paper: "#0E131D", panel: "#161D2A", ink: "#E8ECF3", sub: "#A9B0BE", faint: "#8890A0",
  line: "#273041", lineSoft: "#1D2433", brand: "#0A0E16", brandInk: "#E8ECF3",
  action: "#5E86C2", accent: "#98B6E0", accentSoft: "rgba(152,182,224,0.14)",
  green: "#52C697", greenBg: "rgba(49,158,114,0.18)", amber: "#EBB65E", amberBg: "rgba(224,162,60,0.16)",
  red: "#F07B72", redBg: "rgba(216,88,79,0.18)", grey: "#9CA3B0", greyBg: "rgba(156,163,176,0.14)",
  boardGradient: "linear-gradient(160deg, #1B2538 0%, #131B2B 100%)",
  hero: "linear-gradient(135deg, #2F548C 0%, #4470B4 100%)",
  catBlue: "#7FA2DD", catTeal: "#45BBAE", catPlum: "#B69BDD", catViolet: "#B592E6", catLilac: "#BFA2F2", catSlate: "#9EA8BA",
  pageBg: "radial-gradient(1100px 620px at 78% -8%, rgba(63,108,174,0.34), transparent 62%), radial-gradient(900px 520px at 8% 108%, rgba(94,72,190,0.16), transparent 60%), #070A11",
  scheme: "dark",
  shCard: "0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 32px -14px rgba(0,0,0,0.6)",
  shPop: "0 24px 60px -12px rgba(0,0,0,0.7)",
};

export const THEME_TOKENS = { classic: CLASSIC, studio: STUDIO, midnight: MIDNIGHT };

const cssName = (k) => "--vp-" + k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
const FONT_KEYS = new Set(["fSans", "fDisplay", "fMono"]);
const SHAPE_KEYS = new Set(["rs", "rBtn", "rCtl", "shCard", "shPop", "pageBg", "scheme"]);
const varsFor = (keys) => Object.fromEntries(keys.map((k) => [k, `var(${cssName(k)})`]));
const ALL_KEYS = Object.keys(CLASSIC);

export const C = varsFor(ALL_KEYS.filter((k) => !FONT_KEYS.has(k) && !SHAPE_KEYS.has(k)));
// Shape tokens: button/control radius and elevation.
export const T = varsFor([...SHAPE_KEYS]);
export const SANS = `var(${cssName("fSans")})`;
export const DISPLAY = `var(${cssName("fDisplay")})`;
export const MONO = `var(${cssName("fMono")})`;

// Radius that scales with the look: classic keeps the exact px it always had,
// Studio rounds everything up by the look's `rs` factor.
export const rad = (px) => `calc(${px}px * var(${cssName("rs")}))`;
// Translucent version of any colour token (works on var() refs, unlike
// appending hex alpha digits to a string).
export const alpha = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export function themeCss() {
  const block = (sel, t) => `${sel}{${ALL_KEYS.map((k) => `${cssName(k)}:${t[k]};`).join("")}color-scheme:${t.scheme};}`;
  return [
    block(":root", THEME_TOKENS[DEFAULT_THEME]),
    ...Object.entries(THEME_TOKENS).map(([id, t]) => block(`html[data-theme="${id}"]`, t)),
  ].join("\n");
}

// Runs before first paint (inline in <head>) so a saved look never flashes
// the default one. Guarded: storage can throw in private windows.
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t&&${JSON.stringify(Object.keys(THEME_TOKENS))}.indexOf(t)>-1)document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export function applyTheme(id) {
  if (!THEME_TOKENS[id]) return;
  document.documentElement.setAttribute("data-theme", id);
  try { localStorage.setItem(THEME_STORAGE_KEY, id); } catch { /* private window — look just won't persist */ }
}
export function currentTheme() {
  if (typeof document === "undefined") return DEFAULT_THEME;
  const t = document.documentElement.getAttribute("data-theme");
  return THEME_TOKENS[t] ? t : DEFAULT_THEME;
}

/* Official logo (public/logo.svg, primary variant extracted from the 2026 brand sheet).
   `size` is the former wordmark font-size; the image is scaled to match.
   `reversed` swaps to the white-ink variant for dark surfaces. */
export function Wordmark({ size = 22, sub = "", reversed = false }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <img src={reversed ? "/logo-white.svg" : "/logo.svg"} alt="ViperPro" style={{ height: size * 1.55, width: "auto", display: "block" }} />
      {sub && <span style={{ fontFamily: SANS, fontWeight: 500, fontSize: size * 0.68, color: C.sub }}>· {sub}</span>}
    </span>
  );
}
