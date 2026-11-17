import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { createBackend, type Backend } from '../main/backend'
import { createRouteFile, scanProject } from '../main/project'

/**
 * Camel Studio in VS Code: a custom editor for Camel route files that runs the same UI as the
 * desktop app in a webview, answered by the same backend (catalog, Maven runner, tracing and
 * debugging, Data Mapper preview, settings). The route's text lives in a VS Code document, so
 * VS Code's own save, dirty marker, revert, Git and text editor all keep working.
 */

const VIEW_TYPE = 'camelStudio.designer'
const ROUTE_FILE = /\.camel\.ya?ml$/i

interface Panel {
  panel: vscode.WebviewPanel
  document: vscode.TextDocument
  root: string
}

const panels = new Set<Panel>()
let backend: Backend
const isTest = process.env.CAMEL_STUDIO_VSCODE_TEST === '1'

/** The project a file belongs to: the nearest folder with a pom.xml, within the workspace. */
function projectRoot(file: string): string {
  const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath
  let dir = dirname(file)
  for (;;) {
    if (existsSync(join(dir, 'pom.xml'))) return dir
    const up = dirname(dir)
    if (up === dir || (ws && dir === ws)) break
    dir = up
  }
  return ws ?? dirname(file)
}

const openDoc = (path: string): vscode.TextDocument | undefined => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === path)

/** Replaces a document's whole text, if it differs. */
async function setText(doc: vscode.TextDocument, text: string): Promise<void> {
  if (doc.getText() === text) return
  const edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text)
  await vscode.workspace.applyEdit(edit)
}

const allowed = (path: string): boolean => {
  const full = resolve(path)
  return [...backend.roots(), ...[...panels].map((p) => p.root)].some((r) => full === r || full.startsWith(r + sep))
}

const broadcast = (message: unknown): void => {
  for (const p of panels) void p.panel.webview.postMessage(message)
}

function html(ctx: vscode.ExtensionContext, p: Panel): string {
  const webview = p.panel.webview
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'media')
  const page = readFileSync(join(media.fsPath, 'index.html'), 'utf8')
  const js = page.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1]
  const css = page.match(/href="\.\/(assets\/[^"]+\.css)"/)?.[1]
  if (!js || !css) return '<p>Camel Studio could not find its user interface files.</p>'
  const uri = (rel: string): string => webview.asWebviewUri(vscode.Uri.joinPath(media, ...rel.split('/'))).toString()
  const nonce = randomBytes(16).toString('base64')
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'${isTest ? " 'unsafe-eval'" : ''}`
  ].join('; ')
  const config = JSON.stringify({ document: p.document.uri.fsPath, platform: process.platform, test: isTest }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${uri(css)}" />
    <script nonce="${nonce}">window.__CAMEL_STUDIO__ = ${config}</script>
    <script nonce="${nonce}" src="${uri('bridge.js')}"></script>
    <script nonce="${nonce}" type="module" src="${uri(js)}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`
}

// Test runs ask a designer tab to evaluate a script and answer (see bridge.ts).
let testSeq = 0
const testWaiting = new Map<number, (r: { ok: boolean; value?: unknown; error?: string }) => void>()

