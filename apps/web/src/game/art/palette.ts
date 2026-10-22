/**
 * The locked palette of the three-quarter art: one character per colour, each naming a `--px-*` token in
 * `tokens.css`. No hex lives here, so the art cannot drift from the UI palette. `.` is transparent and
 * `x` is the hard-edged character shadow (the ink token at {@link SHADOW_ALPHA}).
 */
export const PALETTE: Readonly<Record<string, string>> = {
  k: 'ink',
  '1': 'wood-900',
  '2': 'wood-700',
  '3': 'wood-500',
  '4': 'wood-300',
  '5': 'wood-100',
  p: 'paper',
  q: 'paper-200',
  r: 'paper-400',
  w: 'dialog',
  f: 'dialog-frame',
  g: 'grass-700',
  h: 'grass-500',
  i: 'grass-300',
  b: 'sky-700',
  c: 'sky-300',
  E: 'sky-500',
  y: 'gold-500',
  o: 'gold-700',
  d: 'danger-700',
  e: 'danger-400',
  u: 'warn-500',
  v: 'berry-500',
  s: 'stone-700',
  t: 'stone-500',
  a: 'stone-300',
  z: 'stone-100',
  m: 'plum-700',
  n: 'plum-500',
  A: 'sage-500',
  B: 'sage-300',
  C: 'linen-500',
  D: 'linen-300',
  x: 'ink',
}

/** The alpha of the `x` shadow character (0 to 255). */
export const SHADOW_ALPHA = 96
