import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  NodeToolbar,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeProps,
  type Node,
  type NodeProps
} from '@xyflow/react'
import { ArrowLeft, ArrowRight, Boxes, CircleDot, ClipboardPaste, Copy, EyeOff, FileCode2, GitBranch, Play, Plus, Replace, Scissors, Search, Send, Square, Trash2, TriangleAlert, X } from 'lucide-react'
import { MAPPER_ITEM, categoryOf, paletteEips, samePath, type Category, type PaletteItem, type Path } from '@/model/camel'
import { layoutRoute, type FlowEdgeData, type GroupNodeData, type LabelNodeData, type StepNodeData, type StubNodeData } from '@/model/layout'
import { openMapper, useActiveFile, useStudio } from '@/store'
import { componentIcon, stepIcon } from './icons'
import { DebugBar, SendDialog } from './Runtime'
import { cx, formatCount, formatMs, isPaletteDrag, readDrag, useEntries, useLive, useProblems } from './util'

// ------------------------------------------------------------ drop target --

/** Makes an element accept palette drags; `onItem` receives the dropped palette entry. */
const MOVE_TYPE = 'application/x-camel-studio-move'

function useDropTarget(onItem: (item: PaletteItem) => void, onMove?: (from: Path) => void): {
  over: boolean
  props: { onDragOver(e: DragEvent): void; onDragLeave(): void; onDrop(e: DragEvent): void }
} {
  const [over, setOver] = useState(false)
  return {
    over,
    props: {
      onDragOver(e) {
        if (!isPaletteDrag(e) && !(onMove && e.dataTransfer.types.includes(MOVE_TYPE))) return
        e.preventDefault()
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes(MOVE_TYPE) ? 'move' : 'copy'
        setOver(true)
      },
      onDragLeave() {
        setOver(false)
      },
      onDrop(e) {
        setOver(false)
        const moved = onMove ? e.dataTransfer.getData(MOVE_TYPE) : ''
        if (moved) {
          e.preventDefault()
          e.stopPropagation()
          useStudio.getState().setDragging(false)
          onMove?.(JSON.parse(moved) as Path)
          return
        }
        const item = readDrag(e)
        if (!item) return
        e.preventDefault()
        e.stopPropagation()
        onItem(item)
      }
    }
  }
}

// ------------------------------------------------------------------ nodes --

