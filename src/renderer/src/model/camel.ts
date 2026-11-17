// The route model.
//
// The YAML text of a route file is the single source of truth. The canvas reads a
// plain-JS snapshot of it and addresses every step by its path inside that snapshot
// (for example [0, 'route', 'from', 'steps', 2, 'choice', 'when', 0, 'steps', 1]).
// Edits are applied to the YAML document tree, not to the snapshot, so comments and
// formatting the team wrote by hand survive a visual edit.

import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLSeq } from 'yaml'
import type { CatalogIndex, ComponentDef, ComponentEntry, ModelDef } from '@shared/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Y = any
export type Path = (string | number)[]

export const pathKey = (p: Path): string => p.join('/')
export const samePath = (a: Path | null | undefined, b: Path | null | undefined): boolean =>
  !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i])

export function getAt(root: Y, path: Path): Y {
  let cur = root
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}

// ---------------------------------------------------------------- catalog --

export interface Catalog {
  index: CatalogIndex
  models: Record<string, ModelDef>
  components: Map<string, ComponentEntry>
  languages: Set<string>
  dataformats: Set<string>
  /** Expression languages and data formats, keyed the way the YAML DSL spells them. */
  languageList: { name: string; title: string }[]
  dataformatList: { name: string; title: string }[]
  /** Full component descriptors, loaded on demand. */
  defs: Record<string, ComponentDef>
}

export function buildCatalog(index: CatalogIndex, models: Record<string, ModelDef>): Catalog {
  // The YAML DSL names (`json`, `method`…) are the model names, which differ in places
  // from the artifact-level names in the language and data format catalogs.
  const named = (model: string, prop: string): { name: string; title: string }[] =>
    (models[model]?.properties.find((p) => p.name === prop)?.oneOf ?? [])
      .map((name) => ({ name, title: models[name]?.title ?? name }))
      .sort((a, b) => a.title.localeCompare(b.title))
  const languageList = named('setBody', 'expression')
  const dataformatList = named('marshal', 'dataFormatType')
  return {
    index,
    models,
    components: new Map(index.components.map((c) => [c.name, c])),
    languages: new Set(languageList.map((l) => l.name)),
    dataformats: new Set(dataformatList.map((d) => d.name)),
    languageList,
    dataformatList,
    defs: {}
  }
}

// ---------------------------------------------------------------- parsing --

export interface ParsedFile {
  js: Y[] | null
  error: string | null
}

export function parseRoutes(text: string): ParsedFile {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    const e = doc.errors[0]
    const line = e.linePos?.[0]?.line
    return { js: null, error: `${line ? `Line ${line}: ` : ''}${e.message.split('\n')[0]}` }
  }
  const js = doc.toJS()
  if (js == null) return { js: [], error: null }
  if (!Array.isArray(js)) return { js: null, error: 'A Camel YAML DSL file must be a list (routes, beans, rest…) at the top level.' }
  return { js, error: null }
}

/** Character range of the node at `path`, used to reveal a step in the source view. */
export function rangeOf(text: string, path: Path): [number, number] | null {
  const node = parseDocument(text).getIn(path, true) as { range?: [number, number, number] } | undefined
  return node?.range ? [node.range[0], node.range[1]] : null
}

// ---------------------------------------------------------------- editing --

export class YamlEditor {
  private readonly doc: Document

  constructor(doc: Document) {
    this.doc = doc
  }

  js(path: Path = []): Y {
    return getAt(this.doc.toJS(), path)
  }

  set(path: Path, value: Y): void {
    this.doc.setIn(path, this.doc.createNode(value))
  }

  del(path: Path): void {
    if (this.doc.hasIn(path)) this.doc.deleteIn(path)
  }

  private seq(seqPath: Path): YAMLSeq {
    let node = this.doc.getIn(seqPath)
    if (!isSeq(node)) {
      this.set(seqPath, [])
      node = this.doc.getIn(seqPath)
    }
    const seq = node as YAMLSeq
    seq.flow = false
    return seq
  }

  insert(seqPath: Path, index: number, value: Y): void {
    const seq = this.seq(seqPath)
    seq.items.splice(Math.max(0, Math.min(index, seq.items.length)), 0, this.doc.createNode(value))
  }

