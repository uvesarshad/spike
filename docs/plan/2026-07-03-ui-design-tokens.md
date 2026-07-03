# UI Design Tokens — QA Subagent Side Panel

Source of truth: `extension/panel.html`, `extension/panel.css`, `extension/icons.js`.
This is the only shipped UI in this repo — a Chrome extension side panel (fixed
~360–420px column, not a full browser window) that functions as the app's
control surface / "admin dashboard" (settings, run controls, live progress,
verdict, history). Everything below is extracted verbatim from the live
CSS/HTML, not guessed, so it can be reproduced 1:1 in a Next.js app.

Aesthetic in one line: **dark, near-black canvas · single high-energy lime
accent · white floating result card for strong figure/ground contrast ·
generously rounded pill components · geometric sans with strong size/weight
contrast.**

---

## 1. Color tokens

Defined as CSS custom properties on `:root` (dark, default) with a
`:root[data-theme="light"]` override block. Theme is toggled by JS setting
`data-theme` on `<html>`, not a media query.

### Dark theme (default)

```css
--bg:            #0D0D0F;   /* page canvas */
--bg-2:          #141417;   /* header gradient top-stop */
--card:          #1A1A1D;   /* inputs, chips, tab card, settings card */
--card-2:        #1E1E22;   /* nested/inset surfaces (settings select bg) */
--raised:        #26262C;   /* hover state surfaces, favicon chip bg */
--border:        #2A2A31;   /* default 1px borders */
--border-soft:   #212127;   /* subtler dividers (header, feed) */

--accent:        #C4F82A;   /* primary lime */
--accent-2:      #B4F02C;   /* hover-state lime (slightly darker) */
--accent-press:  #A6E312;   /* active/press state (defined, rarely used directly) */
--accent-tint:   rgba(196, 248, 42, .12);  /* faint lime wash (hover bg) */
--accent-ring:   rgba(196, 248, 42, .22);  /* focus ring */
--on-accent:     #12140A;   /* text/icon color sitting ON lime fills */

--surface:       var(--card-2);   /* result card bg (theme-aware) */
--surface-line:  var(--border);
--code-bg:       #0A0A0C;   /* feed / fix-prompt console surface (always dark) */
--code-ink:      #C9C9D0;   /* text on code surfaces */

--ink:           #F4F4F6;   /* primary text */
--ink-2:         #C9C9D0;   /* secondary text */
--muted:         #8A8A90;   /* tertiary / label text */

--white:         #FFFFFF;
--white-ink:     #141417;
--white-muted:   #6B6B72;
--white-line:    #ECECEF;
--white-inset:   #F4F4F6;

--red:           #FF6B66;   /* fail / destructive */
--amber:         #F5C24A;   /* warning / advanced badge */
--green:         #9BE61F;   /* success accent (history "pass" icon) */
```

### Light theme (`:root[data-theme="light"]`) — overrides only

```css
--bg:            #F6F6F8;
--bg-2:          #FFFFFF;
--card:          #FFFFFF;
--card-2:        #F1F1F4;
--raised:        #E9E9EE;
--border:        #E3E3E9;
--border-soft:   #ECECF0;

--ink:           #17171A;
--ink-2:         #45454D;
--muted:         #77777F;

--accent:        #8FCB0A;   /* darker lime for AA contrast on white */
--accent-2:      #83BC07;
--accent-tint:   rgba(143, 203, 10, .14);
--accent-ring:   rgba(143, 203, 10, .28);
--on-accent:     #10130A;

--code-bg:       #16161A;   /* code/console stays dark in BOTH themes */
--green:         #5C9A00;
```

Note the deliberate asymmetry: `--code-bg`/`--code-ink` (feed + fix-prompt
textarea) never switch to a light surface — the "console" always reads as a
terminal regardless of theme.

### Status / verdict colors (hardcoded, not tokenized — same in both themes)

Verdict badges use flat pastel-on-dark-text pairs, independent of the
dark/light theme variables:

```css
.verdict-pass      { background: #EAFBC2; color: #4A7A00; }
.verdict-fail      { background: #FDE5E3; color: #C23A33; }
.verdict-uncertain { background: #FCF1CF; color: #8A6A12; }
```

Same pairing reused for the "copied" state of the copy button
(`color: #4A7A00; border-color: #BFE76A; background: #F2FBDD;`) and the
auto-fix success note (`color: #4A7A00; background: #EFFBD6; border: #CDEE8E;`).

---

## 2. Typography

```css
font-family: "Inter", "General Sans", "Satoshi", "Segoe UI Variable",
             system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
font-size: 13px;              /* base body size */
-webkit-font-smoothing: antialiased;
```

Monospace stack (feed console + fix-prompt textarea):
```css
font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
```

