// Java DSL generator.
//
// Turns the route model (the same structure the canvas edits) into a standard Camel
// RouteBuilder class. One step is written per line, and the line of every step is
// recorded, so traced messages, statistics and breakpoints reported by Camel as
// `ClassName.java:line` can be matched back to the step on the canvas.

import {
  ENDPOINT_KINDS,
  getAt,
  listEntries,
  normalizeValue,
  parseEndpoint,
  readDataFormat,
  readExpression,
  stepKind,
  type Catalog,
  type LineTarget,
  type Path,
  type Y
} from './camel'

export interface JavaGenOptions {
  packageName: string
  className: string
  /** Model file the class is generated from, relative to the project, for the header. */
  modelRel: string
}

export interface JavaGenResult {
  fileName: string
  code: string
  /** 1-based line of the generated file -> step. */
  lines: Map<number, LineTarget>
  warnings: { path: Path; message: string }[]
}

/**
 * Where a step sits decides how a nested block must be closed, both for the fluent chain to keep
 * compiling and for the steps after it to land in the right branch. These rules follow what
 * ProcessorDefinition.end(), endChoice() and endDoTry() actually do, and are covered by a test
 * route that nests every combination.
 */
type Ctx = 'plain' | 'choice' | 'try' | 'catch' | 'breaker' | 'fallback'

/** Expression languages with a builder method on RouteBuilder. Others go through LanguageExpression. */
const BUILDERS = new Set(['simple', 'constant', 'header', 'exchangeProperty', 'variable', 'jsonpath', 'xpath', 'jq', 'csimple', 'datasonnet'])

/** Steps without children whose DSL method returns its own definition type instead of the chain's type. */
const TYPE_CHANGING = new Set(['delay', 'throttle', 'recipientList', 'routingSlip', 'dynamicRouter', 'kamelet', 'wireTap', 'sample', 'threads'])