  remove(seqPath: Path, index: number): void {
    const seq = this.seq(seqPath)
    if (index >= 0 && index < seq.items.length) seq.items.splice(index, 1)
  }

  move(seqPath: Path, from: number, to: number): void {
    const seq = this.seq(seqPath)
    if (from < 0 || from >= seq.items.length || to < 0 || to >= seq.items.length) return
    const [item] = seq.items.splice(from, 1)
    seq.items.splice(to, 0, item)
  }

  /** Renames a map key in place so the entry keeps its position and comments. */
  renameKey(mapPath: Path, from: string, to: string): boolean {
    const map = this.doc.getIn(mapPath)
    if (!isMap(map)) return false
    const pair = map.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === from)
    if (!pair) return false
    pair.key = this.doc.createNode(to)
    return true
  }

  /** Expands a shorthand step such as `to: "direct:a"` so individual options can be set. */
  ensureObject(valuePath: Path, kind: string): void {
    const current = this.js(valuePath)
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      this.set(valuePath, normalizeValue(kind, current))
    }
  }
}

export function editYaml(text: string, fn: (e: YamlEditor) => void): string {
  const doc = parseDocument(text)
  if (doc.contents == null) doc.contents = doc.createNode([]) as Y
  fn(new YamlEditor(doc))
  return doc.toString({ lineWidth: 0 })
}

// ------------------------------------------------------------------ steps --

export const ENDPOINT_KINDS = new Set(['from', 'to', 'toD', 'wireTap', 'poll'])

/** `- log: "text"` style shorthands: which option the bare string stands for. */
const SHORTHAND: Record<string, string> = {
  from: 'uri',
  to: 'uri',
  toD: 'uri',
  wireTap: 'uri',
  poll: 'uri',
  log: 'message',
  removeHeader: 'name',
  removeHeaders: 'pattern',
  removeProperty: 'name',
  removeProperties: 'pattern',
  removeVariable: 'name',
  convertBodyTo: 'type',
  process: 'ref',
  kamelet: 'name'
}

export function stepKind(step: Y): string {
  return step && typeof step === 'object' && !Array.isArray(step) ? (Object.keys(step)[0] ?? '') : ''
}

export function normalizeValue(kind: string, raw: Y): Record<string, Y> {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    const key = SHORTHAND[kind]
    return key ? { [key]: String(raw) } : {}
  }
  return raw
}

export interface RouteEntry {
  /** Index of the top-level list item. */
  index: number
  rootKey: string
  isRoute: boolean
  id: string
  description: string | null
  /** Path to the `from` object, when this entry is a route. */
  fromPath: Path | null
  /** Path to the `route` object, when the route uses the wrapped form. */
  routePath: Path | null
}

export function listEntries(js: Y[]): RouteEntry[] {
  let unnamed = 0
  return js.map((item, index) => {
    const rootKey = stepKind(item)
    if (rootKey === 'route' && item.route && typeof item.route === 'object') {
      const r = item.route
      return {
        index,
        rootKey,
        isRoute: true,
        id: String(r.id ?? `route-${++unnamed}`),
        description: r.description ?? null,
        fromPath: [index, 'route', 'from'],
        routePath: [index, 'route']
      }
    }
    if (rootKey === 'from' && item.from && typeof item.from === 'object') {
      return {
        index,
        rootKey,
        isRoute: true,
        id: String(item.from.id ?? `route-${++unnamed}`),
        description: item.from.description ?? null,
        fromPath: [index, 'from'],
        routePath: null
      }
    }
    const v = item?.[rootKey]
    return {
      index,
      rootKey: rootKey || 'unknown',
      isRoute: false,
      id: String((v && typeof v === 'object' && (v.id ?? v.path ?? v.name)) || rootKey || 'entry'),
      description: null,
      fromPath: null,
      routePath: null
    }
  })
}

// -------------------------------------------------------------- endpoints --

export interface EndpointParts {
  scheme: string
  path: string
  params: Record<string, Y>
  /** True when options are written inside the URI query string rather than `parameters`. */
  hasQuery: boolean
}