function StepNode({ data, selected }: NodeProps): React.JSX.Element {
  const d = data as StepNodeData
  const isFrom = d.kind === 'from'
  const Icon = stepIcon(d.kind, d.category, d.scheme, d.componentLabel, d.title)
  const { removeStep, moveStep, duplicateStep, setTrigger, notify, toggleBreakpoint } = useStudio.getState()
  const live = d.live
  const stats = live?.stats
  const drop = useDropTarget((item) => {
    if (!isFrom) return
    if (item.type === 'component') setTrigger(d.path, item.name)
    else notify('A route starts from a component. Drop a component here to change the trigger.', 'info')
  })

  return (
    <div
      className={cx('step', `cat-${d.category}`, selected && 'is-selected', isFrom && 'is-from', d.disabled && 'is-disabled', drop.over && isFrom && 'is-drop', d.offPath && 'is-off-path', live?.order !== undefined && 'is-on-path', live?.visitFailed && 'is-failed', live?.paused && 'is-paused')}
      {...(isFrom ? drop.props : {})}
      draggable={!isFrom}
      onDragStart={(e) => {
        if (isFrom) return
        e.dataTransfer.setData(MOVE_TYPE, JSON.stringify(d.path))
        e.dataTransfer.effectAllowed = 'move'
        useStudio.getState().setDragging(true)
      }}
      onDragEnd={() => useStudio.getState().setDragging(false)}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        useStudio.getState().select({ kind: 'step', path: d.path })
        useStudio.getState().openContextMenu({ x: e.clientX, y: e.clientY, path: d.path })
      }}
    >
      {!isFrom && <Handle type="target" position={Position.Left} />}
      <span className="step-icon">
        <Icon size={17} strokeWidth={1.9} />
      </span>
      <span className="step-text">
        <span className="step-title">
          <span className="step-name">{d.title}</span>
          {isFrom && <span className="step-tag">start</span>}
          {d.tag && <span className="step-tag">{d.tag}</span>}
        </span>
        <span className={cx('step-sub', !d.subtitle && (isFrom || d.scheme !== null ? 'is-empty' : 'is-kind'))}>{d.subtitle || (isFrom || d.scheme !== null ? 'not configured' : d.kind)}</span>
      </span>
      {d.problems.length > 0 && (
        <span className="step-problem" title={d.problems.join('\n')}>
          <TriangleAlert size={11} strokeWidth={2.4} />
        </span>
      )}
      {live?.breakpoint && <span className="step-bp" title="Breakpoint: messages pause here when the app runs in Debug" />}
      {live?.order !== undefined && (
        <span className="step-order" title={live.visits && live.visits > 1 ? `Visited ${live.visits} times by this message` : 'Order in which this message reached the step'}>
          {live.order}
          {live.visits && live.visits > 1 ? <small>×{live.visits}</small> : null}
        </span>
      )}
      {stats && (
        <span
          className={cx('step-live', stats.failed > 0 && 'has-failed', stats.inflight > 0 && 'is-busy')}
          title={`${stats.total} messages · ${stats.failed} failed · ${stats.inflight} in flight\nmean ${formatMs(stats.mean)} · last ${formatMs(stats.last)} · max ${formatMs(stats.max)}`}
        >
          {live?.routeState && live.routeState !== 'Started' ? live.routeState.toLowerCase() : formatCount(stats.total)}
          {stats.failed > 0 && <b>{formatCount(stats.failed)}</b>}
        </span>
      )}
      <Handle type="source" position={Position.Right} />
      {!isFrom && d.seqPath && (
        <NodeToolbar isVisible={selected} position={Position.Top} offset={8} className="step-toolbar">
          <button title="Move earlier" disabled={d.index === 0} onClick={() => moveStep(d.seqPath as Path, d.index, -1)}>
            <ArrowLeft size={14} />
          </button>
          <button title="Move later" disabled={d.index >= d.count - 1} onClick={() => moveStep(d.seqPath as Path, d.index, 1)}>
            <ArrowRight size={14} />
          </button>
          <span className="sep" />
          <button title={live?.breakpoint ? 'Remove breakpoint' : 'Add breakpoint (pauses messages here in Debug)'} className={cx(live?.breakpoint && 'is-on-bp')} onClick={() => toggleBreakpoint(d.path)}>
            <CircleDot size={14} />
          </button>
          <button title="Duplicate (⌘D)" onClick={() => duplicateStep(d.path)}>
            <Copy size={14} />
          </button>
          <button title="Delete (⌫)" className="danger" onClick={() => removeStep(d.path)}>
            <Trash2 size={14} />
          </button>
        </NodeToolbar>
      )}
    </div>
  )
}

function GroupNode({ data }: NodeProps): React.JSX.Element {
  const d = data as GroupNodeData
  return (
    <div className={cx('group-box', `cat-${d.category}`)}>
      <Handle type="source" position={Position.Right} style={{ top: d.anchorY }} />
    </div>
  )
}

function BranchLabelNode({ data, selected }: NodeProps): React.JSX.Element {
  const d = data as LabelNodeData
  return (
    <div className={cx('branch-label', `cat-${d.category}`, selected && 'is-selected', !d.ownerPath && 'is-static')} title={d.detail ?? undefined}>
      <span className="branch-kind">{d.label}</span>
      {d.detail && <span className="branch-detail">{d.detail}</span>}
    </div>
  )
}

function StubNode({ data }: NodeProps): React.JSX.Element {
  const d = data as StubNodeData
  const { insertStep, openQuickAdd } = useStudio.getState()
  const drop = useDropTarget((item) => insertStep(d.seqPath, d.index, item), (from) => useStudio.getState().moveStepTo(from, d.seqPath, d.index))
  const open = (e: MouseEvent): void => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    openQuickAdd({ x: r.right, y: r.bottom, seqPath: d.seqPath, index: d.index })
  }
  return (
    <button className={cx('stub nodrag nopan', drop.over && 'is-drop')} title="Add a step here" onClick={open} {...drop.props}>
      <Handle type="target" position={Position.Left} />
      <Plus size={14} strokeWidth={2.2} />
    </button>
  )
}

