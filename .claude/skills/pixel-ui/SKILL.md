---
name: pixel-ui
description: Guildhall's cozy pixel game UI language (Stardew Valley frames + Pokémon DS dialogue/menus). Use for ANY change to apps/web UI, the Phaser hall, or the React Flow builders: styling, new components, copy in dialogue boxes, icons, fonts, assets.
---

# Pixel UI

Guildhall should look and play like a cozy handheld RPG, not a dark SaaS dashboard. We copy the feel of
Stardew Valley menus and Pokémon DS screens, never their assets. The research, measured contrast pairs,
asset URLs and CSS recipes are in [reference.md](reference.md). Read only the section you need.

## Principles

1. **One pixel grid.** `--px` is the logical pixel. Every border, gap, padding, shadow offset, radius step
   and press offset is `calc(var(--px) * n)`. Raw `px` values in UI CSS only appear in `tokens.css`.
2. **Scale by whole numbers only.** Show art at 1x, 2x, 3x or 4x, never 1.5x. `image-rendering: pixelated` on every
   sprite, icon, canvas and `border-image`.
3. **Two visual languages.**
   - *Frames* (Stardew): containers are wood-and-parchment 9-slice frames with a dark warm-brown outline,
     hue-shifted bevels and hard drop shadows.
   - *Interaction* (Pokémon DS): talking, choosing and confirming happen in white dialogue boxes, ▶ cursor
     menus, Yes/No prompts, HP-style meters and item-get banners.
4. **Hard edges only.** No `border-radius`, no `blur()`, no `backdrop-filter`, no soft shadows, no gradients.
   Corners are stepped. Transforms move by whole `--px` only, never by `%`, and nothing scales on hover.
5. **Motion goes in frames.** Animate with `steps()`, not easing curves. The ▶ and ▼ bob 1 `--px`.
6. **Content stays readable.** Theme the chrome. Long agent output gets the readable prose font inside a parchment frame.
7. **Use the Glossary words in copy**: Guild Master, Member, Hall, Quest, Seal, Treasury, Missive, Renown,
   Crowns, Bar the Gates. Never its _Avoid_ words (user, task, notification, approval, coins, stop button…).

## Tokens

Paste into `apps/web/src/styles/tokens.css`. Components read only these variables.

```css
:root {
  --px: 0.125rem;                     /* 2px at 100% zoom, scales with rem */
  --font-body: "Pixelify Sans", monospace;
  --font-head: "Jersey 10", "Pixelify Sans", monospace;
  --font-label: "Silkscreen", monospace;
  --font-mono: "VT323", monospace;
  --font-prose: "Pixelify Sans", system-ui, sans-serif;  /* "Readable text" setting swaps to system-ui */
  --text-sm: 1rem; --text-md: 1.25rem; --text-lg: 1.5rem; --head-md: 2rem; --head-lg: 2.5rem;

  --px-ink: #2b1d14;
  --px-wood-900: #3e2716; --px-wood-700: #5a3a22; --px-wood-500: #8a5a32;
  --px-wood-300: #b77a45; --px-wood-100: #d9a066;
  --px-paper: #f6e7c1; --px-paper-200: #ead4a0; --px-paper-400: #c9a96b;
  --px-dialog: #f8f8f4; --px-dialog-text: #484848; --px-dialog-shadow: #c8c8c0; --px-dialog-frame: #4a5a78;
  --px-grass-700: #2f5d34; --px-grass-500: #4f8a3c; --px-grass-300: #9fd06a;
  --px-sky-700: #2f5f94; --px-sky-300: #8ec5e8;
  --px-gold-500: #f2c14e; --px-gold-700: #c98a1b;
  --px-danger-700: #b83a2e; --px-danger-400: #e86a4f;
  --px-warn-500: #f0c419; --px-berry-500: #8e4a8a;
  --px-focus: var(--px-gold-500);
}
@media (min-width: 100rem) { :root { --px: 0.1875rem; } }  /* 3px on very wide screens */

/* Night: "lamp-lit Hall". Same wood and gold, different fills. */
:root[data-theme="night"] {
  --px-paper: #2a2438; --px-paper-200: #211c2e; --px-ink: #f3e3bf;
  --px-dialog: #1f2433; --px-dialog-text: #e8e4d8; --px-dialog-shadow: #0e1018;
  --px-wood-500: #6e4628;
  --px-grass-700: #9fd06a; --px-danger-700: #e86a4f; --px-sky-700: #8ec5e8;
}
/* Default follows prefers-color-scheme: set data-theme on <html> at boot from
   matchMedia unless the Guild Master picked one (keeps one copy of the night values). */
```