### Type scale (every size used, smallest → largest)

| Size | Weight | Letter-spacing | Used for |
|---|---|---|---|
| 9px | 700 | 0.04em, uppercase | `.badge-adv` "Advanced" pill |
| 10.5px | 600 | 0.08em, uppercase | `.field-label`, `.feed-title`, `.history-toggle`, `.settings-group-title` |
| 11px | 400/600 | — | `.nano-progress-text`, `.nano-gate`, `.fix-sub`, `.settings-key-status`, `.settings-note` |
| 11.5px | 400 | — | `.nano-line`, `.tab-warning`, `.settings-group-sub`, `.settings-field-label`, `.consent-note`, `.fix-prompt`, `.feed` |
| 12px | 500/600 | — | `.suggestion-card`, `.consent-row`, `.history-item`, `.fix-status` |
| 12.5px | 400/600/700 | — | `.tab-title`, `.plain-report`, `.clip-btn`, `.copy-btn`, `.fix-title`, `.fix-note`, `.error-banner` |
| 13px | 400/700 | — | body base, `.text-input`/`.text-area`, `.settings-select`/`.settings-input`, `.autofix-btn`, `.settings-btn-primary` |
| 14px | 600/700 | -0.01em | `.run-btn`, `.stop-btn`, `.settings-title` |
| 15px | 700 | -0.01em | `.logo` |

Rule of thumb: **labels are small/uppercase/tracked-out** (10.5px, 600 weight,
0.08em tracking, `--muted` color); **body/content text sits at 12.5–13px**;
**primary CTAs are 13–14px/700 with slight negative tracking** for a tight,
confident look.

---

## 3. Spacing & sizing scale

No formal spacing scale variable exists — spacing is authored ad hoc but
clusters tightly around an 4/6/7/8/9/11/12/16px rhythm:

- **Micro gaps** (icon+label, chip internals): 6–9px
- **Component padding**: 8px×14px (small pill buttons) → 11–12px×12–16px (inputs, cards) → 12px (primary run button, square-ish)
- **Section gaps** (`.body` flex column, `.inputs`): 8px, 12px, 16px, 18px
- **Panel outer padding**: `.hdr` = `16px 16px 14px`; `.body` = `16px`
- **Card padding**: `.result-card` = `16px`; `.settings-card` = `16px`; `.tab-card` / `.text-input` = `11px 12px`

### Radius scale (tokenized)

```css
--radius-lg: 20px;   /* result card, settings card (outer containers) */
--radius:    14px;   /* inputs, buttons, tab card, feed, fix-prompt */
--radius-sm: 10px;   /* nested inset notes: nano-gate, tab-warning, consent-note */
--pill:      999px;  /* every chip/button/badge/dot that should look "rounded pill" */
```

Hierarchy: outer containers use `radius-lg`, functional controls use
`radius`, small inline callouts use `radius-sm`, and anything button/chip/tag
shaped is a full `pill`.

---

## 4. Layout structure

Single-column vertical stack, no sidebar/nav rail (this is a narrow side
panel, not a wide dashboard) — but it maps directly onto the "header + main
container + stacked sections" pattern used by a full admin dashboard:

```
<body>                                   flex column, min-height:100%, radial-gradient bg
  <header class="hdr">                   16px 16px 14px padding, bottom border, gradient bg
    .hdr-top (flex row, gap 9px)
      .logo (dot + text, flex:1 via margin-left:auto siblings)
      #settingsBtn  (28×28 circular icon button)
      #themeBtn     (28×28 circular icon button)
      #bridgeDot    (9×9 connection-status dot, margin-left:auto)
    #nanoLine        (11.5px status line)
    #nanoOnboard     (conditional: download CTA / progress bar / storage-gate note)
  </header>

  <main class="body">                    flex column, gap:18px, padding:16px, scrollable
    #settingsModal   (fixed overlay, centered card, hidden by default)
    .inputs          (tab card, suggestion chips, task textarea, consent toggle, run/stop row)
    #errorBanner     (conditional inline alert)
    .feed-wrap        (uppercase label + dark monospace console, max-height 220px, scrolls)
    #resultCard       (white/inverted floating card: verdict badge, plain report, fix section)
    #historySection   (collapsible "Recent runs" list)
  </main>
</body>
```

### Header
- Background: `linear-gradient(180deg, var(--bg-2), transparent)` fading into the page canvas — not a flat bar.
- Bottom border: `1px solid var(--border-soft)`.
- Logo mark: a 11×11px rounded-square lime dot with a 4px lime glow ring (`box-shadow: 0 0 0 4px var(--accent-tint)`), followed by 15px/700 wordmark text with -0.01em tracking.
- Icon buttons (gear, theme toggle): 28×28px circles, `1px solid var(--border)`, `--card` bg, hover → lime tint bg + lime border + ink text.
- Connection dot: 9×9 circle; `.dot-on` = lime fill + 4px glow ring; `.dot-off` = flat `#3a3a42`.