function edgePath(sx: number, sy: number, tx: number, ty: number): string {
  if (Math.abs(sy - ty) < 0.5) return `M${sx},${sy}L${tx},${ty}`
  const mx = sx + 22
  const dir = ty > sy ? 1 : -1
  const r = Math.min(10, Math.abs(ty - sy) / 2)
  return `M${sx},${sy}L${mx - r},${sy}Q${mx},${sy} ${mx},${sy + dir * r}L${mx},${ty - dir * r}Q${mx},${ty} ${mx + r},${ty}L${tx},${ty}`
}

function FlowEdge({ data }: EdgeProps): React.JSX.Element {
  const d = data as FlowEdgeData
  const { insertStep, openQuickAdd } = useStudio.getState()
  const insert = d.insert
  const drop = useDropTarget((item) => insert && insertStep(insert.seqPath, insert.index, item), (from) => insert && useStudio.getState().moveStepTo(from, insert.seqPath, insert.index))
  const straight = Math.abs(d.sy - d.ty) < 0.5
  const bx = straight ? (d.sx + d.tx) / 2 - 3 : d.tx - 31
  return (
    <>
      <path className={cx('flow-edge', d.dashed && 'is-dashed')} d={edgePath(d.sx, d.sy, d.dashed ? d.tx : d.tx - 2, d.ty)} markerEnd={d.dashed ? undefined : 'url(#cs-arrow)'} />
      {insert && (
        <EdgeLabelRenderer>
          <button
            className={cx('edge-add nodrag nopan', drop.over && 'is-drop')}
            style={{ transform: `translate(-50%,-50%) translate(${bx}px,${d.ty}px)` }}
            title="Insert a step here"
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              openQuickAdd({ x: r.right, y: r.bottom, seqPath: insert.seqPath, index: insert.index })
            }}
            {...drop.props}
          >
            <Plus size={11} strokeWidth={2.6} />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const nodeTypes = { step: StepNode, 'group-box': GroupNode, 'branch-label': BranchLabelNode, stub: StubNode }
const edgeTypes = { flow: FlowEdge }

const MINIMAP_COLORS: Record<Category, string> = {
  source: 'var(--cat-source)',
  endpoint: 'var(--cat-endpoint)',
  routing: 'var(--cat-routing)',
  transform: 'var(--cat-transform)',
  error: 'var(--cat-error)',
  flow: 'var(--cat-flow)',
  util: 'var(--cat-util)'
}

// ----------------------------------------------------------------- canvas --

function Flow({ routeKey, compact }: { routeKey: string; compact: boolean }): React.JSX.Element | null {
  const file = useActiveFile()
  const catalog = useStudio((s) => s.catalog)
  const activeEntry = useStudio((s) => s.activeEntry)
  const selection = useStudio((s) => s.selection)
  const select = useStudio((s) => s.select)
  const openQuickAdd = useStudio((s) => s.openQuickAdd)
  const theme = useStudio((s) => s.theme)
  const problems = useProblems()
  const entries = useEntries()
  const entry = entries.find((e) => e.index === activeEntry)
  const flow = useReactFlow()
  const live = useLive()

  const layout = useMemo(() => {
    if (!file?.js || !catalog || !entry?.fromPath) return null
    return layoutRoute(file.js, entry.fromPath, catalog, problems)
  }, [file?.js, catalog, entry?.fromPath?.join('/'), problems]) // eslint-disable-line react-hooks/exhaustive-deps

  const nodes = useMemo<Node[]>(() => {
    if (!layout) return []
    return layout.nodes.map((n) => {
      if (n.type === 'step') {
        const info = live.byPath.get(n.id)
        const data: StepNodeData = { ...(n.data as StepNodeData), live: info, offPath: live.tracing && info?.order === undefined && !info?.paused }
        return { ...n, data, selected: selection?.kind === 'step' && samePath(selection.path, data.path) }
      }
      if (n.type === 'branch-label') return { ...n, selected: selection?.kind === 'branch' && samePath(selection.path, (n.data as LabelNodeData).ownerPath) }
      return n
    })
  }, [layout, selection, live])

  // Frame the route whenever a different one is opened (not on every edit). A route that
  // fits is centred; a long one stays readable and starts at its trigger, like reading a line.
  const latest = useRef(layout)
  latest.current = layout
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      const nodes = latest.current?.nodes ?? []
      const el = host.current
      if (!el || nodes.length === 0) return
      const minX = Math.min(...nodes.map((n) => n.position.x))
      const maxX = Math.max(...nodes.map((n) => n.position.x + (n.width ?? 0)))
      const minY = Math.min(...nodes.map((n) => n.position.y))
      const maxY = Math.max(...nodes.map((n) => n.position.y + (n.height ?? 0)))
      const pad = 56
      const w = el.clientWidth
      const h = el.clientHeight
      const zoom = Math.max(0.8, Math.min(1, (w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY)))
      const fitsX = (maxX - minX) * zoom <= w - pad * 2
      const fitsY = (maxY - minY) * zoom <= h - pad * 2
      void flow.setViewport({
        x: fitsX ? (w - (maxX - minX) * zoom) / 2 - minX * zoom : pad - minX * zoom,
        y: fitsY ? (h - (maxY - minY) * zoom) / 2 - minY * zoom : h / 2,
        zoom
      })
    }, 30)
    return () => clearTimeout(t)
  }, [routeKey, flow])

  // Keep the selected step in view, for example one just added at the far end of a long route.
  useEffect(() => {
    const el = host.current
    if (!selection || !el) return
    const node = latest.current?.nodes.find((n) =>
      selection.kind === 'step' ? n.type === 'step' && samePath((n.data as StepNodeData).path, selection.path) : n.type === 'branch-label' && samePath((n.data as LabelNodeData).ownerPath, selection.path)
    )
    if (!node) return
    const { x, y, zoom } = flow.getViewport()
    const w = node.width ?? 0
    const h = node.height ?? 0
    const left = node.position.x * zoom + x
    const top = node.position.y * zoom + y
    const margin = 28
    if (left < margin || top < margin || left + w * zoom > el.clientWidth - margin || top + h * zoom > el.clientHeight - margin) {
      void flow.setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom, duration: 220 })
    }
  }, [selection, flow])

  // When the debugger pauses a message, bring the step it stopped at into view.
  const pausedId = nodes.find((n) => n.type === 'step' && (n.data as StepNodeData).live?.paused)?.id ?? null
  useEffect(() => {
    const el = host.current
    const node = pausedId ? nodes.find((n) => n.id === pausedId) : undefined
    if (!node || !el) return
    const { x, y, zoom } = flow.getViewport()
    const w = node.width ?? 0
    const h = node.height ?? 0
    const left = node.position.x * zoom + x
    const top = node.position.y * zoom + y
    if (left < 28 || top < 60 || left + w * zoom > el.clientWidth - 28 || top + h * zoom > el.clientHeight - 28) {
      void flow.setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom, duration: 220 })
    }
  }, [pausedId, flow]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!layout) return null
  return (
    <ReactFlow
      ref={host}
      colorMode={theme}
      attributionPosition="top-right"
      nodes={nodes}
      edges={layout.edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      panOnScroll
      zoomOnDoubleClick={false}
      minZoom={0.2}
      maxZoom={1.6}
      onNodeDoubleClick={(_e, node) => {
        const data = node.data as StepNodeData
        if (node.type === 'step' && data.title === 'Data Mapper' && data.subtitle) void openMapper(data.subtitle)
      }}
      onNodeClick={(_e, node) => {
        if (node.type === 'step') {
          const data = node.data as StepNodeData
          select({ kind: 'step', path: data.path })
          // While a traced message is shown, clicking a step on its path shows the message there.
          const s = useStudio.getState()
          if (s.selectedExchange && data.live?.traceUid !== undefined) s.selectExchange(s.selectedExchange, data.live.traceUid)
        } else if (node.type === 'branch-label') {
          const owner = (node.data as LabelNodeData).ownerPath
          if (owner) select({ kind: 'branch', path: owner })
        }
        openQuickAdd(null)
      }}
      onPaneClick={() => {
        useStudio.getState().openContextMenu(null)
        select(null)
        openQuickAdd(null)
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
      <Controls showInteractive={false} position="bottom-left" />
      {!compact && <MiniMap
        pannable
        zoomable
        position="bottom-right"
        nodeStrokeWidth={0}
        nodeBorderRadius={6}
        nodeColor={(n) => (n.type === 'step' ? MINIMAP_COLORS[(n.data as StepNodeData).category] : 'transparent')}
        maskColor="var(--minimap-mask)"
        bgColor="var(--bg-1)"
      />}
    </ReactFlow>
  )
}

export function Canvas(): React.JSX.Element {
  const file = useActiveFile()
  const activeEntry = useStudio((s) => s.activeEntry)
  const setView = useStudio((s) => s.setView)
  const addRoute = useStudio((s) => s.addRoute)
  const setBottom = useStudio((s) => s.setBottom)
  // Git conflict markers left by a pull: point to the Git tab rather than a YAML parse error.
  const conflicted = !!file?.error && /^<{7} |^>{7} /m.test(file.text)
  const dragging = useStudio((s) => s.dragging)
  const view = useStudio((s) => s.view)
  const entries = useEntries()
  const problems = useProblems()
  const entry = entries.find((e) => e.index === activeEntry)
  const routeProblems = problems.filter((p) => p.entryIndex === activeEntry).length
  const live = useLive()
  const attached = useStudio((s) => s.attached)
  const rtRoute = useStudio((s) => s.rtStatus?.routes.find((r) => r.routeId === entry?.id) ?? null)
  const tracedId = useStudio((s) => s.selectedExchange)

  let empty: React.JSX.Element | null = null
  if (!file) {
    empty = (
      <div className="canvas-empty">
        <h3>No route open</h3>
        <p>Pick a route file in the project panel, or create one with the + button.</p>
      </div>
    )
  } else if (file.language === 'java') {
    empty = (
      <div className="canvas-empty">
        <h3>Java DSL route</h3>
        <p>Routes written as RouteBuilder classes are shown as source, read-only. Visual editing works on YAML DSL routes.</p>
        <button className="btn" onClick={() => setView('source')}>
          <FileCode2 size={14} /> View source
        </button>
      </div>
    )
  } else if (!file.js) {
    empty = conflicted ? (
      <div className="canvas-empty">
        <h3>This file has a Git conflict</h3>
        <p>It was changed both here and by a teammate. In the Git tab, keep your version or theirs, or edit the conflict markers in the source.</p>
        <span className="input-row">
          <button className="btn primary" onClick={() => setBottom(true, 'git')}>
            <GitBranch size={14} /> Open the Git tab
          </button>
          <button className="btn" onClick={() => setView('source')}>
            <FileCode2 size={14} /> Open source
          </button>
        </span>
      </div>
    ) : (
      <div className="canvas-empty">
        <h3>This file could not be read as Camel YAML</h3>
        <p className="mono">{file.error}</p>
        <button className="btn" onClick={() => setView('source')}>
          <FileCode2 size={14} /> Open source
        </button>
      </div>
    )
  } else if (entries.length === 0) {
    empty = (
      <div className="canvas-empty">
        <h3>This file has no routes yet</h3>
        <button className="btn primary" onClick={addRoute}>
          <Plus size={14} /> Add a route
        </button>
      </div>
    )
  } else if (!entry?.fromPath) {
    empty = (
      <div className="canvas-empty">
        <h3>{entry ? `"${entry.rootKey}" is edited as source` : 'Select a route'}</h3>
        <p>The canvas shows routes. Other definitions such as beans and REST configuration are edited in the source view for now.</p>
        <button className="btn" onClick={() => setView('source')}>
          <FileCode2 size={14} /> Open source
        </button>
      </div>
    )
  }

  return (
    <div className={cx('canvas', dragging && 'is-dragging')}>
      {file && entry?.fromPath && (
        <div className="canvas-head">
          <span className="crumb">{file.rel}</span>
          <span className="crumb-sep">/</span>
          <span className="crumb strong">{entry.id}</span>
          {entry.description && <span className="crumb-desc">{entry.description}</span>}
          <span className="spacer" />
          {live.tracing && (
            <button className="chip accent" title="Stop showing this message's path" onClick={() => useStudio.getState().selectExchange(null)}>
              Showing message path <X size={11} />
            </button>
          )}
          {routeProblems > 0 && (
            <button className="chip warn" onClick={() => useStudio.getState().setBottom(true, 'problems')}>
              <TriangleAlert size={12} /> {routeProblems} {routeProblems === 1 ? 'problem' : 'problems'}
            </button>
          )}
          {attached && rtRoute && (
            <>
              <span className={cx('chip', rtRoute.state === 'Started' ? 'ok' : 'warn')}>{rtRoute.state}</span>
              <button
                className="btn small"
                title={rtRoute.state === 'Started' ? 'Stop only this route; the application keeps running' : 'Start this route'}
                onClick={() => useStudio.getState().routeCommand(rtRoute.routeId, rtRoute.state === 'Started' ? 'stop' : 'start')}
              >
                {rtRoute.state === 'Started' ? <Square size={10} fill="currentColor" /> : <Play size={11} fill="currentColor" />}
                {rtRoute.state === 'Started' ? 'Stop route' : 'Start route'}
              </button>
            </>
          )}
          {attached && (
            <button className="btn small" onClick={() => useStudio.getState().setSendOpen(true)} title="Send a test message to an endpoint of the running application">
              <Send size={12} /> Send message
            </button>
          )}
        </div>
      )}
      {live.stale && (attached || tracedId) && (
        <div className="canvas-banner is-info">
          <TriangleAlert size={14} />
          <span>This file changed after the application was launched, so live statistics and message paths are hidden. Restart the application to see them again.</span>
        </div>
      )}
      {file?.error && file.js && (
        <div className="canvas-banner">
          <TriangleAlert size={14} />
          <span>{conflicted ? 'The file has a Git conflict, so the canvas shows the last valid version. Settle it in the Git tab.' : `The source has a YAML error, so the canvas shows the last valid version. ${file.error}`}</span>
          {conflicted && (
            <button className="link" onClick={() => setBottom(true, 'git')}>
              Git tab
            </button>
          )}
          <button className="link" onClick={() => setView('split')}>
            Show source
          </button>
        </div>
      )}
      <svg className="defs" aria-hidden>
        <defs>
          <marker id="cs-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M1.5,1.5 L8.5,5 L1.5,8.5" />
          </marker>
        </defs>
      </svg>
      {empty ?? (
        <ReactFlowProvider>
          <Flow routeKey={`${file?.path}#${activeEntry}`} compact={view === 'split'} />
        </ReactFlowProvider>
      )}
      <DebugBar />
      <StepMenu />
      <SnippetDialog />
      <QuickAdd />
      <SendDialog />
    </div>
  )
}

// -------------------------------------------------------------- quick add --

interface QuickItem {
  item: PaletteItem
  title: string
  hint: string
  category: Category
  label: string | null
}

function QuickAdd(): React.JSX.Element | null {
  const quickAdd = useStudio((s) => s.quickAdd)
  const catalog = useStudio((s) => s.catalog)
  const settings = useStudio((s) => s.settings)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const all = useMemo<QuickItem[]>(() => {
    if (!catalog) return []
    const mapper: QuickItem = { item: { type: 'eip', name: MAPPER_ITEM }, title: 'Data Mapper', hint: 'map fields', category: 'transform', label: null }
    const team: QuickItem[] = (settings?.snippets ?? []).map((sn) => ({ item: { type: 'snippet', id: sn.id }, title: sn.name, hint: 'team', category: 'util', label: null }))
    const eips: QuickItem[] = paletteEips(catalog).map((name) => ({
      item: { type: 'eip', name },
      title: catalog.models[name]?.title ?? name,
      hint: name,
      category: categoryOf(name, catalog),
      label: null
    }))
    const comps: QuickItem[] = catalog.index.components
      .filter((c) => !c.consumerOnly && !c.deprecated)
      .map((c) => ({ item: { type: 'component', name: c.name }, title: c.title, hint: c.name, category: 'endpoint', label: c.label }))
    return [...team, mapper, ...eips, ...comps]
  }, [catalog, settings])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      const starters = [MAPPER_ITEM, 'log', 'setBody', 'setHeader', 'choice', 'split', 'filter', 'marshal', 'unmarshal', 'doTry', 'bean']
      const first = [...all.filter((a) => a.item.type === 'snippet'), ...starters.map((n) => all.find((a) => a.item.type === 'eip' && a.item.name === n))].filter((a): a is QuickItem => !!a)
      const common = ['direct', 'http', 'kafka', 'jms', 'sql', 'file', 'rest']
      return [...first, ...common.map((n) => all.find((a) => a.item.type === 'component' && a.item.name === n)).filter((a): a is QuickItem => !!a)]
    }
    const score = (a: QuickItem): number => {
      const t = a.title.toLowerCase()
      const h = a.hint.toLowerCase()
      if (h === q || t === q) return 0
      if (h.startsWith(q) || t.startsWith(q)) return 1
      if (h.includes(q) || t.includes(q)) return 2
      return 9
    }
    return all
      .map((a) => ({ a, s: score(a) }))
      .filter((x) => x.s < 9)
      // On a tie, processors come before components: typing "log" should offer the Log step, not the log: endpoint.
      .sort((x, y) => x.s - y.s || Number(x.a.item.type === 'component') - Number(y.a.item.type === 'component') || x.a.title.localeCompare(y.a.title))
      .slice(0, 40)
      .map((x) => x.a)
  }, [all, query])

  useEffect(() => {
    setQuery('')
    setCursor(0)
  }, [quickAdd?.x, quickAdd?.y])
  useEffect(() => setCursor(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!quickAdd) return null
  const { insertStep, openQuickAdd } = useStudio.getState()
  const choose = (q: QuickItem | undefined): void => {
    if (!q) return
    if (quickAdd.replace) useStudio.getState().replaceStep(quickAdd.replace, q.item)
    else insertStep(quickAdd.seqPath, quickAdd.index, q.item)
  }
  const left = Math.max(8, Math.min(quickAdd.x + 6, window.innerWidth - 322))
  const top = Math.max(8, Math.min(quickAdd.y + 6, window.innerHeight - 370))

  return (
    <div className="quick-add" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
      <div className="quick-search">
        <Search size={14} />
        <input
          autoFocus
          placeholder={quickAdd.replace ? 'Replace with: processor or component…' : 'Add a step: processor or component…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(c + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(results[cursor])
            } else if (e.key === 'Escape') {
              openQuickAdd(null)
            }
          }}
        />
      </div>
      <div className="quick-list" ref={listRef}>
        {results.length === 0 && <div className="quick-none">Nothing matches “{query}”.</div>}
        {results.map((r, i) => {
          const Icon = r.item.type === 'component' ? componentIcon(r.item.name, r.label) : r.item.type === 'snippet' ? Boxes : stepIcon(r.item.name, r.category, null, null)
          return (
            <button key={`${r.item.type}:${r.item.type === 'snippet' ? r.item.id : r.item.name}`} className={cx('quick-item', `cat-${r.category}`, i === cursor && 'is-active')} onMouseEnter={() => setCursor(i)} onClick={() => choose(r)}>
              <span className="mini-icon">
                <Icon size={14} />
              </span>
              <span className="quick-title">{r.title}</span>
              <span className="quick-hint">{r.item.type === 'component' ? `${r.hint}:` : r.hint}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ------------------------------------------------------------ step actions --

/** Right-click menu on a step: everything you can do to it in one place. */
function StepMenu(): React.JSX.Element | null {
  const menu = useStudio((s) => s.contextMenu)
  const file = useActiveFile()
  const breakpoints = useStudio((s) => s.breakpoints)
  if (!menu || !file?.js) return null
  const s = useStudio.getState()
  const path = menu.path
  const isFrom = path[path.length - 1] === 'from'
  const index = path[path.length - 1] as number
  const seqPath = path.slice(0, -1)
  const step = (() => {
    let cur: unknown = file.js
    for (const k of path) cur = (cur as Record<string | number, unknown>)?.[k]
    return cur as Record<string, Record<string, unknown> | undefined> | undefined
  })()
  const kind = step ? Object.keys(step)[0] : ''
  const disabled = !isFrom && step?.[kind]?.disabled === true
  const hasBp = (breakpoints[file.path] ?? []).includes(path.join('/'))
  const close = (): void => s.openContextMenu(null)
  const item = (label: string, icon: React.JSX.Element, run: () => void, opts: { danger?: boolean; hint?: string; off?: boolean } = {}): React.JSX.Element => (
    <button
      className={cx(opts.danger && 'danger')}
      disabled={opts.off}
      onClick={() => {
        close()
        run()
      }}
    >
      {icon}
      <span>{label}</span>
      {opts.hint && <span className="menu-hint">{opts.hint}</span>}
    </button>
  )
  const left = Math.min(menu.x, window.innerWidth - 250)
  const top = Math.min(menu.y, window.innerHeight - 360)
  return (
    <div className="menu step-menu" style={{ left, top }} onMouseLeave={close}>
      {!isFrom && item('Insert a step before', <Plus size={14} />, () => s.openQuickAdd({ x: menu.x, y: menu.y, seqPath, index }))}
      {item('Insert a step after', <Plus size={14} />, () => (isFrom ? s.openQuickAdd({ x: menu.x, y: menu.y, seqPath: [...path, 'steps'], index: 0 }) : s.openQuickAdd({ x: menu.x, y: menu.y, seqPath, index: index + 1 })))}
      {!isFrom && item('Replace with…', <Replace size={14} />, () => s.openQuickAdd({ x: menu.x, y: menu.y, seqPath, index, replace: path }))}
      <span className="menu-sep" />
      {!isFrom && item(disabled ? 'Enable' : 'Disable', <EyeOff size={14} />, () => s.toggleDisabled(path), { hint: 'skipped when it runs' })}
      {!isFrom && item('Duplicate', <Copy size={14} />, () => s.duplicateStep(path), { hint: '⌘D' })}
      {!isFrom && item('Copy', <Copy size={14} />, () => void s.copySteps(path, false), { hint: '⌘C' })}
      {!isFrom && item('Cut', <Scissors size={14} />, () => void s.copySteps(path, true), { hint: '⌘X' })}
      {item('Paste after', <ClipboardPaste size={14} />, () => void s.pasteAfter(path), { hint: '⌘V' })}
      <span className="menu-sep" />
      {!isFrom && item(hasBp ? 'Remove breakpoint' : 'Add breakpoint', <CircleDot size={14} />, () => s.toggleBreakpoint(path))}
      {item(isFrom ? 'Save the route’s steps to the team palette…' : 'Save to the team palette…', <Boxes size={14} />, () => s.setSnippetFor(path))}
      {!isFrom && (
        <>
          <span className="menu-sep" />
          {item('Delete', <Trash2 size={14} />, () => s.removeStep(path), { danger: true, hint: '⌫' })}
        </>
      )}
    </div>
  )
}

/** Names a step (or a route's steps) before it goes into the team palette. */
function SnippetDialog(): React.JSX.Element | null {
  const path = useStudio((s) => s.snippetFor)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  useEffect(() => {
    setName('')
    setDescription('')
  }, [path])
  if (!path) return null
  const { setSnippetFor, saveSnippet } = useStudio.getState()
  return (
    <div className="modal-back" onMouseDown={() => setSnippetFor(null)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <Boxes size={15} />
          <strong>Save to the team palette</strong>
          <span className="spacer" />
          <button className="icon-btn" onClick={() => setSnippetFor(null)}>
            <X size={15} />
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span className="field-head">
              <span className="lbl">Name</span>
            </span>
            <input className="input" autoFocus value={name} placeholder="Audit and acknowledge" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-head">
              <span className="lbl">What it does</span>
            </span>
            <textarea className="input" rows={3} value={description} placeholder="Logs the request, stores it for audit and replies with an acknowledgement." onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="hint">It appears under Processors › Team, and in the quick-add menu. Share it with your team through Settings › Team profile.</div>
        </div>
        <footer className="modal-foot">
          <span className="spacer" />
          <button className="btn" onClick={() => setSnippetFor(null)}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void saveSnippet(path, name, description)}>
            Save
          </button>
        </footer>
      </div>
    </div>
  )
}
