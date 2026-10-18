import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { COLUMNS } from './data/catalog'
import { bindLabel, slotKeyLabel, useBinds } from './lib/keys'
import { posterUrl, saveData, showClip, stopClip } from './lib/abilityMedia'
import { reducedMotion } from './lib/motion'
import { tutorial } from './lib/onboarding'
import { playOffline } from './flow'
import { Button, Kbd, Modal } from './widgets'
import { isPlaySupported, PLAY_REQUIREMENT, usePlaySupported } from './lib/playAccess'

const LESSONS = [
  { clip: 'fireball', title: 'Push them into the lava', text: 'Hits push rivals back. More accumulated knockback means a harder push. Be the last warlock standing.', short: 'Push' },
  { clip: 'teleport', title: 'Keep a way back', text: 'Right-click to move and keep clear of incoming shots. A transport spell can get you back onto solid ground.', short: 'Escape' },
  { clip: 'shield', title: 'Make their shot your opening', text: 'A well-timed Shield sends enemy projectiles back. You can dodge, defend and counterattack.', short: 'Defend' },
  { clip: 'lightning', title: 'Choose your spellbook', text: 'Between rounds, choose one spell from each column. Upgrade that choice later. Items are separate.', short: 'Build' },
] as const

function Preview({ id }: { id: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(() => !reducedMotion() && !saveData())
  useEffect(() => {
    if (!box.current || !playing) return
    showClip(box.current, id, () => setPlaying(false))
    return () => stopClip()
  }, [id, playing])
  return (
    <div className="relative">
      <div ref={box} className="ability-media tutorial-preview">
        <img src={posterUrl(id)} width={300} height={169} alt="" />
      </div>
      <button type="button" className="absolute right-2 bottom-2 rounded border border-white/15 bg-black/75 px-2 py-1 text-xs text-bone hover:bg-black focus-visible:outline-2 focus-visible:outline-gold" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>
        {playing ? 'Pause clip' : 'Play clip'}
      </button>
    </div>
  )
}

/** Opens before the first play action connects anywhere, and on demand from the menu. */
export function Tutorial() {
  const intent = useSyncExternalStore(tutorial.subscribe, tutorial.get)
  if (!intent) return null
  return <Guide key={intent.label ?? 'manual'} label={intent.label} />
}

function Guide({ label }: { label: string | null }) {
  const playSupported = usePlaySupported()
  const content = useRef<HTMLElement>(null)
  const [index, setIndex] = useState(0)
  const binds = useBinds()
  const lesson = LESSONS[index]
  const last = index === LESSONS.length - 1
  useEffect(() => {
    const dialog = content.current?.closest<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex="0"]')]
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    dialog.addEventListener('keydown', onKey)
    return () => dialog.removeEventListener('keydown', onKey)
  }, [])
  const practice = () => {
    if (!isPlaySupported()) return
    tutorial.continue()
    playOffline()
  }
  return (
    <Modal title="How to play" onClose={tutorial.dismiss} width="max-w-2xl" footer={
      <div className="flex w-full flex-wrap items-center justify-between gap-3">
        <Button size="sm" variant="ghost" disabled={!!label && !playSupported} title={label && !playSupported ? PLAY_REQUIREMENT : undefined} onClick={tutorial.continue}>{label ? 'Skip & continue' : 'Back to menu'}</Button>
        <div className="flex items-center gap-2">
          {index > 0 && <Button size="sm" onClick={() => setIndex((n) => n - 1)}>Previous</Button>}
          {last ? <Button variant="primary" disabled={!playSupported} title={!playSupported ? PLAY_REQUIREMENT : undefined} onClick={label ? tutorial.continue : practice}>{label ?? 'Practice vs bots'}</Button>
            : <Button variant="primary" onClick={() => setIndex((n) => n + 1)}>Next <span aria-hidden>→</span></Button>}
        </div>
      </div>
    }>
      <nav ref={content} className="mb-4 grid grid-cols-4 gap-2" aria-label="Tutorial lessons">
        {LESSONS.map((item, i) => <button key={item.short} type="button" aria-current={i === index ? 'step' : undefined} onClick={() => setIndex(i)} className={`rounded border px-2 py-2 text-sm font-semibold transition-colors ${i === index ? 'border-gold/60 bg-gold/10 text-gold' : 'border-white/10 text-ash hover:border-white/25 hover:text-bone'}`}>
          <span className="mr-1.5 opacity-65">{i + 1}</span>{item.short}
        </button>)}
      </nav>
      <Preview key={lesson.clip} id={lesson.clip} />
      <div className="mt-4" aria-live="polite" aria-atomic="true">
        <h3 className="font-display text-xl font-bold text-[#ffe0a9]">{lesson.title}</h3>
        <p className="mt-2 text-[1.05rem] leading-relaxed text-[#e6d3b8]">{lesson.text}</p>
      </div>
      {index === 3 ? <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="One spell per category">
        {COLUMNS.map((column) => <div key={column.name} className="rounded border px-1 py-2 text-center text-xs font-semibold" style={{ color: column.hue, borderColor: `${column.hue}50`, background: `${column.hue}12` }}>
          {column.name}<span className="mt-1 block text-bone">Choose 1</span>
        </div>)}
      </div> : <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-ash">
        <span><Kbd>Right mouse</Kbd> Move</span>
        <span><Kbd>{slotKeyLabel(binds, 6)}</Kbd> Fireball</span>
        <span><Kbd>{bindLabel(binds, 'shop')}</Kbd> Shop</span>
      </div>}
      <p className="mt-4 text-xs text-ash/80">{!playSupported && <span className="mb-1 block text-[#f3d3a1]">{PLAY_REQUIREMENT}</span>}Aim with the mouse. Your spell keys are shown on the toolbar. Reopen this guide from How to play.</p>
    </Modal>
  )
}
