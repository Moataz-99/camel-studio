// Message structures for the Data Mapper.
//
// Every input (an XSD, a JSON Schema, or a sample XML or JSON message) is turned into the same
// tree of fields. A field is addressed by its path segments from the root:
//   XML:  `{namespace}local` for an element, `@{namespace}local` for an attribute
//   JSON: the property key, or `*` for the items of an array
// The mapping model, the XSLT generator and the UI all work on this one shape.

export type MessageFormat = 'xml' | 'json'
export type SchemaKind = 'xsd' | 'json-schema' | 'xml-sample' | 'json-sample'

export interface Field {
  /** Stable id: JSON of `segs`. Namespace URIs contain slashes, so a plain join is not safe. */
  key: string
  name: string
  segs: string[]
  /** `string`, `number`, `integer`, `boolean`, `object`, `array`, `null`, or an XSD type name. */
  type: string
  /** Has child fields. */
  container: boolean
  /** Carries a value of its own: every leaf, and XML elements with text plus attributes. */
  text: boolean
  /** Occurs many times: an XML element with maxOccurs > 1, or the items of a JSON array. */
  repeating: boolean
  attribute: boolean
  ns: string
  required: boolean
  example?: string
  doc?: string
  children: Field[]
}

export interface SchemaTree {
  format: MessageFormat
  root: Field
  /** XML only: global elements the schema defines, for choosing the root. */
  roots: string[]
  warnings: string[]
}

export const fieldKey = (segs: string[]): string => JSON.stringify(segs)

// ------------------------------------------------------------------ XML DOM --

type XmlParser = (text: string) => Document
let xmlParser: XmlParser | null = null

/** Lets tests running outside a browser supply their own DOM parser. */
export function setXmlParser(parser: XmlParser): void {
  xmlParser = parser
}

function parseXml(text: string): Document {
  const doc = xmlParser ? xmlParser(text) : new DOMParser().parseFromString(text, 'application/xml')
  const err = doc.getElementsByTagName('parsererror')[0]
  if (err) throw new Error(`Not well-formed XML: ${(err.textContent ?? '').trim().split('\n')[0]}`)
  if (!doc.documentElement) throw new Error('The XML document is empty')
  return doc
}

const elementsOf = (node: Node): Element[] => {
  const out: Element[] = []
  for (let n = node.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as Element)
  return out
}

const XS = 'http://www.w3.org/2001/XMLSchema'
const local = (qname: string | null): string => (qname ?? '').split(':').pop() ?? ''
const clark = (ns: string, name: string): string => (ns ? `{${ns}}${name}` : name)

function makeField(parent: string[], seg: string, name: string, props: Partial<Field>): Field {
  const segs = [...parent, seg]
  return {
    key: fieldKey(segs),
    name,
    segs,
    type: 'string',
    container: false,
    text: true,
    repeating: false,
    attribute: false,
    ns: '',
    required: false,
    children: [],
    ...props
  }
}

// --------------------------------------------------------------- XML sample --

function fromXmlSample(text: string): SchemaTree {
  const doc = parseXml(text)

  /** Merges every occurrence of same-named siblings into one field, so optional parts are not lost. */
  const build = (els: Element[], parent: string[], repeating: boolean): Field => {
    const first = els[0]
    const ns = first.namespaceURI ?? ''
    const name = first.localName ?? first.nodeName
    const field = makeField(parent, clark(ns, name), name, { ns, repeating })
    const segs = field.segs

    const attrs = new Map<string, Field>()
    const groups = new Map<string, Element[]>()
    const counts = new Map<string, number>()
    let hasText = false
    for (const el of els) {
      for (let i = 0; i < el.attributes.length; i++) {
        const a = el.attributes[i]
        if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue
        const aNs = a.namespaceURI ?? ''
        const aName = a.localName ?? a.name
        const seg = `@${clark(aNs, aName)}`
        if (!attrs.has(seg)) attrs.set(seg, makeField(segs, seg, aName, { ns: aNs, attribute: true, example: a.value }))
      }
      const perParent = new Map<string, number>()
      for (const child of elementsOf(el)) {
        const k = clark(child.namespaceURI ?? '', child.localName ?? child.nodeName)
        groups.set(k, [...(groups.get(k) ?? []), child])
        perParent.set(k, (perParent.get(k) ?? 0) + 1)
      }
      for (const [k, n] of perParent) counts.set(k, Math.max(counts.get(k) ?? 0, n))
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if ((n.nodeType === 3 || n.nodeType === 4) && (n.nodeValue ?? '').trim() !== '') hasText = true
      }
    }

    field.children = [...attrs.values(), ...[...groups].map(([k, list]) => build(list, segs, (counts.get(k) ?? 0) > 1))]
    field.container = field.children.length > 0
    field.text = hasText || !field.container
    if (field.text && !field.container) field.example = (first.textContent ?? '').trim().slice(0, 80)
    field.type = field.container ? 'element' : 'string'
    return field
  }

  const root = build([doc.documentElement], [], false)
  return { format: 'xml', root, roots: [root.name], warnings: [] }
}