### Main container
- `.body` is the single scrollable region (`overflow-y: auto`), flex column with **18px gaps between major sections** — this is the primary vertical rhythm of the whole app.
- Custom slim scrollbars everywhere: 9px wide, thumb `#34343c` (hover `#44444e`), fully pill-rounded, transparent track, 2px padding via `border` + `background-clip: padding-box`.

### Settings modal (the "admin"/config surface)
- Fixed, full-viewport overlay: `position: fixed; inset: 0; z-index: 60`.
- Centered card, top-aligned (`align-items: flex-start`), `22px 16px` outer padding, own scroll if content overflows.
- Backdrop: `rgba(0,0,0,.5)` + `backdrop-filter: blur(2px)`.
- Card: max-width 420px, `radius-lg` (20px), `--card` background, heavy shadow (`0 18px 60px -20px rgba(0,0,0,.7)`), 16px internal padding, 16px gap between groups.
- Composed of **repeatable "settings-group" sections** (Navigator / Brain / Debugging), each with an uppercase 10.5px title, a muted 11.5px description line, then form fields (select, radio row, text input, password input with show/hide eye toggle). Groups are separated by a 1px top border except the first.
- Footer action row: primary (lime, flex:1) + secondary (ghost, auto-width) button pair, separated from the body by a top border.

This settings-modal pattern (grouped cards, label-above-field, uppercase
group titles, save/close footer) is the direct template for an "admin
dashboard settings page" if porting to Next.js — just render it inline in a
page instead of as a modal.

---

## 5. Core components

### Buttons
Four button families, all `border-radius` either `--radius` (rectangular CTAs) or `--pill` (chips/ghost actions):

| Class | Shape | Fill | Text | Notes |
|---|---|---|---|---|
| `.run-btn` / `.autofix-btn` / `.settings-btn-primary` | radius, full-width or flex:1 | `--accent` solid | `--on-accent`, 700 weight | primary CTA; hover→`--accent-2`; active→`scale(.99)`; shadow `0 6px 18px -8px var(--accent-ring)` on run-btn |
| `.stop-btn` | radius | transparent | `--red` | 1px red-tinted border; hover fills faint red |
| `.settings-btn-secondary` / `.clip-btn` / `.copy-btn` | pill or radius | transparent | `--ink`/`--ink-2` | ghost button, 1px `--border`; hover → `--raised` bg + lime border |
| `.suggestion-card` / `.history-item` | pill | `--card` | `--ink-2` | chip-style; hover → lime tint bg + lime border + ink text |
| `.settings-btn` / `.theme-btn` (icon-only) | circle (pill, fixed 28×28) | `--card` | `--muted` | hover → lime tint |

Universal button interaction pattern: `transition` on background/border/color
(~0.14s ease) + a `transform: scale(.98–.99)` on `:active` for tactile press
feedback. Disabled state = `opacity: .4–.55; cursor: default` (shadow removed
too, on run-btn).

### Inputs
- `.text-input` / `.text-area` / `.settings-select` / `.settings-input`: `--card` (or `--card-2` inside modal) bg, 1px `--border`, `--radius` (14px), `11px 12px` (or `10px 12px`) padding, 13px font.
- Focus state (shared): `border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring);` — a soft lime halo, no default outline.
- Placeholder color: `#5c5c66` (dark-only literal, not tokenized).
- Password/API-key field: relatively-positioned wrapper with an absolutely-positioned 30×30 eye-toggle button inset at `right: 4px`.
- Checkbox/radio: native inputs with `accent-color: var(--accent)` — no custom-drawn control.

### Cards / surfaces
- **Tab card** (`.tab-card`): horizontal flex, 28×28 rounded-9px favicon chip on `--raised`, title+host stacked, `--radius` (14px) container.
- **Result card** (`.result-card`): the one "inverted" surface — `--surface` bg (theme-aware `--card-2`), `--radius-lg` (20px), heavy drop shadow (`0 18px 40px -20px rgba(0,0,0,.45)`), 16px padding, 12px internal gap. This is the visual focal point of a completed run.
- **Feed / console** (`.feed`): `--code-bg` (always near-black), monospace 11.5px, 1.55 line-height, `max-height: 220px` with internal scroll, empty-state via `:empty::before { content: "No activity yet." }`.

### Badges / status
- `.verdict-badge`: pill, 7px/14px padding, icon+text, flat pastel bg per verdict (see §1).
- `.badge-adv` ("Advanced"): 9px/700/uppercase amber pill, inline after a label.
- `.dot`: 9px circular status indicator (on/off).
- `.history-emoji`: colored by outcome (`--green`/`--red`/`--amber`).