`var(--px)*2` below is shorthand for `calc(var(--px) * 2)`.

- Text sits only on `paper`, `paper-200`, `dialog`, `gold-500` (ink) or `wood-700` (paper). `paper-400` is
  decoration only (1.8:1). Use no more than 6 tokens on one panel.
- Fonts are self-hosted through `@fontsource` (OFL, licence file included). Body text is at least 16px. Use Jersey 10 at 32px and up.
  Silkscreen is for UPPERCASE labels only. Never use Press Start 2P for body text.

## Components (in `apps/web/src/ui/pixel/`; pages compose these, never re-style)

- **Frame** `variant: wood | paper | dialog | slot`. The wood frame is a `border-image` 9-slice from our own 24x24 PNG
  (8px slice, `round`, `fill`). Dialog uses stacked hard `box-shadow` borders. The drop shadow is
  `filter: drop-shadow(var(--px)*2 var(--px)*2 0 var(--px-wood-900))`, because `clip-path` would clip a `box-shadow`. Stepped
  corners come from the `steppedCorners(step, n)` helper, never hand-written polygons.
- **DialogueBox**: docked at the bottom, two to three lines, Portrait on the left, DS text shadow
  `1px 1px 0` scaled by `--px`. The typewriter runs at about 40 chars/s. Enter, Space or a click finishes the line; a second press moves to the next line.
  Esc skips everything. ▼ bobs when more lines remain. The full text is in the DOM from the start, and the reveal is visual only.
  `aria-live="polite"` announces each line once. ▶ and ▼ are `aria-hidden`. Members speak here.
- **CursorMenu**: `role="menu"` or `listbox` with a roving tabindex. Up/Down wrap, Home/End jump, Enter selects,
  Esc or Backspace goes back. The ▶ `::before` marks `[aria-selected=true]` and also serves as the focus mark. Hover moves
  the cursor. Rows have no highlight bar.
- **YesNo**: a small frame stacked on the DialogueBox's right edge. The question names the cost
  ("Spend 40 from the Treasury?"). The cursor starts on the **safe** option (NO for destructive actions or Seals).
  Y and N keys work. Never use `window.confirm` or a generic "Are you sure?" modal.
- **Meter** (HP bar): for caps, Treasury remaining, rate limits, context use. A `wood-900` track, a
  Silkscreen label plate, and fill by level: >50% grass, 20-50% warn, <20% danger plus diagonal hatching.
  Always show the number (`37/52`). It drains in steps. `role="meter"` with `aria-valuenow`, `aria-valuemin` and `aria-valuemax`.
- **ItemGet** banner (instead of toasts): drops in at top centre with `steps(4)`. Shows an icon in a Slot and
  "Earned 50 Renown!" or "Seal granted", with the noun in an accent colour. `role="status"`. Danger events get a red frame and
  `role="alert"`. Sound is off by default.
- **PixelButton**: raised with a hard `0 var(--px)*2 0 wood-900` shadow. Hover lightens the fill one ramp step.
  Active moves it `translateY(var(--px)*2)` and removes the shadow. Disabled gets `paper-400` with a checker overlay and stays visible.
  Labels are Silkscreen. A danger button (Bar the Gates) carries an icon and a word, never colour alone.
- **Tooltip**: a small Frame with a bold name, a muted category line, a divider, then stat rows with icons. It opens on
  hover **and** focus (`aria-describedby`) and is clamped to the viewport.
- **SlotGrid**: square 64px slots (16px art at 4x) on recessed `paper-200` with a 1 `--px` dark inner
  top-left edge. The count sits bottom-right with an outline. The selected slot gets a thick gold outline, not a glow.
- **Portrait**: a framed bust of a Member at an integer scale. Its expression can change per line. An error or paused state is
  greyed with an icon and a word.
- **WalkingLoader**: a 16x16 Member walking in place (4 frames) plus "Travelling…" text, `role="status"`.
  Never use shimmer skeletons or spinners.
- **Empty states**: a Portrait and one in-world line ("The Quest Board is empty. Post a Quest?") with a ▶ action.

## Phaser hall and React Flow builders

