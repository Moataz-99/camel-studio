// Global variables, the Camel Studio take on BW5 global variables.
//
// They are plain Spring Boot properties, so the project keeps working without the tool:
//   application.properties          default values
//   application-<env>.properties    per-environment overrides (Spring profiles)
// Routes use them as Camel property placeholders: {{kafka.brokers}}.
// Files are edited line by line, so comments, blank lines and order written by hand survive.

export interface PropLine {
  /** Raw text of the line(s), kept for lines that are not entries. */
  raw: string
  key?: string
  value?: string
  /** Comment lines directly above the entry, without the leading #. */
  comment?: string
}

export interface PropFile {
  /** Path relative to the project root. */
  rel: string
  env: string
  lines: PropLine[]
}

export interface GlobalVar {
  name: string
  description: string
  /** Value per environment; `default` is application.properties. Missing = not set there. */
  values: Record<string, string>
  secret: boolean
  framework: boolean
}

export interface GlobalVars {
  envs: string[]
  vars: GlobalVar[]
  files: Record<string, PropFile>
}

export const RESOURCES = 'src/main/resources'
export const DEFAULT_ENV = 'default'

export const envFileRel = (env: string): string => `${RESOURCES}/application${env === DEFAULT_ENV ? '' : `-${env}`}.properties`

/** Settings that belong to Spring Boot or Camel itself rather than to the integration. */
const FRAMEWORK = /^(spring|server|management|logging|camel\.(main|component|springboot|debug|trace|cloud|health|rest|threadpool|ssl|vault|opentelemetry|metrics|routecontroller|dataformat|language|language|beans|cluster|resilience4j|faulttolerance|lra|saga))\b|^debug$|^trace$/

const SECRET = /pass(word)?|secret|token|api[-_.]?key|credential|private[-_.]?key/i

export const isSecretName = (name: string): boolean => SECRET.test(name)

// ----------------------------------------------------------------- parsing --

function unescapeValue(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, c: string) => {
    if (c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16))
    return ({ t: '\t', n: '\n', r: '\r', f: '\f' } as Record<string, string>)[c] ?? c
  })
}

export function escapeValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/^ /, '\\ ')
}

