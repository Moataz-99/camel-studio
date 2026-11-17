// Camel Studio's own settings (the admin area): which JDK and Maven to use, the Camel catalog
// version, defaults for new projects, and the team palette. Kept in ~/.camel-studio/settings.json
// and shareable as a team profile file.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type { CamelVersionInfo, CustomComponent, ProgressEvent, StudioSettings, ToolCandidate, ToolchainList } from '@shared/types'

/** CAMEL_STUDIO_HOME moves everything (for automated checks that must not touch a real setup). */
export const STUDIO_HOME = process.env.CAMEL_STUDIO_HOME || join(homedir(), '.camel-studio')
const SETTINGS_FILE = join(STUDIO_HOME, 'settings.json')
export const CATALOGS_DIR = join(STUDIO_HOME, 'catalogs')
export const COMPONENTS_DIR = join(STUDIO_HOME, 'components')
const TOOLS_DIR = process.env.CAMEL_STUDIO_TOOLCHAIN || join(STUDIO_HOME, 'toolchain')
const CENTRAL = 'https://repo1.maven.org/maven2'
const isWin = process.platform === 'win32'

const DEFAULTS: StudioSettings = {
  javaHome: null,
  mavenHome: null,
  mavenSettings: null,
  camelVersion: null,
  defaults: { groupId: 'com.example.integration', routeFormat: 'java', javaVersion: '21' },
  snippets: [],
  components: []
}

// --------------------------------------------------------------- storage --

let cached: StudioSettings | null = null

export function getSettings(): StudioSettings {
  if (cached) return cached
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<StudioSettings>
    cached = { ...DEFAULTS, ...raw, defaults: { ...DEFAULTS.defaults, ...(raw.defaults ?? {}) } }
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached
}

export async function updateSettings(patch: Partial<StudioSettings>): Promise<StudioSettings> {
  const next: StudioSettings = { ...getSettings(), ...patch }
  if (patch.defaults) next.defaults = { ...getSettings().defaults, ...patch.defaults }
  await mkdir(STUDIO_HOME, { recursive: true })
  await writeFile(`${SETTINGS_FILE}.tmp`, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE)
  cached = next
  return next
}

// ------------------------------------------------------------- toolchains --

const javaBin = (home: string): string => join(home, 'bin', isWin ? 'java.exe' : 'java')
const mvnBin = (home: string): string => join(home, 'bin', isWin ? 'mvn.cmd' : 'mvn')

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, env, shell: isWin && cmd.endsWith('.cmd') }, (err, out, errOut) => resolve(err ? null : `${out}\n${errOut}`))
  })
}

async function subdirs(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).map((n) => join(dir, n))
}

