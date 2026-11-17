import { create } from 'zustand'
import type { AskpassRequest, DebugState, GitStatus, StudioSettings, NewProjectOptions, ProjectInfo, RecentProject, RouteFileInfo, RouteFormat, RunMode, RunStatus, RuntimeStatus, StudioApi, Toolchain, TraceEvent } from '@shared/types'
import { generateFor, sourceIndex } from './model/source'
import { javaClassName } from './model/javagen'
import { buildGlobals, DEFAULT_ENV, parseProperties, type GlobalVars, type PropFile } from './config/properties'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { emptyMapping } from './mapper/model'
import { IDENTITY_XSLT } from './mapper/xslt'
import { mappingRel, xslRel } from './mapper/paths'
import {
  normalizeValue,
  stepKind,
  MAPPER_ITEM,
  findMapperSteps,
  mapperStep,
  buildCatalog,
  editYaml,
  getAt,
  listEntries,
  pathKey,
  newRoute,
  newStep,
  parseRoutes,
  usedArtifacts,
  validate,
  type Catalog,
  type PaletteItem,
  type Path,
  type Y,
  type YamlEditor
} from './model/camel'

declare global {
  interface Window {
    studio: StudioApi
  }
}

const api = (): StudioApi => window.studio

export interface FileState {
  path: string
  rel: string
  name: string
  language: 'yaml' | 'java'
  text: string
  saved: string
  js: Y[] | null
  error: string | null
  past: string[]
  future: string[]
}

export type Selection = { kind: 'step' | 'branch'; path: Path } | null
export type ViewMode = 'design' | 'split' | 'source'
export type Theme = 'dark' | 'light'

export interface QuickAddState {
  x: number
  y: number
  seqPath: Path
  index: number
  /** Set when the chosen item replaces the step at this path instead of being inserted. */
  replace?: Path
}

export interface ContextMenuState {
  x: number
  y: number
  path: Path
}

/** Every step one message took through the routes, in order. */
export interface ExchangeTrace {
  id: string
  routeId: string
  startedAt: number
  elapsed: number
  failed: boolean
  done: boolean
  events: TraceEvent[]
}

export type BottomTab = 'console' | 'problems' | 'trace' | 'git'

export type GitAction = 'init' | 'commit' | 'pull' | 'push' | 'fetch' | 'abort' | 'resolve'

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'success' | 'error'
}

interface State {
  ready: boolean
  catalog: Catalog | null
  project: ProjectInfo | null
  recent: RecentProject[]
  toolchain: Toolchain | null
  files: Record<string, FileState>
  activePath: string | null
  /** Index of the top-level entry (route) shown on the canvas. */
  activeEntry: number
  selection: Selection
  view: ViewMode
  theme: Theme
  bottomOpen: boolean
  bottomTab: BottomTab
  runMode: RunMode
  /** True once the live link to the running application is up. */
  attached: boolean
  rtStatus: RuntimeStatus | null
  debug: DebugState | null
  exchanges: ExchangeTrace[]
  selectedExchange: string | null
  selectedTraceUid: number | null
  /** Route file text as it was when the app was launched: live data only lines up with that version. */
  launchTexts: Record<string, string>
  /** Breakpoints per route file, as step path keys. */
  breakpoints: Record<string, string[]>
  sendOpen: boolean
  /** Global variables (Spring properties per environment), loaded with the project. */
  globals: GlobalVars | null
  globalsOpen: boolean
  /** Environment the app is run with and placeholders are resolved for. */
  runEnv: string
  runStatus: RunStatus
  runDetail: string | null
  runLines: string[]
  quickAdd: QuickAddState | null
  contextMenu: ContextMenuState | null
  /** Steps copied or cut on the canvas. */
  clipboard: Y[] | null
  /** Camel Studio's own settings (the admin area). */
  settings: StudioSettings | null
  adminOpen: boolean
  snippetFor: Path | null
  toast: Toast | null
  dragging: boolean
  /** Git state of the project folder; null until read. */
  git: GitStatus | null
  gitBusy: GitAction | 'clone' | null
  buildOpen: boolean
  /** The package the last build produced, shown until dismissed. */
  built: { artifact: string; size: number } | null
  /** Git is asking for a user name, password, token or passphrase. */
  askpass: AskpassRequest | null

