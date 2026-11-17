// Automatic left-to-right layout of one route.
//
// A route is a tree, so positions are derived, never stored: the YAML stays free of
// designer metadata and two people editing the same route cannot conflict on layout.
// Every sequence sits on a horizontal baseline; a container (choice, split, doTry…)
// is a header node followed by a group box holding one lane per branch.

import type { Edge, Node } from '@xyflow/react'
import type { RtStats } from '@shared/types'
import {
  branchesOf,
  describeStep,
  getAt,
  normalizeValue,
  pathKey,
  stepKind,
  type BranchInfo,
  type Catalog,
  type Category,
  type Path,
  type Problem,
  type Y
} from './camel'

export const NODE_W = 184
export const NODE_H = 56
const GAP_X = 46
const GAP_Y = 12
const PAD = 16
const STUB = 26
const LABEL_H = 30

/** What the running application says about one step. Merged into the node by the canvas. */
export interface NodeLive {
  stats?: RtStats
  /** Camel's id for the node, needed to set a breakpoint on it. */
  nodeId?: string
  routeState?: string
  /** Position of this step in the selected message's path (1-based), and how often it was visited. */
  order?: number
  visits?: number
  visitFailed?: boolean
  traceUid?: number
  paused?: boolean
  breakpoint?: boolean
}

export interface StepNodeData extends Record<string, unknown> {
  path: Path
  kind: string
  title: string
  subtitle: string
  category: Category
  tag: string | null
  componentLabel: string | null
  scheme: string | null
  problems: string[]
  disabled: boolean
  live?: NodeLive
  /** True while a traced message is shown and this step is not on its path. */
  offPath?: boolean
  /** Position inside its sequence, for the move buttons. */
  seqPath: Path | null
  index: number
  count: number
}

export interface GroupNodeData extends Record<string, unknown> {
  category: Category
  anchorY: number
}

export interface LabelNodeData extends Record<string, unknown> {
  /** Path of the branch object (`…/choice/when/0`), or null for a body that cannot be selected. */
  ownerPath: Path | null
  label: string
  detail: string | null
  category: Category
  width: number
}

export interface StubNodeData extends Record<string, unknown> {
  seqPath: Path
  index: number
  empty: boolean
}

export interface FlowEdgeData extends Record<string, unknown> {
  sx: number
  sy: number
  tx: number
  ty: number
  /** Where a step dropped on this edge is inserted. Absent on the trailing stub edge. */
  insert: { seqPath: Path; index: number } | null
  dashed: boolean
}

interface BranchBox {
  info: BranchInfo
  seq: SeqBox
  w: number
  h: number
  baseline: number
  labelW: number
}

interface ItemBox {
  path: Path
  kind: string
  value: Record<string, Y>
  w: number
  up: number
  down: number
  branches: BranchBox[]
  groupW: number
  groupH: number
  /** Top of the group box relative to the item's baseline. */
  groupTop: number
}

interface SeqBox {
  seqPath: Path
  items: ItemBox[]
  w: number
  up: number
  down: number
}

const labelWidth = (b: BranchInfo): number =>
  b.label ? Math.min(280, 26 + b.label.length * 7 + (b.detail ? 10 + Math.min(b.detail.length, 30) * 6.7 : 0)) : 0

function measureSeq(steps: Y, seqPath: Path, catalog: Catalog): SeqBox {
  const list: Y[] = Array.isArray(steps) ? steps : []
  const items = list.map((step, i) => measureItem(step, [...seqPath, i], catalog))
  return {
    seqPath,
    items,
    w: items.reduce((sum, it) => sum + it.w + GAP_X, 0) + STUB,
    up: Math.max(STUB / 2, ...items.map((it) => it.up)),
    down: Math.max(STUB / 2, ...items.map((it) => it.down))
  }
}

function measureItem(step: Y, path: Path, catalog: Catalog): ItemBox {
  const kind = stepKind(step)
  const value = normalizeValue(kind, step?.[kind])
  const item: ItemBox = { path, kind, value, w: NODE_W, up: NODE_H / 2, down: NODE_H / 2, branches: [], groupW: 0, groupH: 0, groupTop: 0 }
  const infos = branchesOf(kind, value, catalog)
  if (infos.length === 0) return item

  item.branches = infos.map((info) => {
    const seq = measureSeq(getAt(value, info.stepsRel), [...path, kind, ...info.stepsRel], catalog)
    const labelW = labelWidth(info)
    const labelH = info.label ? LABEL_H : 0
    return { info, seq, labelW, w: Math.max(seq.w, labelW), h: labelH + seq.up + seq.down, baseline: labelH + seq.up }
  })
  item.groupW = PAD * 2 + Math.max(...item.branches.map((b) => b.w))
  item.groupH = PAD * 2 + item.branches.reduce((sum, b) => sum + b.h, 0) + GAP_Y * (item.branches.length - 1)
  if (item.branches.length === 1) {
    // A single body stays on the main line so the flow reads straight through.
    const b = item.branches[0]
    item.groupTop = -(PAD + b.baseline)
    item.up = Math.max(NODE_H / 2, PAD + b.baseline)
    item.down = Math.max(NODE_H / 2, PAD + b.h - b.baseline)
  } else {
    item.groupTop = -item.groupH / 2
    item.up = item.down = Math.max(NODE_H / 2, item.groupH / 2)
  }
  item.w = NODE_W + GAP_X + item.groupW
  return item
}