### Icons
Inline SVG set (`extension/icons.js`), Lucide-style line icons: `24×24`
viewBox, `fill="none" stroke="currentColor" stroke-width="2"
stroke-linecap="round" stroke-linejoin="round"`. Rendered size is controlled
purely by CSS (`.ico-svg { width/height }`), defaulting to 16px, overridden
to 12–15px per context. Icons: `plan, click, type, navigate, assert, wait,
finish` (step-kind icons), `pass, fail, uncertain` (verdict icons), `check,
x, wrench, sparkles` (inline state icons), `globe, lock, cart, search,
download` (content icons), `chevron, eye, eye-off, sun, moon, info, gear`
(UI chrome icons). Icons take color from context via `currentColor` — no
per-icon color CSS needed. Hydration: any `<span class="ico"
data-icon="name">` is auto-filled with the matching SVG on `DOMContentLoaded`
via a global `qaHydrateIcons()`.

---

## 6. Animation & motion

All keyframes are namespaced `__qa_*` to avoid collisions:

```css
@keyframes __qa_step_in {           /* new timeline row entrance */
  from { opacity: 0; transform: translateX(-6px); }
  to   { opacity: 1; transform: translateX(0); }
}                                    /* 220ms ease, applied once per row */

@keyframes __qa_spin {              /* loading spinner */
  to { transform: rotate(360deg); }
}                                    /* 700ms linear infinite */

@keyframes __qa_think {             /* "..." thinking dots, staggered */
  0%, 20%  { opacity: 0.2; }
  50%      { opacity: 1; }
  80%, 100%{ opacity: 0.2; }
}                                    /* 1.2s infinite; dot 2 delays .2s, dot 3 delays .4s */
```

Micro-interaction transitions (used everywhere, not just buttons):
`background .14s ease`, `border-color .14s ease`, `color .14s ease`,
`transform .06s ease` (press), `box-shadow .14s ease`, and one slower
exception — the nano-download progress bar fill: `width .25s ease`.

Spinner element (`.step-spinner`): 11×11px circle, 2px border, one edge
(`border-top-color`) painted `--accent` to create a rotating-arc effect.

No page-transition/route-change animations exist (single-view app) — all
motion is local to list items, buttons, and status indicators.

---

## 7. Content/page inventory

This app has exactly one "page" (the side panel), organized as stacked
sections rather than routes. If porting to a multi-page Next.js admin
dashboard, treat each section as a candidate route/tab:

1. **Header** — branding, settings entry point, theme toggle, daemon connection status, on-device AI onboarding banner.
2. **Settings** (modal today; would be `/settings` page in a full dashboard) — three grouped cards: **Navigator** (cheap per-step model config: provider, API-key/CLI mode, model override, key management), **Brain** (planner model config, same shape plus Ollama/GLM options), **Debugging** (fix-mode radio: prompt vs auto-fix, conditional coding-agent picker).
3. **Run configuration** (`.inputs`) — current-tab indicator card, quick-start suggestion chips, free-text task textarea, interaction-consent checkbox, run/stop button pair.
4. **Live progress** (`.feed-wrap`) — scrolling monospace timeline of step rows (icon + text + state/spinner), auto-animated entrance.
5. **Result** (`#resultCard`) — verdict badge (pass/fail/uncertain), plain-English report, optional clip download, optional fix-prompt sub-section (auto-fix CTA, status, copyable prompt textarea).
6. **History** (`#historySection`) — collapsible list of recent runs (icon by verdict, task text truncated, relative timestamp).

---

## 8. Design principles to preserve when cloning

- **One accent color, used sparingly but consistently** — lime (`--accent`) marks every interactive/primary/success touchpoint (focus rings, primary buttons, active dots, spinners, hover chips). Never introduce a second brand hue.
- **Dark canvas + one inverted white card** — the result card is the only surface that flips to a light/raised treatment against the dark app; this is what gives the "verdict" its visual weight. Don't make everything white, and don't make the result card dark too.
- **Console-styled surfaces stay dark in both themes** — feed + fix-prompt always use `--code-bg`/`--code-ink`, independent of light/dark toggle.
- **Uppercase, tracked-out micro-labels** (10.5px/600/0.08em) mark every section header (`FIELD-LABEL`, `FEED`, `SETTINGS-GROUP-TITLE`) — this is the primary way hierarchy is established, more than font-size jumps.
- **Everything actionable is a pill or has pill-adjacent radius**; only structural containers (cards, modals, inputs) use the squarer 14–20px radii.
- **Motion is small and fast** (0.06–0.25s) — reinforces responsiveness, never used for decoration.