export function parseEndpoint(value: Record<string, Y>): EndpointParts {
  const uri = String(value.uri ?? '')
  const q = uri.indexOf('?')
  const base = q >= 0 ? uri.slice(0, q) : uri
  const colon = base.indexOf(':')
  const params: Record<string, Y> = {}
  if (q >= 0) {
    for (const part of uri.slice(q + 1).split('&')) {
      if (!part) continue
      const eq = part.indexOf('=')
      params[eq >= 0 ? part.slice(0, eq) : part] = eq >= 0 ? part.slice(eq + 1) : ''
    }
  }
  if (value.parameters && typeof value.parameters === 'object') Object.assign(params, value.parameters)
  return {
    scheme: colon >= 0 ? base.slice(0, colon) : base,
    path: colon >= 0 ? base.slice(colon + 1) : '',
    params,
    hasQuery: q >= 0
  }
}

/** Writes scheme and path, moving any query-string options into `parameters`. */
export function writeEndpointBase(e: YamlEditor, valuePath: Path, kind: string, scheme: string, path: string): void {
  e.ensureObject(valuePath, kind)
  const parts = parseEndpoint(e.js(valuePath) ?? {})
  e.set([...valuePath, 'uri'], `${scheme}:${path}`)
  if (parts.hasQuery) e.set([...valuePath, 'parameters'], parts.params)
}

export function writeEndpointParam(e: YamlEditor, valuePath: Path, kind: string, name: string, value: Y): void {
  e.ensureObject(valuePath, kind)
  const parts = parseEndpoint(e.js(valuePath) ?? {})
  if (parts.hasQuery) {
    e.set([...valuePath, 'uri'], `${parts.scheme}:${parts.path}`)
    e.set([...valuePath, 'parameters'], parts.params)
  }
  if (value === undefined || value === '') {
    e.del([...valuePath, 'parameters', name])
    const left = e.js([...valuePath, 'parameters'])
    if (left && typeof left === 'object' && Object.keys(left).length === 0) e.del([...valuePath, 'parameters'])
  } else {
    e.set([...valuePath, 'parameters', name], value)
  }
}

// ------------------------------------------------------------ expressions --

export interface ExprValue {
  language: string
  text: string
  /** `inline`: the language key sits directly on the step. `nested`: under the property name. */
  where: 'inline' | 'nested'
}

function exprIn(holder: Y, languages: Set<string>, where: ExprValue['where']): ExprValue | null {
  if (!holder || typeof holder !== 'object') return null
  for (const key of Object.keys(holder)) {
    if (!languages.has(key)) continue
    const v = holder[key]
    return { language: key, text: v && typeof v === 'object' ? String(v.expression ?? '') : String(v ?? ''), where }
  }
  return null
}

export function readExpression(value: Y, prop: string, languages: Set<string>): ExprValue | null {
  if (!value || typeof value !== 'object') return null
  if (prop === 'expression') return exprIn(value.expression, languages, 'nested') ?? exprIn(value, languages, 'inline')
  const holder = value[prop]
  if (typeof holder === 'string') return { language: 'simple', text: holder, where: 'nested' }
  return exprIn(holder, languages, 'nested')
}

export function writeExpression(
  e: YamlEditor,
  valuePath: Path,
  prop: string,
  languages: Set<string>,
  language: string,
  text: string
): void {
  const prev = readExpression(e.js(valuePath), prop, languages)
  const holderPath = prev?.where === 'nested' || prop !== 'expression' ? [...valuePath, prop] : valuePath
  if (!prev) {
    if (prop === 'expression') e.set([...valuePath, language], expr(text))
    else e.set([...valuePath, prop], { [language]: expr(text) })
    return
  }
  if (typeof e.js(holderPath) === 'string') {
    e.set(holderPath, { [language]: expr(text) })
    return
  }
  if (prev.language !== language && !e.renameKey(holderPath, prev.language, language)) {
    e.del([...holderPath, prev.language])
  }
  const existing = e.js([...holderPath, language])
  if (existing && typeof existing === 'object') e.set([...holderPath, language, 'expression'], text)
  else e.set([...holderPath, language], text)
}