// ---------------------------------------------------------------------- XSD --

function fromXsd(text: string, rootName?: string): SchemaTree {
  const doc = parseXml(text)
  const schema = doc.documentElement
  if (schema.namespaceURI !== XS || schema.localName !== 'schema') throw new Error('This is not an XML Schema (no xs:schema root)')
  const tns = schema.getAttribute('targetNamespace') ?? ''
  const qualified = schema.getAttribute('elementFormDefault') === 'qualified'
  const attrQualified = schema.getAttribute('attributeFormDefault') === 'qualified'
  const warnings: string[] = []

  const globals = (kind: string): Map<string, Element> => {
    const m = new Map<string, Element>()
    for (const el of elementsOf(schema)) if (el.namespaceURI === XS && el.localName === kind && el.getAttribute('name')) m.set(el.getAttribute('name') as string, el)
    return m
  }
  const elements = globals('element')
  const complexTypes = globals('complexType')
  const simpleTypes = globals('simpleType')
  const groups = globals('group')
  const attributeGroups = globals('attributeGroup')
  for (const el of elementsOf(schema)) {
    if (el.namespaceURI === XS && (el.localName === 'include' || el.localName === 'import')) {
      warnings.push(`xs:${el.localName} of "${el.getAttribute('schemaLocation') ?? ''}" is not followed; types from it appear as text fields`)
    }
  }
  if (elements.size === 0) throw new Error('The schema defines no global element to use as the message root')
  const roots = [...elements.keys()]
  const rootEl = elements.get(rootName ?? '') ?? elements.get(roots[0]) as Element

  const xs = (el: Element, name: string): Element[] => elementsOf(el).filter((c) => c.namespaceURI === XS && c.localName === name)
  const simpleBase = (st: Element | undefined, seen = 0): string => {
    if (!st || seen > 10) return 'string'
    const r = xs(st, 'restriction')[0]
    const base = r?.getAttribute('base')
    if (!base) return 'string'
    const named = simpleTypes.get(local(base))
    return named && !base.startsWith('xs:') && !base.startsWith('xsd:') ? simpleBase(named, seen + 1) : local(base)
  }
  const isBuiltin = (qname: string): boolean => /^(xs|xsd):/.test(qname) || (!complexTypes.has(local(qname)) && !simpleTypes.has(local(qname)))

  const occursMany = (el: Element): boolean => {
    const max = el.getAttribute('maxOccurs')
    return max === 'unbounded' || (max !== null && Number(max) > 1)
  }

  const buildElement = (decl: Element, parent: string[], global: boolean, depth: number, stack: string[], inheritedMany: boolean): Field | null => {
    let el = decl
    const ref = decl.getAttribute('ref')
    if (ref) {
      const target = elements.get(local(ref))
      if (!target) {
        warnings.push(`Element reference "${ref}" not found`)
        return null
      }
      el = target
      global = true
    }
    const name = el.getAttribute('name') ?? ''
    const ns = global || qualified || decl.getAttribute('form') === 'qualified' ? tns : ''
    const field = makeField(parent, clark(ns, name), name, {
      ns,
      repeating: occursMany(decl) || inheritedMany,
      required: decl.getAttribute('minOccurs') !== '0',
      doc: xs(el, 'annotation')[0]?.textContent?.trim() || undefined
    })
    const type = el.getAttribute('type')
    if (type && isBuiltin(type)) {
      field.type = local(type)
      return field
    }
    if (type && simpleTypes.has(local(type))) {
      field.type = simpleBase(simpleTypes.get(local(type)))
      return field
    }
    const ct = type ? complexTypes.get(local(type)) : xs(el, 'complexType')[0]
    const st = !type ? xs(el, 'simpleType')[0] : undefined
    if (st) {
      field.type = simpleBase(st)
      return field
    }
    if (!ct) return field // no type at all: anyType, treated as text
    const typeId = type ? `type:${local(type)}` : ''
    if (depth > 14 || (typeId && stack.includes(typeId))) {
      field.doc = 'Recursive structure: deeper levels are not shown'
      field.type = 'element'
      return field
    }
    complexInto(field, ct, depth + 1, typeId ? [...stack, typeId] : stack)
    field.type = type ? local(type) : 'element'
    return field
  }

  const attribute = (a: Element, parent: string[]): Field | null => {
    let decl = a
    const ref = a.getAttribute('ref')
    if (ref) {
      const g = elementsOf(schema).find((e) => e.namespaceURI === XS && e.localName === 'attribute' && e.getAttribute('name') === local(ref))
      if (!g) return null
      decl = g
    }
    const name = decl.getAttribute('name') ?? ''
    const ns = attrQualified || a.getAttribute('form') === 'qualified' || ref ? tns : ''
    const type = decl.getAttribute('type')
    return makeField(parent, `@${clark(ns, name)}`, name, {
      ns,
      attribute: true,
      required: a.getAttribute('use') === 'required',
      type: type ? (simpleTypes.has(local(type)) ? simpleBase(simpleTypes.get(local(type))) : local(type)) : simpleBase(xs(decl, 'simpleType')[0])
    })
  }

  const particles = (holder: Element, field: Field, depth: number, stack: string[], many: boolean): void => {
    for (const c of elementsOf(holder)) {
      if (c.namespaceURI !== XS) continue
      const repeat = many || occursMany(c)
      switch (c.localName) {
        case 'element': {
          const f = buildElement(c, field.segs, false, depth, stack, many)
          if (f) field.children.push(f)
          break
        }
        case 'sequence':
        case 'choice':
        case 'all':
          particles(c, field, depth, stack, repeat)
          break
        case 'group': {
          const g = groups.get(local(c.getAttribute('ref')))
          if (g) particles(g, field, depth, stack, repeat)
          break
        }
        case 'attribute': {
          const f = attribute(c, field.segs)
          if (f) field.children.push(f)
          break
        }
        case 'attributeGroup': {
          const g = attributeGroups.get(local(c.getAttribute('ref')))
          if (g) particles(g, field, depth, stack, false)
          break
        }
        case 'any':
          warnings.push(`xs:any inside ${field.name} is not shown`)
          break
      }
    }
  }

  const complexInto = (field: Field, ct: Element, depth: number, stack: string[]): void => {
    const sc = xs(ct, 'simpleContent')[0]
    const cc = xs(ct, 'complexContent')[0]
    if (sc) {
      const ext = xs(sc, 'extension')[0] ?? xs(sc, 'restriction')[0]
      if (ext) particles(ext, field, depth, stack, false)
      field.text = true
    } else if (cc) {
      const ext = xs(cc, 'extension')[0] ?? xs(cc, 'restriction')[0]
      const base = ext?.getAttribute('base')
      const baseCt = base ? complexTypes.get(local(base)) : undefined
      if (baseCt && xs(cc, 'extension')[0] && !stack.includes(`type:${local(base)}`)) complexInto(field, baseCt, depth, [...stack, `type:${local(base)}`])
      if (ext) particles(ext, field, depth, stack, false)
      field.text = ct.getAttribute('mixed') === 'true'
    } else {
      particles(ct, field, depth, stack, false)
      field.text = ct.getAttribute('mixed') === 'true'
    }
    // Attributes first, as in the document.
    field.children.sort((a, b) => Number(b.attribute) - Number(a.attribute))
    field.container = field.children.length > 0
    if (!field.container) field.text = true
  }

  const root = buildElement(rootEl, [], true, 0, [], false) as Field
  root.repeating = false
  return { format: 'xml', root, roots, warnings }
}