export interface RouteLayout {
  nodes: Node[]
  edges: Edge[]
}

export function layoutRoute(js: Y[], fromPath: Path, catalog: Catalog, problems: Problem[]): RouteLayout {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const problemsByPath = new Map<string, string[]>()
  for (const p of problems) {
    const key = pathKey(p.path)
    problemsByPath.set(key, [...(problemsByPath.get(key) ?? []), p.message])
  }

  const base = { draggable: false, connectable: false, deletable: false } as const

  const stepNode = (path: Path, kind: string, value: Record<string, Y>, x: number, baseline: number, seq: { seqPath: Path; index: number; count: number } | null): string => {
    const id = pathKey(path)
    const d = describeStep(kind, value, catalog)
    const data: StepNodeData = {
      path,
      kind,
      title: d.title,
      subtitle: d.subtitle,
      category: d.category,
      tag: d.tag,
      componentLabel: d.componentLabel,
      scheme: d.scheme,
      problems: problemsByPath.get(id) ?? [],
      disabled: value.disabled === true,
      seqPath: seq?.seqPath ?? null,
      index: seq?.index ?? 0,
      count: seq?.count ?? 0
    }
    nodes.push({
      ...base,
      id,
      type: 'step',
      position: { x, y: baseline - NODE_H / 2 },
      width: NODE_W,
      height: NODE_H,
      measured: { width: NODE_W, height: NODE_H },
      zIndex: 10,
      data
    })
    return id
  }

  const edge = (source: string, target: string, sx: number, sy: number, tx: number, ty: number, insert: FlowEdgeData['insert'], dashed = false): void => {
    const data: FlowEdgeData = { sx, sy, tx, ty, insert, dashed }
    edges.push({ id: `${source}→${target}`, source, target, type: 'flow', selectable: false, focusable: false, data })
  }

  /** Places a sequence; `fromX`/`fromY` is the point the incoming edge leaves from. */
  const placeSeq = (seq: SeqBox, x: number, baseline: number, sourceId: string, fromX: number, fromY: number, depth: number): void => {
    let cx = x
    let prev = { id: sourceId, x: fromX, y: fromY }
    seq.items.forEach((it, i) => {
      const id = stepNode(it.path, it.kind, it.value, cx, baseline, { seqPath: seq.seqPath, index: i, count: seq.items.length })
      edge(prev.id, id, prev.x, prev.y, cx, baseline, { seqPath: seq.seqPath, index: i })
      prev = { id, x: cx + NODE_W, y: baseline }

      if (it.branches.length > 0) {
        const category = (nodes[nodes.length - 1].data as StepNodeData).category
        const gx = cx + NODE_W + GAP_X
        const gTop = baseline + it.groupTop
        const groupId = `${id}#group`
        const groupData: GroupNodeData = { category, anchorY: baseline - gTop }
        nodes.push({
          ...base,
          id: groupId,
          type: 'group-box',
          position: { x: gx, y: gTop },
          width: it.groupW,
          height: it.groupH,
          measured: { width: it.groupW, height: it.groupH },
          selectable: false,
          focusable: false,
          zIndex: depth,
          style: { pointerEvents: 'none' },
          data: groupData
        })
        let by = gTop + PAD
        for (const b of it.branches) {
          if (b.info.label) {
            const labelData: LabelNodeData = {
              ownerPath: b.info.ownerRel ? [...it.path, it.kind, ...b.info.ownerRel] : null,
              label: b.info.label,
              detail: b.info.detail,
              category,
              width: b.labelW
            }
            nodes.push({
              ...base,
              id: `${id}#label:${b.info.key}`,
              type: 'branch-label',
              position: { x: gx + PAD, y: by },
              width: b.labelW,
              height: LABEL_H - 8,
              measured: { width: b.labelW, height: LABEL_H - 8 },
              selectable: b.info.ownerRel !== null,
              zIndex: 10,
              data: labelData
            })
          }
          placeSeq(b.seq, gx + PAD, by + b.baseline, id, cx + NODE_W, baseline, depth + 1)
          by += b.h + GAP_Y
        }
        prev = { id: groupId, x: gx + it.groupW, y: baseline }
      }
      cx += it.w + GAP_X
    })

    const stubId = `${pathKey(seq.seqPath)}#end`
    const stubData: StubNodeData = { seqPath: seq.seqPath, index: seq.items.length, empty: seq.items.length === 0 }
    nodes.push({
      ...base,
      id: stubId,
      type: 'stub',
      position: { x: cx, y: baseline - STUB / 2 },
      width: STUB,
      height: STUB,
      measured: { width: STUB, height: STUB },
      selectable: false,
      zIndex: 10,
      data: stubData
    })
    edge(prev.id, stubId, prev.x, prev.y, cx, baseline, null, true)
  }

  const from = normalizeValue('from', getAt(js, fromPath))
  const fromId = stepNode(fromPath, 'from', from, 0, 0, null)
  const root = measureSeq(from.steps, [...fromPath, 'steps'], catalog)
  placeSeq(root, NODE_W + GAP_X, 0, fromId, NODE_W, 0, 0)
  return { nodes, edges }
}