/**
 * An expression in the YAML DSL's canonical form. Camel also accepts the bare string
 * (`simple: "\${body}"`) but logs a "compact notation" warning for it at startup, so new
 * expressions are written the long way. Existing files keep whatever form they use.
 */
export const expr = (text: string): { expression: string } => ({ expression: text })

export function readDataFormat(value: Y, dataformats: Set<string>): string | null {
  if (!value || typeof value !== 'object') return null
  return Object.keys(value).find((k) => dataformats.has(k)) ?? null
}

// --------------------------------------------------------------- branches --

export interface BranchInfo {
  key: string
  /** Shown on the canvas above the branch. Null for a container's single, unnamed body. */
  label: string | null
  detail: string | null
  /** Catalog model that describes the branch itself (`when`, `doCatch`…), for the inspector. */
  model: string | null
  /** Path of the branch object relative to the step value; null for the main body. */
  ownerRel: Path | null
  stepsRel: Path
  removable: boolean
}

const short = (cls: string): string => String(cls).split('.').pop() ?? String(cls)

export function branchesOf(kind: string, value: Record<string, Y>, catalog: Catalog): BranchInfo[] {
  // A Data Mapper is one box on the canvas; the steps inside it are generated.
  if (isMapperStep(kind, value)) return []
  if (kind === 'choice') {
    const out: BranchInfo[] = []
    const whens: Y[] = Array.isArray(value.when) ? value.when : []
    whens.forEach((w, i) => {
      const expr = readExpression(w, 'expression', catalog.languages)
      out.push({
        key: `when-${i}`,
        label: 'when',
        detail: expr?.text || null,
        model: 'when',
        ownerRel: ['when', i],
        stepsRel: ['when', i, 'steps'],
        removable: true
      })
    })
    if (value.otherwise !== undefined) {
      out.push({
        key: 'otherwise',
        label: 'otherwise',
        detail: null,
        model: 'otherwise',
        ownerRel: ['otherwise'],
        stepsRel: ['otherwise', 'steps'],
        removable: true
      })
    }
    return out
  }
  if (kind === 'doTry') {
    const out: BranchInfo[] = [
      { key: 'try', label: 'try', detail: null, model: null, ownerRel: null, stepsRel: ['steps'], removable: false }
    ]
    const catches: Y[] = Array.isArray(value.doCatch) ? value.doCatch : []
    catches.forEach((c, i) => {
      const ex: string[] = Array.isArray(c?.exception) ? c.exception : []
      out.push({
        key: `catch-${i}`,
        label: 'catch',
        detail: ex.map(short).join(', ') || null,
        model: 'doCatch',
        ownerRel: ['doCatch', i],
        stepsRel: ['doCatch', i, 'steps'],
        removable: true
      })
    })
    if (value.doFinally !== undefined) {
      out.push({
        key: 'finally',
        label: 'finally',
        detail: null,
        model: 'doFinally',
        ownerRel: ['doFinally'],
        stepsRel: ['doFinally', 'steps'],
        removable: true
      })
    }
    return out
  }
  if (kind === 'circuitBreaker' && value.onFallback !== undefined) {
    return [
      { key: 'main', label: 'protected', detail: null, model: null, ownerRel: null, stepsRel: ['steps'], removable: false },
      {
        key: 'fallback',
        label: 'fallback',
        detail: null,
        model: 'onFallback',
        ownerRel: ['onFallback'],
        stepsRel: ['onFallback', 'steps'],
        removable: true
      }
    ]
  }
  if (catalog.models[kind]?.output) {
    return [{ key: 'main', label: null, detail: null, model: null, ownerRel: null, stepsRel: ['steps'], removable: false }]
  }
  return []
}

// ---------------------------------------------------------------- display --

export type Category = 'source' | 'endpoint' | 'routing' | 'transform' | 'error' | 'flow' | 'util'

export interface StepDisplay {
  title: string
  subtitle: string
  category: Category
  /** Small caps tag in the node corner, e.g. `to` vs `toD`. */
  tag: string | null
  /** Catalog label of the component, used to pick an icon. */
  componentLabel: string | null
  /** Component scheme for endpoint steps, otherwise null. */
  scheme: string | null
}