  init(): Promise<void>
  loadSettings(): Promise<void>
  updateSettings(patch: Partial<StudioSettings>): Promise<void>
  setAdminOpen(open: boolean): void
  openContextMenu(menu: ContextMenuState | null): void
  toggleDisabled(path: Path): void
  replaceStep(path: Path, item: PaletteItem): void
  copySteps(path: Path, cut: boolean): Promise<void>
  pasteAfter(path: Path): Promise<void>
  moveStepTo(from: Path, seqPath: Path, index: number): void
  saveSnippet(path: Path | null, name: string, description: string): Promise<void>
  setSnippetFor(path: Path | null): void
  openProject(root: string): Promise<void>
  pickAndOpenProject(): Promise<void>
  createProject(options: NewProjectOptions): Promise<void>
  closeProject(): void
  openFile(info: RouteFileInfo, language: 'yaml' | 'java'): Promise<void>
  setActiveEntry(index: number): void
  select(selection: Selection): void
  setView(view: ViewMode): void
  toggleTheme(): void
  setBottom(open: boolean, tab?: BottomTab): void
  setText(path: string, text: string): void
  edit(fn: (e: YamlEditor) => void, select?: Selection): void
  undo(): void
  redo(): void
  save(): Promise<void>
  newRouteFile(name: string): Promise<void>
  addRoute(): void
  deleteEntry(index: number): void
  insertStep(seqPath: Path, index: number, item: PaletteItem): void
  insertAfterSelection(item: PaletteItem): void
  removeStep(path: Path): void
  moveStep(seqPath: Path, index: number, delta: number): void
  duplicateStep(path: Path): void
  setTrigger(fromPath: Path, scheme: string): void
  loadComponent(name: string): Promise<void>
  openQuickAdd(q: QuickAddState | null): void
  setDragging(dragging: boolean): void
  notify(message: string, tone?: Toast['tone']): void
  run(mode?: RunMode): Promise<void>
  stop(): Promise<void>
  enableRuntimeTools(): Promise<void>
  setRouteFormat(format: RouteFormat): Promise<void>
  selectExchange(id: string | null, uid?: number | null): void
  clearTraces(): void
  toggleBreakpoint(path: Path): void
  debugStep(): void
  debugResume(): void
  routeCommand(routeId: string, command: 'start' | 'stop'): void
  setSendOpen(open: boolean): void
  loadGlobals(): Promise<void>
  /** Writes changed property files and reloads. */
  saveGlobalFiles(files: { rel: string; text: string }[]): Promise<boolean>
  setGlobalsOpen(open: boolean): void
  setRunEnv(env: string): void
  clearConsole(): void
  refreshGit(): Promise<void>
  gitRun(action: GitAction, options?: { message?: string; paths?: string[]; side?: 'mine' | 'theirs' }): Promise<boolean>
  cloneProject(url: string, parentDir: string): Promise<string | null>
  /** Picks up changes made on disk (after a pull) in the project and in open files without edits. */
  reloadFromDisk(): Promise<void>
  answerAskpass(value: string | null): void
  setBuildOpen(open: boolean): void
  buildPackage(skipTests: boolean, version: string | null): Promise<void>
  closeBuilt(): void
}

const HISTORY_LIMIT = 200
const MAX_EXCHANGES = 200
const MAX_LOG_LINES = 5000
let toastSeq = 0

/** Inside VS Code the designer follows the editor's theme (the webview body carries it as a class). */
export const vscodeTheme = (): Theme | null => {
  if (window.studio?.host !== 'vscode') return null
  return document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light') ? 'light' : 'dark'
}

