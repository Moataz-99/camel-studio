// Runs Data Mapper stylesheets for the live preview, with the same engine Camel uses at run
// time (Saxon-HE, the engine behind camel-xslt-saxon), so the preview shows exactly what the
// route will produce.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MapperPreviewRequest, MapperPreviewResult } from '@shared/types'
import { resolveTools, TOOLCHAIN_DIR } from './runner'

/** The Saxon release camel-xslt-saxon 4.22.2 is built against, and the jars it needs at run time. */
const SAXON_VERSION = '13.0'
const JARS = [
  { group: 'net/sf/saxon', artifact: 'Saxon-HE', version: SAXON_VERSION, classifier: '' },
  { group: 'org/xmlresolver', artifact: 'xmlresolver', version: '6.0.23', classifier: '' },
  { group: 'org/xmlresolver', artifact: 'xmlresolver', version: '6.0.23', classifier: 'data' }
]
const CENTRAL = 'https://repo1.maven.org/maven2'
const SOURCE_PARAM = 'CamelStudioSourceJson'

let saxonReady: Promise<string[]> | null = null

/** Paths of the Saxon jars: the local Maven cache if it has them, otherwise a one-time download. */
function saxonJars(): Promise<string[]> {
  saxonReady ??= (async () => {
    const dir = join(TOOLCHAIN_DIR, `saxon-${SAXON_VERSION}`)
    const paths: string[] = []
    for (const j of JARS) {
      const file = `${j.artifact}-${j.version}${j.classifier ? `-${j.classifier}` : ''}.jar`
      const m2 = join(homedir(), '.m2', 'repository', ...j.group.split('/'), j.artifact, j.version, file)
      const own = join(dir, file)
      if (existsSync(m2)) {
        paths.push(m2)
        continue
      }
      if (!existsSync(own)) {
        const url = `${CENTRAL}/${j.group}/${j.artifact}/${j.version}/${file}`
        const [jar, sha1] = await Promise.all([fetch(url), fetch(`${url}.sha1`)])
        if (!jar.ok || !sha1.ok) throw new Error(`Could not download ${file} from Maven Central (HTTP ${jar.status})`)
        const bytes = Buffer.from(await jar.arrayBuffer())
        const expected = (await sha1.text()).trim().split(/\s+/)[0]
        if (createHash('sha1').update(bytes).digest('hex') !== expected) throw new Error(`${file} failed its checksum check`)
        await mkdir(dir, { recursive: true })
        await writeFile(`${own}.part`, bytes)
        await rename(`${own}.part`, own)
      }
      paths.push(own)
    }
    return paths
  })().catch((e) => {
    saxonReady = null
    throw e
  })
  return saxonReady
}

const JAVA_HOME_BIN = (env: NodeJS.ProcessEnv): string => (env.JAVA_HOME ? join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java')

/** Saxon reports problems on stderr with a lot of framing; keep the lines a person needs. */
function cleanError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^at |^Errors were reported|^Transformation failed|^Processing terminated/.test(l))
  return lines.slice(0, 8).join('\n') || 'The transformation failed'
}

export async function runPreview(root: string | null, req: MapperPreviewRequest): Promise<MapperPreviewResult> {
  const started = Date.now()
  let jars: string[]
  try {
    jars = await saxonJars()
  } catch (e) {
    return { ok: false, output: '', error: `The preview engine could not be prepared: ${(e as Error).message}`, ms: 0 }
  }
  const tools = await resolveTools(root)
  if (!tools.javaOut) return { ok: false, output: '', error: 'The preview needs Java. No JDK was found on this machine.', ms: 0 }

  const work = await mkdtemp(join(tmpdir(), 'camel-studio-map-'))
  try {
    const xsl = join(work, 'mapping.xsl')
    await writeFile(xsl, req.xslt, 'utf8')
    const args = ['-cp', jars.join(delimiter), 'net.sf.saxon.Transform', `-xsl:${xsl}`, '-warnings:silent']
    if (req.sourceFormat === 'json') {
      // Same as at run time: the JSON travels as a parameter and the input document is a placeholder.
      const json = join(work, 'input.json')
      const doc = join(work, 'input.xml')
      await writeFile(json, req.input, 'utf8')
      await writeFile(doc, '<camel-studio/>', 'utf8')
      args.push(`-s:${doc}`, `?${SOURCE_PARAM}=unparsed-text('${pathToFileURL(json).href}')`)
    } else {
      const doc = join(work, 'input.xml')
      await writeFile(doc, req.input, 'utf8')
      args.push(`-s:${doc}`)
    }
    // Saxon's name=value form passes a plain string, the same type Camel hands in for a String header.
    for (const p of req.params ?? []) if (/^[A-Za-z_][\w.-]*$/.test(p.name)) args.push(`${p.name}=${p.value}`)
    const java = tools.javaOut ? JAVA_HOME_BIN(tools.env) : 'java'
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      execFile(java, args, { env: tools.env, timeout: 30000, maxBuffer: 20 * 1024 * 1024 }, (err, out, errOut) => {
        resolve({ stdout: String(out), stderr: String(errOut), code: err ? 1 : 0 })
      })
    })
    const ms = Date.now() - started
    if (code !== 0) return { ok: false, output: stdout, error: cleanError(stderr), ms }
    return { ok: true, output: stdout, error: null, ms }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Reads a file the user picked outside the project, so it can be copied in. */
export const readPicked = (path: string): Promise<string> => readFile(path, 'utf8')
