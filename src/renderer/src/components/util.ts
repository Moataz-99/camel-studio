import { useMemo } from 'react'
import type { DragEvent } from 'react'
import type { TraceEvent } from '@shared/types'
import { listEntries, pathKey, validate, type LineTarget, type PaletteItem, type Problem, type RouteEntry } from '@/model/camel'
import { javaProblems, sourceIndex } from '@/model/source'
import { placeholderRefs } from '@/config/usage'
import type { NodeLive } from '@/model/layout'
import { useActiveFile, useStudio } from '@/store'

export const cx = (...parts: (string | false | null | undefined | 0)[]): string => parts.filter(Boolean).join(' ')

const DND_TYPE = 'application/x-camel-studio'

export function startDrag(e: DragEvent, item: PaletteItem): void {
  e.dataTransfer.setData(DND_TYPE, JSON.stringify(item))
  e.dataTransfer.effectAllowed = 'copy'
}

export const isPaletteDrag = (e: DragEvent): boolean => e.dataTransfer.types.includes(DND_TYPE)

export function readDrag(e: DragEvent): PaletteItem | null {
  try {
    const raw = e.dataTransfer.getData(DND_TYPE)
    return raw ? (JSON.parse(raw) as PaletteItem) : null
  } catch {
    return null
  }
}

export function useEntries(): RouteEntry[] {
  const file = useActiveFile()
  return useMemo(() => (file?.js ? listEntries(file.js) : []), [file?.js])
}

export function useProblems(): Problem[] {
  const file = useActiveFile()
  const catalog = useStudio((s) => s.catalog)
  const project = useStudio((s) => s.project)
  const globals = useStudio((s) => s.globals)
  return useMemo(() => {
    if (!file?.js || !catalog || file.error) return []
    const problems = validate(file.js, catalog)
    // A {{variable}} that no environment defines makes the route fail to start.
    if (globals) {
      const known = new Set(globals.vars.map((v) => v.name))
      const seen = new Set<string>()
      for (const ref of placeholderRefs(file.js)) {
        if (ref.hasDefault || known.has(ref.name) || !ref.step) continue
        const key = `${ref.name}@${ref.step.join('/')}`
        if (seen.has(key)) continue
        seen.add(key)
        const entryIndex = typeof ref.step[0] === 'number' ? ref.step[0] : 0
        problems.push({ entryIndex, path: ref.step, message: `Global variable {{${ref.name}}} is not defined` })
      }
    }
    return project?.routeFormat === 'java' ? [...problems, ...javaProblems(file.js, project, file.name, catalog)] : problems
  }, [file?.js, file?.error, file?.name, catalog, project, globals])
}

/** True when a key event comes from a place where the user is typing. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.closest) return false
  return !!el.closest('input, textarea, select, [contenteditable="true"], .cm-editor')
}

// ------------------------------------------------------------- live data --

export interface Live {
  /** The live link to the running app is up. */
  running: boolean
  /** The file was edited since the app was launched, so live data no longer lines up with it. */
  stale: boolean
  /** A traced message is selected and its path is being shown. */
  tracing: boolean
  byPath: Map<string, NodeLive>
  /** Finds the canvas step a traced event belongs to, when it is in the open file. */
  locate(event: TraceEvent): LineTarget | null
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p

/** Joins what the running app reports (statistics, traced path, breakpoints) to the steps of the open file. */
export function useLive(): Live {
  const file = useActiveFile()
  const entries = useEntries()
  const catalog = useStudio((s) => s.catalog)
  const attached = useStudio((s) => s.attached)
  const rtStatus = useStudio((s) => s.rtStatus)
  const debug = useStudio((s) => s.debug)
  const exchanges = useStudio((s) => s.exchanges)
  const selectedExchange = useStudio((s) => s.selectedExchange)
  const launchTexts = useStudio((s) => s.launchTexts)
  const breakpoints = useStudio((s) => s.breakpoints)
  const project = useStudio((s) => s.project)

  return useMemo(() => {
    const byPath = new Map<string, NodeLive>()
    const at = (key: string): NodeLive => {
      let v = byPath.get(key)
      if (!v) byPath.set(key, (v = {}))
      return v
    }
    const nowhere = (): LineTarget | null => null
    if (!file || file.language !== 'yaml' || !catalog) return { running: false, stale: false, tracing: false, byPath, locate: nowhere }
    for (const key of breakpoints[file.path] ?? []) at(key).breakpoint = true

    const exchange = selectedExchange ? exchanges.find((x) => x.id === selectedExchange) : undefined
    if (!attached && !exchange) return { running: false, stale: false, tracing: false, byPath, locate: nowhere }
    if (file.text !== (launchTexts[file.path] ?? file.saved)) return { running: attached, stale: true, tracing: false, byPath, locate: nowhere }

    const source = sourceIndex(file.text, file.name, project, catalog)
    const index = source.byLine
    const fromByRoute = new Map(entries.filter((e) => e.fromPath).map((e) => [e.id, e.fromPath as LineTarget['path']]))
    const locate = (ev: TraceEvent): LineTarget | null => {
      if (ev.nodeKind === 'from') {
        const path = fromByRoute.get(ev.routeId)
        return path ? { kind: 'step', path } : null
      }
      const m = ev.location?.match(/^(.*):(\d+)$/)
      if (!m || baseName(m[1]) !== source.name) return null
      return index.get(Number(m[2])) ?? null
    }

    for (const route of rtStatus?.routes ?? []) {
      const fromPath = fromByRoute.get(route.routeId)
      if (fromPath && (!route.file || route.file === source.name)) {
        const n = at(pathKey(fromPath))
        n.stats = route
        n.routeState = route.state
      }
      for (const p of route.processors) {
        if (p.file !== source.name) continue
        const target = index.get(p.line)
        if (!target) continue
        const n = at(pathKey(target.path))
        n.stats = p
        n.nodeId = p.id
      }
    }

    if (exchange) {
      let order = 0
      for (const ev of exchange.events) {
        if (ev.last) continue
        const target = locate(ev)
        if (!target) continue
        const n = at(pathKey(target.path))
        if (n.order === undefined) {
          n.order = ++order
          n.traceUid = ev.uid
        }
        n.visits = (n.visits ?? 0) + 1
        n.visitFailed = n.visitFailed || ev.failed
      }
    }
    for (const ev of debug?.suspended ?? []) {
      const target = locate(ev)
      if (target) at(pathKey(target.path)).paused = true
    }
    return { running: attached, stale: false, tracing: !!exchange, byPath, locate }
  }, [file, entries, catalog, attached, rtStatus, debug, exchanges, selectedExchange, launchTexts, breakpoints, project])
}

export const formatMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`)

export const formatCount = (n: number): string => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`)

export function formatClock(timestamp: number): string {
  const d = new Date(timestamp)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}
