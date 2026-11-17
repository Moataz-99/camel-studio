import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { RunEvent, RunMode, RunStatus, Toolchain } from '@shared/types'
import { activeByDefaultProfiles, hasProfile, PROFILE, PROFILE_DEBUG } from './project'
import { getSettings } from './settings'

const isWin = process.platform === 'win32'

/**
 * A desktop app started from Finder or the Start menu does not inherit the PATH a
 * terminal has, so `java` and `mvn` installed through SDKMAN, Homebrew and the like
 * would not be found. Ask the user's login shell for its PATH once.
 */
let envPromise: Promise<NodeJS.ProcessEnv> | null = null
export function shellEnv(): Promise<NodeJS.ProcessEnv> {
  envPromise ??= new Promise((resolve) => {
    if (isWin) return resolve(process.env)
    const shell = process.env.SHELL || '/bin/zsh'
    execFile(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"; printf "__JH__%s__JH__" "$JAVA_HOME"'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(process.env)
      const path = stdout.match(/__PATH__(.*?)__PATH__/s)?.[1]
      const javaHome = stdout.match(/__JH__(.*?)__JH__/s)?.[1]
      resolve({
        ...process.env,
        ...(path ? { PATH: path } : {}),
        ...(javaHome ? { JAVA_HOME: javaHome } : {})
      })
    })
  })
  return envPromise
}

function probe(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: 15000, shell: isWin }, (err, stdout, stderr) => {
      if (err) return resolve(null)
      resolve(`${stdout}\n${stderr}`)
    })
  })
}

function wrapperPath(root: string | null): string | null {
  if (!root) return null
  const p = join(root, isWin ? 'mvnw.cmd' : 'mvnw')
  return existsSync(p) ? p : null
}

/** `CAMEL_STUDIO_MVN` overrides the Maven executable (useful for a pinned Maven or for tests). */
function mavenCommand(root: string | null): string {
  return process.env.CAMEL_STUDIO_MVN || wrapperPath(root) || (isWin ? 'mvn.cmd' : 'mvn')
}

/**
 * Camel Studio's own toolchain: a JDK and a Maven unpacked under ~/.camel-studio/toolchain
 * (`jdk` and `maven`). It is a fallback only: whatever the machine or the project already
 * provides wins, and nothing outside that folder is changed (no PATH or profile edits).
 */
export const TOOLCHAIN_DIR = process.env.CAMEL_STUDIO_TOOLCHAIN || join(homedir(), '.camel-studio', 'toolchain')

function privateJavaHome(): string | null {
  const home = join(TOOLCHAIN_DIR, 'jdk')
  return existsSync(join(home, 'bin', isWin ? 'java.exe' : 'java')) ? home : null
}

function privateMaven(): string | null {
  const mvn = join(TOOLCHAIN_DIR, 'maven', 'bin', isWin ? 'mvn.cmd' : 'mvn')
  return existsSync(mvn) ? mvn : null
}

export interface ResolvedTools {
  env: NodeJS.ProcessEnv
  mvn: string
  javaOut: string | null
  mvnOut: string | null
  privateTools: boolean
}

export async function resolveTools(root: string | null): Promise<ResolvedTools> {
  let env = await shellEnv()
  let privateTools = false
  const chosen = getSettings()

  // A JDK picked in the admin area wins over whatever the machine has on its PATH.
  if (chosen.javaHome && existsSync(join(chosen.javaHome, 'bin', isWin ? 'java.exe' : 'java'))) {
    env = { ...env, JAVA_HOME: chosen.javaHome, PATH: `${join(chosen.javaHome, 'bin')}${delimiter}${env.PATH ?? ''}` }
  }
  let javaOut = await probe(chosen.javaHome ? join(chosen.javaHome, 'bin', isWin ? 'java.exe' : 'java') : 'java', ['-version'], env)
  if (!javaOut) {
    const home = privateJavaHome()
    if (home) {
      env = { ...env, JAVA_HOME: home, PATH: `${join(home, 'bin')}${delimiter}${env.PATH ?? ''}` }
      javaOut = await probe(join(home, 'bin', 'java'), ['-version'], env)
      privateTools ||= javaOut !== null
    }
  }

  const chosenMvn = chosen.mavenHome ? join(chosen.mavenHome, 'bin', isWin ? 'mvn.cmd' : 'mvn') : null
  // A project's own Maven wrapper still wins: it pins the version the project was built with.
  let mvn = process.env.CAMEL_STUDIO_MVN || wrapperPath(root) || (chosenMvn && existsSync(chosenMvn) ? chosenMvn : mavenCommand(root))
  let mvnOut = await probe(mvn, ['-v'], env)
  if (!mvnOut && !process.env.CAMEL_STUDIO_MVN) {
    const own = privateMaven()
    const out = own ? await probe(own, ['-v'], env) : null
    if (own && out) {
      mvn = own
      mvnOut = out
      privateTools = true
    }
  }
  return { env, mvn, javaOut, mvnOut, privateTools }
}

