import type { ReactNode } from 'react'
import { Badge } from '../Badge'
import type { Overlays } from './graph'
import type { BuilderConfig } from './model'

/** Props of {@link Outline}. */
export interface OutlineProps {
  config: BuilderConfig
  overlays: Overlays
  issues: ReadonlyMap<string, string[]>
  selected?: string | null
  /** When set, each name is a button that selects it; when absent the tree is read-only (a phone). */
  onSelect?: (id: string) => void
}

/**
 * The hierarchy Steward, Halls, Captains, Members as a nested list. On a phone it is the whole
 * read-only view; beside the canvas it is the keyboard route to every node.
 */
export function Outline({ config, overlays, issues, selected, onSelect }: OutlineProps) {
  const name = (id: string, text: string): ReactNode =>
    onSelect ? (
      <button
        type="button"
        className="outline-name"
        aria-pressed={selected === id}
        onClick={() => onSelect(id)}
      >
        {text}
      </button>
    ) : (
      <span>{text}</span>
    )
  const problems = (id: string) =>
    (issues.get(id) ?? []).map((message) => (
      <p key={message} role="alert" className="error-text">
        {message}
      </p>
    ))
  return (
    <ul aria-label="Guild hierarchy" className="outline">
      <li data-node-id={config.steward.id}>
        <strong>{config.steward.name}</strong> <span className="muted">Steward</span>
        <ul aria-label="Halls">
          {config.halls.map((hall) => (
            <li key={hall.id} data-node-id={hall.id}>
              {name(hall.id, hall.name)} {hall.locked && <Badge tone="neutral">Locked</Badge>}{' '}
              {overlays.pausedHalls.has(hall.id) && <Badge tone="warn">Hall paused</Badge>}{' '}
              {overlays.barred && <Badge tone="danger">Gates barred</Badge>}
              {problems(hall.id)}
              <ul aria-label={`${hall.name} staff`}>
                {hall.captain && (
                  <li data-node-id={hall.captain.id}>
                    {name(hall.captain.id, hall.captain.name)}{' '}
                    <span className="muted">Captain</span>
                    {problems(hall.captain.id)}
                  </li>
                )}
                {hall.members.map((member) => (
                  <li key={member.id} data-node-id={member.id}>
                    {name(member.id, member.name)} <span className="muted">{member.rank}</span>
                    {problems(member.id)}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </li>
    </ul>
  )
}
