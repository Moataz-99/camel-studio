// Types shared by the main process, the preload bridge and the renderer.

// ---------------------------------------------------------------- catalog --

export interface CatalogProperty {
  name: string
  /** `path` and `parameter` for endpoints; `attribute`, `element`, `expression` for EIP models. */
  kind: string
  type: string
  displayName?: string
  group?: string
  label?: string
  required?: boolean
  secret?: boolean
  deprecated?: boolean
  enum?: string[]
  oneOf?: string[]
  javaType?: string
  defaultValue?: string | number | boolean
  description?: string
  index?: number
}

export interface ComponentEntry {
  name: string
  title: string
  description: string
  label: string
  syntax: string
  artifactId: string
  consumerOnly: boolean
  producerOnly: boolean
  deprecated: boolean
  remote: boolean
}

export interface ComponentDef {
  name: string
  title: string
  description: string
  label: string
  syntax: string
  artifactId: string
  consumerOnly: boolean
  producerOnly: boolean
  properties: CatalogProperty[]
}

export interface ModelEntry {
  name: string
  title: string
  description: string
  label: string
  input: boolean
  output: boolean
  abstract: boolean
  deprecated: boolean
}

export interface ModelDef extends ModelEntry {
  properties: CatalogProperty[]
}

export interface NamedEntry {
  name: string
  title: string
  description: string
  artifactId?: string
}

export interface CatalogIndex {
  camelVersion: string
  springBootVersion: string | null
  components: ComponentEntry[]
  eips: ModelEntry[]
  languages: NamedEntry[]
  dataformats: NamedEntry[]
}

// ---------------------------------------------------------------- project --

export interface RouteFileInfo {
  /** Absolute path. */
  path: string
  /** Path relative to the project root, with forward slashes. */
  rel: string
  name: string
}

export interface ProjectInfo {
  root: string
  name: string
  hasPom: boolean
  groupId: string | null
  artifactId: string | null
  camelVersion: string | null
  springBootVersion: string | null
  /** Folder new route files are created in, relative to root. */
  routesDir: string
  routeFiles: RouteFileInfo[]
  /** Java DSL RouteBuilder classes. Shown read-only. */
  javaRoutes: RouteFileInfo[]
  /** True when pom.xml has the `camel-studio` profile that enables tracing and debugging. */
  runtimeTools: boolean
  /** What saving a route writes for Camel to run: the YAML itself, or a generated Java class. */
  routeFormat: RouteFormat
  /** Java mode: package of the generated classes, and their folder relative to root. */
  javaPackage: string
  javaDir: string
  /** application.properties (env `default`) and application-<env>.properties files. */
  envFiles: { env: string; rel: string }[]
  /** The project's own version in pom.xml. */
  version: string | null
}

export type RouteFormat = 'yaml' | 'java'

export interface NewProjectOptions {
  routeFormat: RouteFormat
  javaVersion?: string
  parentDir: string
  name: string
  groupId: string
  artifactId: string
}

export interface RecentProject {
  root: string
  name: string
  openedAt: number
}

export interface DependencySyncResult {
  added: string[]
  skipped: string | null
}

// ----------------------------------------------------------------- runner --

export interface Toolchain {
  java: string | null
  maven: string | null
  /** True when the project ships its own Maven wrapper. */
  wrapper: boolean
  /** True when the JDK or Maven comes from Camel Studio's own folder (~/.camel-studio/toolchain). */
  privateTools: boolean
}

export type RunStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'failed' | 'building'
export type RunMode = 'run' | 'debug'

// ---------------------------------------------------------------- runtime --
// Live data from the running application, read through Camel's CLI connector.

export interface RtStats {
  total: number
  failed: number
  inflight: number
  /** Mean, last and max processing time in milliseconds. */
  mean: number
  last: number
  max: number
}

export interface RtProcessor extends RtStats {
  id: string
  /** Base name of the route file and the 1-based line the step starts on. */
  file: string
  line: number
}

export interface RtRoute extends RtStats {
  routeId: string
  state: string
  from: string
  file: string
  processors: RtProcessor[]
}

export interface RuntimeStatus {
  pid: number
  name: string
  camelVersion: string
  state: string
  uptime: number
  routes: RtRoute[]
}

export interface TraceValue {
  key?: string
  type?: string
  value?: unknown
}

export interface TraceMessage {
  exchangePattern?: string
  body?: TraceValue
  headers?: TraceValue[]
  exchangeProperties?: TraceValue[]
  exchangeVariables?: TraceValue[]
}

export interface TraceException {
  type?: string
  message?: string
  /** Camel sends the stack trace as one string; older versions sent a list of lines. */
  stackTrace?: string | string[]
}

/** One step of one message: the message as it arrived at a node. */
export interface TraceEvent {
  uid: number
  exchangeId: string
  routeId: string
  nodeId: string
  nodeKind: string
  label: string
  /** `file.camel.yaml:12`, when Camel knows where the node was defined. */
  location: string | null
  first: boolean
  last: boolean
  timestamp: number
  elapsed: number
  failed: boolean
  message: TraceMessage
  exception: TraceException | null
}

