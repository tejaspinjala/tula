# Pixel UI reference (research brief behind SKILL.md)

Read from SKILL.md; this is the long form. Goal: the whole web app (React 19 + Vite, Phaser 4 hall, React Flow builders) reads as a cozy handheld RPG,
not a dark SaaS dashboard. We **emulate the feel**; we never ship Nintendo / Game Freak / The Pokémon Company
or ConcernedApe assets (sprites, frames, fonts ripped from ROMs, sounds, logos, names). Every pixel we ship is
our own or CC0 / CC-BY / OFL / MIT, with the license recorded in `CREDITS.md`.

---

## 1. What defines each reference

### Stardew Valley menus (the frame language)
- **Wood-and-parchment 9-slice frames.** Every menu is a frame: an outer dark-brown outline, a 2-3 px
  wood band with a lighter top-left bevel and darker bottom-right, corner pieces with a nailed/rounded
  pixel notch, and a warm parchment or tan fill. Built from a small tile sheet (`LooseSprites/Cursors`,
  `Maps/MenuTiles` in the game files) scaled by an integer UI zoom.
- **Outline colour is never pure black.** Outlines are a very dark warm brown; shading is hue-shifted
  (shadows go toward red-brown/purple, highlights toward yellow), never grey.
- **Inventory grid.** Fixed square slots (16 px art at 4x = 64 px) on a recessed darker-tan background;
  each slot has an inner 1 px dark top-left edge (inset look). Stack count bottom-right in a tiny bold
  number with a dark outline. Selected slot = thick bright outline, not a glow.
- **Tooltip boxes.** Small 9-slice frame that follows the cursor: bold item name, category line in a
  muted colour, divider, description, then stat lines with tiny icons (energy, money). Snaps to
  stay on-screen.
- **Tabs** stick out above the frame like file-folder tabs with an icon each; the active tab sits 1 tile
  lower, joined to the frame.
- **Close button** is a red "X" token outside the top-right corner, not inside.
- **Warm palette, few hues.** Browns, tans, butter yellow, grass green, sky blue; saturated reds only
  for danger/hearts. Low global contrast in the world art, high contrast inside menus.
- **Day / season tint.** The world (not menus) gets a multiply tint that warms in the evening and goes
  blue-violet at night; seasons recolour foliage. Menus stay readable regardless.
- **Diegetic HUD.** Clock/date/gold live in a wooden sign-like widget top-right; energy as a vertical
  bar with an "E" label. Everything is a physical object.

### Pokémon DS (Diamond/Pearl/Platinum, HeartGold/SoulSilver, Black/White) (the interaction language)
- **Native canvas 256x192 per screen, two screens.** Top screen = presentation (scene, battle, map,
  info card); bottom (touch) screen = controls (menu, bag pockets, big touch buttons). Everything is
  authored on that grid and integer-scaled.
- **Dialogue box.** Full-width bottom box, ~2 lines of text, white/near-white fill, 1-2 px coloured
  border (DP: slate/blue frames selectable by the player; HGSS adds patterned frames; BW: cleaner,
  slightly translucent dark-on-light), small rounded pixel corners (2-3 px stepped, not CSS radius).
- **Text has a drop shadow:** dark grey glyphs with a 1 px light-grey shadow down-right. This, more
  than the font, is the "DS text" signature.
- **Typewriter reveal** at a fixed characters-per-frame rate; pressing A completes the line, second press
  advances. A small **bouncing ▼** at the bottom-right means "more"; it's missing on the last line.
- **▶ cursor menus.** A vertical list in a small frame (often on the right, e.g. the start menu), a solid
  ▶ to the left of the selected row; no hover highlight bar in DP. Up/Down moves, wraps around; B backs out.
