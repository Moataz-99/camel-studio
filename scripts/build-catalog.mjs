// Builds the offline Camel catalog bundle used by the designer.
//
// Source of truth is the official `org.apache.camel:camel-catalog` JAR on Maven
// Central: it carries one JSON descriptor per component, EIP, language and data
// format. We slim those down into resources/catalog so the palette and the
// property forms need no network access at runtime.
//
//   node scripts/build-catalog.mjs            # version from package.json
//   node scripts/build-catalog.mjs 4.22.2     # explicit version

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync, strFromU8 } from 'fflate'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const camelVersion = process.argv[2] || pkg.camelStudio.camelVersion
const CENTRAL = 'https://repo1.maven.org/maven2/org/apache/camel'
const outDir = join(root, 'resources', 'catalog')

async function fetchOk(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return res
}

console.log(`Camel catalog ${camelVersion}: downloading…`)
const jar = new Uint8Array(
  await (await fetchOk(`${CENTRAL}/camel-catalog/${camelVersion}/camel-catalog-${camelVersion}.jar`)).arrayBuffer()
)
const BASE = 'org/apache/camel/catalog/'
const wanted = ['components/', 'models/', 'languages/', 'dataformats/']
const files = unzipSync(jar, {
  filter: (f) => f.name.endsWith('.json') && wanted.some((w) => f.name.startsWith(BASE + w))
})

// The Spring Boot version that this Camel release is built and tested against.
let springBootVersion = null
try {
  const parentPom = await (await fetchOk(`${CENTRAL}/camel-parent/${camelVersion}/camel-parent-${camelVersion}.pom`)).text()
  springBootVersion = parentPom.match(/<spring-boot-version>([^<]+)</)?.[1] ?? null
} catch (e) {
  console.warn(`  could not resolve Spring Boot version: ${e.message}`)
}

const slimProp = (name, p) => {
  const out = { name, kind: p.kind, type: p.type }
  if (p.displayName) out.displayName = p.displayName
  if (p.group) out.group = p.group
  if (p.label) out.label = p.label
  if (p.required) out.required = true
  if (p.secret) out.secret = true
  if (p.deprecated) out.deprecated = true
  if (p.enum) out.enum = p.enum
  if (p.oneOf) out.oneOf = p.oneOf
  if (p.javaType) out.javaType = p.javaType
  if (p.defaultValue !== undefined && p.defaultValue !== null && p.defaultValue !== '') out.defaultValue = p.defaultValue
  if (p.description) out.description = p.description
  if (p.index !== undefined) out.index = p.index
  return out
}
const slimProps = (props) => Object.entries(props ?? {}).map(([name, p]) => slimProp(name, p))

const index = {
  camelVersion,
  springBootVersion,
  components: [],
  eips: [],
  languages: [],
  dataformats: []
}
const components = {}
const models = {}

for (const [path, bytes] of Object.entries(files)) {
  const rel = path.slice(BASE.length)
  const [kind] = rel.split('/')
  const json = JSON.parse(strFromU8(bytes))

  if (kind === 'components') {
    const c = json.component
    index.components.push({
      name: c.scheme ?? c.name,
      title: c.title,
      description: c.description,
      label: c.label ?? '',
      syntax: c.syntax,
      artifactId: c.artifactId,
      consumerOnly: !!c.consumerOnly,
      producerOnly: !!c.producerOnly,
      deprecated: !!c.deprecated,
      remote: !!c.remote
    })
    components[c.scheme ?? c.name] = {
      name: c.scheme ?? c.name,
      title: c.title,
      description: c.description,
      label: c.label ?? '',
      syntax: c.syntax,
      artifactId: c.artifactId,
      consumerOnly: !!c.consumerOnly,
      producerOnly: !!c.producerOnly,
      properties: slimProps(json.properties)
    }
  } else if (kind === 'models') {
    const m = json.model
    const entry = {
      name: m.name,
      title: m.title,
      description: m.description,
      label: m.label ?? '',
      input: !!m.input,
      output: !!m.output,
      abstract: !!m.abstract,
      deprecated: !!m.deprecated
    }
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

for (const k of ['components', 'eips', 'languages', 'dataformats']) {
  index[k].sort((a, b) => a.name.localeCompare(b.name))
}

await rm(outDir, { recursive: true, force: true })
await mkdir(join(outDir, 'components'), { recursive: true })
await writeFile(join(outDir, 'index.json'), JSON.stringify(index))
await writeFile(join(outDir, 'models.json'), JSON.stringify(models))
await Promise.all(
  Object.entries(components).map(([name, c]) => writeFile(join(outDir, 'components', `${name}.json`), JSON.stringify(c)))
)

console.log(
  `  ${index.components.length} components, ${index.eips.length} models, ` +
    `${index.languages.length} languages, ${index.dataformats.length} data formats` +
    ` · Spring Boot ${springBootVersion ?? 'unknown'}`
)
console.log(`  written to ${outDir}`)
