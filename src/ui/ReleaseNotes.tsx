import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useGame } from '../game/store'
import { getBuildUpdate, onBuildUpdate } from '../lib/buildVersion'
import type { ReleaseNotes } from '../../scripts/release-version.mjs'
import { currentRelease, readSeenRelease, releaseNotes, rememberRelease, shouldAnnounceRelease, useReleaseNotes } from './lib/releaseNotes'
import { Button, Modal } from './widgets'

const date = (value: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value))

export function ReleaseNotesButton({ compact = false }: { compact?: boolean }) {
  return <Button size={compact ? 'sm' : 'md'} className="gap-2 border-gold/50 text-[#ffd890]" onClick={useReleaseNotes.getState().show} data-testid="open-release-notes">
    <span className="btn-label">What’s new</span>
    <span className="font-ui text-xs tracking-normal text-bone">v{currentRelease.version}</span>
  </Button>
}

function Entry({ release }: { release: ReleaseNotes }) {
  return <article aria-label={`Release v${release.version}`}>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="font-semibold text-gold">v{release.version}</span>
      <time className="text-sm text-ash" dateTime={release.releaseDate}>{date(release.releaseDate)}</time>
    </div>
    <h3 className="mb-3 text-lg font-semibold text-bone">{release.title}</h3>
    <ul className="ml-5 list-disc space-y-2 text-[0.98rem] leading-relaxed text-[#dfcdb9] marker:text-gold">{release.changes.map((change) => <li key={change}>{change}</li>)}</ul>
  </article>
}

export function ReleaseNotesContent() {
  return <>
    <Entry release={currentRelease} />
    {releaseNotes.length > 1 && <details className="mt-6 border-t border-gold/20 pt-4" data-testid="older-release-notes">
      <summary className="cursor-pointer rounded py-2 font-semibold text-gold focus-visible:outline-2 focus-visible:outline-gold">Earlier releases <span className="text-sm font-normal text-ash">({releaseNotes.length - 1})</span></summary>
      <div className="mt-3 flex flex-col gap-5">{releaseNotes.slice(1).map((release) => <details key={release.version} className="rounded border border-white/10 bg-black/20 p-3">
        <summary className="cursor-pointer rounded text-sm font-semibold text-bone focus-visible:outline-2 focus-visible:outline-gold">v{release.version} · {release.title}</summary>
        <div className="mt-4"><Entry release={release} /></div>
      </details>)}</div>
    </details>}
  </>
}

/** Persistent at App level: never interrupts first visits, lobby entry or combat. */
export function ReleaseNotesDialog() {
  const screen = useGame((state) => state.screen)
  const settingsOpen = useGame((state) => state.settingsOpen)
  const roomBusy = useGame((state) => state.lobby.status === 'connecting' || (state.lobby.status === 'open' && state.lobby.role !== 'offline'))
  const updateRequired = useSyncExternalStore(onBuildUpdate, getBuildUpdate, () => false)
  const requested = useReleaseNotes((state) => state.open)
  const [seen, setSeen] = useState(readSeenRelease)
  const [automatic, setAutomatic] = useState(false)
  useEffect(() => {
    if (seen !== null) return
    rememberRelease(currentRelease.version)
    setSeen(currentRelease.version)
  }, [seen])
  useEffect(() => {
    useReleaseNotes.getState().hide()
    setAutomatic(false)
  }, [screen])
  useEffect(() => {
    if (screen !== 'menu' || roomBusy || settingsOpen || updateRequired || !shouldAnnounceRelease(seen)) return
    // Let the entrance splash fade before presenting a returning player's update.
    const timer = window.setTimeout(() => setAutomatic(true), 850)
    return () => window.clearTimeout(timer)
  }, [screen, roomBusy, settingsOpen, updateRequired, seen])
  const close = () => {
    rememberRelease(currentRelease.version)
    setSeen(currentRelease.version)
    setAutomatic(false)
    useReleaseNotes.getState().hide()
  }
  if (updateRequired || settingsOpen || (!requested && !(automatic && screen === 'menu' && !roomBusy))) return null
  return createPortal(<Modal title="What’s new" onClose={close} width="max-w-2xl" footer={<Button variant="primary" className="w-full sm:w-auto" onClick={close}>Got it · v{currentRelease.version}</Button>}>
    <p className="mb-4 text-sm text-ash">You’re playing Brawlock v{currentRelease.version}.</p>
    <ReleaseNotesContent />
  </Modal>, document.body)
}