export function activate(ctx: vscode.ExtensionContext): unknown {
  /** Saves the extension started itself: the designer already did what a save needs. */
  const ownSaves = new Set<string>()

  backend = createBackend({
    send: (channel, payload) => broadcast({ type: 'event', channel, payload }),
    catalogDir: () => join(ctx.extensionPath, 'catalog'),
    userDataDir: () => ctx.globalStorageUri.fsPath,
    async pickOpen({ title, folder, filters }) {
      const r = await vscode.window.showOpenDialog({
        title,
        canSelectFiles: !folder,
        canSelectFolders: !!folder,
        canSelectMany: false,
        filters: filters ? Object.fromEntries(filters.map((f) => [f.name, f.extensions])) : undefined
      })
      return r?.[0]?.fsPath ?? null
    },
    async pickSave({ title, defaultName, filters }) {
      const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir()
      const r = await vscode.window.showSaveDialog({ title, defaultUri: vscode.Uri.file(join(base, defaultName)), filters: filters ? Object.fromEntries(filters.map((f) => [f.name, f.extensions])) : undefined })
      return r?.fsPath ?? null
    },
    reveal: (path) => void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path)),
    openExternal: async (url) => {
      await vscode.env.openExternal(vscode.Uri.parse(url))
    },
    reload: () => {
      for (const p of panels) p.panel.webview.html = html(ctx, p)
    },
    initialProject: () => null,
    // Files open in VS Code are read and written through their documents, unsaved edits included.
    readFile: async (path) => openDoc(path)?.getText() ?? null,
    async writeFile(path, content) {
      const doc = openDoc(path)
      if (!doc) return false
      await setText(doc, content)
      ownSaves.add(path)
      try {
        await doc.save()
      } finally {
        ownSaves.delete(path)
      }
      return true
    }
  })

  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      {
        resolveCustomTextEditor(document, panel) {
          const p: Panel = { panel, document, root: projectRoot(document.uri.fsPath) }
          panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] }
          panel.webview.html = html(ctx, p)
          panels.add(p)
          panel.onDidDispose(() => panels.delete(p))
          panel.webview.onDidReceiveMessage((m: { type: string; id?: number; channel?: string; args?: unknown[]; path?: string; text?: string; ok?: boolean; value?: unknown; error?: string }) => {
            void onMessage(p, m)
          })
        }
      },
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    ),
    // Typing in a text editor, a revert, a Git checkout: the designer follows.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0 || e.document.uri.scheme !== 'file') return
      broadcast({ type: 'event', channel: 'doc:change', payload: { path: e.document.uri.fsPath, text: e.document.getText(), saved: false } })
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file' || ownSaves.has(doc.uri.fsPath)) return
      broadcast({ type: 'event', channel: 'doc:change', payload: { path: doc.uri.fsPath, text: doc.getText(), saved: true } })
    }),
    vscode.commands.registerCommand('camelStudio.openDesigner', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri
      if (target) void vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE)
    }),
    vscode.commands.registerCommand('camelStudio.openSource', (uri?: vscode.Uri) => {
      const target = uri ?? [...panels].find((p) => p.panel.active)?.document.uri
      if (target) void vscode.commands.executeCommand('vscode.openWith', target, 'default')
    }),
    vscode.commands.registerCommand('camelStudio.newRoute', (uri?: vscode.Uri) => newRoute(uri)),
    { dispose: () => backend.dispose() }
  )

  async function onMessage(p: Panel, m: { type: string; id?: number; channel?: string; args?: unknown[]; path?: string; text?: string; ok?: boolean; value?: unknown; error?: string }): Promise<void> {
    if (m.type === 'invoke' && m.id !== undefined && m.channel) {
      try {
        let value: unknown
        if (m.channel === 'project:initial') value = p.root
        else {
          const handler = backend.handlers[m.channel] as ((...a: unknown[]) => unknown) | undefined
          if (!handler) throw new Error(`Not available in VS Code: ${m.channel}`)
          value = await handler(...(m.args ?? []))
        }
        void p.panel.webview.postMessage({ type: 'result', id: m.id, ok: true, value })
      } catch (e) {
        void p.panel.webview.postMessage({ type: 'result', id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    } else if (m.type === 'doc:update' && m.path && typeof m.text === 'string') {
      if (!allowed(m.path)) return
      const doc = openDoc(m.path) ?? (await vscode.workspace.openTextDocument(vscode.Uri.file(m.path)))
      await setText(doc, m.text)
    } else if (m.type === 'doc:open' && m.path) {
      if (!allowed(m.path)) return
      void vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(m.path), ROUTE_FILE.test(m.path) ? VIEW_TYPE : 'default')
    } else if (m.type === 'test:result' && m.id !== undefined) {
      testWaiting.get(m.id)?.({ ok: !!m.ok, value: m.value, error: m.error })
      testWaiting.delete(m.id)
    }
  }

  // Exposed for the automated checks only.
  return {
    panels: () => [...panels].map((p) => p.document.uri.fsPath),
    evaluate(path: string, code: string): Promise<{ ok: boolean; value?: unknown; error?: string }> {
      const p = [...panels].find((x) => x.document.uri.fsPath === path)
      if (!p || !isTest) return Promise.resolve({ ok: false, error: 'no designer tab for that file' })
      const id = ++testSeq
      return new Promise((done) => {
        testWaiting.set(id, done)
        void p.panel.webview.postMessage({ type: 'test:eval', id, code })
      })
    }
  }
}

/** Camel Studio: New Route File — in the project of the folder or file chosen, opened in the designer. */
async function newRoute(uri?: vscode.Uri): Promise<void> {
  const from = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath ?? [...panels].find((p) => p.panel.active)?.document.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!from) {
    void vscode.window.showInformationMessage('Open a folder with a Camel project first.')
    return
  }
  // A folder: look for the project from inside it; a file: from its folder.
  const root = projectRoot(statSync(from).isDirectory() ? join(from, 'pom.xml') : from)
  const name = await vscode.window.showInputBox({ title: 'New route file', prompt: 'Name of the route file', placeHolder: 'order-intake', validateInput: (v) => (/^[A-Za-z][\w-]*$/.test(v.trim()) ? null : 'Letters, digits and dashes, starting with a letter') })
  if (!name) return
  const id = name.trim().toLowerCase()
  const content = `- route:
    id: ${id}
    from:
      uri: timer:${id}
      parameters:
        period: 5000
      steps:
        - log:
            message: "Hello from ${id}"
`
  try {
    await scanProject(root)
    const info = await createRouteFile(root, id, content)
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(info.path), VIEW_TYPE)
  } catch (e) {
    void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
  }
}

export function deactivate(): void {
  backend?.dispose()
}
