/* ViperPro brand tokens — "grey ink, periwinkle accent"
   Core: Slate 700 #58585A (text) · Blue 400 #98B6E0 (accent)
   ponytail: blue/grey scale steps derived from the two core colours;
   swap for the exact hex steps in ViperPro_Brand_Guidelines_2026.pdf when extracted. */
export const C = {
  paper: "#EEF2F8", panel: "#FFFFFF", ink: "#26262A", sub: "#58585A", faint: "#8A8F98",
  line: "#DFE4EC", lineSoft: "#EBEFF5", brand: "#22304C", brandInk: "#F3F6FB",
  action: "#426190", accent: "#98B6E0",
  green: "#2E8A64", greenBg: "#E7F4EE", amber: "#9C6F17", amberBg: "#FAF0DB",
  red: "#C6473E", redBg: "#FBE9E7", grey: "#6B7078", greyBg: "#EEF0F3",
};

export const SANS = '"Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const DISPLAY = '"Jost", "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif';
export const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

/* Official logo (public/logo.svg, primary variant extracted from the 2026 brand sheet).
   `size` is the former wordmark font-size; the image is scaled to match. */
export function Wordmark({ size = 22, sub = "" }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <img src="/logo.svg" alt="ViperPro" style={{ height: size * 1.55, width: "auto", display: "block" }} />
      {sub && <span style={{ fontFamily: SANS, fontWeight: 500, fontSize: size * 0.68, color: C.sub }}>· {sub}</span>}
    </span>
  );
}