export async function detectToolchain(root: string | null): Promise<Toolchain> {
  const t = await resolveTools(root)
  return {
    java: t.javaOut?.match(/version "([^"]+)"/)?.[1] ?? (t.javaOut ? 'detected' : null),
    maven: t.mvnOut?.match(/Apache Maven (\S+)/)?.[1] ?? (t.mvnOut ? 'detected' : null),
    wrapper: wrapperPath(root) !== null && t.mvn === wrapperPath(root),
    privateTools: t.privateTools
  }
}

/**
 * When the project has the Camel Studio profile, run with it so the app carries Camel's CLI
 * connector (live statistics, tracing, test messages) and, in debug mode, the debugger.
 */
function runtimeToolArgs(root: string, mode: RunMode): string[] {
  let pom = ''
  try {
    pom = readFileSync(join(root, 'pom.xml'), 'utf8')
  } catch {
    return []
  }
  if (!hasProfile(pom, PROFILE)) return []
  const profiles = [PROFILE]
  if (mode === 'debug' && hasProfile(pom, PROFILE_DEBUG)) profiles.push(PROFILE_DEBUG)
  // Naming a profile switches Maven's activeByDefault profiles off: name those too, so the build is unchanged.
  profiles.push(...activeByDefaultProfiles(pom).filter((p) => !profiles.includes(p)))
  // sourceLocationEnabled makes Camel record the line of every Java DSL step, which is how
  // generated classes are matched back to the canvas.
  const jvm = ['-Dcamel.trace.enabled=true', '-Dcamel.main.sourceLocationEnabled=true']
  // The debugger is driven through the connector's files; its JMX port is not needed.
  if (mode === 'debug') jvm.push('-Dcamel.debug.jmxConnectorEnabled=false')
  const jvmArg = `-Dspring-boot.run.jvmArguments=${jvm.join(' ')}`
  return [`-P${profiles.join(',')}`, isWin ? `"${jvmArg}"` : jvmArg]
}

/** The runnable JAR in target/: the newest one that is not sources, javadoc, tests or the plain variant. */
function builtJar(root: string): { path: string; size: number } | null {
  const dir = join(root, 'target')
  let best: { path: string; size: number; time: number } | null = null
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jar') || /-(sources|javadoc|tests|plain)\.jar$/.test(name)) continue
      const st = statSync(join(dir, name))
      if (!best || st.mtimeMs > best.time) best = { path: join(dir, name), size: st.size, time: st.mtimeMs }
    }
  } catch {
    return null
  }
  return best && { path: best.path, size: best.size }
}

const STARTED = /Started \S+ in [\d.]+ seconds|Apache Camel \S+ \(.*\) started in/
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

