import {
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { type DragEvent, useCallback, useEffect, useState } from 'react'
import type { WorkflowGraph } from '../../../guildd/src/workflows/graph'
import { Badge } from '../Badge'
import { formatDollars } from '../costs'
import type { Place } from './layout'
import type { NodeOverlay } from './overlay'

/** The drag payload type palette pieces carry. */
export const NODE_PIECE = 'application/x-guildhall-workflow-node'

/** What one workflow node shows on the canvas. */
export interface FlowData extends Record<string, unknown> {
  label: string
  type: string
  issues: string[]
  overlay: NodeOverlay | null
}
type FlowNode = Node<FlowData, 'step'>

function StepNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <div className={`flow-node flow-step${selected ? ' flow-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <strong>{data.label}</strong>
      <span className="muted">{data.type}</span>
      {data.overlay && (
        <div className="flow-badges">
          <Badge tone={data.overlay.tone}>{data.overlay.text}</Badge>
          {data.overlay.attempts !== null && (
            <span className="muted">{`${data.overlay.attempts} attempts`}</span>
          )}
          {data.overlay.costMicros !== null && (
            <span className="muted">{formatDollars(data.overlay.costMicros)}</span>
          )}
        </div>
      )}
      {data.issues.map((message) => (
        <p key={message} role="alert" className="error-text node-issue">
          {message}
        </p>
      ))}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

/** The initial fit of the canvas. */
export const FIT_VIEW_OPTIONS = { padding: 0, minZoom: 0.3 }

const nodeTypes = { step: StepNode }

/** Props of {@link Canvas}. */
export interface CanvasProps {
  graph: WorkflowGraph
  places: ReadonlyMap<string, Place>
  issues: ReadonlyMap<string, string[]>
  overlay: ReadonlyMap<string, NodeOverlay>
  selected: string | null
  /** True on a phone: nothing can be dragged, dropped or connected. */
  readOnly: boolean
  onSelect: (id: string | null) => void
  onConnect: (from: string, to: string) => void
  onMove: (id: string, place: Place) => void
  /** A palette piece of the given node type was dropped at a canvas position. */
  onDropType: (type: string, place: Place) => void
}

function build(props: Pick<CanvasProps, 'graph' | 'places' | 'issues' | 'overlay' | 'selected'>): {
  nodes: FlowNode[]
  edges: Edge[]
} {
  const nodes = props.graph.nodes.map(
    (n): FlowNode => ({
      id: n.id,
      type: 'step',
      position: props.places.get(n.id) ?? { x: 0, y: 0 },
      selected: n.id === props.selected,
      data: {
        label: n.name ?? n.id,
        type: n.type,
        issues: props.issues.get(n.id) ?? [],
        overlay: props.overlay.get(n.id) ?? null,
      },
    })
  )
  const edges = props.graph.edges.map(
    (e): Edge => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to })
  )
  return { nodes, edges }
}

function Flow(props: CanvasProps) {
  const { screenToFlowPosition } = useReactFlow<FlowNode>()
  const [nodes, setNodes] = useState<FlowNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const { graph, places, issues, overlay, selected } = props
  useEffect(() => {
    const built = build({ graph, places, issues, overlay, selected })
    setNodes(built.nodes)
    setEdges(built.edges)
  }, [graph, places, issues, overlay, selected])

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => setNodes((current) => applyNodeChanges(changes, current)),
    []
  )
  const onConnect = (connection: Connection) => {
    if (connection.source && connection.target) {
      props.onConnect(connection.source, connection.target)
    }
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const type = event.dataTransfer.getData(NODE_PIECE)
    if (type) {
      const at = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      // Centre the new node on the cursor (a node is about 11rem by 4.5rem).
      props.onDropType(type, { x: at.x - 88, y: at.y - 36 })
    }
  }

  return (
    <div className="builder-canvas workflow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onNodeClick={(_event, node) => props.onSelect(node.id)}
        onPaneClick={() => props.onSelect(null)}
        onNodeDragStop={(_event, node) => props.onMove(node.id, node.position)}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={onDrop}
        nodesDraggable={!props.readOnly}
        nodesConnectable={!props.readOnly}
        deleteKeyCode={null}
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

/** The React Flow canvas of a workflow graph: nodes laid out left to right, with overlays. */
export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  )
}