/** Every JDK and Maven this machine has in the usual places, with its version. */
export async function listToolchains(shellPath: string | undefined): Promise<ToolchainList> {
  const jdkHomes = new Map<string, string>()
  const add = (path: string, source: string): void => {
    if (existsSync(javaBin(path)) && !jdkHomes.has(path)) jdkHomes.set(path, source)
  }
  for (const d of await subdirs(TOOLS_DIR)) add(d.endsWith('.jdk') ? d : existsSync(join(d, 'Contents', 'Home')) ? join(d, 'Contents', 'Home') : d, 'Camel Studio')
  if (process.env.JAVA_HOME) add(process.env.JAVA_HOME, 'JAVA_HOME')
  if (process.platform === 'darwin') {
    for (const base of ['/Library/Java/JavaVirtualMachines', join(homedir(), 'Library', 'Java', 'JavaVirtualMachines')]) for (const d of await subdirs(base)) add(join(d, 'Contents', 'Home'), 'installed')
  }
  if (process.platform === 'linux') for (const d of await subdirs('/usr/lib/jvm')) add(d, 'installed')
  if (isWin) {
    for (const base of ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Zulu']) for (const d of await subdirs(base)) add(d, 'installed')
  }
  for (const d of await subdirs(join(homedir(), '.sdkman', 'candidates', 'java'))) if (!d.endsWith('current')) add(d, 'SDKMAN')
  // The one on PATH, when it is not one of the above.
  for (const dir of (shellPath ?? '').split(isWin ? ';' : ':')) {
    if (existsSync(join(dir, isWin ? 'java.exe' : 'java')) && !dir.startsWith('/usr/bin')) add(join(dir, '..'), 'PATH')
  }

  const jdks: ToolCandidate[] = []
  for (const [path, source] of jdkHomes) {
    const out = await run(javaBin(path), ['-version'])
    const version = out?.match(/version "([^"]+)"/)?.[1]
    if (version) jdks.push({ path, version, source })
  }

  const mavenHomes = new Map<string, string>()
  for (const d of await subdirs(TOOLS_DIR)) if (existsSync(mvnBin(d)) && !d.endsWith(`${isWin ? '\\' : '/'}maven`)) mavenHomes.set(d, 'Camel Studio')
  for (const d of await subdirs(join(homedir(), '.sdkman', 'candidates', 'maven'))) if (existsSync(mvnBin(d)) && !d.endsWith('current')) mavenHomes.set(d, 'SDKMAN')
  if (process.env.MAVEN_HOME && existsSync(mvnBin(process.env.MAVEN_HOME))) mavenHomes.set(process.env.MAVEN_HOME, 'MAVEN_HOME')
  for (const base of ['/opt/homebrew/opt/maven/libexec', '/usr/local/opt/maven/libexec', '/usr/share/maven', 'C:\\Program Files\\Apache\\maven']) if (existsSync(mvnBin(base))) mavenHomes.set(base, 'installed')
  const mavens: ToolCandidate[] = []
  const anyJava = jdks[0]?.path
  for (const [path, source] of mavenHomes) {
    const out = await run(mvnBin(path), ['-v'], anyJava ? { ...process.env, JAVA_HOME: anyJava } : process.env)
    const version = out?.match(/Apache Maven (\S+)/)?.[1] ?? (out ? '?' : null)
    if (version) mavens.push({ path, version, source })
  }
  return { jdks, mavens }
}

// --------------------------------------------------------------- downloads --

type Progress = (e: ProgressEvent) => void

async function download(url: string, task: string, progress: Progress): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}): ${url}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const chunks: Uint8Array[] = []
  let received = 0
  let last = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (Date.now() - last > 150) {
      last = Date.now()
      progress({ task, received, total })
    }
  }
  progress({ task, received, total })
  return Buffer.concat(chunks)
}

/** Unpacks with the system tar, which also reads .zip on Windows 10 and later. */
function untar(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xf', archive, '-C', dest], { timeout: 300000 }, (err, _out, errOut) => (err ? reject(new Error(`Unpacking failed: ${errOut || err.message}`)) : resolve()))
  })
}

async function findHome(dir: string, binary: string, depth = 3): Promise<string | null> {
  if (existsSync(join(dir, 'bin', binary))) return dir
  if (depth === 0) return null
  for (const d of await subdirs(dir)) {
    if ((await stat(d).catch(() => null))?.isDirectory()) {
      const hit = await findHome(d, binary, depth - 1)
      if (hit) return hit
    }
  }
  return null
}

/** Installs Eclipse Temurin (the Adoptium OpenJDK build) into ~/.camel-studio/toolchain. */
export async function installJdk(feature: number, progress: Progress): Promise<string> {
  const os = isWin ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
  const api = `https://api.adoptium.net/v3/assets/latest/${feature}/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`
  const meta = (await (await fetch(api)).json()) as { release_name: string; binary: { package: { name: string; link: string; checksum: string } } }[]
  const pkg = meta[0]?.binary?.package
  if (!pkg) throw new Error(`No JDK ${feature} build is published for ${os}/${arch}`)
  const task = `JDK ${meta[0].release_name}`
  const bytes = await download(pkg.link, task, progress)
  if (createHash('sha256').update(bytes).digest('hex') !== pkg.checksum) throw new Error('The JDK download failed its checksum check')
  return unpackInto(bytes, pkg.name, meta[0].release_name, isWin ? 'java.exe' : 'java', task, progress)
}

