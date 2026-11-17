import { createStudioApi, type Listener } from '../shared/client'
import type { EditorDocument } from '../shared/types'

/**
 * Runs in the VS Code webview before the UI: builds window.studio on postMessage, the same API
 * the desktop app gets from its preload. The extension answers every call with the shared backend.
 */

interface VsCodeApi {
  postMessage(message: unknown): void
}
declare function acquireVsCodeApi(): VsCodeApi

interface Config {
  document: string
  platform: string
  test?: boolean
}

const config = (window as unknown as { __CAMEL_STUDIO__: Config }).__CAMEL_STUDIO__
const vscode = acquireVsCodeApi()

let seq = 0
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
const listeners = new Map<string, Set<Listener>>()

window.addEventListener('message', (event: MessageEvent) => {
  const m = event.data as { type: string; id?: number; ok?: boolean; value?: unknown; error?: string; channel?: string; payload?: unknown; code?: string }
  if (m.type === 'result' && m.id !== undefined) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    if (!p) return
    if (m.ok) p.resolve(m.value)
    else p.reject(new Error(m.error ?? 'Failed'))
  } else if (m.type === 'event' && m.channel) {
    listeners.get(m.channel)?.forEach((l) => l(m.payload))
  } else if (m.type === 'test:eval' && config.test && m.code !== undefined) {
    // Automated checks only: the extension enables this (and the CSP for it) in test runs.
    Promise.resolve()
      .then(() => (0, eval)(m.code!))
      .then(
        (value) => vscode.postMessage({ type: 'test:result', id: m.id, ok: true, value }),
        (e: unknown) => vscode.postMessage({ type: 'test:result', id: m.id, ok: false, error: String(e) })
      )
  }
})

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    vscode.postMessage({ type: 'invoke', id, channel, args })
  })

const on = (channel: string, listener: Listener): (() => void) => {
  let set = listeners.get(channel)
  if (!set) listeners.set(channel, (set = new Set()))
  set.add(listener)
  return () => set.delete(listener)
}

// What the designer last pushed per file: the document's echo of it is not a new change.
const pushed = new Map<string, string>()
const document: EditorDocument = {
  path: config.document,
  update(path, text) {
    pushed.set(path, text)
    vscode.postMessage({ type: 'doc:update', path, text })
  },
  onChange(listener) {
    return on('doc:change', (payload) => {
      const e = payload as { path: string; text: string; saved: boolean }
      if (!e.saved && pushed.get(e.path) === e.text) return
      listener(e)
    })
  },
  open(path) {
    vscode.postMessage({ type: 'doc:open', path })
  }
}

;(window as unknown as { studio: unknown }).studio = createStudioApi(invoke, on, config.platform, 'vscode', document)