const UTIL_KINDS = new Set(['log', 'bean', 'process', 'script', 'step'])

export function categoryOf(kind: string, catalog: Catalog): Category {
  if (kind === MAPPER_ITEM) return 'transform'
  if (kind === 'from') return 'source'
  if (ENDPOINT_KINDS.has(kind) || kind === 'kamelet' || kind === 'enrich' || kind === 'pollEnrich') return 'endpoint'
  if (UTIL_KINDS.has(kind)) return 'util'
  const label = catalog.models[kind]?.label ?? ''
  if (/error|resilience/.test(label)) return 'error'
  if (/transformation|dataformat/.test(label)) return 'transform'
  if (/flowcontrol/.test(label)) return 'flow'
  if (/routing|aggregate|loadbalancing/.test(label)) return 'routing'
  return 'util'
}

export function describeStep(kind: string, value: Record<string, Y>, catalog: Catalog): StepDisplay {
  const model = catalog.models[kind]
  const category = categoryOf(kind, catalog)
  const base: StepDisplay = { title: model?.title ?? kind, subtitle: '', category, tag: null, componentLabel: null, scheme: null }
  if (isMapperStep(kind, value)) return { ...base, title: 'Data Mapper', subtitle: mapperName(value), category: 'transform' }

  if (ENDPOINT_KINDS.has(kind)) {
    const ep = parseEndpoint(value)
    const comp = catalog.components.get(ep.scheme)
    return {
      title: comp?.title ?? (ep.scheme || 'Endpoint'),
      subtitle: ep.path || (ep.scheme ? '' : String(value.uri ?? '')),
      category,
      tag: kind === 'to' || kind === 'from' ? null : kind,
      componentLabel: comp?.label ?? null,
      scheme: ep.scheme
    }
  }

  const expr = model?.properties.some((p) => p.kind === 'expression' && p.name === 'expression')
    ? readExpression(value, 'expression', catalog.languages)
    : null

  switch (kind) {
    case 'log':
      return { ...base, subtitle: String(value.message ?? '') }
    case 'setHeader':
    case 'setProperty':
    case 'setVariable':
      return { ...base, subtitle: `${value.name ?? '?'} = ${expr?.text ?? ''}` }
    case 'removeHeader':
    case 'removeProperty':
    case 'removeVariable':
      return { ...base, subtitle: String(value.name ?? '') }
    case 'removeHeaders':
    case 'removeProperties':
      return { ...base, subtitle: String(value.pattern ?? '') }
    case 'marshal':
    case 'unmarshal':
      return { ...base, subtitle: readDataFormat(value, catalog.dataformats) ?? '' }
    case 'convertBodyTo':
      return { ...base, subtitle: short(String(value.type ?? '')) }
    case 'bean':
      return { ...base, subtitle: [value.ref ?? short(String(value.beanType ?? '')), value.method].filter(Boolean).join('.') }
    case 'process':
      return { ...base, subtitle: String(value.ref ?? '') }
    case 'kamelet':
      return { ...base, subtitle: String(value.name ?? '') }
    case 'throwException':
      return { ...base, subtitle: short(String(value.exceptionType ?? value.ref ?? '')) }
    default:
      return { ...base, subtitle: expr?.text ?? '' }
  }
}

/** Catalog models that are structural parts of other steps, not steps of their own. */
const NOT_STEPS = new Set(['from', 'when', 'otherwise', 'doCatch', 'doFinally', 'onFallback', 'route', 'onException', 'onCompletion', 'intercept', 'interceptFrom', 'interceptSendToEndpoint'])

/** Names of the processors (EIPs) that can be added as a step. */
export function paletteEips(catalog: Catalog): string[] {
  return catalog.index.eips
    .filter((m) => !NOT_STEPS.has(m.name) && !m.deprecated && m.input && (m.label.split(',').includes('eip') || m.name === 'throwException'))
    .map((m) => m.name)
}

// -------------------------------------------------------------- templates --

