import type { StudioApi } from './types'

export type Invoke = (channel: string, ...args: unknown[]) => Promise<any>
export type Listener = (payload: unknown) => void
export type Subscribe = (channel: string, listener: Listener) => () => void

/**
 * The typed API the UI uses (window.studio), built on two primitives each shell provides: a
 * request/response call and an event subscription. Electron's preload passes IPC; the VS Code
 * webview passes postMessage.
 */
export function createStudioApi(invoke: Invoke, on: Subscribe, platform: string, host: StudioApi['host'], document?: StudioApi['document']): StudioApi {
  return {
    platform,
    host,
    catalog: {
      index: () => invoke('catalog:index'),
      models: () => invoke('catalog:models'),
      component: (name) => invoke('catalog:component', name)
    },
    project: {
      initial: () => invoke('project:initial'),
      recent: () => invoke('project:recent'),
      pickFolder: (title) => invoke('project:pickFolder', title),
      open: (root) => invoke('project:open', root),
      create: (options) => invoke('project:create', options),
      rescan: (root) => invoke('project:rescan', root),
      readFile: (path) => invoke('project:readFile', path),
      writeFile: (path, content) => invoke('project:writeFile', path, content),
      createRouteFile: (root, fileName, content) => invoke('project:createRouteFile', root, fileName, content),
      syncDependencies: (root, artifactIds) => invoke('project:syncDependencies', root, artifactIds),
      enableRuntimeTools: (root) => invoke('project:enableRuntimeTools', root),
      setRouteFormat: (root, format) => invoke('project:setRouteFormat', root, format),
      pruneGenerated: (root, keep) => invoke('project:pruneGenerated', root, keep),
      importFile: (root, destDir, title) => invoke('project:importFile', root, destDir, title),
      reveal: (path) => invoke('project:reveal', path),
      setVersion: (root, version) => invoke('project:setVersion', root, version),
      copyArtifact: (path) => invoke('project:copyArtifact', path)
    },
    git: {
      status: (root) => invoke('git:status', root),
      log: (root) => invoke('git:log', root),
      diff: (root, path) => invoke('git:diff', root, path),
      init: (root) => invoke('git:init', root),
      commit: (root, message, paths) => invoke('git:commit', root, message, paths),
      pull: (root) => invoke('git:pull', root),
      push: (root) => invoke('git:push', root),
      fetch: (root) => invoke('git:fetch', root),
      setRemote: (root, url) => invoke('git:setRemote', root, url),
      setIdentity: (name, email) => invoke('git:setIdentity', name, email),
      resolve: (root, path, side) => invoke('git:resolve', root, path, side),
      abortMerge: (root) => invoke('git:abortMerge', root),
      clone: (url, parentDir) => invoke('git:clone', url, parentDir),
      onAskpass: (listener) => on('git:askpass', listener as Listener),
      answerAskpass: (id, value) => invoke('git:answerAskpass', id, value)
    },
    run: {
      toolchain: (root) => invoke('run:toolchain', root),
      start: (root, mode, profile) => invoke('run:start', root, mode, profile),
      build: (root, skipTests) => invoke('run:build', root, skipTests),
      stop: () => invoke('run:stop'),
      onEvent: (listener) => on('run:event', listener as Listener)
    },
    runtime: {
      onEvent: (listener) => on('runtime:event', listener as Listener),
      routeCommand: (routeId, command) => invoke('runtime:route', routeId, command),
      debugCommand: (command, nodeId) => invoke('runtime:debug', command, nodeId),
      send: (request) => invoke('runtime:send', request)
    },
    mapper: {
      preview: (request) => invoke('mapper:preview', request)
    },
    testConnection: (target) => invoke('connection:test', target),
    settings: {
      get: () => invoke('settings:get'),
      update: (patch) => invoke('settings:update', patch),
      toolchains: () => invoke('settings:toolchains'),
      installJdk: (feature) => invoke('settings:installJdk', feature),
      installMaven: () => invoke('settings:installMaven'),
      pickFile: (title, extensions) => invoke('settings:pickFile', title, extensions),
      pickFolder: (title) => invoke('settings:pickFolder', title),
      camelVersions: () => invoke('settings:camelVersions'),
      installCamel: (version) => invoke('settings:installCamel', version),
      useCamel: (version) => invoke('settings:useCamel', version),
      importComponent: () => invoke('settings:importComponent'),
      removeComponent: (scheme) => invoke('settings:removeComponent', scheme),
      exportProfile: () => invoke('settings:exportProfile'),
      importProfile: () => invoke('settings:importProfile'),
      onProgress: (listener) => on('settings:progress', listener as Listener)
    },
    project2: {
      alignVersions: (root) => invoke('project:alignVersions', root)
    },
    openDocs: (url) => invoke('app:openDocs', url),
    document
  }
}
