// Where Camel says a step came from, for the file as Camel actually runs it.
//
// YAML projects run the route file itself, so a location is `file.camel.yaml:line`.
// Java projects run the generated class, so a location is `package.ClassName:line`.

import type { ProjectInfo } from '@shared/types'
import { lineIndex, parseRoutes, type Catalog, type LineTarget, type Path, type Problem, type Y } from './camel'
import { generateJava, javaClassName, type JavaGenResult } from './javagen'

export interface SourceIndex {
  /** Name Camel reports for this source: the file name, or the fully qualified class name. */
  name: string
  byLine: Map<number, LineTarget>
}

export const javaFqcn = (project: ProjectInfo, fileName: string): string => `${project.javaPackage}.${javaClassName(fileName)}`

export function generateFor(js: Y[], project: ProjectInfo, fileName: string, modelRel: string, catalog: Catalog): JavaGenResult {
  return generateJava(js, { packageName: project.javaPackage, className: javaClassName(fileName), modelRel }, catalog)
}

export function sourceIndex(text: string, fileName: string, project: ProjectInfo | null, catalog: Catalog): SourceIndex {
  if (project?.routeFormat === 'java') {
    const js = parseRoutes(text).js
    if (!js) return { name: '', byLine: new Map() }
    return { name: javaFqcn(project, fileName), byLine: generateFor(js, project, fileName, '', catalog).lines }
  }
  return { name: fileName, byLine: lineIndex(text, catalog) }
}

/** What the Java generator could not express, shown next to the ordinary validation problems. */
export function javaProblems(js: Y[], project: ProjectInfo, fileName: string, catalog: Catalog): Problem[] {
  return generateFor(js, project, fileName, '', catalog).warnings.map((w) => ({
    entryIndex: typeof w.path[0] === 'number' ? w.path[0] : 0,
    path: w.path as Path,
    message: `Java output: ${w.message}`
  }))
}
