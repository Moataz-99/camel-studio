// The mapping model: what each target field gets, stored per target field.
//
// A rule is attached to a target field (by key) and may say:
//   forEach   the field repeats once per item of a source collection (optionally sorted)
//   value     the field's value: a source field, a formula (XPath), a constant, a choice
//             between values by condition, or a copy of a whole source structure
//   condition the field is only written when an XPath test is true
// Inputs are the message body plus any headers, variables or exchange properties the mapping
// declares as parameters; Camel hands all of those to the stylesheet by name.
// Source fields are stored by path, never as XPath text, so the XPath can be recomputed
// relative to whichever loop the field ends up inside.

import { fieldKey, indexFields, type Field, type MessageFormat, type SchemaKind, type SchemaTree } from './schema'

export type SimpleValue = { kind: 'field'; source: string[] } | { kind: 'formula'; expr: string } | { kind: 'constant'; text: string }

export interface ChooseCase {
  test: string
  value: SimpleValue
}

export type ValueRule =
  | SimpleValue
  /** choose / when / otherwise: the first case whose test is true gives the value. */
  | { kind: 'choose'; cases: ChooseCase[]; otherwise?: SimpleValue }
  /** XML to XML: the content of a source structure, copied as it is. */
  | { kind: 'copy'; source: string[] }

export interface SortKey {
  /** A field of the loop item, or a formula. */
  source?: string[]
  expr?: string
  order: 'ascending' | 'descending'
  type: 'text' | 'number'
}

export interface TargetRule {
  value?: ValueRule
  forEach?: string[]
  sort?: SortKey[]
  condition?: string
}

export type ParamKind = 'header' | 'variable' | 'property'

export interface Param {
  name: string
  kind: ParamKind
  /** Value used by the live preview. */
  sample?: string
}

export interface SchemaRef {
  /** Path relative to the project root. */
  file: string
  kind: SchemaKind
  /** XSD only: chosen root element. */
  root?: string
}

export interface MappingDef {
  version: 1
  name: string
  source: SchemaRef | null
  target: SchemaRef | null
  rules: Record<string, TargetRule>
  /** Headers, variables and properties used as extra inputs. */
  params?: Param[]
  /** Input used by the live preview. */
  sample?: string
}

/** Parameters are addressed as fields under this pseudo root: ['$', name]. */
export const PARAM_ROOT = '$'
export const PARAM_NAME = /^[A-Za-z_][\w.-]*$/

export function paramField(p: Param): Field {
  const segs = [PARAM_ROOT, p.name]
  return { key: fieldKey(segs), name: p.name, segs, type: 'string', container: false, text: true, repeating: false, attribute: false, ns: '', required: false, example: p.sample, doc: `${p.kind} ${p.name}`, children: [] }
}

/** Every input field by key: the body tree plus the declared parameters. */
export function sourceFields(source: SchemaTree, def: MappingDef): Map<string, Field> {
  const m = indexFields(source.root)
  for (const p of def.params ?? []) {
    const f = paramField(p)
    m.set(f.key, f)
  }
  return m
}

/** Source fields a value reads, for drawing lines and checking for stale references. */
export function valueSources(v: ValueRule | undefined): string[][] {
  if (!v) return []
  if (v.kind === 'field' || v.kind === 'copy') return [v.source]
  if (v.kind === 'choose') return [...v.cases.map((c) => c.value), ...(v.otherwise ? [v.otherwise] : [])].flatMap((sv) => (sv.kind === 'field' ? [sv.source] : []))
  return []
}

export const emptyMapping = (name: string): MappingDef => ({ version: 1, name, source: null, target: null, rules: {} })

// ------------------------------------------------------------- source XPath --

/** Prefixes for the namespaces used by an XML source, declared on the stylesheet. */
export function sourcePrefixes(tree: SchemaTree | null): Map<string, string> {
  const m = new Map<string, string>()
  if (!tree || tree.format !== 'xml') return m
  const walk = (f: Field): void => {
    if (f.ns && !m.has(f.ns)) m.set(f.ns, `s${m.size}`)
    f.children.forEach(walk)
  }
  walk(tree.root)
  return m
}