// --------------------------------------------------------------- JSON sample --

const jsonType = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v)

function fromJsonValue(values: unknown[], parent: string[], seg: string | null, name: string, repeating: boolean): Field {
  const present = values.filter((v) => v !== undefined)
  const kinds = [...new Set(present.map(jsonType).filter((t) => t !== 'null'))]
  const type = kinds.includes('object') ? 'object' : kinds.includes('array') ? 'array' : kinds.includes('number') ? 'number' : (kinds[0] ?? 'string')
  const segs = seg === null ? [] : [...parent, seg]
  const field: Field = {
    key: fieldKey(segs),
    name,
    segs,
    type,
    container: false,
    text: true,
    repeating,
    attribute: false,
    ns: '',
    required: false,
    children: []
  }
  if (type === 'object') {
    const objects = present.filter((v): v is Record<string, unknown> => jsonType(v) === 'object')
    const keys: string[] = []
    for (const o of objects) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k)
    field.children = keys.map((k) => fromJsonValue(objects.map((o) => o[k]), segs, k, k, false))
  } else if (type === 'array') {
    const items = present.filter(Array.isArray).flat()
    field.children = [fromJsonValue(items.length ? items : [''], segs, '*', `${name} item`, true)]
  } else {
    const ex = present.find((v) => v !== null)
    if (ex !== undefined) field.example = String(ex).slice(0, 80)
  }
  field.container = field.children.length > 0
  field.text = !field.container
  return field
}

