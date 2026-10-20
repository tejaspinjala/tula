import { useState } from 'react'
import { LookPicker, LookPreview } from '../game/LookPicker'
import { choiceFor } from '../game/look'
import {
  addMember,
  type BuilderConfig,
  type BuilderHall,
  type BuilderMember,
  deleteHall,
  deleteMember,
  moveMember,
  rename,
  setCaptain,
  setHallSettings,
  setLook,
  setRank,
} from './model'

const RANKS: BuilderMember['rank'][] = ['apprentice', 'journeyman', 'adept']

/** Props of {@link Inspector}. */
export interface InspectorProps {
  config: BuilderConfig
  selected: string | null
  onChange: (next: BuilderConfig) => void
  onSelect: (id: string | null) => void
}

function DeleteWithConfirm({ what, onConfirm }: { what: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <button type="button" className="btn-danger" onClick={() => setAsking(true)}>
        Delete
      </button>
    )
  }
  return (
    <fieldset className="actions confirm-delete">
      <legend className="sr-only">{`Confirm deleting ${what}`}</legend>
      <button type="button" className="btn-danger" onClick={onConfirm}>
        Confirm delete
      </button>
      <button type="button" onClick={() => setAsking(false)}>
        Keep
      </button>
    </fieldset>
  )
}

function HallEditor({ hall, config, onChange, onSelect }: InspectorProps & { hall: BuilderHall }) {
  return (
    <>
      <label>
        Hall name
        <input
          value={hall.name}
          onChange={(e) => onChange(rename(config, hall.id, e.target.value))}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={hall.locked}
          onChange={(e) => onChange(setHallSettings(config, hall.id, { locked: e.target.checked }))}
        />{' '}
        Locked (accepts no Quests)
      </label>
      <label>
        <input
          type="checkbox"
          checked={hall.privateEligible}
          onChange={(e) =>
            onChange(setHallSettings(config, hall.id, { privateEligible: e.target.checked }))
          }
        />{' '}
        Private routing eligible
      </label>
      <label>
        Captain name
        <input
          value={hall.captain?.name ?? ''}
          placeholder="No Captain"
          onChange={(e) => onChange(setCaptain(config, hall.id, e.target.value || null))}
        />
      </label>
      <div className="actions">
        <button type="button" onClick={() => onChange(addMember(config, hall.id))}>
          Add Member
        </button>
        <DeleteWithConfirm
          what={hall.name}
          onConfirm={() => {
            onChange(deleteHall(config, hall.id))
            onSelect(null)
          }}
        />
      </div>
      <section aria-labelledby="caps-heading" className="inspector-caps">
        <h3 id="caps-heading" className="sub-title">
          Caps
        </h3>
        <p className="muted">No per-Hall caps can be set yet.</p>
      </section>
    </>
  )
}

function MemberEditor({
  member,
  hallId,
  config,
  onChange,
  onSelect,
}: InspectorProps & { member: BuilderMember; hallId: string }) {
  const hall = config.halls.find((h) => h.id === hallId)
  const siblings = hall?.members ?? []
  const at = siblings.findIndex((m) => m.id === member.id)
  const neighbour = siblings[at + 2]
  const look = member.look ?? choiceFor(member.id)
  return (
    <>
      <label>
        Member name
        <input
          value={member.name}
          onChange={(e) => onChange(rename(config, member.id, e.target.value))}
        />
      </label>
      <label>
        Rank
        <select
          aria-label="Rank"
          value={member.rank}
          onChange={(e) => {
            const rank = RANKS.find((r) => r === e.target.value)
            if (rank) {
              onChange(setRank(config, member.id, rank))
            }
          }}
        >
          {RANKS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="look-editor">
        <legend>Look</legend>
        <LookPreview look={look} label={`${member.name}'s look`} />
        <LookPicker look={look} onChange={(next) => onChange(setLook(config, member.id, next))} />
        {member.look && (
          <button type="button" onClick={() => onChange(setLook(config, member.id, null))}>
            Reset look
          </button>
        )}
      </fieldset>
      <label>
        Move to Hall
        <select
          aria-label="Move to Hall"
          value={hallId}
          onChange={(e) => onChange(moveMember(config, member.id, { hallId: e.target.value }))}
        >
          {config.halls.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </label>
      <div className="actions">
        <button
          type="button"
          disabled={at <= 0}
          onClick={() => {
            const before = siblings[at - 1]
            if (before) {
              onChange(moveMember(config, member.id, { hallId, before: before.id }))
            }
          }}
        >
          Move up
        </button>
        <button
          type="button"
          disabled={at < 0 || at >= siblings.length - 1}
          onClick={() =>
            onChange(
              moveMember(
                config,
                member.id,
                neighbour ? { hallId, before: neighbour.id } : { hallId }
              )
            )
          }
        >
          Move down
        </button>
        <DeleteWithConfirm
          what={member.name}
          onConfirm={() => {
            onChange(deleteMember(config, member.id))
            onSelect(null)
          }}
        />
      </div>
    </>
  )
}

/** The side inspector: edits the selected Hall, Captain or Member. */
export function Inspector(props: InspectorProps) {
  const { config, selected } = props
  const hall = config.halls.find((h) => h.id === selected)
  const holder = config.halls.find(
    (h) => h.captain?.id === selected || h.members.some((m) => m.id === selected)
  )
  const member = holder?.members.find((m) => m.id === selected)
  const captain = holder?.captain?.id === selected ? holder.captain : null
  return (
    <section aria-labelledby="inspector-heading" className="card inspector">
      <h2 id="inspector-heading" className="card-title">
        Inspector
      </h2>
      {hall && <HallEditor key={hall.id} {...props} hall={hall} />}
      {holder && member && (
        <MemberEditor key={member.id} {...props} member={member} hallId={holder.id} />
      )}
      {captain && (
        <label>
          Captain name
          <input
            value={captain.name}
            onChange={(e) => props.onChange(rename(config, captain.id, e.target.value))}
          />
        </label>
      )}
      {!hall && !member && !captain && (
        <p className="muted">Select a Hall, Captain or Member to edit it.</p>
      )}
    </section>
  )
}
