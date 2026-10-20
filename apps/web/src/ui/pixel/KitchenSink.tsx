import { useState } from 'react'
import { CursorMenu } from './CursorMenu'
import { DialogueBox } from './DialogueBox'
import { EmptyState } from './EmptyState'
import { Frame } from './Frame'
import { ItemGet } from './ItemGet'
import { Meter } from './Meter'
import { PixelButton } from './PixelButton'
import { Portrait } from './Portrait'
import { SlotGrid } from './SlotGrid'
import { ThemeControls } from './ThemeControls'
import { Tooltip } from './Tooltip'
import { WalkingLoader } from './WalkingLoader'
import { YesNo } from './YesNo'

/** Whether `pathname` is the dev-only kitchen sink; never true in a production build. */
export function isKitchenSinkPath(pathname: string, dev: boolean): boolean {
  return dev && pathname.replace(/\/+$/, '') === '/kitchen-sink'
}

const MENU = [
  { id: 'board', label: 'Quest Board' },
  { id: 'seals', label: 'Seals' },
  { id: 'treasury', label: 'Treasury' },
  { id: 'hall', label: 'Hall' },
]

const SLOTS = [
  { id: 'quill', label: 'Silver Quill', count: 3 },
  { id: 'seal', label: 'Seal', count: 12 },
  { id: 'key', label: 'Gate Key' },
  { id: 'lamp', label: 'Lamp', count: 2 },
  { id: 'scroll', label: 'Scroll', count: 40 },
  { id: 'map', label: 'Map' },
  { id: 'crown', label: 'Crown', count: 7 },
  { id: 'ink', label: 'Ink' },
]

/**
 * The dev-only kitchen sink: every kit component in one page, for screenshots in both themes.
 * It is mounted only when `import.meta.env.DEV` is true.
 */
export function KitchenSink() {
  const [picked, setPicked] = useState('Nothing yet')
  const [answer, setAnswer] = useState('Unanswered')
  const [talking, setTalking] = useState(true)

  return (
    <div className="px-sink">
      <header className="px-sink-head">
        <h1>Guildhall kit</h1>
        <ThemeControls />
      </header>

      <main className="px-sink-grid">
        <Frame variant="wood" className="px-sink-wide">
          <h2 className="px-sink-title">Frames</h2>
          <div className="px-sink-row">
            <Frame variant="paper">Paper frame</Frame>
            <Frame variant="dialog">Dialog frame</Frame>
            <Frame variant="slot">Slot</Frame>
          </div>
        </Frame>

        <Frame variant="paper">
          <h2 className="px-sink-title">Buttons</h2>
          <div className="px-sink-row">
            <PixelButton>Post a Quest</PixelButton>
            <PixelButton disabled>Grant the Seal</PixelButton>
            <PixelButton danger>Bar the Gates</PixelButton>
          </div>
        </Frame>

        <Frame variant="paper">
          <h2 className="px-sink-title">Cursor menu</h2>
          <CursorMenu label="Go to" items={MENU} onSelect={(id) => setPicked(id)} />
          <p className="px-sink-note">Chosen: {picked}</p>
        </Frame>

        <Frame variant="paper">
          <h2 className="px-sink-title">Meters</h2>
          <div className="px-sink-col">
            <Meter label="Treasury" value={37} max={52} />
            <Meter label="Cap" value={20} max={52} />
            <Meter label="Context" value={6} max={52} />
          </div>
        </Frame>

        <Frame variant="paper">
          <h2 className="px-sink-title">Banners</h2>
          <div className="px-sink-col">
            <ItemGet verb="Earned 50" noun="Renown" />
            <ItemGet verb="Granted a" noun="Seal" />
            <ItemGet danger verb="Barred the" noun="Gates" />
          </div>
        </Frame>

        <Frame variant="paper">
          <h2 className="px-sink-title">Satchel</h2>
          <SlotGrid label="Satchel" slots={SLOTS} columns={4} onSelect={() => {}} />
          <div className="px-sink-row">
            <Tooltip
              name="Silver Quill"
              category="Tool"
              stats={[
                { label: 'Cost', value: '3 Crowns' },
                { label: 'Uses', value: '12' },
              ]}
            >
              {(trigger) => <PixelButton {...trigger}>Inspect</PixelButton>}
            </Tooltip>
          </div>
        </Frame>

        <Frame variant="paper">
          <h2 className="px-sink-title">Members</h2>
          <div className="px-sink-row">
            <Portrait name="Ana" mood="happy" />
            <Portrait name="Bo" mood="worried" />
            <Portrait name="Cy" state="paused" />
            <Portrait name="Di" state="error" />
          </div>
          <WalkingLoader />
        </Frame>

        <Frame variant="paper" className="px-sink-wide">
          <EmptyState
            member="Ana"
            line="The Quest Board is empty."
            actionLabel="Post a Quest?"
            onAction={() => {}}
          />
        </Frame>

        <div className="px-sink-wide px-sink-stage">
          {talking ? (
            <DialogueBox
              speaker="Ana"
              lines={[
                'Welcome back, Guild Master. The Hall is quiet today.',
                'Two Quests wait on the Quest Board, and one Seal needs your word.',
              ]}
              onDone={() => setTalking(false)}
            />
          ) : (
            <PixelButton onClick={() => setTalking(true)}>Talk to Ana again</PixelButton>
          )}
          <YesNo
            question="Spend 40 from the Treasury?"
            safe="no"
            onAnswer={(yes) => setAnswer(yes ? 'Yes' : 'No')}
          />
          <p className="px-sink-note">Answered: {answer}</p>
        </div>
      </main>
    </div>
  )
}
