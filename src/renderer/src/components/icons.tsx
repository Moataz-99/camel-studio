import {
  Activity,
  ArrowRightLeft,
  Bot,
  Boxes,
  Braces,
  Bug,
  Cable,
  CalendarClock,
  CircleStop,
  Cloud,
  Code,
  Coffee,
  Combine,
  Cpu,
  Database,
  Eraser,
  FileJson,
  FileText,
  Funnel,
  Gauge,
  GitBranch,
  GitFork,
  GitCompareArrows,
  Globe,
  HardDrive,
  Hourglass,
  Inbox,
  Layers,
  Lock,
  Mail,
  MessagesSquare,
  Network,
  Package,
  Puzzle,
  Radio,
  Repeat,
  Replace,
  ScrollText,
  Send,
  Server,
  ShieldAlert,
  ShieldCheck,
  Shuffle,
  Split,
  Table2,
  Tag,
  Timer,
  TriangleAlert,
  Variable,
  Waypoints,
  Webhook,
  Workflow,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { Category } from '@/model/camel'

const EIP_ICONS: Record<string, LucideIcon> = {
  choice: GitBranch,
  filter: Funnel,
  split: Split,
  multicast: GitFork,
  recipientList: Waypoints,
  routingSlip: Waypoints,
  dynamicRouter: Shuffle,
  loadBalance: Shuffle,
  aggregate: Combine,
  resequence: Layers,
  loop: Repeat,
  delay: Hourglass,
  throttle: Gauge,
  stop: CircleStop,
  threads: Cpu,
  log: ScrollText,
  bean: Coffee,
  process: Code,
  script: Code,
  setBody: Replace,
  transform: Replace,
  setHeader: Tag,
  setProperty: Tag,
  setVariable: Variable,
  removeHeader: Eraser,
  removeHeaders: Eraser,
  removeProperty: Eraser,
  removeProperties: Eraser,
  removeVariable: Eraser,
  marshal: FileJson,
  unmarshal: Braces,
  convertBodyTo: ArrowRightLeft,
  validate: ShieldCheck,
  doTry: ShieldAlert,
  circuitBreaker: Zap,
  throwException: TriangleAlert,
  rollback: TriangleAlert,
  onException: Bug,
  wireTap: Radio,
  enrich: Puzzle,
  pollEnrich: Puzzle,
  poll: Inbox,
  to: Send,
  toD: Send,
  kamelet: Package,
  idempotentConsumer: ShieldCheck,
  saga: Workflow,
  step: Boxes,
  pipeline: Workflow
}

/** Component catalog labels, most specific first. */
const LABEL_ICONS: [string, LucideIcon][] = [
  ['scheduling', Timer],
  ['messaging', MessagesSquare],
  ['database', Database],
  ['file', FileText],
  ['mail', Mail],
  ['http', Globe],
  ['rest', Globe],
  ['webservice', Globe],
  ['api', Webhook],
  ['ai', Bot],
  ['security', Lock],
  ['monitoring', Activity],
  ['cache', HardDrive],
  ['search', Table2],
  ['iot', Cpu],
  ['networking', Network],
  ['container', Boxes],
  ['clustering', Server],
  ['cloud', Cloud],
  ['transformation', Replace],
  ['validation', ShieldCheck],
  ['script', Code],
  ['core', Cable]
]

const SCHEME_ICONS: Record<string, LucideIcon> = {
  timer: Timer,
  quartz: CalendarClock,
  cron: CalendarClock,
  scheduler: CalendarClock,
  direct: Cable,
  seda: Cable,
  log: ScrollText,
  bean: Coffee,
  kafka: MessagesSquare
}

const CATEGORY_ICONS: Record<Category, LucideIcon> = {
  source: Inbox,
  endpoint: Send,
  routing: GitBranch,
  transform: Replace,
  error: ShieldAlert,
  flow: Hourglass,
  util: Code
}

export function componentIcon(scheme: string, label: string | null): LucideIcon {
  if (SCHEME_ICONS[scheme]) return SCHEME_ICONS[scheme]
  const labels = (label ?? '').split(',')
  return LABEL_ICONS.find(([l]) => labels.includes(l))?.[1] ?? Cable
}

export function stepIcon(kind: string, category: Category, scheme: string | null, componentLabel: string | null, title?: string): LucideIcon {
  if (kind === 'camel-studio-datamapper' || title === 'Data Mapper') return GitCompareArrows
  if (scheme !== null && (componentLabel !== null || SCHEME_ICONS[scheme])) return componentIcon(scheme, componentLabel)
  return EIP_ICONS[kind] ?? CATEGORY_ICONS[category]
}

export const CATEGORY_NAMES: Record<Category, string> = {
  source: 'Trigger',
  endpoint: 'Endpoints',
  routing: 'Routing',
  transform: 'Transformation',
  error: 'Error handling',
  flow: 'Flow control',
  util: 'Utility'
}
