import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { type DragEvent, useCallback, useEffect, useState } from 'react'
import { Badge } from '../Badge'
import { Frame, Meter } from '../ui/pixel'
import { capBadge } from './caps'
import {
  type BuilderNode,
  buildGraph,
  type CaptainData,
  type HallData,
  type MemberData,
  type Overlays,
  type StewardData,
} from './graph'
import type { BuilderConfig } from './model'
import { useBoardFit } from './useBoardFit'

import './blueprint.css'

/** The pixel grid the blueprint snaps to: 8 logical pixels (`--px` is 2 CSS pixels). */
/** The initial fit of the guild board: readable at the least, panned beyond that. */
const BOARD_FIT = { padding: 0.1, minZoom: 0.6 }

export const SNAP_GRID: [number, number] = [16, 16]

/** The drag payload type palette pieces carry. */
export const PIECE_TYPE = 'application/x-guildhall-piece'

function Problems({ issues }: { issues: string[] }) {
  return (
    <>
      {issues.map((message) => (
        <p key={message} role="alert" className="error-text node-issue">
          {message}
        </p>
      ))}
    </>
  )
}

function StewardNode({ data }: NodeProps & { data: StewardData }) {
  return (
    <Frame variant="paper" className="flow-node flow-steward">
      <span className="flow-plate">Steward</span>
      <strong>{data.name}</strong>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </Frame>
  )
}

function HallNode({ data, selected }: NodeProps & { data: HallData }) {
  return (
    <Frame variant="paper" className={`flow-node flow-hall${selected ? ' flow-selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="flow-plate">{selected ? '\u25B6 Hall' : 'Hall'}</span>
      <strong>{data.hall.name}</strong>
      {data.hall.maxConcurrentMembers !== undefined && (
        <Meter label="Members" value={data.claimed} max={data.hall.maxConcurrentMembers} />
      )}
      <div className="flow-badges">
        {data.hall.maxConcurrentMembers === undefined && (
          <Badge tone="neutral">{`Members ${capBadge(data.claimed, data.hall)}`}</Badge>
        )}
        {data.hall.locked && <Badge tone="neutral">Locked</Badge>}
        {data.paused && <Badge tone="warn">Hall paused</Badge>}
        {data.barred && <Badge tone="danger">Gates barred</Badge>}
      </div>
      <Problems issues={data.issues} />
    </Frame>
  )
}

function CaptainNode({ data, selected }: NodeProps & { data: CaptainData }) {
  return (
    <Frame variant="paper" className={`flow-node flow-captain${selected ? ' flow-selected' : ''}`}>
      <span className="flow-plate">{selected ? '\u25B6 Captain' : 'Captain'}</span>
      <strong>{data.name}</strong>
      <Problems issues={data.issues} />
    </Frame>
  )
}

function MemberNode({ data, selected }: NodeProps & { data: MemberData }) {
  return (
    <Frame variant="paper" className={`flow-node flow-member${selected ? ' flow-selected' : ''}`}>
      <span className="flow-plate">
        {selected ? `\u25B6 ${data.member.rank}` : data.member.rank}
      </span>
      <strong>{data.member.name}</strong>
      <Problems issues={data.issues} />
    </Frame>
  )
}

const nodeTypes = {
  steward: StewardNode,
  hall: HallNode,
  captain: CaptainNode,
  member: MemberNode,
}

/** Props of {@link Canvas}. */
export interface CanvasProps {
  config: BuilderConfig
  overlays: Overlays
  issues: ReadonlyMap<string, string[]>
  selected: string | null
  onSelect: (id: string | null) => void
  onMove: (memberId: string, to: { hallId: string; before?: string }) => void
  /** A palette piece (`hall`, `member` or `template:<id>`) was dropped; `hallId` is the Hall under the drop, if any. */
  onDropPiece: (piece: string, hallId: string | null) => void
}

function Flow({ config, overlays, issues, selected, onSelect, onMove, onDropPiece }: CanvasProps) {
  const { getIntersectingNodes, screenToFlowPosition } = useReactFlow<BuilderNode>()
  const [nodes, setNodes] = useState<BuilderNode[]>([])
  const [edges, setEdges] = useState(() => buildGraph(config, overlays, issues).edges)

  // The layout is derived from the config; every edit (or a drop that changed nothing) snaps back to it.
  const relayout = useCallback(() => {
    const graph = buildGraph(config, overlays, issues)
    setNodes(graph.nodes.map((n) => ({ ...n, selected: n.id === selected })))
    setEdges(graph.edges)
  }, [config, overlays, issues, selected])
  useEffect(relayout, [relayout])

  // A Hall, Captain or Member that was just added may sit outside the view: bring everything in.
  const overflowRight = useBoardFit(BOARD_FIT, nodes.length)

  const onNodesChange = useCallback(
    (changes: NodeChange<BuilderNode>[]) =>
      setNodes((current) => applyNodeChanges(changes, current)),
    []
  )

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const piece = event.dataTransfer.getData(PIECE_TYPE)
    if (!piece) {
      return
    }
    const at = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const hall = nodes.find(
      (n) =>
        n.type === 'hall' &&
        at.x >= n.position.x &&
        at.x <= n.position.x + (n.width ?? 0) &&
        at.y >= n.position.y &&
        at.y <= n.position.y + (n.height ?? 0)
    )
    onDropPiece(piece, hall?.id ?? null)
  }

  return (
    <div className="builder-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_event, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
        onNodeDragStop={(_event, node) => {
          if (node.type === 'member') {
            const hit = getIntersectingNodes(node)
            const onMember = hit.find((n) => n.type === 'member')
            const hall = hit.find((n) => n.type === 'hall')
            if (onMember && onMember.data.kind === 'member') {
              onMove(node.id, { hallId: onMember.data.hallId, before: onMember.id })
            } else if (hall) {
              onMove(node.id, { hallId: hall.id })
            }
          }
          relayout()
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={onDrop}
        nodesConnectable={false}
        elementsSelectable
        elevateNodesOnSelect={false}
        snapToGrid
        snapGrid={SNAP_GRID}
        defaultEdgeOptions={{ type: 'step' }}
        minZoom={0.3}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={SNAP_GRID[0]} size={2} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable ariaLabel="Map of the guild" />
      </ReactFlow>
      {overflowRight && (
        <p className="board-cue" role="note">
          More Halls this way. Drag to pan. <span aria-hidden="true">{'\u25B6'}</span>
        </p>
      )}
    </div>
  )
}

/** The React Flow canvas: the Steward, Halls and their staff laid out as a hierarchy, with drag and drop. */
export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  )
}