export interface DebugState {
  enabled: boolean
  breakpoints: string[]
  /** Messages currently paused at a breakpoint. */
  suspended: TraceEvent[]
}

export type RuntimeEvent =
  | { type: 'attached'; pid: number }
  | { type: 'status'; status: RuntimeStatus }
  | { type: 'trace'; events: TraceEvent[] }
  | { type: 'debug'; debug: DebugState }
  | { type: 'detached' }

export interface SendRequest {
  endpoint: string
  body: string
  headers: { key: string; value: string }[]
  exchangePattern: 'InOnly' | 'InOut'
}

export interface SendResult {
  /** True when the message was handed over asynchronously (debug mode), so no reply is available. */
  relayed: boolean
  status: string
  elapsed: number
  exception: TraceException | null
  message: TraceMessage | null
}

export type RunEvent =
  | { type: 'log'; lines: string[] }
  | { type: 'status'; status: RunStatus; detail?: string }
  /** A package build finished: the runnable JAR it produced. */
  | { type: 'built'; artifact: string; size: number }

// -------------------------------------------------------------------- git --

export type GitFileState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict'

export interface GitFile {
  /** Relative to the project folder, with forward slashes. */
  path: string
  /** Original path of a renamed file. */
  from?: string
  state: GitFileState
}

export interface GitStatus {
  /** False when no git executable was found. */
  available: boolean
  repo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  /** URL of the `origin` remote. */
  remote: string | null
  files: GitFile[]
  /** A pull stopped on conflicts and the merge is not finished. */
  merging: boolean
  /** Name and email commits are made with; null when Git has none. */
  identity: { name: string; email: string } | null
  noCommits: boolean
}

export interface GitCommit {
  hash: string
  author: string
  when: string
  subject: string
}

export interface AskpassRequest {
  id: number
  prompt: string
}

// ----------------------------------------------------------------- mapper --

export interface MapperPreviewRequest {
  xslt: string
  input: string
  sourceFormat: 'xml' | 'json'
  /** Example values for the headers, variables and properties the mapping reads. */
  params?: { name: string; value: string }[]
}

export interface MapperPreviewResult {
  ok: boolean
  output: string
  error: string | null
  ms: number
}

export interface ImportedFile {
  /** Path relative to the project root. */
  rel: string
  name: string
  content: string
}

// ------------------------------------------------------------ connections --

export type ConnectionTarget =
  | { kind: 'http'; url: string }
  /** `greeting`: read the first line the server sends (FTP, SSH, mail). */
  | { kind: 'tcp'; hosts: { host: string; port: number }[]; tls?: boolean; greeting?: boolean }

export interface ConnectionCheck {
  target: string
  ok: boolean
  ms: number
  message: string
  greeting?: string
}

export interface ConnectionResult {
  ok: boolean
  checks: ConnectionCheck[]
}

// --------------------------------------------------------------- settings --
// Camel Studio's own settings (the admin area), in ~/.camel-studio/settings.json.

/** A group of steps saved to the palette, BW5's shared processes in Camel Studio. */
export interface Snippet {
  id: string
  name: string
  description: string
  /** The steps as YAML DSL objects. */
  steps: unknown[]
}

/** A component the team built itself, imported from its JAR. */
export interface CustomComponent {
  scheme: string
  title: string
  description: string
  groupId: string
  artifactId: string
  version: string
}

export interface ProjectDefaults {
  groupId: string
  routeFormat: RouteFormat
  javaVersion: string
}

export interface StudioSettings {
  /** null: found automatically. */
  javaHome: string | null
  mavenHome: string | null
  /** A Maven settings.xml (company mirror, credentials), passed with -s. */
  mavenSettings: string | null
  /** Camel catalog in use; null is the one built into the app. */
  camelVersion: string | null
  defaults: ProjectDefaults
  snippets: Snippet[]
  components: CustomComponent[]
}

export interface ToolCandidate {
  path: string
  version: string
  source: string
}

export interface ToolchainList {
  jdks: ToolCandidate[]
  mavens: ToolCandidate[]
}

export interface CamelVersionInfo {
  version: string
  installed: boolean
  bundled: boolean
  /** Long-term support release line (4.10, 4.14…), when known. */
  lts: boolean
}

export interface ProgressEvent {
  task: string
  received: number
  total: number
  done?: boolean
  error?: string
}

// -------------------------------------------------------------------- api --

/** VS Code: the route file a designer tab shows. Its text lives in a VS Code document. */
export interface EditorDocument {
  path: string
  /** Pushes the designer's text for a file into its VS Code document (which then shows as modified). */
  update(path: string, text: string): void
  /** The document changed outside the designer (typing in a text editor, revert, git) or was saved. */
  onChange(listener: (event: { path: string; text: string; saved: boolean }) => void): () => void
  /** Opens another file in VS Code: route files in the designer, anything else as text. */
  open(path: string): void
}

