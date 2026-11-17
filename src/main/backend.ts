import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { CatalogIndex, ModelDef, NewProjectOptions, ProgressEvent, ProjectInfo, RecentProject, RouteFormat, RunEvent, RunMode, RuntimeEvent, SendRequest, StudioSettings } from '@shared/types'
import { alignVersions, createProject, createRouteFile, enableRuntimeTools, pruneGenerated, scanProject, setProjectVersion, setRouteFormat, syncDependencies } from './project'
import * as git from './git'
import { answerAskpass, closeAskpass, onAskpass } from './askpass'
import { detectToolchain, Runner, shellEnv } from './runner'
import { readPicked, runPreview } from './xslt'
import { testConnection } from './connection'
import { applyProfile, camelVersions, CATALOGS_DIR, COMPONENTS_DIR, getSettings, importComponentJar, installCatalog, installJdk, installMaven, listToolchains, profileOf, removeComponent, updateSettings } from './settings'
import { RuntimeLink } from './runtime'

/**
 * Everything the UI asks for, independent of the shell around it. The desktop app (Electron) and
 * the VS Code extension each provide a Host for the few things that differ: dialogs, revealing a
 * file, sending events to the UI, and where the catalog and the app's own data live.
 */
export interface FileFilter {
  name: string
  extensions: string[]
}

export interface Host {
  /** Pushes an event to the UI (every open view). */
  send(channel: string, payload: unknown): void
  /** The catalog shipped with this build. */
  catalogDir(): string
  /** Where this shell keeps its own state (recent projects, the askpass helper). */
  userDataDir(): string
  pickOpen(options: { title: string; folder?: boolean; filters?: FileFilter[] }): Promise<string | null>
  pickSave(options: { title: string; defaultName: string; filters?: FileFilter[] }): Promise<string | null>
  reveal(path: string): void
  openExternal(url: string): Promise<void>
  /** Reloads the UI (after a catalog switch). */
  reload(): void
  /** Project to open at start, if any. */
  initialProject(): string | null
  /** VS Code: files open in an editor are read from and written through the editor's document. */
  readFile?(path: string): Promise<string | null>
  writeFile?(path: string, content: string): Promise<boolean>
}

export type Handler = (...args: never[]) => unknown

export interface Backend {
  handlers: Record<string, Handler>
  /** Folders the UI has opened; file access is confined to them. */
  roots(): string[]
  dispose(): void
}

