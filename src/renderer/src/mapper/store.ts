import { create } from 'zustand'
import { findMapperSteps, mapperInnerSteps, MAPPER_PREFIX } from '@/model/camel'
import { useStudio } from '@/store'
import { connect as connectFields, emptyMapping, sourceFields, type MappingDef, type SchemaRef } from './model'
import { detectKind, indexFields, readSchema, sampleMessage, type Field, type SchemaKind, type SchemaTree } from './schema'
import { generateXslt, IDENTITY_XSLT } from './xslt'

import { mappingRel, SCHEMAS_DIR, xslRel } from './paths'

export { mappingRel, xslRel }

export type Side = 'source' | 'target'

export interface PreviewState {
  open: boolean
  running: boolean
  output: string
  error: string | null
  ms: number
  /** The output is from an older version of the mapping. */
  stale: boolean
}

interface MapperState {
  name: string | null
  def: MappingDef | null
  savedJson: string
  source: SchemaTree | null
  target: SchemaTree | null
  sourceError: string | null
  targetError: string | null
  past: MappingDef[]
  future: MappingDef[]
  selected: string | null
  sourceSelected: string | null
  collapsed: Record<string, boolean>
  preview: PreviewState
  pasteFor: Side | null

  open(name: string): Promise<void>
  close(): void
  change(fn: (def: MappingDef) => MappingDef): void
  undo(): void
  redo(): void
  select(key: string | null): void
  selectSource(key: string | null): void
  toggle(side: Side, key: string): void
  importSchema(side: Side): Promise<void>
  useSample(side: Side, text: string): Promise<void>
  setRoot(side: Side, root: string): Promise<void>
  removeSchema(side: Side): void
  connect(sourceKey: string, targetKey: string): void
  autoMap(): void
  setPaste(side: Side | null): void
  setSample(text: string): void
  setPreviewOpen(open: boolean): void
  runPreview(): Promise<void>
  save(): Promise<boolean>
  isDirty(): boolean
}

const studio = (): ReturnType<typeof useStudio.getState> => useStudio.getState()
const root = (): string => studio().project?.root ?? ''
const abs = (rel: string): string => `${root()}/${rel}`
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

async function loadTree(ref: SchemaRef | null): Promise<{ tree: SchemaTree | null; error: string | null }> {
  if (!ref) return { tree: null, error: null }
  try {
    const text = await window.studio.project.readFile(abs(ref.file))
    return { tree: readSchema(ref.kind, text, ref.root), error: null }
  } catch (e) {
    return { tree: null, error: `${ref.file}: ${message(e)}` }
  }
}

/** Opens the first levels of a tree; deeper levels start closed so large schemas stay readable. */
function initialCollapsed(tree: SchemaTree | null, prefix: string): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!tree) return out
  const walk = (f: Field, depth: number): void => {
    if (f.container && depth >= 4) out[prefix + f.key] = true
    f.children.forEach((c) => walk(c, depth + 1))
  }
  walk(tree.root, 0)
  return out
}

const PREVIEW_IDLE: PreviewState = { open: true, running: false, output: '', error: null, ms: 0, stale: false }
const HISTORY = 100
let previewSeq = 0