export class Runner {
  private child: ChildProcess | null = null
  private status: RunStatus = 'idle'
  private stopRequested = false
  private pending: string[] = []
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private readonly emit: (event: RunEvent) => void) {}

  private setStatus(status: RunStatus, detail?: string): void {
    this.status = status
    this.emit({ type: 'status', status, detail })
  }

  /** Batches log lines so a chatty build cannot flood the renderer with IPC messages. */
  private log(line: string): void {
    this.pending.push(line)
    this.flushTimer ??= setTimeout(() => this.flush(), 50)
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.pending.length === 0) return
    this.emit({ type: 'log', lines: this.pending })
    this.pending = []
  }

  async start(root: string, mode: RunMode = 'run', profile?: string): Promise<void> {
    if (this.child) throw new Error('The application is already running')
    const { env, mvn: cmd } = await resolveTools(root)
    const settingsXml = getSettings().mavenSettings
    const args = ['-B', '-ntp', ...(settingsXml && existsSync(settingsXml) ? ['-s', settingsXml] : []), ...runtimeToolArgs(root, mode), 'spring-boot:run']
    // The environment is a Spring profile: application-<env>.properties is layered over the defaults.
    if (profile && profile !== 'default' && /^[\w.-]+$/.test(profile)) args.splice(args.length - 1, 0, `-Dspring-boot.run.profiles=${profile}`)
    this.launch(root, cmd, args, env, 'starting')
  }

  /**
   * Builds the deployable package. No Camel Studio profile is named, so the JAR carries none of
   * the dev-only tools (CLI connector, debugger): it is what the project's own build produces.
   */
  async build(root: string, skipTests: boolean): Promise<void> {
    if (this.child) throw new Error('Stop the application before building the package')
    const { env, mvn: cmd } = await resolveTools(root)
    const settingsXml = getSettings().mavenSettings
    const args = ['-B', '-ntp', ...(settingsXml && existsSync(settingsXml) ? ['-s', settingsXml] : []), 'clean', 'package', ...(skipTests ? ['-DskipTests'] : [])]
    this.launch(root, cmd, args, env, 'building')
  }

  private launch(root: string, cmd: string, args: string[], env: NodeJS.ProcessEnv, initial: 'starting' | 'building'): void {
    const building = initial === 'building'
    this.stopRequested = false
    this.setStatus(initial)
    this.log(`$ ${cmd} ${args.join(' ')}`)

    let child: ChildProcess
    try {
      // Own process group on POSIX so stopping also stops the forked JVM.
      child = spawn(cmd, args, { cwd: root, env, detached: !isWin, shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      this.log(String(e))
      this.flush()
      this.setStatus('failed', 'Could not start Maven')
      return
    }
    this.child = child

    const attach = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return
      let buffer = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const raw of lines) {
          const line = raw.replace(ANSI, '')
          if (this.status === 'starting' && STARTED.test(line)) this.setStatus('running')
          this.log(line)
        }
      })
      stream.on('end', () => {
        if (buffer) this.log(buffer.replace(ANSI, ''))
      })
    }
    attach(child.stdout)
    attach(child.stderr)

    child.on('error', (err: NodeJS.ErrnoException) => {
      this.child = null
      this.log(err.code === 'ENOENT' ? `Maven was not found (${cmd}). Install Maven or add a Maven wrapper to the project.` : String(err))
      this.flush()
      this.setStatus('failed', err.code === 'ENOENT' ? 'Maven not found' : err.message)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.log(`Process exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}`)
      this.flush()
      if (building && code === 0 && !this.stopRequested) {
        const jar = builtJar(root)
        if (jar) this.emit({ type: 'built', artifact: jar.path, size: jar.size })
        else this.log('The build finished but no JAR was found in target/.')
        this.flush()
      }
      if (this.stopRequested || code === 0) this.setStatus('idle')
      else this.setStatus('failed', `Exit code ${code ?? signal}`)
    })
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child || child.pid === undefined) return
    this.stopRequested = true
    this.setStatus('stopping')
    const pid = child.pid
    if (isWin) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'])
      return
    }
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig)
      } catch {
        /* already gone */
      }
    }
    signal('SIGTERM')
    setTimeout(() => {
      if (this.child === child) signal('SIGKILL')
    }, 8000)
  }

  /** Synchronous best-effort cleanup for app shutdown. */
  killNow(): void {
    const pid = this.child?.pid
    if (pid === undefined) return
    try {
      if (isWin) spawn('taskkill', ['/pid', String(pid), '/T', '/F'])
      else process.kill(-pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}
