import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { type DragEvent, useCallback, useEffect, useState } from 'react'
import { Badge } from '../Badge'
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
    <div className="flow-node flow-steward">
      <strong>{data.name}</strong>
      <span className="muted">Steward</span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  )
}

function HallNode({ data, selected }: NodeProps & { data: HallData }) {
  return (
    <div className={`flow-node flow-hall${selected ? ' flow-selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <strong>{data.hall.name}</strong>
      <div className="flow-badges">
        <Badge tone="neutral">{`Members ${capBadge(data.claimed, data.hall)}`}</Badge>
        {data.hall.locked && <Badge tone="neutral">Locked</Badge>}
        {data.paused && <Badge tone="warn">Hall paused</Badge>}
        {data.barred && <Badge tone="danger">Gates barred</Badge>}
      </div>
      <Problems issues={data.issues} />
    </div>
  )
}

function CaptainNode({ data, selected }: NodeProps & { data: CaptainData }) {
  return (
    <div className={`flow-node flow-captain${selected ? ' flow-selected' : ''}`}>
      <strong>{data.name}</strong>
      <span className="muted">Captain</span>
      <Problems issues={data.issues} />
    </div>
  )
}

function MemberNode({ data, selected }: NodeProps & { data: MemberData }) {
  return (
    <div className={`flow-node flow-member${selected ? ' flow-selected' : ''}`}>
      <strong>{data.member.name}</strong>
      <span className="muted">{data.member.rank}</span>
      <Problems issues={data.issues} />
    </div>
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
        fitView
        minZoom={0.3}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
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
