import { useEffect } from 'react'
import { usedSchemes } from '@/model/camel'
import { useActiveFile, useStudio } from '@/store'
import { Canvas } from './components/Canvas'
import { BottomPanel, StatusBar, TitleBar, ToastHost, Welcome } from './components/Chrome'
import { Inspector } from './components/Inspector'
import { Explorer, Palette } from './components/Sidebar'
import { SourceEditor } from './components/SourceEditor'
import { cx, isTyping } from './components/util'
import { MapperView } from './mapper/Mapper'
import { GlobalVarsView } from './config/GlobalVars'
import { AdminView } from './settings/Admin'
import { AskpassDialog } from './components/Git'
import { BuildDialog, BuiltDialog } from './components/Build'
import { useMapper } from './mapper/store'
import { clearSubtree } from './mapper/model'
import { indexFields } from './mapper/schema'

export function App(): React.JSX.Element {
  const ready = useStudio((s) => s.ready)
  const project = useStudio((s) => s.project)
  const view = useStudio((s) => s.view)
  const theme = useStudio((s) => s.theme)
  const file = useActiveFile()

  useEffect(() => {
    void useStudio.getState().init()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // Load the full option list of every component the open file uses.
  useEffect(() => {
    if (file?.js) usedSchemes(file.js).forEach((s) => void useStudio.getState().loadComponent(s))
  }, [file?.js])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStudio.getState()
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 's') {
        e.preventDefault()
        // Commit the field being edited before saving.
        ;(document.activeElement as HTMLElement | null)?.blur?.()
        void s.save()
        return
      }
      if (mod && key === 'j') {
        e.preventDefault()
        s.setBottom(!s.bottomOpen)
        return
      }
      if (e.key === 'Escape' && s.quickAdd) {
        s.openQuickAdd(null)
        return
      }
      if ((e.key === 'F8' || e.key === 'F10') && (s.debug?.suspended.length ?? 0) > 0) {
        e.preventDefault()
        if (e.key === 'F8') s.debugResume()
        else s.debugStep()
        return
      }
      if (isTyping(e.target)) return
      const m = useMapper.getState()
      if (m.name) {
        // The Data Mapper covers the route editor: its own undo, delete and escape apply.
        if (mod && key === 'z') {
          e.preventDefault()
          if (e.shiftKey) m.redo()
          else m.undo()
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && m.selected && m.target) {
          e.preventDefault()
          const field = indexFields(m.target.root).get(m.selected)
          if (field) m.change((d) => clearSubtree(d, field))
        } else if (e.key === 'Escape') {
          m.select(null)
          m.selectSource(null)
        }
        return
      }
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if (mod && key === 'y') {
        e.preventDefault()
        s.redo()
      } else if (mod && (key === 'c' || key === 'x') && s.selection?.kind === 'step' && typeof s.selection.path[s.selection.path.length - 1] === 'number') {
        e.preventDefault()
        void s.copySteps(s.selection.path, key === 'x')
      } else if (mod && key === 'v' && s.selection?.kind === 'step') {
        e.preventDefault()
        void s.pasteAfter(s.selection.path)
      } else if (mod && key === 'd' && s.selection?.kind === 'step') {
        e.preventDefault()
        s.duplicateStep(s.selection.path)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selection?.kind === 'step') {
        e.preventDefault()
        s.removeStep(s.selection.path)
      } else if (e.key === 'Escape') {
        s.select(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ready) return <div className="boot" />
  if (!project) {
    return (
      <>
        <Welcome />
        <AdminView />
        <AskpassDialog />
        <ToastHost />
      </>
    )
  }

  const effectiveView = file?.language === 'java' ? 'source' : view
  return (
    <div className={cx('app', window.studio.host === 'vscode' && 'is-vscode')}>
      <TitleBar />
      <div className="workbench">
        <div className="sidebar">
          <Explorer />
          <Palette />
        </div>
        <main className="main-col">
          <div className={cx('editors', `view-${effectiveView}`)}>
            {effectiveView !== 'source' && <Canvas />}
            {effectiveView !== 'design' && <SourceEditor />}
          </div>
          <BottomPanel />
        </main>
        {effectiveView !== 'source' && <Inspector />}
        <MapperView />
        <GlobalVarsView />
      </div>
      <StatusBar />
      <AdminView />
      <BuildDialog />
      <BuiltDialog />
      <AskpassDialog />
      <ToastHost />
    </div>
  )
}
