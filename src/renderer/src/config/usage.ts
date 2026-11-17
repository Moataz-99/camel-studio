// What a route reads and writes: global variables ({{name}}) and message data (headers,
// exchange variables and properties: BW5's process variables).

import { getAt, isMapperStep, normalizeValue, stepKind, type Path, type Y } from '@/model/camel'
import { placeholdersIn } from './properties'

/** The step a value belongs to: the deepest `steps[i]`, or the route's `from`. */
export function owningStep(path: Path): Path | null {
  for (let i = path.length - 1; i > 0; i--) {
    if (typeof path[i] === 'number' && path[i - 1] === 'steps') return path.slice(0, i + 1)
  }
  const at = path.indexOf('from')
  return at >= 0 ? path.slice(0, at + 1) : null
}

export interface PlaceholderRef {
  name: string
  hasDefault: boolean
  step: Path | null
}

/** Every {{placeholder}} written in a file, with the step it is in. */
export function placeholderRefs(js: Y[]): PlaceholderRef[] {
  const out: PlaceholderRef[] = []
  const visit = (node: Y, path: Path): void => {
    if (typeof node === 'string') {
      for (const p of placeholdersIn(node)) out.push({ name: p.name, hasDefault: p.hasDefault, step: owningStep(path) })
      return
    }
    if (Array.isArray(node)) return node.forEach((n, i) => visit(n, [...path, i]))
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) visit(v, [...path, k])
  }
  visit(js, [])
  return out
}

export type DataKind = 'header' | 'variable' | 'property'

export interface DataItem {
  kind: DataKind
  name: string
  /** Steps that set it. */
  set: Path[]
  /** Steps that read it. */
  read: Path[]
}

const SETTERS: Record<string, DataKind> = { setHeader: 'header', setVariable: 'variable', setProperty: 'property' }
const READ_LANG: Record<string, DataKind> = { header: 'header', variable: 'variable', exchangeProperty: 'property' }
/** Simple language references: ${header.x}, ${headers.x}, ${variable.x}, ${exchangeProperty.x}. */
const READ_SIMPLE = /\$\{(?:in\.)?(headers?|variables?|exchangeProperty)[.:]([\w.-]+?)\}/g

/** Message data one route sets and reads, so it can be listed and checked. */
export function messageData(js: Y[], fromPath: Path): DataItem[] {
  const items = new Map<string, DataItem>()
  const at = (kind: DataKind, name: string): DataItem => {
    const key = `${kind}:${name}`
    let it = items.get(key)
    if (!it) items.set(key, (it = { kind, name, set: [], read: [] }))
    return it
  }
  const visit = (node: Y, path: Path): void => {
    if (typeof node === 'string') {
      for (const m of node.matchAll(READ_SIMPLE)) {
        const kind: DataKind = m[1].startsWith('header') ? 'header' : m[1].startsWith('variable') ? 'variable' : 'property'
        const step = owningStep(path)
        if (step) at(kind, m[2]).read.push(step)
      }
      return
    }
    if (Array.isArray(node)) return node.forEach((n, i) => visit(n, [...path, i]))
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      const p = [...path, k]
      // A Data Mapper's steps are generated plumbing, not the user's data.
      if (k === 'step' && isMapperStep('step', v as Y)) continue
      if (SETTERS[k] && v && typeof v === 'object' && typeof (v as Y).name === 'string') at(SETTERS[k], (v as Y).name).set.push(path)
      if (READ_LANG[k]) {
        const name = typeof v === 'string' ? v : (v as Y)?.expression
        const step = owningStep(path)
        if (typeof name === 'string' && name && step) at(READ_LANG[k], name).read.push(step)
      }
      visit(v, p)
    }
  }
  const from = getAt(js, fromPath)
  visit(normalizeValue('from', from).steps ?? [], [...fromPath, 'steps'])
  return [...items.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

/** Names set anywhere in the file, for the expression helper. */
export function namesSet(js: Y[]): Record<DataKind, string[]> {
  const out: Record<DataKind, Set<string>> = { header: new Set(), variable: new Set(), property: new Set() }
  const visit = (node: Y): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    const kind = stepKind(node)
    if (kind === 'step' && isMapperStep('step', node.step)) return
    if (SETTERS[kind] && typeof node[kind]?.name === 'string') out[SETTERS[kind]].add(node[kind].name)
    for (const v of Object.values(node)) visit(v)
  }
  visit(js)
  return { header: [...out.header].sort(), variable: [...out.variable].sort(), property: [...out.property].sort() }
}
