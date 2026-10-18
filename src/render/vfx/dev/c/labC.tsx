/**
 * Dev-only death / after-hit VFX lab (workstream C). Not part of the app build.
 *   npx vite --port 5196 -> http://localhost:5196/src/render/vfx/dev/c/labC.html?cause=fireball
 * Params: &cause=<fireball|lava|scourge|obstacle|disconnect|<spell id>|all>  &every=5 (s per cycle)
 *         &hit (after-hit mode: damage instead of kill)  &q=low|medium|high|ultra  &fx=0..1
 *         &slow=0.3  &zoom=500..1500  &vc=<victim colour hex, e.g. ff6fb5>  &n=1..4 (victims dying together)  &cancel=0.5 (stop the killer's windup after 0.5 s)
 *         &off=<module spell ids> (unregister modules, e.g. off=scourge to see the built-in)
 *         &hidecharge (hide PawnView's built-in Scourge charge decal)  &lvl=1..3 (Scourge level)  &allcast (victims cast Scourge too)
 *         &pov=<player> (-1 spectator)  &kc=<killer colour hex>  &match8 | &match8=cb (8-bot match, standard / colourblind palette; probe __labC.fightT())
 * Console: __labC.since() = sim seconds since the victim's last death (screenshot timing),
 *          __labC.devTime.scale = 0 freezes everything (render clock too).
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../../index.css'
import { useGame, type Quality } from '../../../../game/store'
import { frame } from '../../../../game/frame'
import { MatchView, renderStats } from '../../../index'
import { cameraZoomParam } from '../../../cameraRig'
import { devTime } from '../../../stats'
import { ALL_CAUSES, labState, startDeathLab } from './deathLab'
import { matchState, startMatchLab } from './matchLab'
import { registerSpellVfx, spellVfxModules, type SpellVfx } from '../../registry'

const params = new URLSearchParams(location.search)
// &hidecharge  hide PawnView's built-in Scourge charge decal (until render gates it when a
// module claims 'scourge'): moved to layer 1, which the camera does not render
if (params.has('hidecharge')) {
  registerSpellVfx({
    spell: '__lab_hidecharge',
    frame(ctx) {
      ctx.scene.traverse((o) => {
        const m = (o as { material?: { name?: string } }).material
        if (m && m.name === 'ScourgeCharge') o.layers.set(1)
      })
    },
  })
}
// &probe  per-frame instance counts of workstream C's batches (frozen-clock accumulation check)
const probe: Record<string, number> = {}
if (params.has('probe')) {
  const names = new Set(['cast-hand-marks', 'projectile-cores', 'vfxA-cores', 'scourge-glow', 'scourge-windup', 'death-glow', 'afterhit-arcs', 'death-runes', 'death-decals-glow'])
  registerSpellVfx({
    spell: '__lab_probe',
    frame(ctx) {
      // read last frame's committed counts (this runs before the batches refill)
      ctx.scene.traverse((o) => {
        if (names.has(o.name)) probe[o.name] = (o as unknown as { count: number }).count
      })
    },
  })
}
// &off=scourge,__deaths  unregister VFX modules (A/B comparisons against the built-ins)
if (params.has('off')) {
  const off = new Set((params.get('off') ?? '').split(','))
  const mods = spellVfxModules() as SpellVfx[]
  for (let i = mods.length - 1; i >= 0; i--) if (off.has(mods[i].spell)) mods.splice(i, 1)
}
const q = params.get('q') as Quality | null
if (q) useGame.getState().setSettings({ quality: q })
if (params.has('slow')) devTime.scale = Number(params.get('slow')) || 1
if (params.has('fx')) useGame.getState().setSettings({ fxIntensity: Number(params.get('fx')) })
;(window as unknown as Record<string, unknown>).__labC = {
  devTime,
  frame,
  stats: renderStats,
  zoom: cameraZoomParam,
  state: labState,
  since: () => (labState.deathTick < 0 ? -1 : (labState.tick - labState.deathTick) / 60),
  sinceHit: () => (labState.hitTick < 0 ? -1 : (labState.tick - labState.hitTick) / 60),
  probe,
  fightT: () => matchState.fightT,
  sinceCast: () => (labState.castTick < 0 ? -1 : (labState.tick - labState.castTick) / 60),
}

function Lab() {
  const [label, setLabel] = useState('')
  const [perf, setPerf] = useState('')
  useEffect(() => {
    const c = params.get('cause') ?? 'all'
    const causes = c === 'all' ? [...ALL_CAUSES] : c.split(',')
    const vc = params.get('vc')
    // &match8[=cb]: 8 bots fighting, standard or colourblind slot palette (palette review)
    const stop = params.has('match8') ? startMatchLab({ n: Number(params.get('n') ?? 8), cb: params.get('match8') === 'cb', seed: Number(params.get('seed') ?? 7) }) : startDeathLab({ causes, castOnly: params.has('cast'), every: Number(params.get('every') ?? 5), hit: params.has('hit'), victimColor: vc ? parseInt(vc, 16) : undefined, n: Number(params.get('n') ?? 1), cancelAfter: params.has('cancel') ? Number(params.get('cancel') || 0.5) : undefined, level: Number(params.get('lvl') ?? 0) || undefined, allCast: params.has('allcast'), killerColor: params.has('kc') ? parseInt(params.get('kc') ?? '', 16) : undefined }, setLabel)
    // &pov=<player>: render from that player's view (-1 = spectator / replay)
    if (params.has('pov')) frame.localPlayer = Number(params.get('pov'))
    const t = params.has('zoom') ? setTimeout(() => (cameraZoomParam.distance = Number(params.get('zoom'))), 50) : 0
    const id = setInterval(() => {
      const s = renderStats
      setPerf(`${s.backend} ${s.tier} | ${s.fps.toFixed(0)} fps | cpu ${s.cpuMs.toFixed(2)} ms | gpu ${s.gpuMs.toFixed(2)} ms | ${s.drawCalls} draws`)
    }, 250)
    return () => {
      stop()
      clearInterval(id)
      if (t) clearTimeout(t)
    }
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0 }} onContextMenu={(e) => e.preventDefault()}>
      <MatchView />
      <div style={{ position: 'absolute', left: 8, top: 8, font: '12px ui-monospace, monospace', color: '#ffd9b0', textShadow: '0 1px 2px #000', pointerEvents: 'none' }}>
        <div id="perf">{perf}</div>
        <div id="label" style={{ fontSize: 15, marginTop: 4 }}>{label}</div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Lab />
  </StrictMode>,
)