const NCNAME = /^[A-Za-z_][\w.-]*$/

function xmlStep(seg: string, prefixes: Map<string, string>): string {
  const attr = seg.startsWith('@')
  const body = attr ? seg.slice(1) : seg
  const m = body.match(/^\{(.*)\}(.+)$/)
  const name = m ? `${prefixes.get(m[1]) ?? 's'}:${m[2]}` : body
  return attr ? `@${name}` : name
}

const jsonStep = (seg: string): string => (seg === '*' ? '?*' : NCNAME.test(seg) ? `?${seg}` : `?('${seg.replace(/'/g, "''")}')`)

const isPrefix = (p: string[], of: string[]): boolean => p.length <= of.length && p.every((s, i) => s === of[i])

/**
 * XPath that reads a source field. `context` is the source collection item the expression runs
 * inside (the innermost loop), or null at the top level.
 */
export function sourceXPath(format: MessageFormat, segs: string[], context: string[] | null, prefixes: Map<string, string>): string {
  if (segs[0] === PARAM_ROOT) return '$' + segs[1]
  if (format === 'json') {
    if (context && isPrefix(context, segs)) return `.${segs.slice(context.length).map(jsonStep).join('')}` || '.'
    return `$src${segs.map(jsonStep).join('')}`
  }
  if (context && isPrefix(context, segs)) {
    const rest = segs.slice(context.length)
    return rest.length === 0 ? '.' : rest.map((s) => xmlStep(s, prefixes)).join('/')
  }
  return `/${segs.map((s) => xmlStep(s, prefixes)).join('/')}`
}

/** The source collection the target field is inside: the forEach of itself or its nearest ancestor. */
export function loopContext(def: MappingDef, target: Field, targetIndex: Map<string, Field>): string[] | null {
  for (let segs = target.segs; ; segs = segs.slice(0, -1)) {
    const rule = def.rules[fieldKey(segs)]
    if (rule?.forEach && targetIndex.has(fieldKey(segs))) return rule.forEach
    if (segs.length === 0) return null
  }
}

/** Loop context for the children of a field (its own loop counts). */
export function childContext(def: MappingDef, target: Field, targetIndex: Map<string, Field>): string[] | null {
  return loopContext(def, target, targetIndex)
}

// ---------------------------------------------------------------- editing --

export type Rules = Record<string, TargetRule>

function setRule(rules: Rules, key: string, patch: Partial<TargetRule> | null): Rules {
  const next = { ...rules }
  const merged: TargetRule = patch === null ? {} : { ...(next[key] ?? {}), ...patch }
  for (const k of Object.keys(merged) as (keyof TargetRule)[]) if (merged[k] === undefined) delete merged[k]
  if (Object.keys(merged).length === 0) delete next[key]
  else next[key] = merged
  return next
}

export function updateRule(def: MappingDef, key: string, patch: Partial<TargetRule> | null): MappingDef {
  return { ...def, rules: setRule(def.rules, key, patch) }
}