/** Installs the newest Apache Maven 3.9 from Maven Central into ~/.camel-studio/toolchain. */
export async function installMaven(progress: Progress): Promise<string> {
  const metadata = await (await fetch(`${CENTRAL}/org/apache/maven/apache-maven/maven-metadata.xml`)).text()
  const versions = [...metadata.matchAll(/<version>(3\.9\.\d+)<\/version>/g)].map((m) => m[1])
  const version = versions.sort((a, b) => Number(a.split('.')[2]) - Number(b.split('.')[2])).pop()
  if (!version) throw new Error('No Maven 3.9 release was found on Maven Central')
  const name = `apache-maven-${version}-bin.tar.gz`
  const url = `${CENTRAL}/org/apache/maven/apache-maven/${version}/${name}`
  const task = `Maven ${version}`
  const bytes = await download(url, task, progress)
  const sha1 = (await (await fetch(`${url}.sha1`)).text()).trim().split(/\s+/)[0]
  if (createHash('sha1').update(bytes).digest('hex') !== sha1) throw new Error('The Maven download failed its checksum check')
  return unpackInto(bytes, name, `apache-maven-${version}`, isWin ? 'mvn.cmd' : 'mvn', task, progress)
}

async function unpackInto(bytes: Buffer, fileName: string, folder: string, binary: string, task: string, progress: Progress): Promise<string> {
  const target = join(TOOLS_DIR, folder.replace(/[^\w.+-]/g, '-'))
  const staging = `${target}.part`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const archive = join(staging, fileName)
  await writeFile(archive, bytes)
  await untar(archive, staging)
  await rm(archive, { force: true })
  const home = await findHome(staging, binary)
  if (!home) throw new Error(`The download did not contain bin/${binary}`)
  await rm(target, { recursive: true, force: true })
  await rename(staging, target)
  progress({ task, received: bytes.length, total: bytes.length, done: true })
  return home.replace(staging, target)
}

// ----------------------------------------------------------------- catalogs --

const versionKey = (v: string): number[] => v.split('.').map((n) => Number(n) || 0)
const newer = (a: string, b: string): number => {
  const x = versionKey(a)
  const y = versionKey(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]
  return 0
}
/** Camel's long-term support release lines (one per year, each supported for about a year). */
const LTS = new Set(['4.4', '4.8', '4.10', '4.14', '4.18'])

export async function camelVersions(bundled: string): Promise<CamelVersionInfo[]> {
  const xml = await (await fetch(`${CENTRAL}/org/apache/camel/camel-catalog/maven-metadata.xml`)).text()
  const all = [...xml.matchAll(/<version>(4\.\d+\.\d+)<\/version>/g)].map((m) => m[1]).sort(newer)
  // The newest patch of each minor line, newest lines first.
  const lines = new Map<string, string>()
  for (const v of all) {
    const line = v.split('.').slice(0, 2).join('.')
    if (!lines.has(line)) lines.set(line, v)
  }
  const installed = new Set(await readdir(CATALOGS_DIR).catch(() => [] as string[]))
  const list = [...lines.values()].slice(0, 12)
  if (!list.includes(bundled)) list.push(bundled)
  return list.sort(newer).map((version) => ({ version, installed: installed.has(version) || version === bundled, bundled: version === bundled, lts: LTS.has(version.split('.').slice(0, 2).join('.')) }))
}

