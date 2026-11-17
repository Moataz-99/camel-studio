// XSLT 3.0 generator for a mapping, run by Camel's xslt-saxon component (Saxon-HE).
//
// XML sources are read as the input document. JSON sources arrive as the exchange variable
// CamelStudioSourceJson (Camel passes variables to the stylesheet as parameters) and are read
// with parse-json, so fields are addressed with XPath 3.1 lookups: $src?order?id.
// JSON targets are built in the standard XPath JSON-as-XML form and written with xml-to-json.
// Declared headers, variables and properties become stylesheet parameters of the same name.

import { fieldKey, indexFields, type Field, type SchemaTree } from './schema'
import { loopContext, sourceFields, sourcePrefixes, sourceXPath, type MappingDef, type SimpleValue, type TargetRule } from './model'

export const SOURCE_PARAM = 'CamelStudioSourceJson'

export interface XsltResult {
  xslt: string
  /** Problems that make the stylesheet incomplete (it is still written). */
  warnings: string[]
}

const escText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string): string => escText(s).replace(/"/g, '&quot;')
/** Attribute value templates treat braces as expressions: double them for literal text. */
const escAvt = (s: string): string => escAttr(s).replace(/\{/g, '{{').replace(/\}/g, '}}')

const JSON_NUMBER = /^(number|integer|int|long|short|decimal|double|float)$/

function jsonElement(f: Field): string {
  if (f.type === 'object') return 'fn:map'
  if (f.type === 'array') return 'fn:array'
  if (JSON_NUMBER.test(f.type)) return 'fn:number'
  if (f.type === 'boolean') return 'fn:boolean'
  if (f.type === 'null') return 'fn:null'
  return 'fn:string'
}

/** One resolved value: an XPath to read, or literal text. */
type Resolved = { select: string } | { text: string }

export function generateXslt(def: MappingDef, source: SchemaTree, target: SchemaTree, modelRel: string): XsltResult {
  const warnings: string[] = []
  const prefixes = sourcePrefixes(source)
  const targetIndex = indexFields(target.root)
  const sources = sourceFields(source, def)
  const out: string[] = []
  const pad = (n: number): string => '  '.repeat(n)
  const emit = (n: number, s: string): void => void out.push(pad(n) + s)

  const used = (f: Field): boolean => !!def.rules[f.key] || f.children.some(used)

  const resolve = (v: SimpleValue, ctx: string[] | null, where: string): Resolved | null => {
    if (v.kind === 'constant') return { text: v.text }
    if (v.kind === 'formula') return v.expr.trim() ? { select: v.expr.trim() } : null
    if (!sources.has(fieldKey(v.source))) {
      warnings.push(`${where}: its input field is no longer in the input structure`)
      return null
    }
    return { select: sourceXPath(source.format, v.source, ctx, prefixes) }
  }

  /** The content instruction for a resolved value, placed inside an element or attribute. */
  const content = (r: Resolved): string => ('text' in r ? `<xsl:text>${escText(r.text)}</xsl:text>` : `<xsl:value-of select="${escAttr(r.select)}"/>`)

  /**
   * Writes the value part of a field. `wrap` produces the lines around one value (the JSON
   * element, the attribute, or nothing for XML element text); for a choose, each branch gets its
   * own wrap so a JSON field is left out when no branch applies.
   */
  const writeValue = (rule: TargetRule | undefined, ctx: string[] | null, d: number, where: string, wrap: (inner: string, d: number, guard: string | null) => void): boolean => {
    const v = rule?.value
    if (!v || v.kind === 'copy') return false
    if (v.kind === 'choose') {
      const cases = v.cases
        .map((c) => ({ test: c.test.trim(), r: resolve(c.value, ctx, where) }))
        .filter((c): c is { test: string; r: Resolved } => !!c.test && !!c.r)
      const other = v.otherwise ? resolve(v.otherwise, ctx, where) : null
      if (cases.length === 0 && !other) return false
      if (cases.length === 0 && other) {
        wrap(content(other), d, null)
        return true
      }
      emit(d, '<xsl:choose>')
      for (const c of cases) {
        emit(d + 1, `<xsl:when test="${escAttr(c.test)}">`)
        wrap(content(c.r), d + 2, null)
        emit(d + 1, '</xsl:when>')
      }
      if (other) {
        emit(d + 1, '<xsl:otherwise>')
        wrap(content(other), d + 2, null)
        emit(d + 1, '</xsl:otherwise>')
      }
      emit(d, '</xsl:choose>')
      return true
    }
    const r = resolve(v, ctx, where)
    if (!r) return false
    wrap(content(r), d, v.kind === 'constant' ? null : 'select' in r ? r.select : null)
    return true
  }

  /** Writes one target field (and what is below it) with its loop and condition around it. */
  const node = (f: Field, depth: number, parentNs: string, keyed: boolean): void => {
    if (!used(f)) return
    const rule = def.rules[f.key]
    let d = depth
    const close: string[] = []
    if (rule?.forEach) {
      if (!sources.has(fieldKey(rule.forEach))) {
        warnings.push(`${f.name}: the collection it repeats over is no longer in the input structure`)
      } else {
        const outer = f.segs.length ? loopContext(def, { ...f, segs: f.segs.slice(0, -1) }, targetIndex) : null
        emit(d, `<xsl:for-each select="${escAttr(sourceXPath(source.format, rule.forEach, outer, prefixes))}">`)
        // Sort keys must be the first children of the loop.
        for (const s of rule.sort ?? []) {
          const select = s.source ? sourceXPath(source.format, s.source, rule.forEach, prefixes) : s.expr?.trim()
          if (!select) continue
          emit(d + 1, `<xsl:sort select="${escAttr(select)}" order="${s.order}" data-type="${s.type}"/>`)
        }
        close.unshift('</xsl:for-each>')
        d++
      }
    }
    const ctx = loopContext(def, f, targetIndex)
    if (rule?.condition?.trim()) {
      emit(d, `<xsl:if test="${escAttr(rule.condition.trim())}">`)
      close.unshift('</xsl:if>')
      d++
    }
    const copy = rule?.value?.kind === 'copy' ? rule.value : null
    const copySelect = copy && sources.has(fieldKey(copy.source)) ? sourceXPath(source.format, copy.source, ctx, prefixes) : null
    if (copy && !copySelect) warnings.push(`${f.name}: the structure it copies is no longer in the input structure`)

    if (target.format === 'json') {
      const el = jsonElement(f)
      const keyAttr = keyed ? ` key="${escAvt(f.name)}"` : ''
      if (f.container) {
        emit(d, `<${el}${keyAttr}>`)
        for (const c of f.children) node(c, d + 1, '', f.type === 'object')
        emit(d, `</${el}>`)
      } else {
        writeValue(rule, ctx, d, f.name, (inner, dd, guard) => {
          // A missing input value leaves the field out instead of writing an invalid empty number.
          if (guard) {
            emit(dd, `<xsl:if test="exists(${escAttr(guard)})">`)
            emit(dd + 1, `<${el}${keyAttr}>${inner}</${el}>`)
            emit(dd, '</xsl:if>')
          } else {
            emit(dd, `<${el}${keyAttr}>${inner}</${el}>`)
          }
        })
      }
    } else if (f.attribute) {
      const ns = f.ns ? ` namespace="${escAttr(f.ns)}"` : ''
      const v = rule?.value
      if (v?.kind === 'field' || v?.kind === 'formula') {
        const r = resolve(v, ctx, f.name)
        if (r && 'select' in r) emit(d, `<xsl:attribute name="${escAttr(f.name)}"${ns} select="${escAttr(r.select)}"/>`)
      } else {
        writeValue(rule, ctx, d, f.name, (inner, dd) => emit(dd, `<xsl:attribute name="${escAttr(f.name)}"${ns}>${inner}</xsl:attribute>`))
      }
    } else {
      const nsDecl = f.ns !== parentNs ? ` xmlns="${escAttr(f.ns)}"` : ''
      const kids = f.children.filter(used)
      const hasValue = !!rule?.value && rule.value.kind !== 'copy'
      if (kids.length === 0 && !hasValue && !copySelect) {
        emit(d, `<${f.name}${nsDecl}/>`)
      } else {
        emit(d, `<${f.name}${nsDecl}>`)
        // Attributes must come before any child content.
        for (const c of kids.filter((k) => k.attribute)) node(c, d + 1, f.ns, false)
        if (copySelect) emit(d + 1, `<xsl:copy-of select="${escAttr(copySelect)}/@*, ${escAttr(copySelect)}/node()"/>`)
        writeValue(rule, ctx, d + 1, f.name, (inner, dd) => emit(dd, inner))
        for (const c of kids.filter((k) => !k.attribute)) node(c, d + 1, f.ns, false)
        emit(d, `</${f.name}>`)
      }
    }
    for (const c of close) emit(--d, c)
  }

  const nsDecls = [...prefixes].map(([ns, p]) => ` xmlns:${p}="${escAttr(ns)}"`).join('')
  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- Generated by Camel Studio from ${escText(modelRel)}. Do not edit: changes are overwritten when the mapping is saved. -->`,
    `<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:fn="http://www.w3.org/2005/xpath-functions"${nsDecls} exclude-result-prefixes="#all">`,
    '',
    target.format === 'json' ? '  <xsl:output method="text" encoding="UTF-8"/>' : '  <xsl:output method="xml" encoding="UTF-8" indent="yes"/>'
  ]
  const params = (def.params ?? []).filter((p) => p.name.trim())
  if (params.length) {
    head.push('')
    for (const p of params) head.push(`  <!-- ${p.kind} ${escText(p.name)}: Camel passes it in by name -->`, `  <xsl:param name="${escAttr(p.name)}" select="''"/>`)
  }
  if (source.format === 'json') {
    head.push('', `  <xsl:param name="${SOURCE_PARAM}" select="'null'"/>`, `  <xsl:variable name="src" select="parse-json($${SOURCE_PARAM})"/>`)
  }
  head.push('', '  <xsl:template match="/">')

  if (!used(target.root)) warnings.push('Nothing is mapped yet')
  if (target.format === 'json') {
    emit(2, '<xsl:variable name="out">')
    if (used(target.root)) node(target.root, 3, '', false)
    else emit(3, `<${jsonElement(target.root)}/>`)
    emit(2, '</xsl:variable>')
    emit(2, '<xsl:value-of select="xml-to-json($out)"/>')
  } else if (used(target.root)) {
    node(target.root, 2, '', false)
  } else {
    emit(2, `<${target.root.name}${target.root.ns ? ` xmlns="${escAttr(target.root.ns)}"` : ''}/>`)
  }

  const xslt = [...head, ...out, '  </xsl:template>', '', '</xsl:stylesheet>', ''].join('\n')
  return { xslt, warnings }
}

/** Placeholder written before a mapping is configured: passes the message through unchanged. */
export const IDENTITY_XSLT = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by Camel Studio. This mapping is not configured yet, so the message passes through unchanged. -->
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:template match="/">
    <xsl:copy-of select="."/>
  </xsl:template>
</xsl:stylesheet>
`