const q = (s: unknown): string => JSON.stringify(String(s ?? ''))
const ref = (s: unknown): string => q(String(s ?? '').replace(/^#(bean:)?/, ''))
const cls = (fqn: unknown): string => `${String(fqn ?? 'java.lang.Object').trim()}.class`

export function javaClassName(modelFileName: string): string {
  const base = modelFileName.replace(/\.camel\.ya?ml$|\.ya?ml$/i, '')
  const pascal = base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')
  return `${/^[A-Za-z]/.test(pascal) ? pascal : `R${pascal}`}Routes`
}

function endpointUri(value: Record<string, Y>): string {
  const ep = parseEndpoint(value)
  if (!ep.scheme) return String(value.uri ?? '')
  const query = Object.entries(ep.params)
    .map(([k, v]) => {
      const s = String(v)
      // RAW() stops Camel from interpreting characters that are special inside a URI.
      return `${k}=${/[&+%]/.test(s) && !/^RAW\(/.test(s) ? `RAW(${s})` : s}`
    })
    .join('&')
  return `${ep.scheme}:${ep.path}${query ? `?${query}` : ''}`
}

export function generateJava(js: Y[], options: JavaGenOptions, catalog: Catalog): JavaGenResult {
  const body: { text: string; target?: LineTarget }[] = []
  const imports = new Set<string>(['org.apache.camel.builder.RouteBuilder', 'org.springframework.stereotype.Component'])
  const warnings: JavaGenResult['warnings'] = []
  const pad = (n: number): string => '    '.repeat(n)
  const emit = (indent: number, text: string, target?: LineTarget): void => void body.push({ text: pad(indent) + text, target })
  const warn = (path: Path, message: string): void => void warnings.push({ path, message })

  const expression = (value: Y, prop: string, path: Path): string => {
    const ex = readExpression(value, prop, catalog.languages)
    if (!ex) {
      warn(path, 'Expression is missing')
      return 'constant("")'
    }
    if (BUILDERS.has(ex.language)) return `${ex.language}(${q(ex.text)})`
    imports.add('org.apache.camel.model.language.LanguageExpression')
    return `new LanguageExpression(${q(ex.language)}, ${q(ex.text)})`
  }

  const dataFormat = (value: Record<string, Y>, path: Path): string => {
    const name = readDataFormat(value, catalog.dataformats)
    const opts: Record<string, Y> = (name && value[name] && typeof value[name] === 'object' ? value[name] : {}) as Record<string, Y>
    const df = (type: string, args = ''): string => {
      imports.add(`org.apache.camel.model.dataformat.${type}`)
      return `new ${type}(${args})`
    }
    switch (name) {
      case 'json':
        imports.add('org.apache.camel.model.dataformat.JsonLibrary')
        return df('JsonDataFormat', `JsonLibrary.${opts.library ?? 'Jackson'}`)
      case 'jacksonXml':
        return df('JacksonXMLDataFormat')
      case 'csv':
        return df('CsvDataFormat')
      case 'base64':
        return df('Base64DataFormat')
      case 'jaxb':
        return df('JaxbDataFormat')
      case 'gzipDeflater':
        return df('GzipDeflaterDataFormat')
      case 'zipDeflater':
        return df('ZipDeflaterDataFormat')
      case 'zipFile':
        return df('ZipFileDataFormat')
      case 'yaml':
        return df('YAMLDataFormat')
      default:
        warn(path, `Data format "${name ?? 'none'}" is not supported in Java output yet; it is referenced by name`)
        return q(name ?? '')
    }
  }

  /** Writes boolean and value options that have a same-named DSL method. Anything else is reported. */
  const options_ = (indent: number, kind: string, value: Record<string, Y>, path: Path, allowed: Record<string, 'flag' | 'string' | 'ref'>, handled: string[]): void => {
    for (const [name, v] of Object.entries(value)) {
      if (handled.includes(name) || v === undefined || v === null || ['id', 'description', 'disabled', 'steps', 'expression', 'uri', 'parameters'].includes(name)) continue
      if (catalog.languages.has(name) || catalog.dataformats.has(name)) continue
      const how = allowed[name]
      if (how === 'flag') emit(indent, `.${name}(${v === true || v === 'true'})`)
      else if (how === 'string') emit(indent, `.${name}(${q(v)})`)
      else if (how === 'ref') emit(indent, `.${name}(${ref(v)})`)
      else warn(path, `Option "${name}" of ${kind} is not written to Java yet`)
    }
  }

  const common = (indent: number, value: Record<string, Y>): void => {
    if (value.id) emit(indent, `.id(${q(value.id)})`)
    if (value.description) emit(indent, `.description(${q(value.description)})`)
    if (value.disabled === true) emit(indent, '.disabled()')
  }

  /** Lines that close a nested block (or step away from a step that changed the chain's type). */
  const closers = (ctx: Ctx, kind: string): string[] => {
    switch (ctx) {
      case 'choice':
        // endChoice() on a nested choice would return that same choice, so leave it with end() first.
        return kind === 'choice' ? ['.end()', '.endChoice()'] : ['.endChoice()']
      case 'try':
        return kind === 'doTry' ? ['.end()', '.endDoTry()'] : ['.endDoTry()']
      case 'catch':
        // Inside doCatch/doFinally the parent is the clause, not the try: step out to the clause, then back to the try.
        return ['.end()', '.endDoTry()']
      case 'breaker':
        return ['.endCircuitBreaker()']
      case 'fallback':
        return ['.end()', '.endCircuitBreaker()']
      default:
        return ['.end()']
    }
  }
  const close = (indent: number, ctx: Ctx, kind: string): void => closers(ctx, kind).forEach((c) => emit(indent, c))

  const steps = (list: Y, seqPath: Path, indent: number, ctx: Ctx): void => {
    if (!Array.isArray(list)) return
    list.forEach((s, i) => step(s, [...seqPath, i], indent, ctx))
  }

  const step = (raw: Y, path: Path, indent: number, ctx: Ctx): void => {
    const kind = stepKind(raw)
    if (!kind) return
    const value = normalizeValue(kind, raw[kind])
    const target: LineTarget = { kind: 'step', path }
    const line = (text: string): void => emit(indent, text, target)
    const vp = [...path, kind]
    const inner = indent + 1
    const block = (open: string, allowed: Record<string, 'flag' | 'string' | 'ref'> = {}, handled: string[] = []): void => {
      line(open)
      common(inner, value)
      options_(inner, kind, value, path, allowed, handled)
      steps(value.steps, [...vp, 'steps'], inner, 'plain')
      close(indent, ctx, kind)
    }
    const simpleStep = (text: string, allowed: Record<string, 'flag' | 'string' | 'ref'> = {}, handled: string[] = []): void => {
      line(text)
      common(inner, value)
      options_(inner, kind, value, path, allowed, handled)
      if (TYPE_CHANGING.has(kind) && ctx !== 'plain') close(indent, ctx, kind)
    }

    if (ENDPOINT_KINDS.has(kind) && kind !== 'from') {
      const uri = q(endpointUri(value))
      if (kind === 'to' && value.pattern) {
        imports.add('org.apache.camel.ExchangePattern')
        return simpleStep(`.to(ExchangePattern.${value.pattern}, ${uri})`, {}, ['pattern'])
      }
      return simpleStep(`.${kind}(${uri})`, kind === 'wireTap' ? { copy: 'flag' } : {})
    }

    switch (kind) {
      case 'log': {
        if (value.loggingLevel || value.logName) {
          imports.add('org.apache.camel.LoggingLevel')
          const level = `LoggingLevel.${value.loggingLevel ?? 'INFO'}`
          return simpleStep(value.logName ? `.log(${level}, ${q(value.logName)}, ${q(value.message)})` : `.log(${level}, ${q(value.message)})`, {}, ['message', 'loggingLevel', 'logName'])
        }
        return simpleStep(`.log(${q(value.message)})`, {}, ['message'])
      }
      case 'setBody':
      case 'transform':
      case 'script':
      case 'validate':
        return simpleStep(`.${kind}(${expression(value, 'expression', path)})`)
      case 'delay':
        return simpleStep(`.delay(${expression(value, 'expression', path)})`, { asyncDelayed: 'flag' })
      case 'throttle':
        return simpleStep(`.throttle(${expression(value, 'expression', path)})`)
      case 'recipientList':
      case 'routingSlip':
      case 'dynamicRouter':
        return simpleStep(`.${kind}(${expression(value, 'expression', path)})`, kind === 'recipientList' ? { parallelProcessing: 'flag', stopOnException: 'flag', delimiter: 'string' } : {})
      case 'setHeader':
      case 'setProperty':
      case 'setVariable':
        return simpleStep(`.${kind}(${q(value.name)}, ${expression(value, 'expression', path)})`, {}, ['name'])
      case 'removeHeader':
      case 'removeProperty':
      case 'removeVariable':
        return simpleStep(`.${kind}(${q(value.name)})`, {}, ['name'])
      case 'removeHeaders':
      case 'removeProperties':
        return simpleStep(`.${kind}(${q(value.pattern)}${value.excludePattern ? `, ${q(value.excludePattern)}` : ''})`, {}, ['pattern', 'excludePattern'])
      case 'convertBodyTo':
        return simpleStep(`.convertBodyTo(${cls(value.type)}${value.charset ? `, ${q(value.charset)}` : ''})`, {}, ['type', 'charset'])
      case 'bean': {
        const what = value.beanType ? cls(value.beanType) : ref(value.ref)
        return simpleStep(`.bean(${what}${value.method ? `, ${q(value.method)}` : ''})`, {}, ['ref', 'beanType', 'method'])
      }
      case 'process':
        return simpleStep(`.process(${ref(value.ref)})`, {}, ['ref'])
      case 'stop':
        return simpleStep('.stop()')
      case 'rollback':
        return simpleStep(value.message ? `.rollback(${q(value.message)})` : '.rollback()', {}, ['message'])
      case 'throwException':
        return simpleStep(`.throwException(${cls(value.exceptionType ?? 'java.lang.RuntimeException')}, ${q(value.message)})`, {}, ['exceptionType', 'message'])
      case 'marshal':
      case 'unmarshal':
        return simpleStep(`.${kind}(${dataFormat(value, path)})`)
      case 'kamelet':
        return simpleStep(`.kamelet(${q(value.name)})`, {}, ['name'])
      case 'enrich':
      case 'pollEnrich': {
        const ex = readExpression(value, 'expression', catalog.languages)
        return simpleStep(`.${kind}(${q(ex?.text ?? '')})`)
      }

      case 'choice': {
        line('.choice()')
        common(inner, value)
        const whens: Y[] = Array.isArray(value.when) ? value.when : []
        whens.forEach((w, i) => {
          const wp = [...vp, 'when', i]
          emit(inner, `.when(${expression(w, 'expression', wp)})`, { kind: 'branch', path: wp })
          steps(w?.steps, [...wp, 'steps'], inner + 1, 'choice')
        })
        if (value.otherwise !== undefined) {
          emit(inner, '.otherwise()', { kind: 'branch', path: [...vp, 'otherwise'] })
          steps(value.otherwise?.steps, [...vp, 'otherwise', 'steps'], inner + 1, 'choice')
        }
        return close(indent, ctx, kind)
      }
      case 'doTry': {
        line('.doTry()')
        common(inner, value)
        steps(value.steps, [...vp, 'steps'], inner, 'try')
        const catches: Y[] = Array.isArray(value.doCatch) ? value.doCatch : []
        catches.forEach((c, i) => {
          const cp = [...vp, 'doCatch', i]
          const types: string[] = Array.isArray(c?.exception) && c.exception.length > 0 ? c.exception : ['java.lang.Exception']
          emit(indent, `.doCatch(${types.map(cls).join(', ')})`, { kind: 'branch', path: cp })
          steps(c?.steps, [...cp, 'steps'], inner, 'catch')
        })
        if (value.doFinally !== undefined) {
          emit(indent, '.doFinally()', { kind: 'branch', path: [...vp, 'doFinally'] })
          steps(value.doFinally?.steps, [...vp, 'doFinally', 'steps'], inner, 'catch')
        }
        return close(indent, ctx, kind)
      }
      case 'circuitBreaker': {
        line('.circuitBreaker()')
        common(inner, value)
        steps(value.steps, [...vp, 'steps'], inner, 'breaker')
        if (value.onFallback !== undefined) {
          emit(indent, '.onFallback()', { kind: 'branch', path: [...vp, 'onFallback'] })
          steps(value.onFallback?.steps, [...vp, 'onFallback', 'steps'], inner, 'fallback')
        }
        return close(indent, ctx, kind)
      }
      case 'filter':
        return block(`.filter(${expression(value, 'expression', path)})`)
      case 'split':
        return block(`.split(${expression(value, 'expression', path)})`, { parallelProcessing: 'flag', streaming: 'flag', stopOnException: 'flag', shareUnitOfWork: 'flag', timeout: 'string', delimiter: 'string', aggregationStrategy: 'ref' })
      case 'multicast':
        return block('.multicast()', { parallelProcessing: 'flag', streaming: 'flag', stopOnException: 'flag', shareUnitOfWork: 'flag', timeout: 'string', aggregationStrategy: 'ref' })
      case 'loop':
        return block(`.${value.doWhile === true ? 'loopDoWhile' : 'loop'}(${expression(value, 'expression', path)})`, { copy: 'flag' }, ['doWhile'])
      case 'pipeline':
        return block('.pipeline()')
      case 'step':
        return block('.step()')
      case 'aggregate':
        return block(`.aggregate(${expression(value, 'correlationExpression', path)})`, { aggregationStrategy: 'ref', completionSize: 'string', completionTimeout: 'string', completionInterval: 'string' }, ['correlationExpression'])
      default:
        warn(path, `Step "${kind}" is not supported in Java output yet and was left out`)
        emit(indent, `// TODO: "${kind}" is not supported by Camel Studio's Java output yet`, target)
    }
  }

  const entries = listEntries(js)
  for (const entry of entries) {
    if (!entry.fromPath) {
      warn([entry.index], `"${entry.rootKey}" entries are not written to Java yet`)
      continue
    }
    const from = normalizeValue('from', getAt(js, entry.fromPath))
    const holder: Record<string, Y> = (entry.routePath ? getAt(js, entry.routePath) : from) ?? {}
    emit(2, '')
    if (entry.description) emit(2, `// ${String(entry.description).replace(/\s+/g, ' ')}`)
    emit(2, `from(${q(endpointUri(from))})`, { kind: 'step', path: entry.fromPath })
    emit(3, `.routeId(${q(entry.id)})`)
    if (entry.description) emit(3, `.routeDescription(${q(entry.description)})`)
    if (holder.autoStartup === false || holder.autoStartup === 'false') emit(3, '.autoStartup(false)')
    if (holder.streamCache !== undefined) emit(3, `.streamCache(${q(holder.streamCache)})`)
    if (holder.group) emit(3, `.routeGroup(${q(holder.group)})`)
    steps(from.steps, [...entry.fromPath, 'steps'], 3, 'plain')
    body[body.length - 1].text += ';'
  }

  const head = [
    `package ${options.packageName};`,
    '',
    ...[...imports].sort().map((i) => `import ${i};`),
    '',
    '/**',
    ` * Generated by Camel Studio from ${options.modelRel}.`,
    ' * Do not edit: changes made here are overwritten the next time the routes are saved.',
    ' */',
    '@Component',
    `public class ${options.className} extends RouteBuilder {`,
    '',
    '    @Override',
    '    public void configure() throws Exception {'
  ]
  const lines = new Map<number, LineTarget>()
  body.forEach((b, i) => {
    if (b.target) lines.set(head.length + i + 1, b.target)
  })
  const code = [...head, ...body.map((b) => b.text), '    }', '}', ''].join('\n')
  return { fileName: `${options.className}.java`, code, lines, warnings }
}