function fromJsonSample(text: string): SchemaTree {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}`)
  }
  return { format: 'json', root: fromJsonValue([value], [], null, 'body', false), roots: [], warnings: [] }
}

// -------------------------------------------------------------- JSON Schema --

function fromJsonSchema(text: string): SchemaTree {
  let schema: Record<string, unknown>
  try {
    schema = JSON.parse(text)
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}`)
  }
  const warnings: string[] = []
  type S = Record<string, unknown>

  const resolve = (s: S | undefined, seen: string[]): { s: S; ref: string | null } => {
    let cur = s ?? {}
    let ref: string | null = null
    for (let i = 0; i < 10 && typeof cur.$ref === 'string'; i++) {
      ref = cur.$ref as string
      if (!ref.startsWith('#/')) {
        warnings.push(`External reference "${ref}" is not followed`)
        return { s: {}, ref }
      }
      let target: unknown = schema
      for (const part of ref.slice(2).split('/')) target = (target as S | undefined)?.[decodeURIComponent(part.replace(/~1/g, '/').replace(/~0/g, '~'))]
      cur = (target as S) ?? {}
      if (seen.includes(ref)) break
    }
    // allOf: merge the parts; anyOf/oneOf: take the first option.
    if (Array.isArray(cur.allOf)) {
      const merged: S = { ...cur, properties: { ...((cur.properties as S) ?? {}) }, required: [...((cur.required as string[]) ?? [])] }
      for (const part of cur.allOf as S[]) {
        const p = resolve(part, seen).s
        Object.assign(merged.properties as S, (p.properties as S) ?? {})
        ;(merged.required as string[]).push(...((p.required as string[]) ?? []))
        if (!merged.type && p.type) merged.type = p.type
      }
      cur = merged
    }
    const alt = (cur.oneOf ?? cur.anyOf) as S[] | undefined
    if (Array.isArray(alt) && alt.length && !cur.properties && !cur.type) cur = resolve(alt.find((a) => a.type !== 'null') ?? alt[0], seen).s
    return { s: cur, ref }
  }

  const typeOf = (s: S): string => {
    const t = Array.isArray(s.type) ? (s.type as string[]).find((x) => x !== 'null') : (s.type as string | undefined)
    if (t) return t
    if (s.properties) return 'object'
    if (s.items) return 'array'
    return 'string'
  }

  const build = (raw: S | undefined, parent: string[], seg: string | null, name: string, repeating: boolean, required: boolean, seen: string[]): Field => {
    const { s, ref } = resolve(raw, seen)
    const type = typeOf(s)
    const segs = seg === null ? [] : [...parent, seg]
    const field: Field = {
      key: fieldKey(segs),
      name,
      segs,
      type,
      container: false,
      text: true,
      repeating,
      attribute: false,
      ns: '',
      required,
      doc: typeof s.description === 'string' ? s.description : undefined,
      example: Array.isArray(s.examples) ? String(s.examples[0]) : s.example !== undefined ? String(s.example) : undefined,
      children: []
    }
    const nextSeen = ref ? [...seen, ref] : seen
    if (ref && seen.includes(ref)) {
      field.doc = 'Recursive structure: deeper levels are not shown'
    } else if (type === 'object') {
      const req = (s.required as string[]) ?? []
      field.children = Object.entries((s.properties as Record<string, S>) ?? {}).map(([k, v]) => build(v, segs, k, k, false, req.includes(k), nextSeen))
    } else if (type === 'array') {
      field.children = [build(s.items as S, segs, '*', `${name} item`, true, false, nextSeen)]
    }
    field.container = field.children.length > 0
    field.text = !field.container
    return field
  }

  const title = typeof schema.title === 'string' && schema.title ? schema.title : 'body'
  return { format: 'json', root: build(schema, [], null, title, false, true, []), roots: [], warnings }
}