export interface StudioApi {
  platform: string
  /** Which shell runs the UI. */
  host: 'desktop' | 'vscode'
  document?: EditorDocument
  catalog: {
    index(): Promise<CatalogIndex>
    models(): Promise<Record<string, ModelDef>>
    component(name: string): Promise<ComponentDef | null>
  }
  project: {
    initial(): Promise<string | null>
    recent(): Promise<RecentProject[]>
    pickFolder(title: string): Promise<string | null>
    open(root: string): Promise<ProjectInfo>
    create(options: NewProjectOptions): Promise<ProjectInfo>
    rescan(root: string): Promise<ProjectInfo>
    readFile(path: string): Promise<string>
    writeFile(path: string, content: string): Promise<void>
    createRouteFile(root: string, fileName: string, content: string): Promise<RouteFileInfo>
    syncDependencies(root: string, artifactIds: string[]): Promise<DependencySyncResult>
    enableRuntimeTools(root: string): Promise<ProjectInfo>
    setRouteFormat(root: string, format: RouteFormat): Promise<ProjectInfo>
    /** Java projects: deletes generated classes not in `keep` (file names). Returns what was removed. */
    pruneGenerated(root: string, keep: string[]): Promise<string[]>
    /** Lets the user pick a file and copies it into `destDir` (relative to the project). Null when cancelled. */
    importFile(root: string, destDir: string, title: string): Promise<ImportedFile | null>
    reveal(path: string): Promise<void>
    /** Sets the project's own version in pom.xml. */
    setVersion(root: string, version: string): Promise<ProjectInfo>
    /** Lets the user pick a folder and copies the built package there. Null when cancelled. */
    copyArtifact(path: string): Promise<string | null>
  }
  git: {
    status(root: string): Promise<GitStatus>
    log(root: string): Promise<GitCommit[]>
    diff(root: string, path: string): Promise<string>
    init(root: string): Promise<void>
    /** Commits the given paths (all changes when empty). */
    commit(root: string, message: string, paths: string[]): Promise<string>
    pull(root: string): Promise<string>
    push(root: string): Promise<string>
    fetch(root: string): Promise<void>
    setRemote(root: string, url: string): Promise<void>
    setIdentity(name: string, email: string): Promise<void>
    /** Settles a conflicting file with the local version (`mine`) or the pulled one (`theirs`). */
    resolve(root: string, path: string, side: 'mine' | 'theirs'): Promise<void>
    abortMerge(root: string): Promise<void>
    /** Clones into a new folder under `parentDir`; returns that folder. */
    clone(url: string, parentDir: string): Promise<string>
    /** Git asks for a user name, password, token or SSH passphrase. */
    onAskpass(listener: (request: AskpassRequest) => void): () => void
    answerAskpass(id: number, value: string | null): Promise<void>
  }
  run: {
    toolchain(root: string | null): Promise<Toolchain>
    /** `profile` is a Spring profile (environment); omitted or `default` runs without one. */
    start(root: string, mode: RunMode, profile?: string): Promise<void>
    /** `mvn clean package`: builds the deployable JAR without Camel Studio's dev-only tools. */
    build(root: string, skipTests: boolean): Promise<void>
    stop(): Promise<void>
    onEvent(listener: (event: RunEvent) => void): () => void
  }
  runtime: {
    onEvent(listener: (event: RuntimeEvent) => void): () => void
    routeCommand(routeId: string, command: 'start' | 'stop' | 'suspend' | 'resume'): Promise<void>
    debugCommand(command: 'add' | 'remove' | 'step' | 'resume', nodeId?: string): Promise<void>
    send(request: SendRequest): Promise<SendResult>
  }
  mapper: {
    preview(request: MapperPreviewRequest): Promise<MapperPreviewResult>
  }
  testConnection(target: ConnectionTarget): Promise<ConnectionResult>
  settings: {
    get(): Promise<StudioSettings>
    /** Merges and saves; returns the stored settings. */
    update(patch: Partial<StudioSettings>): Promise<StudioSettings>
    toolchains(): Promise<ToolchainList>
    installJdk(feature: number): Promise<string>
    installMaven(): Promise<string>
    pickFile(title: string, extensions: string[]): Promise<string | null>
    pickFolder(title: string): Promise<string | null>
    camelVersions(): Promise<CamelVersionInfo[]>
    installCamel(version: string): Promise<void>
    /** Switches the catalog and reloads the window. */
    useCamel(version: string | null): Promise<void>
    importComponent(): Promise<CustomComponent | null>
    removeComponent(scheme: string): Promise<StudioSettings>
    exportProfile(): Promise<string | null>
    importProfile(): Promise<StudioSettings | null>
    onProgress(listener: (event: ProgressEvent) => void): () => void
  }
  project2: {
    /** Points pom.xml at the selected Camel version (and its Spring Boot version). */
    alignVersions(root: string): Promise<{ changed: string[] }>
  }
  openDocs(url: string): Promise<void>
}
