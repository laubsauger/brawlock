/**
 * Dev-only showcase capture page (not part of the app build). One shot per page load:
 *   npx vite --config scripts/showcase/vite.showcase.config.ts
 *   http://localhost:5341/src/render/showcase/showcase.html?mute&shot=<id>&ssaa=2
 * Driven by scripts/showcase/record.mjs through window.__showcase:
 *   ready()  -> true once renderer, warlock rig, textures, fonts and the shot are up
 *   begin()  -> switch to the virtual clock and render the pre-roll
 *   frame()  -> advance one 1/60 s video frame and render it; returns { vt, st, done }
 * Without a driver (?play) the page plays the shot in real time for preview.
 */
import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import '../../index.css'
import { useGame } from '../../game/store'
import { InkFilters } from '../../ui/InkFilters'
import { MatchView, preloadWarlock, renderStats } from '../index'
import { Director, VIDEO_FPS } from './director'
import { installCameraOverride } from './camRig'
import { ShowcaseOverlay } from './overlay'
import { SHOTS, shotById } from './shots'

interface VClock {
  engage(): void
  step(ms: number): number
  readonly on: boolean
  readonly now: number
  readonly errors: string[]
}
declare global {
  interface Window {
    __vclock: VClock
    __showcase: unknown
  }
}

const params = new URLSearchParams(location.search)
const shotId = params.get('shot') ?? SHOTS[0].id
const spec = shotById(shotId)
useGame.getState().setSettings({ quality: (params.get('q') as 'ultra' | 'high' | null) ?? 'ultra', fxIntensity: 1, showPerf: false })
installCameraOverride()

const status = { warlock: false, fonts: false, overlay: false, director: null as Director | null, began: false, error: '' }
void preloadWarlock().then(() => (status.warlock = true))
void document.fonts.ready.then(async () => {
  await Promise.all(['84px "Metal Mania"', '700 20px "Barlow Semi Condensed"', '500 20px "Barlow Semi Condensed"', '700 34px "Cinzel"'].map((f) => document.fonts.load(f).catch(() => [])))
  status.fonts = true
})

const MS = 1000 / VIDEO_FPS

function worldUp(): boolean {
  return !!(window as unknown as Record<string, unknown>).__brawlockWorld && renderStats.backend !== ''
}

window.__showcase = {
  shots: () => SHOTS.map((s) => ({ id: s.id, dur: s.dur })),
  status: () => ({ warlock: status.warlock, fonts: status.fonts, overlay: status.overlay, world: worldUp(), director: !!status.director, error: status.error, backend: renderStats.backend, tier: renderStats.tier, dpr: renderStats.dpr }),
  ready: () => status.warlock && status.fonts && status.overlay && worldUp() && !!status.director,
  info: () => ({ id: spec.id, dur: spec.dur, frames: status.director?.frames ?? 0, fps: VIDEO_FPS }),
  begin(): void {
    const d = status.director
    if (!d || status.began) return
    status.began = true
    window.__vclock.engage()
    const pre = spec.preroll ?? 12
    for (let i = 0; i < pre; i++) {
      d.advance(window.__vclock.now + MS, true)
      window.__vclock.step(MS)
    }
  },
  frame(): { vt: number; st: number; done: boolean; errors: number } {
    const d = status.director!
    d.advance(window.__vclock.now + MS)
    window.__vclock.step(MS)
    return { vt: d.vt, st: d.simT, done: d.done, errors: window.__vclock.errors.length }
  },
  errors: () => window.__vclock.errors.slice(0, 5),
  /**
   * Debug-overlay guard: every visible text / image / canvas on the page must belong to
   * the designed overlays (.sc-ov: wordmark, lower thirds, cards; .bl-ov: in-world plates
   * and combat numbers) or be the one WebGPU canvas. Anything else (perf HUD, Inspector,
   * lab captions) is reported and fails the take.
   */
  audit(): string[] {
    const bad: string[] = []
    let canvases = 0
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (el.closest('.sc-ov, .bl-ov, svg') || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      if (el.tagName === 'CANVAS') {
        canvases++
        continue
      }
      const text = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '')
      if (text || el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'IFRAME') bad.push(`${el.tagName}.${String(el.className)}: ${(el.textContent ?? '').trim().slice(0, 60)}`)
    }
    if (canvases !== 1) bad.push(`${canvases} visible canvases (expected the one WebGPU canvas)`)
    return bad
  },
  log: () => status.director?.sim.log.map((l) => [Number(l.st.toFixed(3)), l.e.type, 'spell' in l.e ? l.e.spell : 'cause' in l.e ? l.e.cause : '']) ?? [],
}

function Showcase() {
  const hostRef = useRef<HTMLDivElement>(null)
  const ovRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!hostRef.current || !ovRef.current) return
    const overlay = new ShowcaseOverlay(ovRef.current, hostRef.current)
    void overlay.ready().then(() => (status.overlay = true))
    let stopped = false
    // the director starts once the warlock rig is in (pawn views built before that stay procedural)
    const wait = setInterval(() => {
      if (stopped || !status.warlock) return
      clearInterval(wait)
      try {
        const d = new Director(spec, overlay)
        d.attach()
        status.director = d
      } catch (e) {
        status.error = String((e as Error).stack ?? e)
        console.error(e)
      }
      if (params.has('play')) {
        // real-time preview without the capture driver
        const tick = () => {
          if (stopped || !status.director) return
          const dd = status.director
          if (dd.done) return
          dd.advance(performance.now() + MS)
          setTimeout(tick, MS)
        }
        setTimeout(tick, 300)
      }
    }, 50)
    return () => {
      stopped = true
      clearInterval(wait)
      overlay.root.remove()
    }
  }, [])
  return (
    <div ref={hostRef} style={{ position: 'fixed', inset: 0 }}>
      <InkFilters />
      <MatchView />
      <div ref={ovRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
    </div>
  )
}

// no StrictMode: its double effect pass would build the world and the overlay twice
createRoot(document.getElementById('root')!).render(<Showcase />)
