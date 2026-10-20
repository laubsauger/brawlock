/**
 * Replay entry points for the UI: which matches have a replay, watch, export / import a
 * `.brawlock` file, and leave the viewer back to where it was opened from.
 */
import { useEffect, useState } from 'react'
import { useGame, type Screen } from '../../game/store'
import { REPLAY_EXT } from '../../game/replay/format'
import { replays } from '../../game/replay/store'
import { replayViewer } from '../../game/replay/viewer'
import { toast } from './toast'
import { session } from '../../game/session'

let returnTo: Screen = 'menu'

/** Ids of every stored replay (refreshes when the library changes). */
export function useReplayIds(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    let live = true
    const load = () =>
      void replays.list().then((list) => {
        if (live) setIds(new Set(list.map((m) => m.id)))
      })
    load()
    const off = replays.onChange(load)
    return () => {
      live = false
      off()
    }
  }, [])
  return ids
}

/** Open the viewer on a stored replay. */
export async function watchReplay(id: string): Promise<void> {
  if (session.isActive()) {
    toast('Leave your current room before watching a replay.', 'warn')
    return
  }
  const g = useGame.getState()
  returnTo = g.screen === 'replay' ? returnTo : g.screen === 'results' ? 'results' : 'menu'
  g.setScreen('replay')
  const status = await replayViewer.open(id)
  if (status === 'missing') toast('That replay is no longer stored.', 'warn')
  // "Watch replay" means watch: start playing right away (Space pauses)
  if (status === 'ready') replayViewer.play()
}

/** Leave the viewer. */
export function exitReplay(): void {
  replayViewer.close()
  useGame.getState().setScreen(returnTo)
}

/** Download a stored replay as a `.brawlock` file. */
export async function exportReplay(id: string): Promise<void> {
  const file = await replays.exportFile(id)
  if (!file) {
    toast('That replay is no longer stored.', 'warn')
    return
  }
  const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** Import a shared `.brawlock` file and start watching it. */
export async function importReplay(file: File): Promise<void> {
  const meta = await replays.importFile(new Uint8Array(await file.arrayBuffer()))
  if (!meta) {
    toast(`That file is not a Brawlock replay (${REPLAY_EXT}).`, 'warn')
    return
  }
  toast('Replay imported and kept in your library.', 'info')
  await watchReplay(meta.id)
}