const escapeKey = (s: string): string => s.replace(/\\/g, '\\\\').replace(/([ =:#!])/g, '\\$1')

export function parseProperties(text: string, rel: string, env: string): PropFile {
  const physical = text.split(/\r?\n/)
  if (physical.length && physical[physical.length - 1] === '') physical.pop()
  const lines: PropLine[] = []
  let pendingComment: string[] = []
  for (let i = 0; i < physical.length; i++) {
    let raw = physical[i]
    // A line ending in an odd number of backslashes continues on the next one.
    while (/(^|[^\\])(\\\\)*\\$/.test(raw) && i + 1 < physical.length) raw += `\n${physical[++i]}`
    const trimmed = raw.trimStart()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      lines.push({ raw })
      pendingComment = trimmed === '' ? [] : [...pendingComment, trimmed.slice(1).trim()]
      continue
    }
    const joined = trimmed.replace(/\\\n\s*/g, '')
    const m = joined.match(/^((?:\\.|[^\s=:\\])+)\s*[=:\s]\s*([\s\S]*)$/)
    const key = unescapeValue(m ? m[1] : joined)
    const value = m ? unescapeValue(m[2]) : ''
    lines.push({ raw, key, value, comment: pendingComment.length ? pendingComment.join(' ') : undefined })
    pendingComment = []
  }
  return { rel, env, lines }
}

export function serializeProperties(file: PropFile): string {
  return `${file.lines.map((l) => l.raw).join('\n')}\n`
}

const entryRaw = (key: string, value: string): string => `${escapeKey(key)}=${escapeValue(value)}`

// ----------------------------------------------------------------- the model --

export function buildGlobals(files: PropFile[]): GlobalVars {
  const envs = [DEFAULT_ENV, ...files.map((f) => f.env).filter((e) => e !== DEFAULT_ENV).sort()]
  const byName = new Map<string, GlobalVar>()
  for (const f of files) {
    for (const l of f.lines) {
      if (l.key === undefined) continue
      let v = byName.get(l.key)
      if (!v) {
        v = { name: l.key, description: '', values: {}, secret: SECRET.test(l.key), framework: FRAMEWORK.test(l.key) }
        byName.set(l.key, v)
      }
      v.values[f.env] = l.value ?? ''
      if (l.comment && (!v.description || f.env === DEFAULT_ENV)) v.description = l.comment
    }
  }
  return { envs, vars: [...byName.values()], files: Object.fromEntries(files.map((f) => [f.env, f])) }
}

/** Sets (or, with `undefined`, removes) one key in one file, keeping everything else as written. */
export function setEntry(file: PropFile, key: string, value: string | undefined, description?: string): PropFile {
  const lines = [...file.lines]
  const at = lines.findIndex((l) => l.key === key)
  if (value === undefined) {
    if (at < 0) return file
    // Remove the entry and the comment block that describes it.
    let start = at
    while (start > 0 && lines[start - 1].key === undefined && lines[start - 1].raw.trimStart().startsWith('#')) start--
    lines.splice(start, at - start + 1)
    return { ...file, lines }
  }
  const comment = description?.trim()
  if (at >= 0) {
    const old = lines[at]
    lines[at] = { ...old, raw: entryRaw(key, value), value }
    if (description !== undefined && comment !== (old.comment ?? '')) {
      // Replace the comment block directly above with the new description.
      let start = at
      while (start > 0 && lines[start - 1].key === undefined && lines[start - 1].raw.trimStart().startsWith('#')) start--
      const block = comment ? [{ raw: `# ${comment}` }] : []
      lines.splice(start, at - start, ...block)
      const idx = start + block.length
      lines[idx] = { ...lines[idx], comment: comment || undefined }
    }
    return { ...file, lines }
  }
  const add: PropLine[] = []
  // A described entry gets a blank line before its comment; plain overrides stay compact.
  if (comment && lines.length && lines[lines.length - 1].raw.trim() !== '') add.push({ raw: '' })
  if (comment) add.push({ raw: `# ${comment}` })
  add.push({ raw: entryRaw(key, value), key, value, comment: comment || undefined })
  return { ...file, lines: [...lines, ...add] }
}

export function renameEntry(file: PropFile, from: string, to: string): PropFile {
  return { ...file, lines: file.lines.map((l) => (l.key === from ? { ...l, key: to, raw: entryRaw(to, l.value ?? '') } : l)) }
}

export const emptyFile = (env: string): PropFile => ({ rel: envFileRel(env), env, lines: [] })

/** The value a placeholder gets in an environment: its override, or the default. */
export function resolveVar(g: GlobalVars | null, name: string, env: string): { value: string; from: string } | null {
  const v = g?.vars.find((x) => x.name === name)
  if (!v) return null
  if (env !== DEFAULT_ENV && v.values[env] !== undefined) return { value: v.values[env], from: env }
  if (v.values[DEFAULT_ENV] !== undefined) return { value: v.values[DEFAULT_ENV], from: DEFAULT_ENV }
  return null
}

// ------------------------------------------------------------- placeholders --

/** `{{name}}` or `{{name:default}}` in Camel; `${name}` style is Spring's and not resolved here. */
export const PLACEHOLDER = /\{\{([^}:]+)(?::([^}]*))?\}\}/g

export interface PlaceholderUse {
  name: string
  hasDefault: boolean
}

export function placeholdersIn(text: string): PlaceholderUse[] {
  const out: PlaceholderUse[] = []
  for (const m of text.matchAll(PLACEHOLDER)) out.push({ name: m[1].trim(), hasDefault: m[2] !== undefined })
  return out
}

/** Replaces placeholders with their values in an environment; unknown ones are left as written. */
export function resolveText(text: string, g: GlobalVars | null, env: string): string {
  return text.replace(PLACEHOLDER, (all, name: string, def: string | undefined) => resolveVar(g, name.trim(), env)?.value ?? def ?? all)
}