export const useMapper = create<MapperState>((set, get) => {
  const writeSchemaRef = async (side: Side, ref: SchemaRef): Promise<void> => {
    const { tree, error } = await loadTree(ref)
    if (!tree) {
      studio().notify(error ?? 'The file could not be read', 'error')
      return
    }
    get().change((d) => ({ ...d, [side]: ref, ...(side === 'source' ? { sample: undefined } : {}) }))
    set((s) => ({
      [side]: tree,
      [`${side}Error`]: null,
      collapsed: { ...s.collapsed, ...initialCollapsed(tree, `${side}:`) }
    }))
    if (tree.warnings.length) studio().notify(tree.warnings[0], 'info')
  }

  return {
    name: null,
    def: null,
    savedJson: '',
    source: null,
    target: null,
    sourceError: null,
    targetError: null,
    past: [],
    future: [],
    selected: null,
    sourceSelected: null,
    collapsed: {},
    preview: PREVIEW_IDLE,
    pasteFor: null,

    async open(name) {
      let def: MappingDef
      try {
        def = JSON.parse(await window.studio.project.readFile(abs(mappingRel(name)))) as MappingDef
      } catch {
        def = emptyMapping(name)
      }
      const [s, t] = await Promise.all([loadTree(def.source), loadTree(def.target)])
      set({
        name,
        def,
        savedJson: JSON.stringify(def),
        source: s.tree,
        target: t.tree,
        sourceError: s.error,
        targetError: t.error,
        past: [],
        future: [],
        selected: null,
        sourceSelected: null,
        collapsed: { ...initialCollapsed(s.tree, 'source:'), ...initialCollapsed(t.tree, 'target:') },
        preview: { ...PREVIEW_IDLE, open: get().preview.open },
        pasteFor: null
      })
    },

    close() {
      set({ name: null, def: null, source: null, target: null, past: [], future: [], selected: null, sourceSelected: null })
    },

    change(fn) {
      const def = get().def
      if (!def) return
      const next = fn(def)
      if (next === def) return
      set((s) => ({ def: next, past: [...s.past.slice(-HISTORY), def], future: [], preview: { ...s.preview, stale: true } }))
    },

    undo() {
      const { past, def } = get()
      if (!def || past.length === 0) return
      set((s) => ({ def: past[past.length - 1], past: past.slice(0, -1), future: [def, ...s.future], preview: { ...s.preview, stale: true } }))
    },

    redo() {
      const { future, def } = get()
      if (!def || future.length === 0) return
      set((s) => ({ def: future[0], future: future.slice(1), past: [...s.past, def], preview: { ...s.preview, stale: true } }))
    },

    select(selected) {
      set({ selected })
    },

    selectSource(sourceSelected) {
      set({ sourceSelected })
    },

    toggle(side, key) {
      set((s) => ({ collapsed: { ...s.collapsed, [`${side}:${key}`]: !s.collapsed[`${side}:${key}`] } }))
    },

    async importSchema(side) {
      const project = studio().project
      if (!project) return
      try {
        const file = await window.studio.project.importFile(project.root, SCHEMAS_DIR, side === 'source' ? 'Choose the input message structure' : 'Choose the output message structure')
        if (!file) return
        await writeSchemaRef(side, { file: file.rel, kind: detectKind(file.name, file.content) })
      } catch (e) {
        studio().notify(message(e), 'error')
      }
    },

    async useSample(side, text) {
      const name = get().name
      if (!name) return
      const kind: SchemaKind = detectKind('', text)
      try {
        readSchema(kind, text)
      } catch (e) {
        studio().notify(message(e), 'error')
        return
      }
      const ext = kind === 'xml-sample' || kind === 'xsd' ? (kind === 'xsd' ? 'xsd' : 'xml') : 'json'
      const rel = `${SCHEMAS_DIR}/${name}-${side}.${kind === 'json-schema' ? 'schema.json' : ext}`
      await window.studio.project.writeFile(abs(rel), text)
      await writeSchemaRef(side, { file: rel, kind })
      if (side === 'source' && (kind === 'xml-sample' || kind === 'json-sample')) get().setSample(text)
      set({ pasteFor: null })
    },

    async setRoot(side, rootName) {
      const ref = get().def?.[side]
      if (!ref) return
      await writeSchemaRef(side, { ...ref, root: rootName })
    },

    removeSchema(side) {
      get().change((d) => ({ ...d, [side]: null, rules: {} }))
      set({ [side]: null, [`${side}Error`]: null, selected: null, sourceSelected: null } as Partial<MapperState>)
    },

    connect(sourceKey, targetKey) {
      const { source, target, def } = get()
      if (!source || !target || !def) return
      const s = sourceFields(source, def).get(sourceKey)
      const t = indexFields(target.root).get(targetKey)
      if (!s || !t) return
      const result = connectFields(def, s, t)
      if (result.message) studio().notify(result.message, 'info')
      if (result.mapped > 0) {
        get().change(() => result.def)
        set({ selected: targetKey })
        if (result.mapped > 1) studio().notify(`Mapped ${result.mapped} fields by name.`, 'success')
      }
    },

    autoMap() {
      const { source, target } = get()
      if (!source || !target) return
      get().connect(source.root.key, target.root.key)
    },

    setPaste(pasteFor) {
      set({ pasteFor })
    },

    setSample(text) {
      get().change((d) => ({ ...d, sample: text }))
    },

    setPreviewOpen(open) {
      set((s) => ({ preview: { ...s.preview, open } }))
    },

    async runPreview() {
      const { def, source, target } = get()
      if (!def || !source || !target) return
      const input = def.sample ?? sampleMessage(source)
      if (def.sample === undefined) set((s) => ({ def: s.def ? { ...s.def, sample: input } : s.def }))
      const { xslt } = generateXslt(def, source, target, mappingRel(def.name))
      const seq = ++previewSeq
      set((s) => ({ preview: { ...s.preview, running: true } }))
      try {
        const params = (def.params ?? []).filter((p) => p.name.trim()).map((p) => ({ name: p.name, value: p.sample ?? '' }))
        const r = await window.studio.mapper.preview({ xslt, input, sourceFormat: source.format, params })
        if (seq !== previewSeq) return
        let output = r.output
        if (r.ok && target.format === 'json') {
          try {
            output = JSON.stringify(JSON.parse(output), null, 2)
          } catch {
            /* show as produced */
          }
        }
        set((s) => ({ preview: { ...s.preview, running: false, output: output.trim(), error: r.ok ? null : r.error, ms: r.ms, stale: false } }))
      } catch (e) {
        if (seq === previewSeq) set((s) => ({ preview: { ...s.preview, running: false, error: message(e), stale: false } }))
      }
    },

    isDirty() {
      const { def, savedJson } = get()
      return !!def && JSON.stringify(def) !== savedJson
    },

    /** Writes the mapping, its stylesheet, and the steps of the route step that runs it. */
    async save() {
      const { def, source, target, name } = get()
      if (!def || !name) return true
      try {
        await window.studio.project.writeFile(abs(mappingRel(name)), `${JSON.stringify(def, null, 2)}\n`)
        const xslt = source && target ? generateXslt(def, source, target, mappingRel(name)).xslt : IDENTITY_XSLT
        await window.studio.project.writeFile(abs(xslRel(name)), xslt)
        set({ savedJson: JSON.stringify(def) })
        syncRouteStep(name, source?.format ?? 'xml')
        return true
      } catch (e) {
        studio().notify(`The mapping could not be saved: ${message(e)}`, 'error')
        return false
      }
    }
  }
})

/** Keeps the generated steps inside the route's Data Mapper step in line with the input format. */
export function syncRouteStep(name: string, format: 'xml' | 'json'): void {
  const s = studio()
  const file = s.activePath ? s.files[s.activePath] : null
  if (!file?.js) return
  const wanted = JSON.stringify(mapperInnerSteps(name, format))
  for (const hit of findMapperSteps(file.js)) {
    if (hit.name !== name) continue
    const stepsPath = [...hit.path, 'step', 'steps']
    let current: unknown = file.js
    for (const k of stepsPath) current = (current as Record<string | number, unknown>)?.[k]
    if (JSON.stringify(current) !== wanted) s.edit((e) => e.set(stepsPath, mapperInnerSteps(name, format)))
  }
}

export const isMapperId = (id: unknown): boolean => typeof id === 'string' && id.startsWith(MAPPER_PREFIX)