- **Yes/No box.** A tiny two-row frame pops up stacked above the dialogue box's right edge, cursor on YES.
- **HP-bar meters.** Thin bar inside a dark rounded track with an "HP" label plate; fill is green >50%,
  yellow 20-50%, red <20%; animates down in steps; numeric "37/52" under it. EXP bar is a separate blue bar.
- **Party panel.** Six slots (2x3 grid in DP/HGSS), each a rounded panel with a mini sprite, name,
  level, HP bar; the selected one is a different colour and bobs; fainted ones turn red/grey.
- **Bag.** Pockets as tabs/icons along an edge, list of item names with counts ("x3") on the right,
  description in a box at the bottom, selected item icon shown large.
- **Item-get banner.** A jingle and a dialogue line "Obtained a POTION!" with the item name in a
  colour (blue/red in later gens).

### Shared rules (the pixel grid)
1. One logical pixel grid; everything (borders, gaps, radii, shadows, text offsets) is a multiple of it.
2. Integer scaling only (2x, 3x, 4x). Never 1.5x.
3. Outlines 1 logical px; drop shadows offset 1 logical px (text) or 1-2 logical px (panels), down-right,
   hard edged, no blur.
4. Limited palette per surface (4-8 colours inside one frame), hue-shifted ramps.
5. Corners are stepped (1-2-3 px staircase), never anti-aliased.

---

## 2. Palette (original, inspired by not copied from)

Tokens are named by role; use `--px-*` CSS custom properties. Contrast measured with WCAG formula.

| Token | Hex | Use |
|---|---|---|
| `ink` | `#2b1d14` | Outline, body text on paper (13.3:1 on `paper`) |
| `wood-900` | `#3e2716` | Frame outer shadow, deep wood |
| `wood-700` | `#5a3a22` | Frame band dark, header bars |
| `wood-500` | `#8a5a32` | Frame band mid, buttons |
| `wood-300` | `#b77a45` | Frame band highlight |
| `wood-100` | `#d9a066` | Bevel highlight, slot edges |
| `paper` | `#f6e7c1` | Main panel fill (parchment) |
| `paper-200` | `#ead4a0` | Recessed panels, inventory slot fill |
| `paper-400` | `#c9a96b` | Dividers, disabled fill (decorative only, 1.8:1) |
| `dialog` | `#f8f8f4` | DS-style dialogue/menu boxes |
| `dialog-text` | `#484848` | Dialogue text (8.6:1 on `dialog`) |
| `dialog-shadow` | `#c8c8c0` | 1 px text shadow in dialogue |
| `dialog-frame` | `#4a5a78` | Dialogue/menu border (slate blue) |
| `grass-700` | `#2f5d34` | Success text, "ready" states (6.3:1 on paper) |
| `grass-500` | `#4f8a3c` | Success fill, HP-full |
| `grass-300` | `#9fd06a` | Highlights, night success text |
| `sky-700` | `#2f5f94` | Links, info (darker than `#3b6ea8`, which is only 4.3:1) |
| `sky-300` | `#8ec5e8` | Sky backgrounds, EXP-style progress |
| `gold-500` | `#f2c14e` | Accent, Treasury, selected outline, focus ring (6.1:1 on `wood-700`) |
| `gold-700` | `#c98a1b` | Gold shading, pressed accent |
| `danger-700` | `#b83a2e` | Error text, Bar the Gates (4.6:1 on paper) |
| `danger-400` | `#e86a4f` | HP-low fill, danger on night |
| `warn-500` | `#f0c419` | HP-mid fill, warnings (always with ink text) |
| `berry-500` | `#8e4a8a` | Rare/legendary accent (sparingly) |

Rules: max ~6 of these on any one panel. Text sits only on `paper`, `paper-200`, `dialog`, `gold-500`
(ink text 9.7:1) or `wood-700` (paper text 8.3:1). Never white text on mid wood except bold labels (5.9:1).