export type PaletteItem = { type: 'eip'; name: string } | { type: 'component'; name: string } | { type: 'snippet'; id: string }

// ------------------------------------------------------------ data mapper --
//
// A Data Mapper step is a `step` with an id starting `datamapper-`. Its steps are generated:
// an xslt-saxon call to the stylesheet, plus (for JSON input) moving the body into a variable,
// because XSLT reads XML documents and JSON is handed to the stylesheet as a parameter.

export const MAPPER_ITEM = 'camel-studio-datamapper'
export const MAPPER_PREFIX = 'datamapper-'
export const MAPPER_VARIABLE = 'CamelStudioSourceJson'

export const isMapperStep = (kind: string, value: Record<string, Y> | null | undefined): boolean =>
  kind === 'step' && typeof value?.id === 'string' && value.id.startsWith(MAPPER_PREFIX)

export const mapperName = (value: Record<string, Y>): string => String(value.id ?? '').slice(MAPPER_PREFIX.length)

export const mapperXslPath = (name: string): string => `mappings/${name}.xsl`

export function mapperInnerSteps(name: string, sourceFormat: 'xml' | 'json'): Y[] {
  const call = { to: { uri: `xslt-saxon:${mapperXslPath(name)}` } }
  if (sourceFormat === 'xml') return [call]
  return [
    // A body an earlier step already parsed (unmarshal json) is a Map or List: turn it back into JSON text.
    {
      choice: {
        when: [
          {
            simple: { expression: "${body} is 'java.util.Map' || ${body} is 'java.util.List'" },
            steps: [{ marshal: { json: { library: 'Jackson' } } }]
          }
        ]
      }
    },
    { setVariable: { name: MAPPER_VARIABLE, simple: { expression: '${bodyAs(String)}' } } },
    { setBody: { constant: { expression: '<camel-studio/>' } } },
    call,
    { removeVariable: { name: MAPPER_VARIABLE } }
  ]
}

export function mapperStep(name: string, sourceFormat: 'xml' | 'json'): Y {
  return { step: { id: `${MAPPER_PREFIX}${name}`, description: `Data Mapper: ${name}`, steps: mapperInnerSteps(name, sourceFormat) } }
}

/** Every Data Mapper step in a file, by name, with its path. */
export function findMapperSteps(js: Y[]): { name: string; path: Path }[] {
  const out: { name: string; path: Path }[] = []
  const visit = (node: Y, path: Path): void => {
    if (Array.isArray(node)) return node.forEach((n, i) => visit(n, [...path, i]))
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (k === 'step' && isMapperStep('step', v as Record<string, Y>)) out.push({ name: mapperName(v as Record<string, Y>), path })
      visit(v, [...path, k])
    }
  }
  visit(js, [])
  return out
}

export function newStep(item: PaletteItem, catalog: Catalog): Y {
  if (item.type === 'snippet') return { log: { message: '${body}' } }
  if (item.type === 'component') return { to: { uri: `${item.name}:` } }
  const kind = item.name
  switch (kind) {
    case 'log':
      return { log: { message: '${body}' } }
    case 'choice':
      return { choice: { when: [{ simple: expr('${body} != null'), steps: [] }], otherwise: { steps: [] } } }
    case 'doTry':
      return { doTry: { steps: [], doCatch: [{ exception: ['java.lang.Exception'], steps: [] }] } }
    case 'circuitBreaker':
      return { circuitBreaker: { steps: [], onFallback: { steps: [] } } }
    case 'marshal':
    case 'unmarshal':
      return { [kind]: { json: {} } }
    case 'setHeader':
    case 'setProperty':
    case 'setVariable':
      return { [kind]: { name: '', simple: expr('') } }
    case 'to':
    case 'toD':
    case 'wireTap':
    case 'poll':
      return { [kind]: { uri: 'direct:' } }
    case 'split':
      return { split: { simple: expr('${body}'), steps: [] } }
    case 'convertBodyTo':
      return { convertBodyTo: { type: 'java.lang.String' } }
  }
  const model = catalog.models[kind]
  const value: Record<string, Y> = {}
  if (model?.properties.some((p) => p.kind === 'expression' && p.name === 'expression' && p.required)) value.simple = expr('')
  if (model?.output) value.steps = []
  return { [kind]: value }
}