/** Downloads a camel-catalog release and slims it into the format the designer reads. */
export async function installCatalog(version: string, progress: Progress): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a Camel version: ${version}`)
  const task = `Camel ${version} catalog`
  const jar = await download(`${CENTRAL}/org/apache/camel/camel-catalog/${version}/camel-catalog-${version}.jar`, task, progress)
  const parentPom = await (await fetch(`${CENTRAL}/org/apache/camel/camel-parent/${version}/camel-parent-${version}.pom`)).text().catch(() => '')
  const springBootVersion = parentPom.match(/<spring-boot-version>([^<]+)</)?.[1] ?? null
  const BASE = 'org/apache/camel/catalog/'
  const files = unzipSync(new Uint8Array(jar), { filter: (f) => f.name.endsWith('.json') && ['components/', 'models/', 'languages/', 'dataformats/'].some((w) => f.name.startsWith(BASE + w)) })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type J = any
  const slimProp = (name: string, p: J): J => {
    const out: J = { name, kind: p.kind, type: p.type }
    for (const k of ['displayName', 'group', 'label', 'enum', 'oneOf', 'javaType', 'description', 'index']) if (p[k] !== undefined) out[k] = p[k]
    for (const k of ['required', 'secret', 'deprecated']) if (p[k]) out[k] = true
    if (p.defaultValue !== undefined && p.defaultValue !== null && p.defaultValue !== '') out.defaultValue = p.defaultValue
    return out
  }
  const slimProps = (props: J): J[] => Object.entries(props ?? {}).map(([n, p]) => slimProp(n, p))
  const index: J = { camelVersion: version, springBootVersion, components: [], eips: [], languages: [], dataformats: [] }
  const components: Record<string, J> = {}
  const models: Record<string, J> = {}
  for (const [path, bytes] of Object.entries(files)) {
    const kind = path.slice(BASE.length).split('/')[0]
    const json = JSON.parse(strFromU8(bytes))
    if (kind === 'components') {
      const c = json.component
      const name = c.scheme ?? c.name
      const entry = { name, title: c.title, description: c.description, label: c.label ?? '', syntax: c.syntax, artifactId: c.artifactId, consumerOnly: !!c.consumerOnly, producerOnly: !!c.producerOnly, deprecated: !!c.deprecated, remote: !!c.remote }
      index.components.push(entry)
      components[name] = { ...entry, properties: slimProps(json.properties) }
    } else if (kind === 'models') {
      const m = json.model
      const entry = { name: m.name, title: m.title, description: m.description, label: m.label ?? '', input: !!m.input, output: !!m.output, abstract: !!m.abstract, deprecated: !!m.deprecated }
      index.eips.push(entry)
      models[m.name] = { ...entry, properties: slimProps(json.properties) }
    } else if (kind === 'languages') {
      const l = json.language
      index.languages.push({ name: l.name, title: l.title, description: l.description, artifactId: l.artifactId })
    } else if (kind === 'dataformats') {
      const d = json.dataformat
      index.dataformats.push({ name: d.name, title: d.title, description: d.description, artifactId: d.artifactId })
    }
  }
  for (const k of ['components', 'eips', 'languages', 'dataformats']) index[k].sort((a: J, b: J) => a.name.localeCompare(b.name))
  const out = join(CATALOGS_DIR, version)
  const staging = `${out}.part`
  await rm(staging, { recursive: true, force: true })
  await mkdir(join(staging, 'components'), { recursive: true })
  await writeFile(join(staging, 'index.json'), JSON.stringify(index))
  await writeFile(join(staging, 'models.json'), JSON.stringify(models))
  await Promise.all(Object.entries(components).map(([n, c]) => writeFile(join(staging, 'components', `${n}.json`), JSON.stringify(c))))
  await rm(out, { recursive: true, force: true })
  await rename(staging, out)
  progress({ task, received: jar.length, total: jar.length, done: true })
}

// ---------------------------------------------------------- custom components --

/**
 * Reads a component JAR the team built with Camel's Maven plugin: its descriptor (the same JSON
 * the Camel catalog has) and its Maven coordinates (META-INF/maven/…/pom.properties).
 */
export async function importComponentJar(path: string): Promise<CustomComponent> {
  const zip = unzipSync(new Uint8Array(await readFile(path)), { filter: (f) => f.name.endsWith('.json') || f.name.endsWith('pom.properties') })
  let descriptor: { component: Record<string, unknown>; properties?: Record<string, unknown> } | null = null
  let coords: Record<string, string> | null = null
  for (const [name, bytes] of Object.entries(zip)) {
    if (name.endsWith('pom.properties')) {
      coords = Object.fromEntries(
        strFromU8(bytes)
          .split(/\r?\n/)
          .filter((l) => l.includes('=') && !l.startsWith('#'))
          .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
      )
      continue
    }
    try {
      const json = JSON.parse(strFromU8(bytes))
      if (json?.component?.scheme) descriptor = json
    } catch {
      /* not a descriptor */
    }
  }
  if (!descriptor) throw new Error(`${basename(path)} has no Camel component descriptor. Build the component with camel-package-maven-plugin (it writes one), or check this is the component JAR.`)
  const c = descriptor.component as Record<string, string | boolean>
  const scheme = String(c.scheme)
  const entry: CustomComponent = {
    scheme,
    title: String(c.title ?? scheme),
    description: String(c.description ?? ''),
    groupId: coords?.groupId ?? String(c.groupId ?? ''),
    artifactId: coords?.artifactId ?? String(c.artifactId ?? ''),
    version: coords?.version ?? String(c.version ?? '')
  }
  if (!entry.groupId || !entry.artifactId) throw new Error(`${basename(path)} does not say its Maven coordinates (no pom.properties inside).`)
  const props = Object.entries(descriptor.properties ?? {}).map(([name, p]) => ({ name, ...(p as object) }))
  await mkdir(COMPONENTS_DIR, { recursive: true })
  await writeFile(
    join(COMPONENTS_DIR, `${scheme}.json`),
    JSON.stringify({
      name: scheme,
      title: entry.title,
      description: entry.description,
      label: `custom,${String(c.label ?? '')}`,
      syntax: String(c.syntax ?? `${scheme}:path`),
      artifactId: entry.artifactId,
      consumerOnly: !!c.consumerOnly,
      producerOnly: !!c.producerOnly,
      properties: props
    })
  )
  const s = getSettings()
  await updateSettings({ components: [...s.components.filter((x) => x.scheme !== scheme), entry] })
  return entry
}

export async function removeComponent(scheme: string): Promise<StudioSettings> {
  await rm(join(COMPONENTS_DIR, `${scheme}.json`), { force: true })
  return updateSettings({ components: getSettings().components.filter((c) => c.scheme !== scheme) })
}

// ------------------------------------------------------------- team profile --

/**
 * What a team profile carries: everything except paths that only make sense on one machine
 * (JDK, Maven, settings.xml). Custom component descriptors travel inside it.
 */
export async function profileOf(s: StudioSettings): Promise<Record<string, unknown>> {
  const componentDefs: Record<string, unknown> = {}
  for (const c of s.components) {
    const text = await readFile(join(COMPONENTS_DIR, `${c.scheme}.json`), 'utf8').catch(() => null)
    if (text) componentDefs[c.scheme] = JSON.parse(text)
  }
  return { kind: 'camel-studio-team-profile', version: 1, camelVersion: s.camelVersion, defaults: s.defaults, snippets: s.snippets, components: s.components, componentDefs }
}

export async function applyProfile(text: string): Promise<StudioSettings> {
  const p = JSON.parse(text)
  if (p?.kind !== 'camel-studio-team-profile') throw new Error('This file is not a Camel Studio team profile')
  if (p.componentDefs && typeof p.componentDefs === 'object') {
    await mkdir(COMPONENTS_DIR, { recursive: true })
    for (const [scheme, def] of Object.entries(p.componentDefs)) if (/^[\w+.-]+$/.test(scheme)) await writeFile(join(COMPONENTS_DIR, `${scheme}.json`), JSON.stringify(def))
  }
  return updateSettings({
    camelVersion: typeof p.camelVersion === 'string' ? p.camelVersion : null,
    defaults: p.defaults ?? getSettings().defaults,
    snippets: Array.isArray(p.snippets) ? p.snippets : [],
    components: Array.isArray(p.components) ? p.components : []
  })
}