### Night / dark variant ("lamp-lit hall", not "dark mode")
Keep frames wooden and warm; swap the fills, not the identity.
- `paper` -> `#2a2438` (night parchment, plum-navy), `paper-200` -> `#211c2e`, `ink` -> `#f3e3bf`
  (11.8:1), `dialog` -> `#1f2433`, `dialog-text` -> `#e8e4d8`, `dialog-shadow` -> `#0e1018`.
- Wood ramp darkens one step (`wood-500` -> `#6e4628`); gold stays (it's the lamplight).
- Success/danger use the light ends (`grass-300`, `danger-400` at 4.7:1).
- The Phaser hall gets a Stardew-style time tint: multiply overlay `#1d2a55` at ~35% at night,
  `#ffb36b` at ~12% at dusk, with lit windows/lanterns drawn on an additive layer. Menus are NOT tinted.
- Drive from `prefers-color-scheme` plus a manual toggle (`data-theme`); optionally follow the guild's
  real local time like Stardew's clock.

---

## 3. Fonts (all OFL / CC0)

| Font | License / URL | Role | Notes |
|---|---|---|---|
| **Pixelify Sans** (variable 400-700) | OFL, https://fonts.google.com/specimen/Pixelify+Sans | **Body + UI default** | Most legible mixed-case pixel font on GF; has weights; good Latin coverage. |
| **Jersey 10** | OFL, https://fonts.google.com/specimen/Jersey+10 (*verify before use*) | **Headings / titles** | Condensed, sporty pixel display; reads "game title". Use 32 px+. |
| **Silkscreen** (400/700) | OFL, https://fonts.google.com/specimen/Silkscreen | Labels, tabs, badges, numbers | All-caps 5 px design by Jason Kottke; crisp at 8 px multiples (16/24). Caps only = labels only. |
| **Tiny5** | OFL, https://fonts.google.com/specimen/Tiny5 | Dense meta (timestamps, counts) | 5 px variable-width; only at 16 px+ and never paragraphs. |
| **DotGothic16** | OFL, https://fonts.google.com/specimen/DotGothic16 | Japanese/CJK fallback | Keeps the pixel feel for non-Latin names. |
| **VT323** | OFL, https://fonts.google.com/specimen/VT323 | Run logs / code / raw event view | Terminal look; tall, legible monospaced. |
| **monogram** | CC0, https://datagoblin.itch.io/monogram | Optional alternative body | 5 px fixed-width, very "handheld"; self-host. |
| Press Start 2P | OFL, https://fonts.google.com/specimen/Press+Start+2P | **Avoid for body** | Wide, all-heavy, tiring; ok only for a logo or one-word banner. |

Decisions:
- Body/UI: **Pixelify Sans 16 px minimum** (use 16/20/24; line-height 1.4-1.5). Never below 16 px for
  anything the Guild Master must read; 14 px only for decorative captions with a non-pixel fallback.
- Headings: **Jersey 10** at 32/40/48 px. Labels/buttons: **Silkscreen** 16 px uppercase, letter-spacing 0.
- Long-form prose (Member output, Dossiers, Handoffs over ~3 lines): allow a readable fallback
  (`--font-prose`, e.g. Pixelify Sans at 18 px, or a humanist system font inside a parchment "book"
  frame). Legibility beats theme for content; theme the chrome.
- Self-host via `@fontsource` packages (OFL fonts allow it), `font-display: swap`,
  `-webkit-font-smoothing: none` is NOT reliable cross-browser; size fonts to their pixel grid instead
  (font-size = design px height x integer).
- DS text shadow: `text-shadow: 1px 1px 0 var(--px-dialog-shadow)` at 1x, `2px 2px 0` at 2x scale.

---

## 4. CSS techniques

**Scale model.** Pick a logical pixel `--px: 2px` (desktop 3px on large screens via media query, phone 2px).
Every border, gap, shadow and radius is `calc(var(--px) * n)`. Art assets are drawn at 1x and displayed at
an integer multiple.

```css
:root { --px: 2px; }
@media (min-width: 1600px) { :root { --px: 3px; } }
img.pixel, canvas, .sprite { image-rendering: pixelated; } /* crisp-edges fallback for old Firefox */
```

**9-slice frame from a tiny PNG (preferred for wood frames).** Draw a 24x24 PNG with 8 px corners.

```css
.frame-wood {
  border: calc(var(--px) * 8) solid transparent;           /* border must exist first */
  border-image: url(/ui/frame-wood.png) 8 fill / calc(var(--px) * 8) round;
  image-rendering: pixelated;                                /* applies to border-image too */
}
```
Corner size in the PNG must equal the slice value; border width = slice x integer scale.
Generator: https://leanrada.com/wares/9-slicer/ ; reference: https://developer.mozilla.org/docs/Web/CSS/border-image-slice .
An inline SVG data URI with `shape-rendering="crispEdges"` works the same and is themeable via CSS vars
only if generated at build time.

**Imageless stepped borders (DS dialogue box).** Stack hard box-shadows (the NES.css approach,
https://github.com/nostalgic-css/NES.css , MIT):

```css
.frame-dialog {
  background: var(--px-dialog);
  margin: calc(var(--px) * 2);
  box-shadow:
    0 calc(var(--px) * -2) 0 0 var(--px-dialog-frame),   /* top    */
    0 calc(var(--px) *  2) 0 0 var(--px-dialog-frame),   /* bottom */
    calc(var(--px) * -2) 0 0 0 var(--px-dialog-frame),   /* left   */
    calc(var(--px) *  2) 0 0 0 var(--px-dialog-frame),   /* right  */
    calc(var(--px) * 2) calc(var(--px) * 4) 0 0 var(--px-wood-900); /* hard drop shadow */
}
```
This yields notched (1-step) corners for free. For 2-3 step corners, use `clip-path` with integer px:
`clip-path: polygon(0 6px, 2px 6px, 2px 2px, 6px 2px, 6px 0, calc(100% - 6px) 0, ...)` generated by a
tiny TS helper `steppedCorners(stepPx, steps)` so nobody hand-writes polygons. Note `clip-path` clips
box-shadows; put the drop shadow on a wrapper or use `filter: drop-shadow(4px 4px 0 #3e2716)`
(0 blur keeps it hard).

**No blur, no subpixel.**
- Never `border-radius` on framed elements; never `blur()`, `backdrop-filter`, soft `box-shadow`.
- Transforms only by whole px: `translate(calc(var(--px) * 1))`, never `%` or `scale(1.05)`.
- Position modals with grid/flex centering, not `translate(-50%,-50%)` (half-pixel blur on odd sizes).
- Phaser: `pixelArt: true`, `roundPixels: true`, integer camera zoom. React Flow: snap grid to
  `--px * 8`, edges as `step` type (orthogonal) with 2 logical px stroke, `shape-rendering: crispEdges`.

**Pixel-snapped animation.** Use `steps()`; animate frames, not tweens.
```css
.cursor-arrow { animation: bob 0.6s steps(2, jump-none) infinite; }      /* ▶ and ▼ bob 1 px */
@keyframes bob { to { transform: translateY(calc(var(--px) * 1)); } }
.sprite-walk { animation: walk 0.5s steps(4) infinite; }                 /* sprite sheet x offset */
```

**Button press states.** Raised: hard shadow `0 var(--px*2) 0 wood-900`. `:hover` -> lighten fill one ramp step.
`:active` -> `translateY(calc(var(--px) * 2))` and shadow 0 (button sinks into its shadow). Disabled ->
`paper-400` fill + dotted (checker) pattern overlay, not just lower opacity.

**Focus rings stay pixel.** `:focus-visible { outline: calc(var(--px)*2) solid var(--px-gold-500);
outline-offset: calc(var(--px)*2); }` plus the ▶ cursor appearing on list items. Never remove outlines.
In night theme the ring is still gold (works on both fills).

**Reduced motion.**
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0s !important; animation-iteration-count: 1 !important; }
}
```
And in JS: typewriter renders instantly, toasts appear without slide, walking-sprite loader becomes a static
sprite with "Loading..." text, Phaser day/night tint changes jump instead of fade.

---

## 5. Interaction patterns to borrow

| Pattern | Guildhall use | Spec |
|---|---|---|
| **Dialogue box + typewriter** | Member speech, onboarding, Quest Briefs, Handoffs | Bottom-docked DS box with portrait frame left; ~40 chars/s; click/Enter/Space completes line, again advances; ▼ bobs when more. "Skip" (Esc) shows all. Full text is in the DOM from the start (`aria-live="polite"` announces whole line once), reveal is visual only (CSS `clip`/span opacity). |
| **▶ cursor menus** | Command menus, context menus, side nav | `role="menu"`/`listbox`, roving tabindex, Up/Down wrap, Home/End, Enter select, Esc/Backspace back (B button). ▶ is a CSS `::before` on `[aria-selected=true]`, so it doubles as focus indicator. Mouse hover moves the cursor. |
| **Item-get banners** (not toasts) | Quest done, Seal granted, Renown earned | Top-centre banner sliding in by `steps(4)`, item icon in a slot + "Earned 50 Renown!" with the noun in `gold-500`/`sky-700`; optional 8-bit jingle (off by default, respects a sound toggle). `role="status"`. Danger events use a red-framed variant with `role="alert"`. |
| **Yes/No box** | Every confirm (spend, Bar the Gates, delete) | Small frame stacked on the dialogue box's right; question in the dialogue line; cursor defaults to the **safe** option (NO) for destructive actions; Y/N keys work. |
| **HP-bar meters** | Budget caps, Treasury remaining, rate limits, context usage | Track `wood-900`, label plate "CAP" / "TREASURY", fill green >50%, warn 20-50%, red <20%, PLUS numeric `37/52` and a pattern change at red (diagonal hatch) so colour isn't the only signal. Drains in steps. |
| **Party panel** | Hall roster (Officer, Members) | 2-column slots: portrait, name, rank/level, status meter; selected bobs 1 px; "fainted" = errored/paused, greyed with an icon and text. |
| **Bag with pockets** | Tools/skills/MCP inventory, artifacts | Pocket tabs w/ icons on the left, item list with `x3` counts, description box below, large icon top. |
| **Inventory grid + tooltip** | Tool slots, Seal collections | 64 px slots, Stardew tooltip frame following cursor/focus (also on keyboard focus, `aria-describedby`). |
| **Walking-sprite loader** | Route/data loading | 16x16 Member walking in place 4 frames over a dirt strip + "Travelling..." text. Skeletons become "parchment being unrolled" blocks, not shimmering grey bars. |
| **Empty states with a character line** | Empty Quest Board, empty Archive | Portrait + dialogue box: "The Quest Board is empty. Post a Quest?" with a ▶ action. One line, in-world, helpful. |
| **Two-screen layout** | Desktop: hall (top/left) + control panel (bottom/right) | Top = Phaser hall/presentation; bottom = menus/builders. On phones they stack. |
| **Day/season clock widget** | Header | Wooden sign: guild day, real time, Treasury balance. Seasons could map to billing period. |

---

## 6. Free, commercially usable assets (verify per pack; record in CREDITS.md)

| Asset | License | URL | Use |
|---|---|---|---|
| Kenney **Pixel UI Pack** (750 files) | CC0 | https://kenney.nl/assets/pixel-ui-pack | Panels, buttons, checkboxes as 9-slice bases (recolour to our palette) |
| Kenney **Tiny Town** (130 files, 16x16) | CC0 | https://kenney.nl/assets/tiny-town | Hall tiles, buildings, props |
| Kenney **Tiny Dungeon** | CC0 (*verify before use*) | https://kenney.nl/assets/tiny-dungeon | Member/monster 16x16 sprites matching Tiny Town |
| Kenney **1-Bit Pack** (1000+ tiles) | CC0 | https://kenney.nl/assets/1-bit-pack (*verify URL before use*; mirror https://opengameart.org/content/1-bit-pack) | Monochrome icons tintable via CSS mask, very consistent |
| Kenney **Cursor Pixel Pack** | CC0 | https://opengameart.org/content/cursor-pixel-pack | Pixel mouse cursors / pointers |
| Kenney **UI Pack - Adventure** | CC0 | https://opengameart.org/content/ui-pack-adventure | Parchment/wood panel references (vector, re-pixel it) |
| **Tiny RPG - Mana Soul GUI** (tiopalada) | CC0 | https://opengameart.org/content/tiny-rpg-mana-soul-gui | 6 9-slice frames, animated cursors, HP/MP/EXP bars, portrait + item frames |
| **pixelarticons** (24 px grid, free Base set) | MIT (Pro/paid sets differ, use only the npm package) | https://pixelarticons.com / https://www.npmjs.com/package/pixelarticons | UI icon set (render only at 24/48/72 px); replaces emoji/Lucide |
| **LPC** base assets + Universal Character Generator | CC-BY-SA 3.0 / GPL 3.0 (some also OGA-BY/CC-BY) | https://opengameart.org/content/liberated-pixel-cup-lpc-base-assets-sprites-map-tiles , https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator/ (*verify before use*; per-sprite licences in its CREDITS) | Member portraits/walk cycles. **Share-alike: derivative art must be CC-BY-SA, attribution per CREDITS.TXT.** OK for a web app; keep these files separate. |
| **NES.css** | MIT (code) | https://github.com/nostalgic-css/NES.css | Reference for box-shadow pixel borders; don't adopt wholesale (wrong vibe, Press Start 2P) |
| Fonts above | OFL / CC0 | see section 3 | Self-host with license files |

Prefer CC0 (Kenney, tiopalada) so recolouring needs no tracking. Our own frames (wood 9-slice, DS dialogue)
should be drawn in-house in Aseprite/LibreSprite (~24x24 px each) using the palette above; they are the
identity and should be unique. Itch.io CC0 packs: search https://itch.io/game-assets/assets-cc0/tag-pixel-art
and read each page's license field (many "free" packs, e.g. Sprout Lands, are NOT CC0 and restrict
redistribution or require purchase for commercial use).

**Forbidden:** any Pokémon (Nintendo / Game Freak / Creatures / TPC) or Stardew Valley (ConcernedApe)
sprite, frame, font rip (including FontStruct recreations of the DS fonts), sound, logo, character name,
or trade dress closely copied (e.g. the exact DP frame patterns). No "Pokémon-style" naming in product copy.

---

## 7. Accessibility in pixel UIs

- **Contrast:** body text >= 4.5:1, large/bold >= 3:1, UI boundaries/focus >= 3:1 (WCAG 2.2 1.4.3, 1.4.11).
  Use the pairs measured in section 2; parchment-on-parchment (`paper-400` on `paper`, 1.8:1) is decoration only.
- **Size:** 16 px minimum for readable text; pixel fonts have small x-height, so treat 16 px pixel ~ 13 px
  normal. Respect browser zoom: sizes in `rem` where `1rem = 16px`, and `--px` scales with it
  (`--px: 0.125rem`) so 200% zoom keeps the grid integer.
- **Not colour alone:** meters show numbers + hatching at low; status uses icon + word ("Paused",
  "Failed"); the ▶ cursor marks selection in addition to colour; danger buttons carry a skull/! icon and label.
- **Keyboard:** every menu works with arrows/Enter/Esc; visible gold focus ring everywhere; dialogue
  advances with Enter/Space; no hover-only tooltips (show on focus); skip link to main content.
- **Screen readers:** typewriter text is in the DOM in full; ▶ and ▼ are `aria-hidden`; frames are
  decoration (`border-image`, not `<img>`); sprite loaders have `role="status"` with text.
- **Motion:** honour `prefers-reduced-motion` (section 4); no flashing > 3/s (item-get sparkle stays slow);
  sound off by default with a toggle.
- **Fallback font toggle:** a setting "Readable text" swaps body to a non-pixel font (for dyslexia/low vision)
  while keeping frames.

---

## 8. Anti-patterns ("AI slop") and what to do instead

| Slop | Instead |
|---|---|
| Rounded dark cards (`#0f172a`, `rounded-xl`, 1 px `white/10` border) | Wooden 9-slice frames on parchment; stepped corners; night = lamp-lit plum, still warm |
| Purple/teal/indigo gradients, gradient text | Flat fills from a 24-colour palette; 2-tone dithering or a 1 px highlight band if you need depth |
| Inter / Geist / system sans everywhere | Pixelify Sans body, Jersey 10 headings, Silkscreen labels |
| Glassmorphism, `backdrop-filter: blur`, soft glows, large blurry shadows | Opaque panels, hard 2-4 px offset shadows in `wood-900` |
| Emoji as icons; Lucide line icons | pixelarticons / Kenney 1-bit, rendered at integer sizes |
| Wall-of-cards KPI dashboard | Scenes and objects: hall (Phaser) as home, Quest Board for Quests, Treasury as a chest + HP-style meters, Ledger of Deeds as a parchment book. One focal panel per screen, DS-style top/bottom split |
| Shimmer skeleton loaders, spinners | Walking sprite, unrolling parchment |
| Toasts in the bottom-right corner with an X | Item-get banners with in-world wording |
| `confirm()`/generic modal "Are you sure?" | Yes/No box attached to a dialogue line that names the cost ("Spend 40 from the Treasury?") |
| Smooth eased transitions, scale-on-hover | `steps()` animation, 1-2 px press offsets, ▶ cursor movement |
| Pill badges with pastel backgrounds | Small framed plates (Silkscreen caps) with an icon, like Pokémon type plates |
| Lorem-ish microcopy ("Get started", "No data") | Character lines in the Glossary's voice ("The quest board is empty.") |
| Mixed scales (icons at 20 px, borders at 1 px on 3x art) | One `--px`, everything a multiple of it; lint for raw `px` values in UI CSS |