export function newRoute(id: string): Y {
  return { route: { id, from: { uri: `direct:${id}`, steps: [{ log: { message: '${body}' } }] } } }
}

// ------------------------------------------------------------- validation --

export interface Problem {
  /** Top-level entry the problem belongs to. */
  entryIndex: number
  /** Path of the step (or branch owner) to select when the problem is clicked. */
  path: Path
  message: string
}

function validateValue(kind: string, value: Record<string, Y>, path: Path, entryIndex: number, catalog: Catalog, out: Problem[]): void {
  const model = catalog.models[kind]
  const title = model?.title ?? kind
  if (ENDPOINT_KINDS.has(kind)) {
    const ep = parseEndpoint(value)
    if (!ep.scheme) {
      out.push({ entryIndex, path, message: `${title}: endpoint URI is empty` })
      return
    }
    if (ep.scheme.includes('{') || kind === 'toD') return
    const entry = catalog.components.get(ep.scheme)
    if (!entry) {
      out.push({ entryIndex, path, message: `Unknown component "${ep.scheme}"` })
      return
    }
    if (kind === 'from' && entry.producerOnly) out.push({ entryIndex, path, message: `${entry.title} cannot start a route (producer only)` })
    if (kind !== 'from' && kind !== 'poll' && entry.consumerOnly) {
      out.push({ entryIndex, path, message: `${entry.title} can only start a route (consumer only)` })
    }
    const def = catalog.defs[ep.scheme]
    if (!def) return
    if (!ep.path && def.properties.some((p) => p.kind === 'path' && p.required)) {
      out.push({ entryIndex, path, message: `${entry.title}: ${def.syntax.replace(/^[^:]+:/, '')} is required` })
    }
    for (const p of def.properties) {
      if (p.kind !== 'parameter' || !p.required) continue
      const role = p.label ?? ''
      if (kind === 'from' ? role.includes('producer') : role.includes('consumer')) continue
      const v = ep.params[p.name]
      if (v === undefined || v === '') out.push({ entryIndex, path, message: `${entry.title}: "${p.displayName ?? p.name}" is required` })
    }
    return
  }
  if (!model) {
    out.push({ entryIndex, path, message: `Unknown step "${kind}"` })
    return
  }
  for (const p of model.properties) {
    if (!p.required) continue
    if (p.kind === 'attribute') {
      const v = value[p.name]
      if (v === undefined || v === '') out.push({ entryIndex, path, message: `${title}: "${p.displayName ?? p.name}" is required` })
    } else if (p.kind === 'expression') {
      const ex = readExpression(value, p.name, catalog.languages)
      if (!ex || ex.text === '') out.push({ entryIndex, path, message: `${title}: expression is empty` })
    } else if (p.name === 'dataFormatType' && !readDataFormat(value, catalog.dataformats)) {
      out.push({ entryIndex, path, message: `${title}: choose a data format` })
    }
  }
}

function validateSteps(steps: Y, seqPath: Path, entryIndex: number, catalog: Catalog, out: Problem[]): void {
  if (!Array.isArray(steps)) return
  steps.forEach((step, i) => {
    const path = [...seqPath, i]
    const kind = stepKind(step)
    if (!kind) return
    const value = normalizeValue(kind, step[kind])
    validateValue(kind, value, path, entryIndex, catalog, out)
    for (const b of branchesOf(kind, value, catalog)) {
      if (b.model === 'when' && b.ownerRel) {
        const ex = readExpression(getAt(value, b.ownerRel), 'expression', catalog.languages)
        if (!ex || ex.text === '') out.push({ entryIndex, path: [...path, kind, ...b.ownerRel], message: 'When: condition is empty' })
      }
      validateSteps(getAt(value, b.stepsRel), [...path, kind, ...b.stepsRel], entryIndex, catalog, out)
    }
  })
}

