// Live link to the running application.
//
// Camel's CLI connector (the mechanism behind `camel trace` and `camel debug`) makes a
// running app exchange JSON files with tools under ~/.camel/: it rewrites
// <pid>-status.json and <pid>-debug.json, appends to <pid>-trace.json, and executes
// commands dropped as <pid>-action-<id>.json, answering in <pid>-output-<id>.json.
// No HTTP or JMX port is involved, so this works the same on a laptop and on a server.

import { mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { DebugState, RtProcessor, RtRoute, RtStats, RunMode, RuntimeEvent, RuntimeStatus, SendRequest, SendResult, TraceEvent } from '@shared/types'

const CAMEL_DIR = join(homedir(), '.camel')
const POLL_MS = 400

/**
 * Camel's send command runs on the connector's only thread and waits for the route to finish.
 * A message that stops at a breakpoint would therefore freeze the connector, and with it the
 * debugger. While debugging, test messages go through this small relay route instead: the
 * connector only queues the message, and a queue thread carries it into the target route.
 */
const RELAY_ROUTE = 'camel-studio-send'
const RELAY_HEADER = 'CamelStudioEndpoint'
const RELAY_YAML = `- route:
    id: ${RELAY_ROUTE}
    from:
      uri: seda:${RELAY_ROUTE}
      steps:
        - setProperty:
            name: camelStudioTarget
            simple:
              expression: "\${header.${RELAY_HEADER}}"
        - removeHeader:
            name: ${RELAY_HEADER}
        - toD:
            uri: "\${exchangeProperty.camelStudioTarget}"
`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)

function stats(s: Json): RtStats {
  return {
    total: num(s?.exchangesTotal),
    failed: num(s?.exchangesFailed),
    inflight: num(s?.exchangesInflight),
    mean: num(s?.meanProcessingTime),
    last: num(s?.lastProcessingTime),
    max: num(s?.maxProcessingTime)
  }
}

/** `file:/…/target/classes/camel/orders.camel.yaml:33` -> `orders.camel.yaml` (Camel appends the line number). */
const sourceFile = (source: unknown): string => (typeof source === 'string' ? basename(source.replace(/^[a-z]+:/i, '').replace(/:\d+$/, '')) : '')
const sourceLine = (source: unknown): number => (typeof source === 'string' ? Number(source.match(/:(\d+)$/)?.[1] ?? 0) : 0)

function toStatus(pid: number, raw: Json): RuntimeStatus {
  const all: Json[] = Array.isArray(raw?.routes) ? raw.routes : []
  const routes: RtRoute[] = all.filter((r) => r.routeId !== RELAY_ROUTE).map((r: Json) => {
    const processors: RtProcessor[] = (Array.isArray(r.processors) ? r.processors : []).map((p: Json) => ({
      id: String(p.id ?? ''),
      file: sourceFile(p.source),
      line: sourceLine(p.source) || num((Array.isArray(p.code) ? p.code : []).find((c: Json) => c.match)?.line),
      ...stats(p.statistics)
    }))
    return {
      routeId: String(r.routeId ?? ''),
      state: String(r.state ?? ''),
      from: String(r.from ?? ''),
      file: sourceFile(r.source),
      processors,
      ...stats(r.statistics)
    }
  })
  return {
    pid,
    name: String(raw?.context?.name ?? ''),
    camelVersion: String(raw?.context?.version ?? ''),
    state: String(raw?.context?.state ?? ''),
    uptime: num(raw?.context?.uptime),
    routes
  }
}

function toEvent(t: Json): TraceEvent {
  return {
    uid: num(t.uid),
    exchangeId: String(t.exchangeId ?? ''),
    routeId: String(t.routeId ?? ''),
    nodeId: String(t.nodeId ?? ''),
    nodeKind: String(t.nodeShortName ?? ''),
    label: String(t.nodeLabel ?? t.nodeId ?? ''),
    location: typeof t.location === 'string' ? t.location : null,
    first: t.first === true,
    last: t.last === true,
    timestamp: num(t.timestamp),
    elapsed: num(t.elapsed),
    failed: t.failed === true,
    message: t.message && typeof t.message === 'object' ? t.message : {},
    exception: t.exception ?? t.message?.exception ?? null
  }
}

