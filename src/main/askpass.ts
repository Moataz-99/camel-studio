import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskpassRequest } from '@shared/types'

/**
 * When Git needs a user name, a password or token, an SSH passphrase or a yes to a new host key,
 * it runs the program in GIT_ASKPASS / SSH_ASKPASS. Ours forwards the question to this process
 * over a local socket, the window asks the user, and the answer goes back to Git. Camel Studio
 * never stores it: Git's own credential helper (macOS Keychain, Git Credential Manager on
 * Windows) remembers it if it is configured to.
 */

const isWin = process.platform === 'win32'

// Runs inside Electron started as plain Node (ELECTRON_RUN_AS_NODE): ask, print the answer.
const CLIENT = `const net = require('net')
const c = net.connect(process.env.CAMEL_STUDIO_ASKPASS_SOCK, () => c.write(JSON.stringify({ prompt: process.argv.slice(2).join(' ') }) + '\\n'))
let buf = ''
c.setEncoding('utf8')
c.on('data', (d) => (buf += d))
c.on('end', () => {
  try {
    const r = JSON.parse(buf)
    if (typeof r.value !== 'string') process.exit(1)
    process.stdout.write(r.value + '\\n')
    process.exit(0)
  } catch {
    process.exit(1)
  }
})
c.on('error', () => process.exit(1))
`

// Git runs askpass programs through its shell on every platform (Git for Windows bundles sh).
const WRAPPER = `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "$CAMEL_STUDIO_ELECTRON" "$CAMEL_STUDIO_ASKPASS_JS" "$@"
`

type Ask = (request: AskpassRequest) => void

let server: Server | null = null
let ready: Promise<Record<string, string>> | null = null
let seq = 0
const waiting = new Map<number, (value: string | null) => void>()
let ask: Ask = () => undefined

/** Where questions go: the window shows a prompt and answers with `answerAskpass`. */
export function onAskpass(listener: Ask): void {
  ask = listener
}

export function answerAskpass(id: number, value: string | null): void {
  waiting.get(id)?.(typeof value === 'string' ? value : null)
}

function handle(socket: Socket): void {
  let buf = ''
  socket.setEncoding('utf8')
  socket.on('data', (d: string) => {
    buf += d
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    let prompt = ''
    try {
      prompt = String((JSON.parse(buf.slice(0, nl)) as { prompt?: unknown }).prompt ?? '')
    } catch {
      socket.end(JSON.stringify({ value: null }))
      return
    }
    const id = ++seq
    // Nobody answers within five minutes: Git gets a refusal rather than waiting forever.
    const timer = setTimeout(() => answerAskpass(id, null), 5 * 60_000)
    waiting.set(id, (value) => {
      clearTimeout(timer)
      waiting.delete(id)
      socket.end(JSON.stringify({ value }))
    })
    ask({ id, prompt: prompt.trim() })
  })
  socket.on('error', () => undefined)
}

/** Environment that routes Git's and SSH's questions to the window. Starts the listener once. */
export function askpassEnv(dataDir: string): Promise<Record<string, string>> {
  ready ??= (async () => {
    const dir = join(dataDir, 'askpass')
    await mkdir(dir, { recursive: true })
    const js = join(dir, 'askpass.js')
    const sh = join(dir, 'askpass.sh')
    await writeFile(js, CLIENT, 'utf8')
    await writeFile(sh, WRAPPER, 'utf8')
    await chmod(sh, 0o755)
    const sock = isWin ? `\\\\.\\pipe\\camel-studio-askpass-${process.pid}` : join(tmpdir(), `camel-studio-askpass-${process.pid}.sock`)
    if (!isWin) await unlink(sock).catch(() => undefined)
    server = createServer(handle)
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(sock, () => resolve())
    })
    return {
      GIT_ASKPASS: sh,
      SSH_ASKPASS: sh,
      // OpenSSH 8.4+: use the askpass program even though a terminal may exist.
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0',
      CAMEL_STUDIO_ELECTRON: process.execPath,
      CAMEL_STUDIO_ASKPASS_JS: js,
      CAMEL_STUDIO_ASKPASS_SOCK: sock
    }
  })()
  return ready
}

export function closeAskpass(): void {
  for (const answer of waiting.values()) answer(null)
  server?.close()
  server = null
}