/** Removes the rules of a field and everything under it. */
export function clearSubtree(def: MappingDef, target: Field): MappingDef {
  const rules = { ...def.rules }
  const walk = (f: Field): void => {
    delete rules[f.key]
    f.children.forEach(walk)
  }
  walk(target)
  return { ...def, rules }
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** For a JSON array the collection is its item field; an XML repeating element is its own collection. */
const collectionItem = (f: Field): Field | null => (f.repeating ? f : f.type === 'array' && f.children[0]?.repeating ? f.children[0] : null)

export interface ConnectResult {
  def: MappingDef
  /** How many target fields got a rule. */
  mapped: number
  message: string | null
}

/**
 * What dropping a source field on a target field does:
 *  value onto value             the target takes the source value
 *  collection onto collection   repeat the target per source item, then match children by name
 *  structure onto structure     match children by name
 */
export function connect(def: MappingDef, src: Field, tgt: Field): ConnectResult {
  let rules = def.rules
  let mapped = 0

  const pair = (s: Field, t: Field, depth: number): void => {
    const sItem = collectionItem(s)
    const tItem = collectionItem(t)
    if (sItem && tItem) {
      rules = setRule(rules, tItem.key, { forEach: sItem.segs })
      mapped++
      if (tItem.text && !tItem.container && sItem.text) {
        rules = setRule(rules, tItem.key, { value: { kind: 'field', source: sItem.segs } })
      } else if (tItem.container && sItem.container) {
        children(sItem, tItem, depth + 1)
      }
      return
    }
    if (t.text && !t.container && s.text) {
      rules = setRule(rules, t.key, { value: { kind: 'field', source: s.segs } })
      mapped++
      return
    }
    if (t.container && s.container) {
      if (t.text && s.text) {
        rules = setRule(rules, t.key, { value: { kind: 'field', source: s.segs } })
        mapped++
      }
      children(s, t, depth + 1)
    }
  }

  const children = (s: Field, t: Field, depth: number): void => {
    if (depth > 30) return
    for (const tc of t.children) {
      const sc = s.children.find((c) => norm(c.name) === norm(tc.name) && c.attribute === tc.attribute) ?? s.children.find((c) => norm(c.name) === norm(tc.name))
      if (sc) pair(sc, tc, depth)
    }
  }

  if (!src.text && !src.container) return { def, mapped: 0, message: null }
  if (tgt.container && !tgt.text && !src.container && !collectionItem(tgt)) {
    return { def, mapped: 0, message: `${tgt.name} is a structure: drop a source structure on it, or map its fields one by one.` }
  }
  if (src.container && !src.text && !tgt.container && !collectionItem(src)) {
    return { def, mapped: 0, message: `${src.name} is a structure: drop it on a target structure, or map its fields one by one.` }
  }
  pair(src, tgt, 0)
  if (mapped === 0 && src.container && tgt.container) return { def, mapped: 0, message: `No fields with matching names under ${src.name} and ${tgt.name}.` }
  return { def: { ...def, rules }, mapped, message: null }
}

// -------------------------------------------------------------- inspection --

export interface RuleLine {
  source: string
  target: string
  kind: 'value' | 'loop'
}

/** The lines drawn between the trees. */
export function ruleLines(def: MappingDef): RuleLine[] {
  const out: RuleLine[] = []
  for (const [target, rule] of Object.entries(def.rules)) {
    if (rule.forEach) out.push({ source: fieldKey(rule.forEach), target, kind: 'loop' })
    for (const s of valueSources(rule.value)) out.push({ source: fieldKey(s), target, kind: 'value' })
  }
  return out
}

/** Rules that point at fields the current schemas no longer have. */
export function orphanRules(def: MappingDef, source: SchemaTree | null, target: SchemaTree | null): string[] {
  if (!source || !target) return []
  const s = sourceFields(source, def)
  const t = indexFields(target.root)
  return Object.entries(def.rules)
    .filter(([key, r]) => !t.has(key) || (r.forEach && !s.has(fieldKey(r.forEach))) || valueSources(r.value).some((v) => !s.has(fieldKey(v))))
    .map(([key]) => key)
}

/**
 * Required output fields that will be written empty or not at all: required leaves without a
 * value, whose parents are all either required or mapped (an optional structure left out is fine).
 */
export function missingRequired(def: MappingDef, target: SchemaTree): Field[] {
  const out: Field[] = []
  const walk = (f: Field, reachable: boolean): void => {
    const here = reachable && (f.required || f.segs.length === 0 || hasRules(def, f))
    if (!here) return
    if (inheritsValue(def, f)) return
    if (f.text && !f.container && f.required && !def.rules[f.key]?.value) out.push(f)
    f.children.forEach((c) => walk(c, here))
  }
  walk(target.root, true)
  return out
}

/** A copy on the field or an ancestor fills everything under it. */
function inheritsValue(def: MappingDef, f: Field): boolean {
  for (let i = f.segs.length; i >= 0; i--) if (def.rules[fieldKey(f.segs.slice(0, i))]?.value?.kind === 'copy') return true
  return false
}

/** True when the field or something below it has a rule. */
export function hasRules(def: MappingDef, f: Field): boolean {
  if (def.rules[f.key]) return true
  return f.children.some((c) => hasRules(def, c))
}
