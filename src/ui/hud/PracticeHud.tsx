import { useEffect } from 'react'
import { castModeFor } from '../../game/input'
import { usePractice } from '../../game/practiceState'
import { PRACTICE_STEPS, TELEPORT_SLOT, type PracticeStep } from '../../game/practiceScenario'
import { useGame } from '../../game/store'
import { FIREBALL_SLOT } from '../../sim'
import { leaveToMenu, playBotPractice } from '../flow'
import { bindLabel, slotKeyLabel, useBinds } from '../lib/keys'
import { music, sfx } from '../lib/sound'
import { Button, Kbd } from '../widgets'
import { InnateRow, ItemRow, SpellRow } from './SpellBar'

const TITLES: Record<PracticeStep, string> = {
  move: 'Walk to the gold ring', fireball: 'Hit the training dummy', shop: 'Buy your escape spell',
  teleport: 'Teleport to the gold ring', lava: 'Push the dummy into lava', complete: 'You’re ready for the arena',
}
const CHECKS = ['Move', 'Hit with Fireball', 'Buy Teleport', 'Use Teleport', 'Lava knockout']

export function PracticeHud() {
  const view = usePractice((s) => s.view)
  const binds = useBinds()
  useGame((s) => s.settings.castMode)
  useGame((s) => s.settings.castModeSlots)
  const phase = view?.step
  useEffect(() => {
    if (!phase) return
    music('menu')
    if (phase !== 'move') sfx('ready')
  }, [phase])
  if (!view) return null
  const current = view.step === 'complete' ? PRACTICE_STEPS.length : PRACTICE_STEPS.indexOf(view.step)
  const teleport = view.step === 'teleport'
  const slot = teleport ? TELEPORT_SLOT : FIREBALL_SLOT
  const key = slotKeyLabel(binds, slot)
  const mode = castModeFor(slot, teleport ? 'teleport' : 'fireball')
  const cast = mode === 'normal' ? <>Press <Kbd>{key}</Kbd>, then left-click</>
    : mode === 'release' ? <>Hold <Kbd>{key}</Kbd>, aim, then release over</>
      : <>Aim at</>
  const at = teleport ? 'the gold ring' : 'the dummy'
  return <div className="hud pointer-events-none select-none">
    <section data-testid="guided-practice" className="hud-plate interactive pointer-events-auto absolute top-4 left-4 z-20 w-[min(340px,calc(100vw-32px))] rounded-md p-4" aria-label="Guided practice">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-ash"><span className="font-bold tracking-wider text-gold uppercase">Guided practice</span><span>{Math.min(current + 1, 5)} / 5</span></div>
      <h2 className="font-display text-2xl font-bold text-[#ffe0a9]" aria-live="polite">{TITLES[view.step]}</h2>
      <div className="mt-2 min-h-14 text-sm leading-relaxed text-bone">
        {view.step === 'move' ? <><Kbd>Right mouse</Kbd> on the gold ring to walk there. Aim your spells with the mouse.</>
          : view.step === 'shop' ? <>Choose <strong>Teleport</strong> in the <strong>Transport</strong> column. This shop has no timer. You’ll choose one spell from each column in a real match.</>
            : view.step === 'complete' ? <>You’ve moved, cast, shopped and escaped. Try a gentle match against two bots, or return to the menu.</>
              : <>{cast} {at}{mode === 'quick' ? <>, then press <Kbd>{key}</Kbd></> : null}.{view.step === 'lava' && ' Hits push enemies back. Send this dummy over the edge.'}</>}
      </div>
      {view.retries > 0 && <p className="mt-2 text-xs text-[#ffc69a]">Lava burns! You’re back on solid ground. Keep going.</p>}
      <ol className="my-3 space-y-1 text-sm" aria-label="Practice checklist">{CHECKS.map((title, i) => <li key={title} className={i < current ? 'text-[#a5d6ce]' : i === current ? 'font-semibold text-bone' : 'text-ash/65'} aria-current={i === current ? 'step' : undefined}>
        <span className="mr-2 inline-block w-4" aria-hidden>{i < current ? '✓' : i === current ? '›' : '○'}</span>{title}{i < current && <span className="sr-only"> complete</span>}
      </li>)}</ol>
      {view.step === 'shop' && <Button size="sm" variant="primary" className="mb-2 w-full" onClick={() => useGame.getState().toggle('shopOpen', true)}>Open shop <Kbd>{bindLabel(binds, 'shop')}</Kbd></Button>}
      {view.step === 'complete' && <Button variant="primary" className="mb-2 w-full" onClick={playBotPractice}>Play a bot match</Button>}
      <Button size="sm" variant="ghost" className="w-full" sound="back" onClick={leaveToMenu}>{view.step === 'complete' ? 'Back to menu' : 'Leave practice'}</Button>
      <p className="mt-2 text-[0.7rem] text-ash/80">Offline · no stakes · short practice cooldowns · Esc to pause</p>
    </section>
    <div className="absolute right-0 bottom-0 left-0 flex justify-center"><div className="hud-scale"><div className="hud-plate hud-bottom"><InnateRow /><SpellRow /><ItemRow /></div></div></div>
  </div>
}
