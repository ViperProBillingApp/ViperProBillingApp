# Design

Visual system for the ViperPro Client CRM. Source of truth for tokens: `lib/brand.js`. Derived from the ViperPro Brand System (Edition 01 · 2026): "grey ink, periwinkle accent."

## Looks (themes)

Staff can switch the whole app between looks from the **Look** control (Classic: bottom of the left menu; Studio: palette button in the top bar). The choice is saved per browser (`localStorage` key `vp-look`) and applied before first paint by a boot script in `app/layout.jsx`, so login/reset pages follow it too. Studio is the default for anyone who hasn't picked a look (`DEFAULT_THEME`).

| Look | Layout | Summary |
| --- | --- | --- |
| Classic | Side rail, glass metric tiles, raised tabs | The original look — unchanged, still one click away |
| Studio | Top pill navigation, round icon buttons, KPI cards, notched dark panels | After the Finnova-style dashboard reference, in Viper colours: its violet → Blue 800 `#2F548C`, its near-black panels → deep navy `#141D31`, accent Blue 400 `#98B6E0` |
| Studio Dark | Same as Studio | Dark mode: near-black navy with a soft blue glow; action steps up to Blue 600 `#5E86C2` |

How it works: every token in `lib/brand.js` is a CSS variable (`C.ink` → `var(--vp-ink)`); each look's raw values live in `THEME_TOKENS`, emitted by `themeCss()`. Radii scale per look via `rad(px)` (Classic ×1, Studio ×1.6); use `alpha(color, pct)` for translucency (never append hex digits to a token). Components read `useLook()` only where the Studio layout is structurally different (shell, Today, Clients, Workflow, Emails, Replies, Recovery, drawer tabs, modals, metric tiles).

**Adding a look:** add an entry to `THEMES` (id, label, `layout: "classic" | "studio"`, `dark`, swatch) and a full token set to `THEME_TOKENS`. Categorical colours (`catBlue`, `catTeal`, …) need lifted values on dark looks.

**The notch:** Studio's signature element — a tab tray cut into a dark panel's edge (`NotchTray` / `NotchPanel` in `crm.jsx`). The tray is painted in the colour of the surface it opens onto, with two concave fillets. `edge="top"` for panels, `edge="bottom"` for the client drawer header.

Blue scale (sampled from the 2026 brand PDF, p.5): 800 `#2F548C` · 700 `#3F6CAE` · 600 `#5E86C2` · 400 `#98B6E0` · 100 `#E9F0FA`. Slate: 950 `#232325` · 900 `#2E2E30` · 700 `#58585A` · 500 `#8A8A8F` · 200 `#E4E4E7`.

## Color (Classic)

Core: Slate 700 `#58585A` (body text) · Blue 400 `#98B6E0` (brand periwinkle — logo 'er', accents, key highlights).

| Token | Value | Use |
| --- | --- | --- |
| `paper` | `#EEF2F8` | App background (cool blue-tinted, light and airy) |
| `panel` | `#FFFFFF` | Cards, tables, inputs |
| `ink` | `#26262A` | Headings, primary text |
| `sub` | `#58585A` | Secondary text (brand Slate 700) |
| `faint` | `#8A8F98` | Tertiary/meta text |
| `line` / `lineSoft` | `#DFE4EC` / `#EBEFF5` | Borders, dividers |
| `brand` | `#22304C` | Primary buttons (deep navy, blue-800 derived) |
| `accent` | `#98B6E0` | Brand periwinkle (Blue 400 core) |
| `action` | `#426190` | Secondary solid buttons (blue-600 derived) |
| `green` / `amber` / `red` | `#2E8A64` / `#9C6F17` / `#C6473E` | Semantic status (soft, per brand: #319E72/#E0A23C/#D8584F adjusted darker for text contrast on light backgrounds) |
| `grey` / `greyBg` | `#6B7078` / `#EEF0F3` | Semantic status: neutral/inactive (no state, archived) |

Blue/grey scale steps are derived from the two core colours — exact steps live in `ViperPro_Brand_Guidelines_2026.pdf` (Desktop/Claude/ViperPro_Branding); swap in when extracted. Categorical colors (segments, stages, tags) encode meaning — don't restyle them decoratively.

## Typography

| Role | Face | Use |
| --- | --- | --- |
| Display | Jost (400–700) | Wordmark, page/card titles, primary buttons |
| Body/UI | Hanken Grotesk (400–800) | Everything else |
| Data/Mono | IBM Plex Mono (400–600) | Money, dates, counts, emails, IDs |

Loaded via Google Fonts `<link>` in `app/layout.jsx`. Type scale ~1.2: 12 · 14 · 16 · 22 · 28.

## Logo

`public/logo.svg` — full-colour ViperPro logo (grey wordmark, periwinkle 'er', viper-swoosh V). Used on login and the app header. Min digital width 96px; clear space = cap-height of the 'V'. Never recolour letters other than 'er'. Text fallback: the `Wordmark` component in `lib/brand.js`.

## Components

Inline-styled React components in `components/crm.jsx` (shared at bottom of file): `SolidBtn` (action blue), `GhostBtn` (panel + border), `Pill`/`MiniPill` (status), `Tab`, `MiniSelect`, `Field`, `Section`, `Modal`, `DetailDrawer`. Radius: 8px controls, 12–16px panels. Shadows only on overlays (drawer, modal) and the login card.

## Layout

Max content width 1180px, `clamp(16px, 3vw, 30px)` page padding. Responsive grids via `repeat(auto-fit, minmax(...))`. Utility classes (flex/grid/etc.) in `app/globals.css`.

## Voice in UI copy

Sentence case, plain statements, no exclamation marks, no emoji. Status labels say what happened ("Payment failed"), not how to feel about it.