Sources: https://kenney.nl/assets/pixel-ui-pack , https://kenney.nl/assets/tiny-town ,
https://opengameart.org/content/1-bit-pack , https://opengameart.org/content/tiny-rpg-mana-soul-gui ,
https://opengameart.org/content/liberated-pixel-cup-lpc-base-assets-sprites-map-tiles ,
https://datagoblin.itch.io/monogram , https://fonts.google.com/specimen/Tiny5/about ,
https://fonts.google.com/specimen/Silkscreen/about , https://www.npmjs.com/package/pixelarticons ,
https://github.com/nostalgic-css/NES.css , https://developer.mozilla.org/docs/Web/CSS/border-image-slice ,
https://discourse.32bit.cafe/t/9-patch-border/4370 , https://leanrada.com/wares/9-slicer/ ,
https://blakecrosley.com/blog/pixel-art-interfaces-on-iphone , https://eev.ee/blog/2018/10/09/cheezball-rising-opening-a-dialogue/ ,
https://tcrf.net/Pok%C3%A9mon_Diamond_and_Pearl/Regional_Differences


Unverified (from memory, not opened during research): Kenney Tiny Dungeon and 1-Bit Pack pages on kenney.nl, Jersey 10 specimen, LPC generator URL, and the exact Stardew/DS frame measurements in §1 (from knowledge of the games, no official source).