- Phaser config: `pixelArt: true`, `roundPixels: true`, integer camera zoom, a canvas size that is a multiple of the art.
  Time-of-day tint goes on the world only: multiply `#1d2a55` at about 35% at night and `#ffb36b` at about 12% at dusk. Lanterns go on an
  additive layer. React chrome is never tinted. With reduced motion, the tint changes in one jump instead of fading.
- React Flow: `snapGrid` = 8 `--px`, `step` edges with a 2 `--px` stroke and `shape-rendering: crispEdges`.
  Nodes are `Frame` (paper) with a Silkscreen header plate. Handles are square 4 `--px` pixels. The background is a dot grid
  in `paper-400` with no gradient. The minimap and controls are framed too.
- Desktop layout follows the DS two-screen idea: the scene (Hall or graph) on top or left, menus and inspectors
  below or right. On phones they stack.

## Assets and licensing

- Order of preference: our own art (frames are identity; draw them in Aseprite or LibreSprite with the token palette),
  then CC0 (Kenney Pixel UI Pack, Tiny Town, 1-Bit Pack; tiopalada Mana Soul GUI), then MIT/OFL
  (pixelarticons, fonts). LPC is CC-BY-SA/GPL: use it only with attribution, keep it in its own folder, and keep derivatives under the same licence.
- Every third-party file gets a line in `CREDITS.md`: name, author, licence, URL. Recolour to the tokens.
- Icons: pixelarticons only at 24, 48 or 72px, or Kenney 1-bit used as a CSS mask. **No emoji, no Lucide.**
- **Banned sources:** anything from Pokémon (Nintendo, Game Freak, Creatures, The Pokémon Company) or from Stardew Valley
  (ConcernedApe). That covers sprites, frames, font rips including FontStruct recreations of the DS fonts, sounds, logos,
  names and near-copies of their frame patterns. Never put "Pokémon" or "Stardew" in product copy.
- Itch.io "free" packs are often not CC0. Read the licence field before use. URLs marked
  *verify before use* in reference.md must be checked first.

## Accessibility floor

- Contrast: text 4.5:1 or more (large text 3:1), focus and UI boundaries 3:1 or more, in **both** themes. Use the measured pairs in reference.md §2.
- Text is 16px or larger. Sizes are in `rem` so zooming to 200% keeps the grid whole. Ship a "Readable text" setting
  that swaps `--font-body` and `--font-prose`.
- Never colour alone: meters show numbers and hatching, states show an icon and a word, selection shows the ▶.
- Keyboard: every menu works with the arrow keys, Enter and Esc. Focus is always visible: `outline: calc(var(--px)*2) solid var(--px-focus);
  outline-offset: calc(var(--px)*2)`. Every tooltip also opens on focus. Add a skip link.
- `prefers-reduced-motion`: the typewriter shows text instantly, banners appear without sliding, the loader is static, and nothing loops.
  Nothing flashes more than 3 times a second.

## Banned "AI slop" checklist (reject in review)

- [ ] Rounded dark cards (`rounded-xl`, slate/zinc backgrounds, `white/10` borders)
- [ ] Purple, teal or indigo gradients, gradient text, glows
- [ ] Inter, Geist or system-ui as the chrome font
- [ ] Glassmorphism, `backdrop-filter`, blurred shadows
- [ ] Emoji or thin-line icons
- [ ] A wall of KPI cards. Use a scene instead: the Hall, the Quest Board, a Treasury chest with Meters, the Ledger of Deeds as a book
- [ ] Shimmer skeletons, spinners, bottom-right toasts with an ×
- [ ] Ease-in-out transitions, `scale(1.05)` on hover, `translate(-50%,-50%)` centring (it blurs half pixels)
- [ ] Pastel pill badges. Use framed Silkscreen plates with an icon
- [ ] Generic copy ("Get started", "No data", "Something went wrong"). Write an in-world line instead
- [ ] Mixed scales or raw `px` outside tokens

## Done checklist

- [ ] Only components from `ui/pixel/` and tokens; no raw colours or `px`
- [ ] Screenshots at 1x and 2x DPR, day and night, plus 200% zoom: no blurry edges or half pixels
- [ ] Keyboard-only pass: reach, operate and leave every new control; the ▶ and focus ring are always visible
- [ ] `prefers-reduced-motion` emulated: no typewriter, slide or loop
- [ ] Contrast checked for every new text/background pair in both themes
- [ ] Glossary words in all copy; no _Avoid_ words
- [ ] New third-party assets recorded in `CREDITS.md` with licence and URL
- [ ] Driven in a real browser against a real backend (see `run-check`)