export function validate(js: Y[], catalog: Catalog): Problem[] {
  const out: Problem[] = []
  for (const entry of listEntries(js)) {
    if (!entry.fromPath) continue
    const from = normalizeValue('from', getAt(js, entry.fromPath))
    validateValue('from', from, entry.fromPath, entry.index, catalog, out)
    validateSteps(from.steps, [...entry.fromPath, 'steps'], entry.index, catalog, out)
  }
  return out
}

/** Component schemes used anywhere in the file: drives lazy catalog loading and pom.xml sync. */
export function usedSchemes(js: Y[]): string[] {
  const found = new Set<string>()
  const visit = (node: Y): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    for (const [key, v] of Object.entries(node)) {
      if (ENDPOINT_KINDS.has(key)) {
        const scheme = parseEndpoint(normalizeValue(key, v)).scheme
        if (scheme && /^[A-Za-z0-9+._-]+$/.test(scheme)) found.add(scheme)
      }
      visit(v)
    }
  }
  visit(js)
  return [...found]
}

// ------------------------------------------------------- source locations --

export interface LineTarget {
  kind: 'step' | 'branch'
  path: Path
}

/**
 * Maps 1-based source lines to the step defined there. Camel reports where a node came from
 * as `file.yaml:line` (the line its YAML map starts on), which is how live statistics, traced
 * messages and breakpoints find their node on the canvas without any ids in the YAML.
 */
export function lineIndex(text: string, catalog: Catalog): Map<number, LineTarget> {
  const index = new Map<number, LineTarget>()
  const doc = parseDocument(text)
  if (doc.errors.length > 0) return index
  const js = doc.toJS()
  if (!Array.isArray(js)) return index

  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1)
  const lineOf = (offset: number): number => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const add = (path: Path, kind: LineTarget['kind']): void => {
    const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined
    if (!node?.range) return
    const line = lineOf(node.range[0])
    if (!index.has(line)) index.set(line, { kind, path })
  }
  const walk = (steps: Y, seqPath: Path): void => {
    if (!Array.isArray(steps)) return
    steps.forEach((step, i) => {
      const path = [...seqPath, i]
      const kind = stepKind(step)
      if (!kind) return
      add(path, 'step')
      const value = normalizeValue(kind, step[kind])
      for (const b of branchesOf(kind, value, catalog)) {
        if (b.ownerRel) add([...path, kind, ...b.ownerRel], 'branch')
        walk(getAt(value, b.stepsRel), [...path, kind, ...b.stepsRel])
      }
    })
  }
  for (const entry of listEntries(js)) {
    if (!entry.fromPath) continue
    add(entry.fromPath, 'step')
    walk(getAt(js, [...entry.fromPath, 'steps']), [...entry.fromPath, 'steps'])
  }
  return index
}

/**
 * Maven artifacts the routes need beyond Camel core: one per component, expression language
 * and data format in use. Saving adds the matching Spring Boot starters to pom.xml.
 */
export function usedArtifacts(js: Y[], catalog: Catalog): string[] {
  const found = new Set<string>()
  const add = (artifactId: string | undefined): void => {
    if (artifactId && !artifactId.startsWith('camel-core') && artifactId !== 'camel-support') found.add(artifactId)
  }
  for (const scheme of usedSchemes(js)) add(catalog.components.get(scheme)?.artifactId)
  const languages = new Map(catalog.index.languages.map((l) => [l.name, l.artifactId]))
  const dataformats = new Map(catalog.index.dataformats.map((d) => [d.name.toLowerCase(), d.artifactId]))
  const JSON_LIBS: Record<string, string> = { Jackson: 'camel-jackson', Gson: 'camel-gson', Fastjson: 'camel-fastjson', Jsonb: 'camel-jsonb', Johnzon: 'camel-johnzon' }
  const visit = (node: Y): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    for (const [key, v] of Object.entries(node)) {
      if (catalog.languages.has(key)) add(languages.get(key === 'method' ? 'bean' : key))
      else if (key === 'json' && catalog.dataformats.has(key)) add(JSON_LIBS[String((v as Y)?.library ?? 'Jackson')] ?? 'camel-jackson')
      else if (catalog.dataformats.has(key)) add(dataformats.get(key.toLowerCase()))
      visit(v)
    }
  }
  visit(js)
  return [...found]
}