export function createBackend(host: Host): Backend {
  // ------------------------------------------------------------ catalog --
  /** The catalog chosen in the admin area when it has been downloaded, otherwise the built-in one. */
  const catalogDir = (): string => {
    const v = getSettings().camelVersion
    const dir = v ? join(CATALOGS_DIR, v) : null
    return dir && existsSync(join(dir, 'index.json')) ? dir : host.catalogDir()
  }
  let indexCache: CatalogIndex | null = null
  let modelsCache: Record<string, ModelDef> | null = null
  const catalogIndex = async (): Promise<CatalogIndex> => {
    if (!indexCache) {
      const index = JSON.parse(await readFile(join(catalogDir(), 'index.json'), 'utf8')) as CatalogIndex
      // The team's own components join the catalog like any Camel component.
      for (const c of getSettings().components) {
        const def = await readFile(join(COMPONENTS_DIR, `${c.scheme}.json`), 'utf8').then(JSON.parse, () => null)
        if (!def || index.components.some((x) => x.name === c.scheme)) continue
        index.components.push({ name: c.scheme, title: c.title, description: c.description, label: def.label ?? 'custom', syntax: def.syntax ?? `${c.scheme}:path`, artifactId: c.artifactId, consumerOnly: !!def.consumerOnly, producerOnly: !!def.producerOnly, deprecated: false, remote: true })
      }
      index.components.sort((a, b) => a.name.localeCompare(b.name))
      indexCache = index
    }
    return indexCache
  }
  const resetCatalog = (): void => {
    indexCache = null
    modelsCache = null
  }
  const bundledVersion = async (): Promise<string> => JSON.parse(await readFile(join(host.catalogDir(), 'index.json'), 'utf8')).camelVersion as string

  // ------------------------------------------------------------- recent --
  const recentFile = (): string => join(host.userDataDir(), 'recent-projects.json')
  const readRecent = async (): Promise<RecentProject[]> => {
    try {
      const list = JSON.parse(await readFile(recentFile(), 'utf8')) as RecentProject[]
      return list.filter((r) => existsSync(r.root))
    } catch {
      return []
    }
  }
  const remember = async (project: ProjectInfo): Promise<void> => {
    const list = (await readRecent()).filter((r) => r.root !== project.root)
    list.unshift({ root: project.root, name: project.name, openedAt: Date.now() })
    await mkdir(host.userDataDir(), { recursive: true }).catch(() => undefined)
    await writeFile(recentFile(), JSON.stringify(list.slice(0, 12)), 'utf8').catch(() => undefined)
  }

  // -------------------------------------------------------------- roots --
  const opened = new Set<string>()
  let lastRoot: string | null = null
  /** Resolves a path and checks it lies in a project the user opened. */
  const inside = (path: string): string => {
    const full = resolve(String(path))
    for (const root of opened) if (full === root || full.startsWith(root + sep)) return full
    throw new Error(opened.size ? `Path is outside the open project: ${path}` : 'No project is open')
  }

  // ---------------------------------------------------------- run, link --
  const runtime = new RuntimeLink((event: RuntimeEvent) => host.send('runtime:event', event))
  let runRoot: string | null = null
  let runMode: RunMode = 'run'
  const runner = new Runner((event: RunEvent) => {
    if (event.type === 'status') {
      if (event.status === 'starting' && runRoot) runtime.attach(runRoot, runMode)
      else if (event.status === 'idle' || event.status === 'failed') runtime.detach()
    }
    host.send('run:event', event)
  })

  git.initGit(host.userDataDir())
  onAskpass((request) => host.send('git:askpass', request))

  const progress = (e: ProgressEvent): void => host.send('settings:progress', e)
  const failing = async <T>(task: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      progress({ task, received: 0, total: 0, done: true, error: (e as Error).message })
      throw e
    }
  }

  const open = async (root: string): Promise<ProjectInfo> => {
    const project = await scanProject(root)
    opened.add(project.root)
    lastRoot = project.root
    await remember(project)
    return project
  }

  const h: Record<string, Handler> = {
    'catalog:index': () => catalogIndex(),
    'catalog:models': async () => {
      modelsCache ??= JSON.parse(await readFile(join(catalogDir(), 'models.json'), 'utf8')) as Record<string, ModelDef>
      return modelsCache
    },
    'catalog:component': async (name: string) => {
      if (!/^[A-Za-z0-9+._-]+$/.test(name)) return null
      try {
        return JSON.parse(await readFile(join(catalogDir(), 'components', `${name}.json`), 'utf8'))
      } catch {
        return readFile(join(COMPONENTS_DIR, `${name}.json`), 'utf8').then(JSON.parse, () => null)
      }
    },

    // After a reload (for example a Camel version switch) the project that was open opens again.
    'project:initial': () => lastRoot ?? host.initialProject(),
    'project:recent': () => readRecent(),
    'project:pickFolder': (title: string) => host.pickOpen({ title: String(title), folder: true }),
    'project:open': (root: string) => open(root),
    'project:rescan': (root: string) => scanProject(inside(root)),
    'project:create': async (options: NewProjectOptions) => {
      const index = await catalogIndex()
      const created = await createProject(options, { camel: index.camelVersion, springBoot: index.springBootVersion ?? '4.1.1' })
      return open(created.root)
    },
    'project:readFile': async (path: string) => {
      const full = inside(path)
      const fromEditor = host.readFile ? await host.readFile(full) : null
      return fromEditor ?? readFile(full, 'utf8')
    },
    'project:writeFile': async (path: string, content: string) => {
      const full = inside(path)
      if (host.writeFile && (await host.writeFile(full, String(content)))) return
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, String(content), 'utf8')
    },
    'project:createRouteFile': (root: string, fileName: string, content: string) => createRouteFile(inside(root), fileName, content),
    'project:syncDependencies': (root: string, artifactIds: string[]) => syncDependencies(inside(root), artifactIds),
    'project:reveal': (path: string) => host.reveal(inside(path)),
    'project:enableRuntimeTools': async (root: string) => {
      const safe = inside(root)
      await enableRuntimeTools(safe)
      return scanProject(safe)
    },
    'project:importFile': async (root: string, destDir: string, title: string) => {
      const base = inside(root)
      const picked = await host.pickOpen({ title: String(title), filters: [{ name: 'Schemas and samples', extensions: ['xsd', 'json', 'xml'] }, { name: 'All files', extensions: ['*'] }] })
      if (!picked) return null
      const content = await readPicked(picked)
      const name = basename(picked).replace(/[^\w.-]/g, '-')
      const dir = inside(join(base, destDir))
      await mkdir(dir, { recursive: true })
      const dest = inside(join(dir, name))
      await writeFile(dest, content, 'utf8')
      return { rel: relative(base, dest).split(sep).join('/'), name, content }
    },
    'project:alignVersions': async (root: string) => {
      const index = await catalogIndex()
      return alignVersions(inside(root), index.camelVersion, index.springBootVersion)
    },
    'project:pruneGenerated': (root: string, keep: string[]) => pruneGenerated(inside(root), Array.isArray(keep) ? keep.map(String) : []),
    'project:setRouteFormat': (root: string, format: RouteFormat) => setRouteFormat(inside(root), format === 'java' ? 'java' : 'yaml'),
    'project:setVersion': (root: string, version: string) => setProjectVersion(inside(root), String(version).trim()),
    'project:copyArtifact': async (path: string) => {
      const src = inside(path)
      const folder = await host.pickOpen({ title: 'Copy the package to', folder: true })
      if (!folder) return null
      const dest = join(folder, basename(src))
      await copyFile(src, dest)
      return dest
    },

    'mapper:preview': (request: Parameters<typeof runPreview>[1]) => runPreview(lastRoot, request),
    'connection:test': (target: Parameters<typeof testConnection>[0]) => testConnection(target),

    'run:toolchain': (root: string | null) => detectToolchain(root),
    'run:start': (root: string, mode: RunMode, profile?: string) => {
      runRoot = inside(root)
      runMode = mode === 'debug' ? 'debug' : 'run'
      return runner.start(runRoot, runMode, typeof profile === 'string' ? profile : undefined)
    },
    'run:stop': () => runner.stop(),
    'run:build': (root: string, skipTests: boolean) => runner.build(inside(root), skipTests === true),
    'runtime:route': (routeId: string, command: string) => {
      if (!['start', 'stop', 'suspend', 'resume'].includes(command)) throw new Error(`Unknown route command: ${command}`)
      return runtime.routeCommand(String(routeId), command as 'start')
    },
    'runtime:debug': (command: string, nodeId?: string) => {
      if (!['add', 'remove', 'step', 'resume'].includes(command)) throw new Error(`Unknown debug command: ${command}`)
      return runtime.debugCommand(command as 'add', nodeId ? String(nodeId) : undefined)
    },
    'runtime:send': (request: SendRequest) => runtime.send(request),

    // ---------------------------------------------------------- admin area
    'settings:get': () => getSettings(),
    'settings:update': async (patch: Partial<StudioSettings>) => {
      const next = await updateSettings(patch)
      if (patch.components) resetCatalog()
      return next
    },
    'settings:toolchains': async () => listToolchains((await shellEnv()).PATH),
    'settings:installJdk': (feature: number) =>
      failing('JDK', async () => {
        const home = await installJdk(Number(feature) || 21, progress)
        await updateSettings({ javaHome: home })
        return home
      }),
    'settings:installMaven': () =>
      failing('Maven', async () => {
        const home = await installMaven(progress)
        await updateSettings({ mavenHome: home.replace(/[\\/]bin$/, '') })
        return home
      }),
    'settings:pickFile': (title: string, extensions: string[]) => host.pickOpen({ title: String(title), filters: [{ name: extensions.join(', '), extensions }] }),
    'settings:pickFolder': (title: string) => host.pickOpen({ title: String(title), folder: true }),
    'settings:camelVersions': async () => camelVersions(await bundledVersion()),
    'settings:installCamel': (version: string) => failing(`Camel ${version}`, () => installCatalog(String(version), progress)),
    'settings:useCamel': async (version: string | null) => {
      const bundled = await bundledVersion()
      await updateSettings({ camelVersion: version && version !== bundled ? String(version) : null })
      resetCatalog()
      host.reload()
    },
    'settings:importComponent': async () => {
      const jar = await host.pickOpen({ title: 'Choose the component JAR', filters: [{ name: 'Java archive', extensions: ['jar'] }] })
      if (!jar) return null
      const c = await importComponentJar(jar)
      resetCatalog()
      return c
    },
    'settings:removeComponent': async (scheme: string) => {
      const s = await removeComponent(String(scheme))
      resetCatalog()
      return s
    },
    'settings:exportProfile': async () => {
      const path = await host.pickSave({ title: 'Save the team profile', defaultName: 'camel-studio-team-profile.json', filters: [{ name: 'Team profile', extensions: ['json'] }] })
      if (!path) return null
      await writeFile(path, `${JSON.stringify(await profileOf(getSettings()), null, 2)}\n`, 'utf8')
      return path
    },
    'settings:importProfile': async () => {
      const path = await host.pickOpen({ title: 'Open a team profile', filters: [{ name: 'Team profile', extensions: ['json'] }] })
      if (!path) return null
      const s = await applyProfile(await readFile(path, 'utf8'))
      resetCatalog()
      return s
    },

    // ----------------------------------------------------------------- git
    // The project's own folder only, with the user's own Git, keys and credential helper.
    'git:status': (root: string) => git.status(inside(root)),
    'git:log': (root: string) => git.log(inside(root)),
    'git:diff': (root: string, path: string) => git.diff(inside(root), String(path)),
    'git:init': (root: string) => git.init(inside(root)),
    'git:commit': (root: string, message: string, paths: string[]) => git.commit(inside(root), String(message), Array.isArray(paths) ? paths.map(String) : []),
    'git:pull': (root: string) => git.pull(inside(root)),
    'git:push': (root: string) => git.push(inside(root)),
    'git:fetch': (root: string) => git.fetch(inside(root)),
    'git:setRemote': (root: string, url: string) => git.setRemote(inside(root), String(url)),
    'git:setIdentity': (name: string, email: string) => git.setIdentity(String(name), String(email)),
    'git:resolve': (root: string, path: string, side: string) => git.resolveConflict(inside(root), String(path), side === 'theirs' ? 'theirs' : 'mine'),
    'git:abortMerge': (root: string) => git.abortMerge(inside(root)),
    // Cloning creates a new project folder, so it is not confined to the open one.
    'git:clone': (url: string, parentDir: string) => git.clone(String(url), String(parentDir)),
    'git:answerAskpass': (id: number, value: string | null) => answerAskpass(Number(id), typeof value === 'string' ? value : null),

    'app:openDocs': async (url: string) => {
      // Only ever hand documentation links to the system browser.
      if (/^https:\/\/camel\.apache\.org\//.test(url)) await host.openExternal(url)
    }
  }

  return {
    handlers: h,
    roots: () => [...opened],
    dispose() {
      runtime.detach()
      runner.killNow()
      closeAskpass()
    }
  }
}
