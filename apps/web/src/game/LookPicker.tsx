import { CHAR_SHEET_COLUMNS, framesOf, LOOK_CATALOGUE, type LookChoice } from './look'

/** Pixels from one frame to the next on the characters sheet (16 px plus 1 px spacing). */
const STEP = 17
/** How many times the 16 px sprite is enlarged in the preview. */
const SCALE = 4

const layerStyle = (frame: number) => ({
  position: 'absolute' as const,
  inset: 0,
  backgroundImage: 'url(/game/chars.png)',
  backgroundPosition: `${-(frame % CHAR_SHEET_COLUMNS) * STEP}px ${-Math.floor(frame / CHAR_SHEET_COLUMNS) * STEP}px`,
  imageRendering: 'pixelated' as const,
})

/** A live preview of a character: the body, outfit and hair layers stacked, as the hall draws them. */
export function LookPreview({ look, label }: { look: LookChoice; label: string }) {
  const frames = framesOf(look)
  return (
    <div
      role="img"
      aria-label={label}
      data-testid="look-preview"
      style={{ width: 16 * SCALE, height: 16 * SCALE, flex: 'none' }}
    >
      <div
        style={{
          position: 'relative',
          width: 16,
          height: 16,
          transform: `scale(${SCALE})`,
          transformOrigin: '0 0',
        }}
      >
        {[frames.body, frames.outfit, frames.hair].map((frame, layer) => (
          <div key={['body', 'outfit', 'hair'][layer]} style={layerStyle(frame)} />
        ))}
      </div>
    </div>
  )
}

const PARTS: Array<{ key: keyof LookChoice; label: string; noun: string }> = [
  { key: 'body', label: 'Skin tone', noun: 'Tone' },
  { key: 'outfitStyle', label: 'Outfit style', noun: 'Style' },
  { key: 'outfitColor', label: 'Outfit colour', noun: 'Colour' },
  { key: 'hairStyle', label: 'Hair style', noun: 'Style' },
  { key: 'hairColor', label: 'Hair colour', noun: 'Colour' },
]

/** One select per catalogue part. Every choice is an index inside the fixed catalogue. */
export function LookPicker({
  look,
  onChange,
}: {
  look: LookChoice
  onChange: (next: LookChoice) => void
}) {
  return (
    <>
      {PARTS.map(({ key, label, noun }) => (
        <label key={key}>
          {label}
          <select
            aria-label={label}
            value={look[key]}
            onChange={(e) => {
              const index = Number(e.target.value)
              if (Number.isInteger(index) && index >= 0 && index < LOOK_CATALOGUE[key]) {
                onChange({ ...look, [key]: index })
              }
            }}
          >
            {Array.from({ length: LOOK_CATALOGUE[key] }, (_, i) => ({
              value: i,
              text: `${noun} ${i + 1}`,
            })).map((choice) => (
              <option key={choice.text} value={choice.value}>
                {choice.text}
              </option>
            ))}
          </select>
        </label>
      ))}
    </>
  )
}
