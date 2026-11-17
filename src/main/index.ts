import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createBackend, type FileFilter } from './backend'

const isMac = process.platform === 'darwin'
// Scripted checks must not touch the real profile (recent projects, theme).
if (process.env.CAMEL_STUDIO_SMOKE) app.setPath('userData', join(tmpdir(), 'camel-studio-smoke'))
let win: BrowserWindow | null = null

const toFilters = (filters?: FileFilter[]): Electron.FileFilter[] | undefined => filters?.map((f) => ({ name: f.name, extensions: f.extensions }))

// The desktop shell: Electron dialogs, the system file manager, one window.
const backend = createBackend({
  send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  },
  catalogDir: () => (app.isPackaged ? join(process.resourcesPath, 'catalog') : join(app.getAppPath(), 'resources', 'catalog')),
  userDataDir: () => app.getPath('userData'),
  async pickOpen({ title, folder, filters }) {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { title, properties: folder ? ['openDirectory', 'createDirectory'] : ['openFile'], filters: toFilters(filters) })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  async pickSave({ title, defaultName, filters }) {
    if (!win) return null
    const r = await dialog.showSaveDialog(win, { title, defaultPath: defaultName, filters: toFilters(filters) })
    return r.canceled ? null : (r.filePath ?? null)
  },
  reveal: (path) => shell.showItemInFolder(path),
  openExternal: (url) => shell.openExternal(url),
  reload: () => win?.webContents.reload(),
  initialProject: () => process.env.CAMEL_STUDIO_OPEN ?? null
})

function registerIpc(): void {
  for (const [channel, handler] of Object.entries(backend.handlers)) {
    ipcMain.handle(channel, (_e, ...args: unknown[]) => (handler as (...a: unknown[]) => unknown)(...args))
  }
}

// ----------------------------------------------------------------- window --

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    title: 'Camel Studio',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f4f5f7',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const smoke = process.env.CAMEL_STUDIO_SMOKE
  win.once('ready-to-show', () => {
    if (!smoke) win?.show()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('closed', () => {
    win = null
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) await win.loadURL(devUrl)
  else await win.loadFile(join(__dirname, '../renderer/index.html'))

  // Scripted end-to-end checks: CAMEL_STUDIO_SMOKE points at a .cjs module that
  // receives the window and drives the real UI. Never set in normal use.
  if (smoke) {
    try {
      const mod = createRequire(join(__dirname, 'index.js'))(smoke)
      await (mod.default ?? mod)({ app, win })
    } catch (e) {
      console.error('[smoke] failed:', e)
      process.exitCode = 1
    } finally {
      app.quit()
    }
  }
}

app.whenReady().then(async () => {
  registerIpc()
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('before-quit', () => backend.dispose())
app.on('window-all-closed', () => {
  if (!isMac || process.env.CAMEL_STUDIO_SMOKE) app.quit()
})