const initialTheme = (): Theme => {
  const fromEditor = vscodeTheme()
  if (fromEditor) return fromEditor
  try {
    const stored = localStorage.getItem('camel-studio.theme')
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function mergeTraces(current: ExchangeTrace[], events: TraceEvent[]): ExchangeTrace[] {
  const list = current.slice()
  const position = new Map(list.map((x, i) => [x.id, i]))
  for (const ev of events) {
    let i = position.get(ev.exchangeId)
    if (i === undefined) {
      i = list.length
      position.set(ev.exchangeId, i)
      list.push({ id: ev.exchangeId, routeId: ev.routeId, startedAt: ev.timestamp, elapsed: 0, failed: false, done: false, events: [] })
    }
    const x = list[i]
    if (x.events.some((e) => e.uid === ev.uid)) continue
    list[i] = {
      ...x,
      events: [...x.events, ev],
      failed: x.failed || ev.failed,
      done: x.done || ev.last,
      elapsed: ev.last ? ev.elapsed : Math.max(x.elapsed, ev.timestamp - x.startedAt)
    }
  }
  return list.length > MAX_EXCHANGES ? list.slice(list.length - MAX_EXCHANGES) : list
}

/** Step path key -> Camel node id, for one route file, using the version the app was launched with. */
export function nodeIdsByPath(status: RuntimeStatus, file: FileState, launchTexts: Record<string, string>, catalog: Catalog, project: ProjectInfo | null): Map<string, string> {
  const out = new Map<string, string>()
  const source = sourceIndex(launchTexts[file.path] ?? file.saved, file.name, project, catalog)
  for (const route of status.routes) {
    for (const p of route.processors) {
      if (p.file !== source.name) continue
      const target = source.byLine.get(p.line)
      if (target) out.set(pathKey(target.path), p.id)
    }
  }
  return out
}

export const useStudio = create<State>((set, get) => {
  /** Node ids whose breakpoint has been requested but is not yet confirmed by the debugger. */
  const requested = new Set<string>()

  /**
   * Hands breakpoints set on the canvas to the debugger. Runs on every report from the app, because
   * the app connects before its routes are up and the debugger only knows a node once its route exists.
   */
  const syncBreakpoints = (): void => {
    const { runMode, attached, rtStatus, debug, breakpoints, files, launchTexts, catalog, project } = get()
    if (runMode !== 'debug' || !attached || !rtStatus || !debug?.enabled || !catalog) return
    const applied = new Set(debug.breakpoints)
    for (const [path, keys] of Object.entries(breakpoints)) {
      const file = files[path]
      if (!file || keys.length === 0) continue
      const ids = nodeIdsByPath(rtStatus, file, launchTexts, catalog, project)
      for (const key of keys) {
        const nodeId = ids.get(key)
        if (!nodeId || applied.has(nodeId) || requested.has(nodeId)) continue
        requested.add(nodeId)
        void window.studio.runtime.debugCommand('add', nodeId).catch(() => requested.delete(nodeId))
      }
    }
  }

  const withFile = (path: string, patch: (f: FileState) => FileState): void =>
    set((s) => (s.files[path] ? { files: { ...s.files, [path]: patch(s.files[path]) } } : s))

  const applyText = (f: FileState, text: string): FileState => {
    if (f.language !== 'yaml') return { ...f, text }
    const parsed = parseRoutes(text)
    // Keep the last good snapshot while the source is mid-edit so the canvas does not blank out.
    return { ...f, text, js: parsed.js ?? f.js, error: parsed.error }
  }

  const active = (): FileState | null => {
    const s = get()
    return s.activePath ? (s.files[s.activePath] ?? null) : null
  }

  const loadProject = async (project: ProjectInfo): Promise<void> => {
    set({ project, files: {}, activePath: null, activeEntry: 0, selection: null, runLines: [], runStatus: 'idle', runDetail: null })
    void api()
      .run.toolchain(project.root)
      .then((toolchain) => set({ toolchain }))
    void api()
      .project.recent()
      .then((recent) => set({ recent }))
    set({ globals: null, globalsOpen: false, runEnv: DEFAULT_ENV, git: null, built: null })
    void get().loadGlobals()
    void get().refreshGit()
    if (project.routeFormat === 'java') {
      await writeJava(project, project.routeFiles)
      const removed = await api().project.pruneGenerated(project.root, project.routeFiles.map((f) => `${javaClassName(f.name)}.java`)).catch(() => [] as string[])
      if (removed.length) get().notify(`Removed generated ${removed.join(', ')}: its route file no longer exists.`, 'info')
    }
    // In VS Code the tab shows one file: the document it was opened for.
    const doc = api().document
    if (doc) {
      const info = project.routeFiles.find((f) => f.path === doc.path) ?? { path: doc.path, rel: doc.path.slice(project.root.length + 1).split('\\').join('/'), name: doc.path.split(/[\\/]/).pop() ?? doc.path }
      await get().openFile(info, 'yaml')
    } else if (project.routeFiles[0]) await get().openFile(project.routeFiles[0], 'yaml')
  }

  /** Adds a Data Mapper step: creates its mapping and placeholder stylesheet, then opens the mapper. */
  const createMapper = async (seqPath: Path, index: number): Promise<void> => {
    const { project, activePath, files, activeEntry } = get()
    const file = activePath ? files[activePath] : null
    if (!project || !file?.js) return
    if (file.error) return get().notify('Fix the YAML error in the source view before editing on the canvas.', 'error')
    const entry = listEntries(file.js).find((e) => e.index === activeEntry)
    const base = `${(entry?.id ?? 'route').replace(/[^A-Za-z0-9-]+/g, '-').toLowerCase()}-mapping`
    const taken = new Set(Object.values(files).flatMap((f) => (f.js ? findMapperSteps(f.js).map((m) => m.name) : [])))
    const exists = async (n: string): Promise<boolean> =>
      taken.has(n) || (await api().project.readFile(`${project.root}/${mappingRel(n)}`).then(() => true, () => false))
    let name = base
    for (let i = 2; await exists(name); i++) name = `${base}-${i}`
    try {
      await api().project.writeFile(`${project.root}/${mappingRel(name)}`, `${JSON.stringify(emptyMapping(name), null, 2)}\n`)
      await api().project.writeFile(`${project.root}/${xslRel(name)}`, IDENTITY_XSLT)
    } catch (e) {
      get().notify(message(e), 'error')
      return
    }
    get().edit((e) => e.insert(seqPath, index, mapperStep(name, 'xml')), { kind: 'step', path: [...seqPath, index] })
    await openMapper(name)
  }

  /**
   * Java projects: (re)writes the generated class of each given route file, when it differs from
   * what is on disk. Returns how many generator warnings there were.
   */
  const writeJava = async (project: ProjectInfo, routeFiles: RouteFileInfo[]): Promise<number> => {
    const catalog = get().catalog
    if (!catalog) return 0
    let warnings = 0
    for (const info of routeFiles) {
      const text = get().files[info.path]?.text ?? (await api().project.readFile(info.path).catch(() => null))
      if (text === null) continue
      const js = parseRoutes(text).js
      if (!js) continue
      const result = generateFor(js, project, info.name, info.rel, catalog)
      warnings += result.warnings.length
      const target = `${project.root}/${project.javaDir}/${result.fileName}`
      const existing = await api().project.readFile(target).catch(() => null)
      if (existing !== result.code) await api().project.writeFile(target, result.code)
    }
    return warnings
  }

  return {
    ready: false,
    catalog: null,
    project: null,
    recent: [],
    toolchain: null,
    files: {},
    activePath: null,
    activeEntry: 0,
    selection: null,
    view: 'design',
    theme: initialTheme(),
    bottomOpen: false,
    bottomTab: 'console',
    runMode: 'run',
    attached: false,
    rtStatus: null,
    debug: null,
    exchanges: [],
    selectedExchange: null,
    selectedTraceUid: null,
    launchTexts: {},
    breakpoints: {},
    sendOpen: false,
    globals: null,
    globalsOpen: false,
    runEnv: DEFAULT_ENV,
    runStatus: 'idle',
    runDetail: null,
    runLines: [],
    quickAdd: null,
    contextMenu: null,
    clipboard: null,
    settings: null,
    adminOpen: false,
    snippetFor: null,
    toast: null,
    dragging: false,
    git: null,
    gitBusy: null,
    buildOpen: false,
    built: null,
    askpass: null,

    async init() {
      void get().loadSettings()
      const [index, models, recent] = await Promise.all([api().catalog.index(), api().catalog.models(), api().project.recent()])
      const catalog = buildCatalog(index, models)
      set({ catalog, recent, ready: true })

      api().run.onEvent((event) => {
        if (event.type === 'log') {
          set((s) => {
            const lines = s.runLines.concat(event.lines)
            return { runLines: lines.length > MAX_LOG_LINES ? lines.slice(lines.length - MAX_LOG_LINES) : lines }
          })
        } else if (event.type === 'built') {
          set({ built: { artifact: event.artifact, size: event.size } })
        } else {
          set({ runStatus: event.status, runDetail: event.detail ?? null })
          if (event.status === 'failed') set({ bottomOpen: true, bottomTab: 'console' })
        }
      })
      api().git.onAskpass((request) => set({ askpass: request }))
      const doc = api().document
      if (doc) {
        // The designer and the VS Code document stay in step both ways.
        doc.onChange(({ path, text, saved }) => {
          const f = get().files[path]
          if (!f) return
          if (f.text !== text) withFile(path, (cur) => ({ ...applyText(cur, text), past: [...cur.past, cur.text].slice(-HISTORY_LIMIT), future: [] }))
          // Saved from VS Code (File > Save, Save All): finish what a save does here (Java class, pom.xml).
          if (saved && get().files[path]?.saved !== text) void get().save()
        })
        const timers = new Map<string, ReturnType<typeof setTimeout>>()
        useStudio.subscribe((s, prev) => {
          if (s.files === prev.files) return
          for (const f of Object.values(s.files)) {
            if (f.language !== 'yaml' || prev.files[f.path]?.text === f.text || !prev.files[f.path]) continue
            clearTimeout(timers.get(f.path))
            timers.set(
              f.path,
              setTimeout(() => {
                const now = get().files[f.path]
                if (now) doc.update(now.path, now.text)
              }, 200)
            )
          }
        })
        new MutationObserver(() => {
          const theme = vscodeTheme()
          if (theme && theme !== get().theme) set({ theme })
        }).observe(document.body, { attributes: true, attributeFilter: ['class'] })
      }
      // Commits, pulls and branch switches made outside the app show up when the window is focused again.
      window.addEventListener('focus', () => void get().refreshGit())

      api().runtime.onEvent((event) => {
        if (event.type === 'attached') {
          set({ attached: true })
        } else if (event.type === 'detached') {
          requested.clear()
          set({ attached: false, rtStatus: null, debug: null })
        } else if (event.type === 'status') {
          set({ rtStatus: event.status })
          syncBreakpoints()
        } else if (event.type === 'trace') {
          set((s) => ({ exchanges: mergeTraces(s.exchanges, event.events) }))
        } else {
          const wasPaused = (get().debug?.suspended.length ?? 0) > 0
          set({ debug: event.debug })
          syncBreakpoints()
          const paused = event.debug.suspended[0]
          // A message has just stopped at a breakpoint: bring it into view.
          if (paused && !wasPaused) set({ selectedExchange: paused.exchangeId, selectedTraceUid: null, bottomOpen: true, bottomTab: 'trace' })
        }
      })

      void api()
        .run.toolchain(null)
        .then((toolchain) => set((s) => (s.toolchain ? s : { toolchain })))
      const initial = await api().project.initial()
      if (initial) await get().openProject(initial)
    },

    async openProject(root) {
      try {
        await loadProject(await api().project.open(root))
      } catch (e) {
        get().notify(message(e), 'error')
      }
    },

    async pickAndOpenProject() {
      const root = await api().project.pickFolder('Open a Spring Boot Camel project')
      if (root) await get().openProject(root)
    },

    async createProject(options) {
      await loadProject(await api().project.create(options))
    },

    closeProject() {
      if (get().runStatus === 'running' || get().runStatus === 'starting') void api().run.stop()
      set({ project: null, files: {}, activePath: null, selection: null })
    },

    async openFile(info, language) {
      // VS Code: another file opens in its own editor tab (route files in the designer).
      const doc = api().document
      if (doc && info.path !== doc.path && get().activePath) {
        doc.open(info.path)
        return
      }
      if (!get().files[info.path]) {
        try {
          const text = await api().project.readFile(info.path)
          const base: FileState = { path: info.path, rel: info.rel, name: info.name, language, text, saved: text, js: null, error: null, past: [], future: [] }
          set((s) => ({ files: { ...s.files, [info.path]: applyText(base, text) } }))
        } catch (e) {
          get().notify(message(e), 'error')
          return
        }
      }
      const file = get().files[info.path]
      const firstRoute = file.js ? listEntries(file.js).find((r) => r.isRoute) : undefined
      set((s) => ({
        activePath: info.path,
        activeEntry: firstRoute?.index ?? 0,
        selection: null,
        quickAdd: null,
        view: language === 'java' ? 'source' : s.view === 'source' && s.files[s.activePath ?? '']?.language === 'java' ? 'design' : s.view
      }))
    },

    setActiveEntry(index) {
      set({ activeEntry: index, selection: null, quickAdd: null })
    },

    select(selection) {
      set({ selection })
    },

    setView(view) {
      set({ view })
    },

    toggleTheme() {
      const theme: Theme = get().theme === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem('camel-studio.theme', theme)
      } catch {
        /* storage unavailable */
      }
      set({ theme })
    },

    setBottom(open, tab) {
      set((s) => ({ bottomOpen: open, bottomTab: tab ?? s.bottomTab }))
    },

    setText(path, text) {
      withFile(path, (f) => (f.text === text ? f : applyText(f, text)))
    },

    edit(fn, select) {
      const f = active()
      if (!f || f.language !== 'yaml') return
      if (f.error) {
        get().notify('Fix the YAML error in the source view before editing on the canvas.', 'error')
        return
      }
      let next: string
      try {
        next = editYaml(f.text, fn)
      } catch (e) {
        get().notify(`Edit failed: ${message(e)}`, 'error')
        return
      }
      if (next === f.text) return
      withFile(f.path, (cur) => ({ ...applyText(cur, next), past: [...cur.past.slice(-HISTORY_LIMIT), cur.text], future: [] }))
      if (select !== undefined) set({ selection: select })
    },

    undo() {
      const f = active()
      if (!f || f.past.length === 0) return
      const prev = f.past[f.past.length - 1]
      withFile(f.path, (cur) => ({ ...applyText(cur, prev), past: cur.past.slice(0, -1), future: [cur.text, ...cur.future] }))
      set({ selection: null })
    },

    redo() {
      const f = active()
      if (!f || f.future.length === 0) return
      const next = f.future[0]
      withFile(f.path, (cur) => ({ ...applyText(cur, next), past: [...cur.past, cur.text], future: cur.future.slice(1) }))
      set({ selection: null })
    },

    async save() {
      // An open Data Mapper saves first: it may update its step in the route.
      const mapper = (await import('./mapper/store')).useMapper.getState()
      if (mapper.name && mapper.isDirty() && !(await mapper.save())) return
      const { files, project, catalog } = get()
      if (!project) return
      const dirty = Object.values(files).filter((f) => f.language === 'yaml' && f.text !== f.saved)
      try {
        for (const f of dirty) {
          await api().project.writeFile(f.path, f.text)
          withFile(f.path, (cur) => ({ ...cur, saved: f.text }))
        }
        // Java projects: Camel runs the generated class, so it is rewritten with every save.
        const javaWarnings = project.routeFormat === 'java' ? await writeJava(project, dirty) : 0
        // Keep pom.xml in step with the components, languages and data formats the routes now use.
        const needed = new Set<string>()
        if (catalog) for (const f of Object.values(get().files)) if (f.js) usedArtifacts(f.js, catalog).forEach((a) => needed.add(a))
        const artifacts = [...needed]
        const result = project.hasPom ? await api().project.syncDependencies(project.root, artifacts) : { added: [], skipped: null }
        if (result.added.length > 0) get().notify(`Saved. Added to pom.xml: ${result.added.join(', ')}`, 'success')
        else if (dirty.length > 0) get().notify(dirty.length === 1 ? `Saved ${dirty[0].name}` : `Saved ${dirty.length} files`, 'success')
        if (javaWarnings > 0) get().notify(`Saved, but ${javaWarnings} ${javaWarnings === 1 ? 'thing' : 'things'} could not be written to Java. See the Problems tab.`, 'error')
        void get().refreshGit()
      } catch (e) {
        get().notify(`Save failed: ${message(e)}`, 'error')
      }
    },

    async newRouteFile(name) {
      const project = get().project
      if (!project) return
      const id = name
        .trim()
        .replace(/\.camel\.ya?ml$|\.ya?ml$/i, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
      if (!id) return
      try {
        const content = editYaml('', (e) => e.insert([], 0, newRoute(id)))
        const info = await api().project.createRouteFile(project.root, id, content)
        set({ project: await api().project.rescan(project.root) })
        await get().openFile(info, 'yaml')
      } catch (e) {
        get().notify(message(e), 'error')
      }
    },

    addRoute() {
      const f = active()
      if (!f?.js) return
      const taken = new Set(listEntries(f.js).map((r) => r.id))
      let n = f.js.length + 1
      while (taken.has(`route-${n}`)) n++
      const index = f.js.length
      get().edit((e) => e.insert([], index, newRoute(`route-${n}`)), null)
      set({ activeEntry: index })
    },

    deleteEntry(index) {
      get().edit((e) => e.remove([], index), null)
      const routes = listEntries(active()?.js ?? []).filter((r) => r.isRoute)
      const current = get().activeEntry
      const target = current > index ? current - 1 : current
      set({ activeEntry: routes.find((r) => r.index === target)?.index ?? routes[0]?.index ?? 0 })
    },

    insertStep(seqPath, index, item) {
      const catalog = get().catalog
      if (!catalog) return
      if (item.type === 'component' && catalog.components.get(item.name)?.consumerOnly) {
        get().notify(`${catalog.components.get(item.name)?.title} can only start a route. Drop it on the first node to use it as the trigger.`, 'info')
        return
      }
      if (item.type === 'snippet') {
        const snippet = get().settings?.snippets.find((x) => x.id === item.id)
        if (!snippet) return
        const steps = structuredClone(snippet.steps) as Y[]
        get().edit((e) => steps.forEach((st, i) => e.insert(seqPath, index + i, st)), { kind: 'step', path: [...seqPath, index] })
        set({ quickAdd: null })
        return
      }
      if (item.type === 'eip' && item.name === MAPPER_ITEM) {
        set({ quickAdd: null })
        void createMapper(seqPath, index)
        return
      }
      get().edit((e) => e.insert(seqPath, index, newStep(item, catalog)), { kind: 'step', path: [...seqPath, index] })
      set({ quickAdd: null })
    },

    insertAfterSelection(item) {
      const { selection, activeEntry } = get()
      const f = active()
      if (!f?.js) return
      const entry = listEntries(f.js).find((r) => r.index === activeEntry)
      if (!entry?.fromPath) {
        get().notify('Open a route first.', 'info')
        return
      }
      const rootSeq: Path = [...entry.fromPath, 'steps']
      if (selection?.kind === 'step') {
        const last = selection.path[selection.path.length - 1]
        if (typeof last === 'number') return get().insertStep(selection.path.slice(0, -1), last + 1, item)
        if (last === 'from') return get().insertStep(rootSeq, 0, item)
      }
      if (selection?.kind === 'branch') {
        const seq = [...selection.path, 'steps']
        const steps = getAt(f.js, seq)
        return get().insertStep(seq, Array.isArray(steps) ? steps.length : 0, item)
      }
      const steps = getAt(f.js, rootSeq)
      get().insertStep(rootSeq, Array.isArray(steps) ? steps.length : 0, item)
    },

    removeStep(path) {
      const last = path[path.length - 1]
      if (typeof last !== 'number') return
      get().edit((e) => e.remove(path.slice(0, -1), last), null)
    },

    async loadSettings() {
      set({ settings: await api().settings.get() })
    },

    async updateSettings(patch) {
      try {
        set({ settings: await api().settings.update(patch) })
      } catch (e) {
        get().notify(`Settings could not be saved: ${message(e)}`, 'error')
      }
    },

    setAdminOpen(adminOpen) {
      set({ adminOpen })
    },

    openContextMenu(contextMenu) {
      set({ contextMenu, quickAdd: null })
    },

    toggleDisabled(path) {
      const kind = Object.keys(getAt(active()?.js ?? [], path) ?? {})[0]
      if (!kind) return
      const valuePath = [...path, kind]
      get().edit((e) => {
        e.ensureObject(valuePath, kind)
        if (e.js([...valuePath, 'disabled']) === true) e.del([...valuePath, 'disabled'])
        else e.set([...valuePath, 'disabled'], true)
      }, { kind: 'step', path })
    },

    replaceStep(path, item) {
      const catalog = get().catalog
      const f = active()
      if (!catalog || !f?.js) return
      const last = path[path.length - 1]
      if (typeof last !== 'number') return
      const old = getAt(f.js, path)
      const oldKind = stepKind(old)
      const oldValue = old?.[oldKind] && typeof old[oldKind] === 'object' ? old[oldKind] : {}
      let next: Y
      if (item.type === 'snippet') {
        const snippet = get().settings?.snippets.find((x) => x.id === item.id)
        if (!snippet) return
        const steps = structuredClone(snippet.steps) as Y[]
        get().edit((e) => {
          e.remove(path.slice(0, -1), last)
          steps.forEach((st, i) => e.insert(path.slice(0, -1), last + i, st))
        }, { kind: 'step', path })
        set({ quickAdd: null })
        return
      } else {
        next = newStep(item, catalog)
      }
      const kind = stepKind(next)
      // Keep what still makes sense: the id, the description, and the inner steps of a container.
      for (const k of ['id', 'description']) if (oldValue[k] !== undefined) next[kind][k] = oldValue[k]
      if (Array.isArray(oldValue.steps) && oldValue.steps.length && catalog.models[kind]?.output) next[kind].steps = oldValue.steps
      // An expression carries over when both steps take one (Set Body → Transform, Filter → Choice…).
      const takesExpression = (k: string): boolean => !!catalog.models[k]?.properties.some((p) => p.kind === 'expression' && p.name === 'expression')
      const oldLang = Object.keys(oldValue).find((k) => catalog.languages.has(k))
      if (oldLang && takesExpression(kind) && takesExpression(oldKind)) {
        for (const k of Object.keys(next[kind])) if (catalog.languages.has(k)) delete next[kind][k]
        next[kind][oldLang] = oldValue[oldLang]
      }
      get().edit((e) => {
        e.remove(path.slice(0, -1), last)
        e.insert(path.slice(0, -1), last, next)
      }, { kind: 'step', path })
      set({ quickAdd: null })
    },

    async copySteps(path, cut) {
      const f = active()
      const step = f?.js ? getAt(f.js, path) : undefined
      if (!step || typeof path[path.length - 1] !== 'number') return
      const steps = [structuredClone(step)]
      set({ clipboard: steps })
      // Also as YAML text, so steps can be pasted into another project or a chat.
      try {
        await navigator.clipboard.writeText(stringifyYaml(steps))
      } catch {
        /* the app clipboard is enough */
      }
      if (cut) get().removeStep(path)
      get().notify(cut ? 'Step cut. Select a step and paste with ⌘V to put it after.' : 'Step copied.', 'info')
    },

    async pasteAfter(path) {
      let steps = get().clipboard
      // Steps copied in another window arrive as YAML text.
      try {
        const text = await navigator.clipboard.readText()
        const parsed = text.trim().startsWith('-') ? parseYaml(text) : null
        if (Array.isArray(parsed) && parsed.every((p) => stepKind(p))) steps = parsed
      } catch {
        /* use the app clipboard */
      }
      if (!steps?.length) return get().notify('Nothing to paste: copy a step first (⌘C).', 'info')
      const last = path[path.length - 1]
      const isFrom = last === 'from'
      const seqPath = isFrom ? [...path, 'steps'] : path.slice(0, -1)
      const at = isFrom ? 0 : (last as number) + 1
      const copy = structuredClone(steps)
      get().edit((e) => copy.forEach((st, i) => e.insert(seqPath, at + i, st)), { kind: 'step', path: [...seqPath, at] })
    },

    moveStepTo(from, seqPath, index) {
      const fromSeq = from.slice(0, -1)
      const fromIndex = from[from.length - 1]
      if (typeof fromIndex !== 'number') return
      // A step cannot move inside itself.
      if (seqPath.length > from.length && from.every((k, i) => seqPath[i] === k)) return get().notify('A step cannot be moved inside itself.', 'info')
      const target = [...seqPath]
      let at = index
      // Removing the step first shifts later positions in the same list (or in lists under it).
      if (fromSeq.length <= target.length && fromSeq.every((k, i) => target[i] === k)) {
        if (target.length === fromSeq.length) {
          if (at > fromIndex) at -= 1
          if (at === fromIndex) return
        } else {
          const pos = target[fromSeq.length]
          if (typeof pos === 'number' && pos > fromIndex) target[fromSeq.length] = pos - 1
        }
      }
      get().edit((e) => {
        const step = structuredClone(e.js(from))
        e.remove(fromSeq, fromIndex)
        e.insert(target, at, step)
      }, { kind: 'step', path: [...target, at] })
    },

    setSnippetFor(snippetFor) {
      set({ snippetFor, contextMenu: null })
    },

    async saveSnippet(path, name, description) {
      const f = active()
      if (!f?.js || !path) return
      const value = getAt(f.js, path)
      // A route's trigger saves the steps after it; a step saves itself.
      const steps: Y[] = path[path.length - 1] === 'from' ? structuredClone(normalizeValue('from', value).steps ?? []) : [structuredClone(value)]
      if (steps.length === 0) return get().notify('There are no steps to save.', 'info')
      const s = get().settings
      const snippet = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: name.trim(), description: description.trim(), steps }
      await get().updateSettings({ snippets: [...(s?.snippets ?? []), snippet] })
      set({ snippetFor: null })
      get().notify(`“${snippet.name}” is in the team palette (Processors › Team).`, 'success')
    },

    moveStep(seqPath, index, delta) {
      get().edit((e) => e.move(seqPath, index, index + delta), { kind: 'step', path: [...seqPath, index + delta] })
    },

    duplicateStep(path) {
      const last = path[path.length - 1]
      if (typeof last !== 'number') return
      const seqPath = path.slice(0, -1)
      get().edit((e) => e.insert(seqPath, last + 1, structuredClone(e.js(path))), { kind: 'step', path: [...seqPath, last + 1] })
    },

    setTrigger(fromPath, scheme) {
      const entry = get().catalog?.components.get(scheme)
      if (entry?.producerOnly) {
        get().notify(`${entry.title} cannot start a route. It can only be called from one.`, 'info')
        return
      }
      get().edit(
        (e) => {
          e.set([...fromPath, 'uri'], `${scheme}:`)
          e.del([...fromPath, 'parameters'])
        },
        { kind: 'step', path: fromPath }
      )
    },

    async loadComponent(name) {
      const catalog = get().catalog
      if (!catalog || catalog.defs[name] || !catalog.components.has(name)) return
      const def = await api().catalog.component(name)
      if (!def) return
      set((s) => (s.catalog ? { catalog: { ...s.catalog, defs: { ...s.catalog.defs, [name]: def } } } : s))
    },

    openQuickAdd(quickAdd) {
      set({ quickAdd })
    },

    setDragging(dragging) {
      set({ dragging })
    },

    notify(text, tone = 'info') {
      const id = ++toastSeq
      set({ toast: { id, message: text, tone } })
      setTimeout(() => set((s) => (s.toast?.id === id ? { toast: null } : s)), tone === 'error' ? 6000 : 3500)
    },

    async run(mode = 'run') {
      const project = get().project
      if (!project) return
      if (mode === 'debug' && !project.runtimeTools) {
        set({ bottomOpen: true, bottomTab: 'trace' })
        get().notify('Debugging needs the Camel Studio profile in pom.xml. Enable it in the Trace tab.', 'info')
        return
      }
      await get().save()
      const launchTexts: Record<string, string> = {}
      for (const f of Object.values(get().files)) if (f.language === 'yaml') launchTexts[f.path] = f.saved
      set({ runLines: [], bottomOpen: true, bottomTab: 'console', runMode: mode, launchTexts, exchanges: [], selectedExchange: null, selectedTraceUid: null, rtStatus: null, debug: null })
      const catalog = get().catalog
      const open = Object.values(get().files).filter((f) => f.language === 'yaml')
      const problems = open.reduce((n, f) => n + (f.error ? 1 : f.js && catalog ? validate(f.js, catalog).length : 0), 0)
      if (problems > 0) get().notify(`Running with ${problems} unresolved ${problems === 1 ? 'problem' : 'problems'}. Camel may refuse to start: see the Problems tab.`, 'error')
      try {
        await api().run.start(project.root, mode, get().runEnv)
      } catch (e) {
        get().notify(message(e), 'error')
      }
    },

    async stop() {
      await api().run.stop()
    },

    clearConsole() {
      set({ runLines: [] })
    },

    async refreshGit() {
      const project = get().project
      // VS Code has its own source control view.
      if (!project || api().host === 'vscode') return
      const git = await api().git.status(project.root).catch(() => null)
      if (get().project?.root === project.root) set({ git })
    },

    async gitRun(action, options = {}) {
      const project = get().project
      if (!project || get().gitBusy) return false
      const unsaved = Object.values(get().files).some((f) => f.text !== f.saved)
      if ((action === 'pull' || action === 'abort' || action === 'resolve') && unsaved) {
        get().notify('Save your changes first: pulling may change the same files.', 'info')
        return false
      }
      // A commit records what is on disk, so unsaved edits are saved first.
      if (action === 'commit' && unsaved) await get().save()
      set({ gitBusy: action })
      const g = api().git
      const root = project.root
      try {
        let done = ''
        if (action === 'init') {
          await g.init(root)
          done = 'Git repository created.'
        } else if (action === 'commit') {
          const hash = await g.commit(root, options.message ?? '', options.paths ?? [])
          done = hash ? `Committed ${hash}.` : 'Committed.'
        } else if (action === 'pull') {
          done = await g.pull(root)
        } else if (action === 'push') {
          done = await g.push(root)
        } else if (action === 'fetch') {
          await g.fetch(root)
          done = 'Checked the server for new commits.'
        } else if (action === 'resolve') {
          const side = options.side === 'theirs' ? 'theirs' : 'mine'
          for (const p of options.paths ?? []) await g.resolve(root, p, side)
          done = side === 'mine' ? 'Kept your version. Commit to finish the pull.' : 'Took the pulled version. Commit to finish the pull.'
        } else {
          await g.abortMerge(root)
          done = 'Merge aborted: your files are as they were before the pull.'
        }
        get().notify(done, 'success')
        return true
      } catch (e) {
        get().notify(message(e), 'error')
        return false
      } finally {
        if (action === 'pull' || action === 'abort' || action === 'resolve') await get().reloadFromDisk()
        set({ gitBusy: null })
        await get().refreshGit()
      }
    },

    async cloneProject(url, parentDir) {
      set({ gitBusy: 'clone' })
      try {
        const root = await api().git.clone(url, parentDir)
        await get().openProject(root)
        return root
      } catch (e) {
        throw new Error(message(e))
      } finally {
        set({ gitBusy: null })
      }
    },

    async reloadFromDisk() {
      const project = get().project
      if (!project) return
      const fresh = await api().project.rescan(project.root).catch(() => null)
      if (!fresh) return
      set({ project: fresh })
      for (const f of Object.values(get().files)) {
        if (f.text !== f.saved) continue
        const text = await api().project.readFile(f.path).catch(() => null)
        if (text === null) {
          // The file was deleted by the pull.
          set((s) => {
            const files = { ...s.files }
            delete files[f.path]
            return { files, activePath: s.activePath === f.path ? null : s.activePath, selection: s.activePath === f.path ? null : s.selection }
          })
        } else if (text !== f.saved) {
          set((s) => ({ files: { ...s.files, [f.path]: { ...applyText(f, text), saved: text, past: [], future: [] } } }))
        }
      }
      await get().loadGlobals()
    },

    answerAskpass(value) {
      const request = get().askpass
      if (!request) return
      set({ askpass: null })
      void api().git.answerAskpass(request.id, value)
    },

    setBuildOpen(open) {
      set({ buildOpen: open })
    },

    async buildPackage(skipTests, version) {
      const project = get().project
      if (!project) return
      await get().save()
      try {
        if (version && version !== project.version) set({ project: await api().project.setVersion(project.root, version) })
        set({ runLines: [], bottomOpen: true, bottomTab: 'console', built: null, buildOpen: false })
        await api().run.build(project.root, skipTests)
      } catch (e) {
        get().notify(message(e), 'error')
      }
    },

    closeBuilt() {
      set({ built: null })
    },

    async enableRuntimeTools() {
      const project = get().project
      if (!project) return
      try {
        set({ project: await api().project.enableRuntimeTools(project.root) })
        const running = get().runStatus === 'running' || get().runStatus === 'starting'
        get().notify(`Added two development-only profiles to pom.xml.${running ? ' Restart the app to use them.' : ''}`, 'success')
      } catch (e) {
        get().notify(message(e), 'error')
      }
    },

    async setRouteFormat(format) {
      const { project, files, runStatus } = get()
      if (!project || project.routeFormat === format) return
      if (runStatus === 'running' || runStatus === 'starting') return get().notify('Stop the application before changing the route format.', 'info')
      if (Object.values(files).some((f) => f.text !== f.saved)) return get().notify('Save your changes before changing the route format.', 'info')
      try {
        await loadProject(await api().project.setRouteFormat(project.root, format))
        get().notify(format === 'java' ? 'Routes are now written as Java classes.' : 'Routes are now YAML files run directly by Camel.', 'success')
      } catch (e) {
        get().notify(message(e), 'error')
      }
    },

    selectExchange(id, uid = null) {
      set({ selectedExchange: id, selectedTraceUid: uid })
    },

    clearTraces() {
      set({ exchanges: [], selectedExchange: null, selectedTraceUid: null })
    },

    toggleBreakpoint(path) {
      const f = active()
      if (!f) return
      const key = pathKey(path)
      const current = get().breakpoints[f.path] ?? []
      const on = !current.includes(key)
      set((s) => ({ breakpoints: { ...s.breakpoints, [f.path]: on ? [...current, key] : current.filter((k) => k !== key) } }))
      const { attached, rtStatus, runMode, catalog } = get()
      if (!attached || !rtStatus || runMode !== 'debug' || !catalog) return
      const nodeId = nodeIdsByPath(rtStatus, f, get().launchTexts, catalog, get().project).get(key)
      if (!nodeId) return
      if (on) requested.add(nodeId)
      else requested.delete(nodeId)
      void api().runtime.debugCommand(on ? 'add' : 'remove', nodeId).catch((e) => get().notify(message(e), 'error'))
    },

    debugStep() {
      void api().runtime.debugCommand('step').catch((e) => get().notify(message(e), 'error'))
    },

    debugResume() {
      void api().runtime.debugCommand('resume').catch((e) => get().notify(message(e), 'error'))
    },

    routeCommand(routeId, command) {
      void api().runtime.routeCommand(routeId, command).catch((e) => get().notify(message(e), 'error'))
    },

    setSendOpen(sendOpen) {
      set({ sendOpen })
    },

    async loadGlobals() {
      const project = get().project
      if (!project) return
      const fresh = await api().project.rescan(project.root).catch(() => project)
      const files: PropFile[] = []
      for (const f of fresh.envFiles) {
        const text = await api().project.readFile(`${project.root}/${f.rel}`).catch(() => null)
        if (text !== null) files.push(parseProperties(text, f.rel, f.env))
      }
      const globals = buildGlobals(files)
      set((s) => ({ project: s.project ? { ...s.project, envFiles: fresh.envFiles } : s.project, globals, runEnv: globals.envs.includes(s.runEnv) ? s.runEnv : DEFAULT_ENV }))
    },

    async saveGlobalFiles(files) {
      const project = get().project
      if (!project) return false
      try {
        for (const f of files) await api().project.writeFile(`${project.root}/${f.rel}`, f.text)
        await get().loadGlobals()
        return true
      } catch (e) {
        get().notify(`Global variables could not be saved: ${message(e)}`, 'error')
        return false
      }
    },

    setGlobalsOpen(globalsOpen) {
      set({ globalsOpen })
    },

    setRunEnv(runEnv) {
      set({ runEnv })
    }
  }
})

/** Opens the Data Mapper for a mapping (loaded on demand to keep the two stores independent). */
export async function openMapper(name: string): Promise<void> {
  await (await import('./mapper/store')).useMapper.getState().open(name)
}

export const useActiveFile = (): FileState | null => useStudio((s) => (s.activePath ? (s.files[s.activePath] ?? null) : null))
export const studioApi = api
