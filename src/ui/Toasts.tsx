import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useGame } from '../game/store'
import { getBuildUpdate, onBuildUpdate, reloadLatestBuild } from '../lib/staleBuild'
import { onToast, type ToastTone } from './lib/toast'
import { WarnGlyph } from './hud/ConnIndicator'
import { Button } from './widgets'

function BuildUpdateNotice() {
  const available = useSyncExternalStore(onBuildUpdate, getBuildUpdate, () => false)
  const screen = useGame((s) => s.screen)
  const dialog = useRef<HTMLDialogElement>(null)
  const blocked = available && screen !== 'match' && screen !== 'boot'
  useEffect(() => {
    if (blocked && !dialog.current?.open) dialog.current?.showModal()
  }, [blocked])
  if (!blocked) return null
  return <dialog ref={dialog} aria-labelledby="build-update-title" aria-describedby="build-update-description" aria-modal="true" data-testid="build-update-required"
    className="panel panel-solid pointer-events-auto fixed inset-0 m-auto w-[min(32rem,calc(100vw-2rem))] [--panel-outline:#ffc54899] p-8 text-center text-bone shadow-2xl backdrop:bg-obsidian/90"
    onCancel={(event) => event.preventDefault()} onKeyDown={(event) => event.stopPropagation()}>
    <p className="mb-3 text-sm font-bold tracking-widest text-gold uppercase">Game updated</p>
    <h2 id="build-update-title" className="display text-4xl text-[#ffd890]">Reload to play</h2>
    <p id="build-update-description" className="mt-4 mb-6 text-base leading-relaxed">A new version of Brawlock is ready. Reload the game to update before joining or starting another game.</p>
    <Button size="lg" variant="primary" className="w-full" autoFocus onClick={reloadLatestBuild}>Reload game</Button>
  </dialog>
}

/** Short confirmations under the top HUD strip (below the score pills); newest replaces the last. */
export function Toasts() {
  const [msg, setMsg] = useState<{ text: string; tone: ToastTone; key: number } | null>(null)
  useEffect(() => {
    let n = 0
    let timer = 0
    const off = onToast((text, tone) => {
      setMsg({ text, tone, key: ++n })
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setMsg(null), tone === 'warn' ? 5000 : 3200)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [])
  return <>
    <BuildUpdateNotice />
    {msg && (
    <div className="pointer-events-none fixed top-[124px] right-0 left-0 z-[70] flex justify-center px-4" role="status" aria-live="polite">
      <div
        key={msg.key}
        className={`toast pop-in ink-sm flex max-w-xl items-center gap-2 rounded-md px-4 py-2 text-center text-[0.98rem] font-semibold ${msg.tone === 'warn' ? 'toast-warn text-[#ffd9c7]' : 'text-[#ffe6bf]'}`}
      >
        {msg.tone === 'warn' && <WarnGlyph />}
        {msg.text}
      </div>
    </div>
  )}
  </>
}