// ---------------------------------------------------------------- entry point --

export function detectKind(fileName: string, text: string): SchemaKind {
  const t = text.trimStart()
  if (/\.xsd$/i.test(fileName) || /<(\w+:)?schema[\s>]/.test(t.slice(0, 2000))) return 'xsd'
  if (t.startsWith('<')) return 'xml-sample'
  try {
    const v = JSON.parse(t)
    if (v && typeof v === 'object' && !Array.isArray(v) && ('$schema' in v || ('type' in v && ('properties' in v || 'items' in v)))) return 'json-schema'
  } catch {
    /* fall through */
  }
  return 'json-sample'
}

export function readSchema(kind: SchemaKind, text: string, rootName?: string): SchemaTree {
  switch (kind) {
    case 'xsd':
      return fromXsd(text, rootName)
    case 'xml-sample':
      return fromXmlSample(text)
    case 'json-schema':
      return fromJsonSchema(text)
    case 'json-sample':
      return fromJsonSample(text)
  }
}

export const KIND_LABELS: Record<SchemaKind, string> = {
  xsd: 'XML Schema',
  'xml-sample': 'XML sample',
  'json-schema': 'JSON Schema',
  'json-sample': 'JSON sample'
}

/** Every field, depth first, for lookups by key. */
export function indexFields(root: Field): Map<string, Field> {
  const m = new Map<string, Field>()
  const walk = (f: Field): void => {
    m.set(f.key, f)
    f.children.forEach(walk)
  }
  walk(root)
  return m
}

// ---------------------------------------------------------- sample messages --

/** A message that fits the structure, used to start the preview when no sample was given. */
export function sampleMessage(tree: SchemaTree): string {
  const leaf = (f: Field): unknown => {
    if (f.example !== undefined) return f.type === 'number' || f.type === 'integer' ? Number(f.example) || 0 : f.type === 'boolean' ? f.example === 'true' : f.example
    if (f.type === 'number' || f.type === 'integer' || /^(int|integer|long|short|decimal|double|float|byte|positiveInteger|nonNegativeInteger)$/.test(f.type)) return 1
    if (f.type === 'boolean') return true
    if (/date/i.test(f.type)) return '2026-01-31'
    return f.name
  }
  if (tree.format === 'json') {
    const val = (f: Field): unknown => (f.type === 'object' ? Object.fromEntries(f.children.map((c) => [c.name, val(c)])) : f.type === 'array' ? [val(f.children[0]), val(f.children[0])].slice(0, f.children[0]?.container ? 1 : 2) : leaf(f))
    return JSON.stringify(val(tree.root), null, 2)
  }
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>']
  const el = (f: Field, indent: string, parentNs: string | null): void => {
    const attrs = f.children.filter((c) => c.attribute)
    const kids = f.children.filter((c) => !c.attribute)
    const nsDecl = f.ns !== (parentNs ?? '') ? ` xmlns="${esc(f.ns)}"` : ''
    const attrText = attrs.map((a) => ` ${a.name}="${esc(String(leaf(a)))}"`).join('')
    if (kids.length === 0) {
      lines.push(`${indent}<${f.name}${nsDecl}${attrText}>${f.text ? esc(String(leaf(f))) : ''}</${f.name}>`)
      return
    }
    lines.push(`${indent}<${f.name}${nsDecl}${attrText}>`)
    for (const k of kids) el(k, `${indent}  `, f.ns)
    lines.push(`${indent}</${f.name}>`)
  }
  el(tree.root, '', null)
  return lines.join('\n')
}
