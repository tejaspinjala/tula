import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import axe from 'axe-core'
import type { ReactElement } from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { App } from './App'
import { ArchivePanel } from './ArchivePanel'
import { ArtifactViewer } from './ArtifactViewer'
import { CostTablePanel } from './CostTablePanel'
import { FoundGuildPanel } from './FoundGuildPanel'
import { GatesPanel } from './GatesPanel'
import { LearningPanel } from './LearningPanel'
import { PasskeyPanel } from './PasskeyPanel'
import { ProposalPanel } from './ProposalPanel'
import { webAuthnBrowser } from './passkeys'
import { QuestBoardPanel } from './QuestBoardPanel'
import { RosterPanel } from './RosterPanel'
import { VIEWS } from './router'
import { SealPanel } from './SealPanel'
import { Shell } from './Shell'
import { SummonPanel } from './SummonPanel'
import { TimelinePanel } from './TimelinePanel'
import { TreasuryPanel } from './TreasuryPanel'
import { TripwirePanel } from './TripwirePanel'
import { VaultPanel } from './VaultPanel'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch
const at = (time: string) => `2026-03-01T${time}.000Z`
const history = {
  events: [
    { seq: 1, type: 'guild.founded', payload: {}, occurredAt: at('08:00:00') },
    {
      seq: 2,
      type: 'quest.posted',
      payload: { questId: 'q1', hallId: 'h1' },
      occurredAt: at('09:00:00'),
    },
    {
      seq: 3,
      type: 'quest.done',
      payload: { questId: 'q1', hallId: 'h1' },
      occurredAt: at('10:00:00'),
    },
    {
      seq: 4,
      type: 'note.added',
      payload: { noteId: 'n1', version: 1, kind: 'lesson' },
      occurredAt: at('11:00:00'),
    },
  ],
  next: null,
}

const suggestion = {
  id: 's1',
  sourceId: 'src1',
  repo: 'acme/app',
  kind: 'pr',
  title: 'Cache the roster',
  body: 'Merged pull request',
  url: 'https://github.com/acme/app/pull/1',
  status: 'pending',
  noteId: null,
}

// react-dom reads the DOM's capabilities when it loads, so the DOM is registered first.
GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/events/history')) {
        return Response.json(history)
      }
      if (url.endsWith('/gates')) {
        return Response.json({ guild: true, global: false })
      }
      if (url.includes('/learning/suggestions')) {
        return Response.json({ suggestions: [suggestion], next: null })
      }
      return Response.json({ error: 'down' }, { status: 503 })
    },
    { preconnect: realFetch.preconnect }
  )
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

async function mount(ui: ReactElement): Promise<{ root: Root; host: HTMLElement }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(ui)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return { root, host }
}

async function unmount(m: { root: Root; host: HTMLElement }): Promise<void> {
  await act(async () => m.root.unmount())
  m.host.remove()
}

async function violations(host: HTMLElement): Promise<string[]> {
  const result = await axe.run(host, {
    resultTypes: ['violations'],
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
}

const panels: Array<[string, ReactElement]> = [
  [
    'Found your guild',
    <FoundGuildPanel key="f" fetcher={fetch} browser={webAuthnBrowser} onSession={() => {}} />,
  ],
  ['Passkey', <PasskeyPanel key="p" session={null} onSession={() => {}} />],
  ['Artifact', <ArtifactViewer key="a" session={session} />],
  ['Vault', <VaultPanel key="v" session={session} />],
  ['Roster', <RosterPanel key="r" session={session} />],
  ['Archive', <ArchivePanel key="ar" session={session} />],
  ['Proposals', <ProposalPanel key="pr" session={session} />],
  ['Seals', <SealPanel key="s" session={session} />],
  ['Tripwires', <TripwirePanel key="t" session={session} />],
  ['Treasury', <TreasuryPanel key="tr" session={session} />],
  ['Quest Board', <QuestBoardPanel key="q" session={session} />],
  ['Costs', <CostTablePanel key="c" session={session} />],
  ['Timeline', <TimelinePanel key="tl" session={session} />],
  ['Gates', <GatesPanel key="g" session={session} />],
  ['Summon', <SummonPanel key="su" session={session} />],
  ['Learning', <LearningPanel key="l" session={session} />],
]

describe('axe: no serious or critical violations', () => {
  test.each(panels)('%s panel', async (_name, ui) => {
    const m = await mount(ui)
    expect(await violations(m.host)).toEqual([])
    await unmount(m)
  })

  test.each(VIEWS.map((v) => [v.label, v.path] as const))(
    'the signed-in %s view',
    async (_label, path) => {
      window.history.pushState({}, '', path)
      const m = await mount(
        <Shell session={session} guildName="Ember Guild" status="ok" onSession={() => {}} />
      )
      expect(m.host.querySelectorAll('h1').length).toBe(1)
      expect(await violations(m.host)).toEqual([])
      await unmount(m)
      window.history.pushState({}, '', '/')
    }
  )

  test('the signed-out ledger shell', async () => {
    const m = await mount(<App />)
    expect(await violations(m.host)).toEqual([])
    await unmount(m)
  })
})

describe('keyboard', () => {
  test('every interactive element is focusable and none is taken out of the tab order', async () => {
    const m = await mount(
      <>
        {panels.map(([, ui]) => ui)}
        <App />
      </>
    )
    const controls = m.host.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [tabindex]'
    )
    expect(controls.length).toBeGreaterThan(5)
    for (const el of controls) {
      if (el.hasAttribute('disabled') || el.getAttribute('tabindex') === '-1') {
        // The only deliberate -1 is the programmatic focus target of the skip link.
        expect(el.id === 'main' || el.hasAttribute('disabled')).toBe(true)
        continue
      }
      el.focus()
      expect(document.activeElement).toBe(el)
    }
    await unmount(m)
  })
})

describe('reduced motion', () => {
  test('the stylesheet disables animation and transition under prefers-reduced-motion', async () => {
    const css = await Bun.file(new URL('./index.css', import.meta.url)).text()
    const block = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}/)?.[1] ?? ''
    expect(block).toContain('animation')
    expect(block).toContain('transition')
    // Beats every class-level rule by specificity, with no !important.
    expect(block).toContain('html:root *')
  })
})

describe('Timeline panel', () => {
  test('scrubbing the slider replays the log and gives screen-reader text for each event', async () => {
    const m = await mount(<TimelinePanel session={session} />)
    const slider = m.host.querySelector<HTMLInputElement>('input[type="range"]')
    expect(slider?.getAttribute('aria-label') ?? m.host.querySelector('label')).toBeTruthy()
    const items = [...m.host.querySelectorAll('ol li')].map((li) => li.textContent)
    expect(items.join('|')).toContain('Quest q1 done')
    expect(m.host.querySelector('[aria-live="polite"]')).not.toBeNull()
    expect(m.host.textContent).toContain('Notes: 1')

    if (!slider) {
      throw new Error('no slider')
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(slider, '2')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      slider.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(m.host.textContent).toContain('Notes: 0')
    expect(m.host.textContent).toContain('queued: 1')
    expect(m.host.textContent).not.toContain('Quest q1 done')
    await unmount(m)
  })
})
