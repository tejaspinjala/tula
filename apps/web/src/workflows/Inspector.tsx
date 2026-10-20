import { useState } from 'react'
import { QUEST_TEMPLATES } from '../../../guildd/src/quests'
import type { WorkflowGraph } from '../../../guildd/src/workflows/graph'
import { connect, disconnect, type FieldSpec, fieldsFor, removeNode, setField } from './model'

/** Props of {@link Inspector}. */
export interface InspectorProps {
  graph: WorkflowGraph
  selected: string | null
  /** The Halls of the guild, for the Hall picker. */
  halls: { id: string; name: string }[]
  onChange: (next: WorkflowGraph) => void
  onSelect: (id: string | null) => void
}

const LABELS: Record<string, string> = {
  name: 'Name',
  hallId: 'Hall',
  templateId: 'Quest template',
  briefTemplate: 'Brief',
  doneCondition: 'Done condition',
  maxUsd: 'Budget in dollars (advisory)',
  scheduleId: 'Schedule id',
  of: 'Judges the output of',
}

function DeleteWithConfirm({ what, onConfirm }: { what: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <button type="button" className="btn-danger" onClick={() => setAsking(true)}>
        Delete node
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

function Field(props: {
  spec: FieldSpec
  value: string | number | undefined
  graph: WorkflowGraph
  nodeId: string
  halls: InspectorProps['halls']
  onSet: (key: string, value: string | number | undefined) => void
  onTemplate: (templateId: string) => void
}) {
  const { spec, value, onSet } = props
  const label = LABELS[spec.key] ?? spec.key
  const text = value === undefined ? '' : String(value)
  if (spec.key === 'hallId') {
    const ids = new Set(props.halls.map((h) => h.id))
    return (
      <label>
        {label}
        <select aria-label={label} value={text} onChange={(e) => onSet(spec.key, e.target.value)}>
          {!ids.has(text) && <option value={text}>{text || 'Choose a Hall'}</option>}
          {props.halls.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </label>
    )
  }
  if (spec.key === 'templateId') {
    return (
      <label>
        {label}
        <select aria-label={label} value={text} onChange={(e) => props.onTemplate(e.target.value)}>
          {!QUEST_TEMPLATES.some((t) => t.id === text) && (
            <option value={text}>{text || 'Choose a template'}</option>
          )}
          {QUEST_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
    )
  }
  if (spec.key === 'of') {
    const others = props.graph.nodes.filter((n) => n.id !== props.nodeId)
    return (
      <label>
        {label}
        <select aria-label={label} value={text} onChange={(e) => onSet(spec.key, e.target.value)}>
          {!others.some((n) => n.id === text) && (
            <option value={text}>{text || 'Choose a node'}</option>
          )}
          {others.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name ?? n.id}
            </option>
          ))}
        </select>
      </label>
    )
  }
  if (spec.kind === 'number') {
    return (
      <label>
        {label}
        <input
          type="number"
          min={0}
          step="any"
          value={text}
          onChange={(e) => onSet(spec.key, e.target.value === '' ? 0 : Number(e.target.value))}
        />
      </label>
    )
  }
  if (spec.key === 'briefTemplate' || spec.key === 'doneCondition') {
    return (
      <label>
        {label}
        <textarea rows={3} value={text} onChange={(e) => onSet(spec.key, e.target.value)} />
      </label>
    )
  }
  return (
    <label>
      {label}
      <input
        value={text}
        onChange={(e) =>
          onSet(spec.key, spec.optional && e.target.value === '' ? undefined : e.target.value)
        }
      />
    </label>
  )
}

/**
 * The inspector of one node: pickers for Hall, Quest template, brief and done-condition, generated
 * from the shared schema's fields, plus "Runs after" checkboxes (the keyboard way to connect).
 */
export function Inspector({ graph, selected, halls, onChange, onSelect }: InspectorProps) {
  const node = graph.nodes.find((n) => n.id === selected)
  if (!node) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <p className="muted">Select a node to edit it.</p>
      </aside>
    )
  }
  const values: Record<string, unknown> = { ...node }
  const read = (key: string) => {
    const v = values[key]
    return typeof v === 'string' || typeof v === 'number' ? v : undefined
  }
  const incoming = new Set(graph.edges.filter((e) => e.to === node.id).map((e) => e.from))
  return (
    <aside className="inspector" aria-label="Inspector">
      <h3 className="sub-title">{`${node.name ?? node.id} (${node.type})`}</h3>
      {fieldsFor(node.type).map((spec) => (
        <Field
          key={spec.key}
          spec={spec}
          value={read(spec.key)}
          graph={graph}
          nodeId={node.id}
          halls={halls}
          onSet={(key, value) => onChange(setField(graph, node.id, key, value))}
          onTemplate={(templateId) => {
            const template = QUEST_TEMPLATES.find((t) => t.id === templateId)
            const next = setField(graph, node.id, 'templateId', templateId)
            onChange(template ? setField(next, node.id, 'hallId', template.hallId) : next)
          }}
        />
      ))}
      {node.type !== 'trigger.manual' && node.type !== 'trigger.schedule' && (
        <fieldset>
          <legend>Runs after</legend>
          {graph.nodes
            .filter((n) => n.id !== node.id)
            .map((n) => (
              <label key={n.id}>
                <input
                  type="checkbox"
                  checked={incoming.has(n.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? connect(graph, n.id, node.id)
                        : disconnect(graph, n.id, node.id)
                    )
                  }
                />{' '}
                {n.name ?? n.id}
              </label>
            ))}
        </fieldset>
      )}
      <DeleteWithConfirm
        what={node.id}
        onConfirm={() => {
          onChange(removeNode(graph, node.id))
          onSelect(null)
        }}
      />
    </aside>
  )
}