function toDebug(raw: Json): DebugState {
  return {
    enabled: raw?.enabled === true,
    breakpoints: (Array.isArray(raw?.breakpoints) ? raw.breakpoints : []).map((b: Json) => String(b.nodeId)),
    suspended: (Array.isArray(raw?.suspended) ? raw.suspended : []).map(toEvent)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class RuntimeLink {
  private timer: NodeJS.Timeout | null = null
  private root: string | null = null
  private launchedAt = 0
  private pid: number | null = null
  private busy = false
  private statusStamp = 0
  private tracePos = 0
  private debugText = ''
  private seq = 0
  private mode: RunMode = 'run'
  private relayReady = false
  private relayAttempts = 0
  private readonly emit: (event: RuntimeEvent) => void

  constructor(emit: (event: RuntimeEvent) => void) {
    this.emit = emit
  }

  /** Starts looking for the app that was just launched from `root`. */
  attach(root: string, mode: RunMode): void {
    this.detach()
    this.mode = mode
    this.root = root
    this.launchedAt = Date.now()
    this.timer = setInterval(() => void this.tick(), POLL_MS)
  }

  detach(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.root = null
    if (this.pid !== null) this.emit({ type: 'detached' })
    this.pid = null
    this.relayReady = false
    this.relayAttempts = 0
    this.statusStamp = 0
    this.tracePos = 0
    this.debugText = ''
  }

  private async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      if (this.pid === null) await this.discover()
      else await this.poll()
    } catch {
      // Files are rewritten while we read them: a failed read is simply retried on the next tick.
    } finally {
      this.busy = false
    }
  }

  /** The connector names its files after the JVM's pid, which Maven forks: find it by working directory. */
  private async discover(): Promise<void> {
    if (!this.root) return
    const wanted = await realpath(this.root)
    const names = (await readdir(CAMEL_DIR).catch(() => [] as string[])).filter((n) => /^\d+$/.test(n))
    for (const name of names) {
      const lock = await stat(join(CAMEL_DIR, name)).catch(() => null)
      if (!lock || lock.mtimeMs < this.launchedAt - 2000) continue
      const text = await readFile(join(CAMEL_DIR, `${name}-status.json`), 'utf8').catch(() => '')
      if (!text) continue
      let dir: string | null = null
      try {
        dir = JSON.parse(text)?.runtime?.directory ?? null
      } catch {
        continue
      }
      if (!dir || (await realpath(dir).catch(() => dir)) !== wanted) continue
      this.pid = Number(name)
      this.emit({ type: 'attached', pid: this.pid })
      await this.poll()
      return
    }
  }

  private file(suffix: string): string {
    return join(CAMEL_DIR, `${this.pid}${suffix}`)
  }

  private async poll(): Promise<void> {
    if (this.pid === null) return
    if (!(await stat(this.file('')).catch(() => null))) {
      // Lock file gone: the application has stopped.
      this.emit({ type: 'detached' })
      this.pid = null
      return
    }

    const st = await stat(this.file('-status.json')).catch(() => null)
    if (st && st.mtimeMs !== this.statusStamp && st.size > 0) {
      const raw = JSON.parse(await readFile(this.file('-status.json'), 'utf8'))
      this.statusStamp = st.mtimeMs
      this.emit({ type: 'status', status: toStatus(this.pid, raw) })
      if (this.mode === 'debug') {
        // Trust what the app reports, not the reply to the load command: load errors are swallowed on its side.
        const routes: Json[] = Array.isArray(raw?.routes) ? raw.routes : []
        this.relayReady = routes.some((r) => r.routeId === RELAY_ROUTE && r.state === 'Started')
        if (!this.relayReady && raw?.context?.state === 'Started' && this.relayAttempts < 3) {
          this.relayAttempts++
          void this.loadRelay()
        }
      }
    }

    // The trace file only grows: read what was appended, up to the last complete line.
    const tr = await stat(this.file('-trace.json')).catch(() => null)
    if (tr && tr.size > this.tracePos) {
      const handle = await open(this.file('-trace.json'), 'r')
      try {
        const buffer = Buffer.alloc(tr.size - this.tracePos)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.tracePos)
        const chunk = buffer.subarray(0, bytesRead)
        const end = chunk.lastIndexOf(0x0a)
        if (end >= 0) {
          this.tracePos += end + 1
          const events: TraceEvent[] = []
          for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
            if (!line.trim()) continue
            try {
              const doc = JSON.parse(line)
              for (const t of Array.isArray(doc?.traces) ? doc.traces : []) {
                // Steps of the relay route are plumbing, not part of the user's route. Its closing event is kept: it ends the message.
                if (t.routeId === RELAY_ROUTE && t.last !== true) continue
                events.push(toEvent(t))
              }
            } catch {
              /* a damaged line is skipped */
            }
          }
          if (events.length > 0) this.emit({ type: 'trace', events })
        }
      } finally {
        await handle.close()
      }
    }

    const debugText = await readFile(this.file('-debug.json'), 'utf8').catch(() => '')
    if (debugText && debugText !== this.debugText) {
      const raw = JSON.parse(debugText)
      this.debugText = debugText
      this.emit({ type: 'debug', debug: toDebug(raw) })
    }
  }

  /** Drops a command for the app and, when a reply is expected, waits for it. */
  private async action(payload: Record<string, unknown>, replyTimeoutMs: number): Promise<Json> {
    if (this.pid === null) throw new Error('The application is not connected yet')
    const id = `cs${process.pid}n${++this.seq}`
    const actionFile = this.file(`-action-${id}.json`)
    const outputFile = this.file(`-output-${id}.json`)
    // Write under another name first so the app never reads a half-written command.
    const temp = this.file(`-pending-${id}.tmp`)
    await writeFile(temp, JSON.stringify(payload), 'utf8')
    await rename(temp, actionFile)

    let reply: Json = null
    const deadline = Date.now() + replyTimeoutMs
    while (Date.now() < deadline) {
      await sleep(80)
      const text = await readFile(outputFile, 'utf8').catch(() => '')
      if (!text.trim()) continue
      try {
        reply = JSON.parse(text)
        break
      } catch {
        /* still being written */
      }
    }
    void unlink(outputFile).catch(() => undefined)
    return reply
  }

  /** Adds the relay route to the running app. If that fails, sending falls back to the direct way. */
  private async loadRelay(): Promise<void> {
    try {
      const dir = join(tmpdir(), 'camel-studio')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${RELAY_ROUTE}.camel.yaml`)
      await writeFile(file, RELAY_YAML, 'utf8')
      // The loader takes plain file paths, not file: URIs.
      await this.action({ action: 'load', source: [file] }, 15000)
    } catch {
      /* the next status report shows whether the route is there */
    }
  }

  async routeCommand(routeId: string, command: string): Promise<void> {
    await this.action({ action: 'route', id: routeId, command }, 0)
  }

  async debugCommand(command: string, nodeId?: string): Promise<void> {
    await this.action({ action: 'debug', command, ...(nodeId ? { breakpoint: nodeId } : {}) }, 1500)
    this.debugText = ''
  }

  async send(request: SendRequest): Promise<SendResult> {
    if (this.mode === 'debug' && !this.relayReady) {
      // Sending directly would run the route on the connector's own thread: one breakpoint and the debugger freezes.
      throw new Error(
        'Test messages are not available in this debug session, because the helper route could not be started. ' +
          'Check that camel-seda-starter is in the camel-studio-debug profile of pom.xml, or use Run instead of Debug to send messages.'
      )
    }
    if (this.mode === 'debug') {
      const reply = await this.action(
        {
          action: 'send',
          endpoint: `seda:${RELAY_ROUTE}`,
          body: request.body,
          exchangePattern: 'InOnly',
          headers: [...request.headers.filter((h) => h.key.trim() !== ''), { key: RELAY_HEADER, value: request.endpoint }]
        },
        15000
      )
      if (!reply) throw new Error('The application did not answer within 15 seconds')
      return { relayed: true, status: String(reply.status ?? 'unknown'), elapsed: num(reply.elapsed), exception: reply.exception ?? null, message: null }
    }
    const reply = await this.action(
      {
        action: 'send',
        endpoint: request.endpoint,
        body: request.body,
        exchangePattern: request.exchangePattern,
        headers: request.headers.filter((h) => h.key.trim() !== '')
      },
      30000
    )
    if (!reply) throw new Error('The application did not answer within 30 seconds')
    return {
      relayed: false,
      status: String(reply.status ?? 'unknown'),
      elapsed: num(reply.elapsed),
      exception: reply.exception ?? null,
      message: reply.message ?? null
    }
  }
}
