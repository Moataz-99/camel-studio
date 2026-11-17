import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { createStudioApi } from '@shared/client'

// The desktop shell: the UI's API over Electron IPC.
const api = createStudioApi(
  (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  (channel, listener) => {
    const handler = (_e: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  process.platform,
  // Automated layout checks only: render the UI as the VS Code extension shows it.
  process.env.CAMEL_STUDIO_AS_VSCODE ? 'vscode' : 'desktop',
  process.env.CAMEL_STUDIO_AS_VSCODE ? { path: process.env.CAMEL_STUDIO_AS_VSCODE, update: () => undefined, onChange: () => () => undefined, open: () => undefined } : undefined
)

contextBridge.exposeInMainWorld('studio', api)
