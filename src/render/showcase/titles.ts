/**
 * Trailer title layer: kinetic type, spell tags, flashes, the splash intro and the end card,
 * drawn on a transparent 1920x1080 page and captured with alpha by scripts/showcase/titles.mjs.
 * Every motion is a function of the edit clock `t` (no CSS animations), so a capture is exact.
 *
 *   window.__titles.load(spec); window.__titles.render(t)
 *
 * Typography follows the game: Metal Mania words, Cinzel display caps, Barlow Semi Condensed
 * kickers with the shop's diamond bullets, glyph-following ink halos (as ui/InkFilters).
 */
import splashUrl from '../../../art/brand/splash.png'
import { SPELLS } from '../../sim/spells/data'
import { COLUMNS } from '../../ui/data/catalog'
import { clamp01, ease, easeOut, lerp } from './cam'
import { accentCss } from './overlay'

export type TitleEvent =
  /** opaque splash art; the wordmark lands at `mark`, a flash at `out`, gone at `until` */
  | { kind: 'brand'; at: number; mark: number; out: number; until: number }
  /** a big word slammed in on a beat */
  | { kind: 'slam'; at: number; until: number; text: string; sub?: string; subAt?: number; size?: number; y?: number; hue?: 'ember' | 'gold' | 'bone' }
  /** spell name tag, bottom left: column kicker + name */
  | { kind: 'tag'; at: number; until: number; spell: string }
  | { kind: 'flash'; at: number; dur: number; peak?: number; color?: 'ember' | 'white' }
  /** black overlay from `from` to `to` opacity */
  | { kind: 'fade'; at: number; until: number; from: number; to: number }
  | { kind: 'vignette'; at: number; until: number; strength?: number }
  | { kind: 'end'; at: number; until: number; line1: string; line2?: string; line3?: string }

export interface TitleSpec {
  dur: number
  events: TitleEvent[]
}

const LOGO = '/brand/wordmark.webp'

const INK = [
  { id: 'ink-sm', dilate: 1, blur: 1.6, opacity: 0.92 },
  { id: 'ink-md', dilate: 2, blur: 3.5, opacity: 0.88 },
  { id: 'ink-lg', dilate: 4, blur: 9, opacity: 0.8 },
  { id: 'ink-xl', dilate: 8, blur: 14, opacity: 0.94 },
]

const CSS = `
.tt{position:absolute;inset:0;overflow:hidden;pointer-events:none;font-family:"Barlow Semi Condensed",system-ui,sans-serif;color:#f2e4cf;-webkit-font-smoothing:antialiased}
.tt>*{position:absolute;display:none}
.tt-fill{inset:0}
.tt-slam{left:0;right:0;top:0;bottom:0;flex-direction:column;align-items:center;justify-content:center}
.tt-wordw{position:relative;will-change:transform,opacity}
.tt-word{font-family:"Metal Mania","Cinzel",serif;line-height:1;white-space:nowrap;letter-spacing:.03em;text-transform:uppercase;-webkit-background-clip:text;background-clip:text;color:transparent;padding:0 .2em;filter:url(#ink-xl) drop-shadow(0 0 34px rgba(255,110,30,.55))}
.tt-hot{position:absolute;inset:0;filter:drop-shadow(0 0 60px rgba(255,180,90,.9));will-change:opacity}
.tt-sub{will-change:transform,opacity;margin-top:18px;display:flex;align-items:center;gap:16px;font-weight:700;font-size:30px;letter-spacing:.42em;text-transform:uppercase;color:#f6e3c6;filter:url(#ink-md);white-space:nowrap}
.tt-sub i,.tt-kick i{display:inline-block;width:10px;height:10px;transform:rotate(45deg);background:currentColor;box-shadow:0 0 10px currentColor}
.tt-tag{left:84px;bottom:86px}
.tt-tag>*{will-change:transform,opacity}
.tt-kick{display:flex;align-items:center;gap:12px;font-weight:700;font-size:20px;letter-spacing:.34em;text-transform:uppercase;filter:url(#ink-sm);white-space:nowrap}
.tt-name{font-family:"Metal Mania","Cinzel",serif;font-size:78px;line-height:1;margin-top:4px;white-space:nowrap;text-shadow:0 3px 0 rgba(20,6,2,.9)}
.tt-rule{height:3px;width:380px;margin-top:10px;border-radius:2px;transform-origin:0 50%}
.tt-brand{inset:0;background:#000;overflow:hidden}
.tt-brand-art{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:50% 46%;will-change:transform}
.tt-brand-dim{position:absolute;inset:0;background:#000;will-change:opacity}
.tt-brand-glow{position:absolute;left:50%;top:22%;width:1500px;height:520px;margin:-260px 0 0 -750px;background:radial-gradient(ellipse at 50% 50%,rgba(255,150,50,.55) 0%,rgba(255,90,20,.22) 40%,rgba(0,0,0,0) 70%);will-change:opacity}
.tt-brand-shade{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 55%,rgba(0,0,0,0) 38%,rgba(4,2,1,.55) 100%),linear-gradient(180deg,rgba(3,2,6,.55) 0%,rgba(3,2,6,.12) 34%,rgba(0,0,0,0) 55%)}
.tt-brand-mark{position:absolute;left:50%;top:22%;width:1040px;will-change:transform,opacity;filter:drop-shadow(0 6px 26px rgba(0,0,0,.85)) drop-shadow(0 0 50px rgba(255,120,40,.45))}
.tt-end{inset:0;flex-direction:column;align-items:center;justify-content:center}
.tt-end-bg{position:absolute;inset:0;will-change:opacity;background:radial-gradient(ellipse at 50% 46%,rgba(30,10,4,.35) 0%,rgba(6,3,2,.86) 60%,#050202 100%)}
.tt-end img{position:relative;width:1000px;will-change:transform,opacity;filter:drop-shadow(0 6px 24px rgba(0,0,0,.8)) drop-shadow(0 0 60px rgba(255,100,30,.4))}
.tt-end-glow{position:absolute;left:50%;top:50%;width:1500px;height:560px;margin:-400px 0 0 -750px;background:radial-gradient(ellipse at 50% 50%,rgba(255,140,50,.5) 0%,rgba(255,90,20,.2) 40%,rgba(0,0,0,0) 70%);will-change:opacity}
.tt-end>div{will-change:transform,opacity}
.tt-end-l1{position:relative;margin-top:30px;font-family:"Cinzel",serif;font-weight:700;font-size:40px;letter-spacing:.2em;color:#ffe2b8;filter:url(#ink-lg);text-transform:uppercase}
.tt-end-l2{position:relative;margin-top:18px;font-weight:600;font-size:28px;letter-spacing:.16em;color:#ffc548;filter:url(#ink-md)}
.tt-end-l3{position:relative;margin-top:34px;display:flex;align-items:center;gap:16px;font-weight:700;font-size:20px;letter-spacing:.42em;text-transform:uppercase;color:#c9b39a}
.tt-end-l3 i{display:inline-block;width:8px;height:8px;transform:rotate(45deg);background:#ff7a2a;box-shadow:0 0 8px #ff7a2a}
`

const FILLS = {
  ember: 'linear-gradient(180deg,#fff6dc 0%,#ffd58a 34%,#ff8a2e 64%,#c2380c 100%)',
  gold: 'linear-gradient(180deg,#fffaf0 0%,#ffe6a8 40%,#ffc548 70%,#a8620c 100%)',
  bone: 'linear-gradient(180deg,#ffffff 0%,#f6e3c6 55%,#c9a77c 100%)',
}

function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag)
  e.className = cls
  parent.appendChild(e)
  return e
}

function show(e: HTMLElement, on: boolean, display = 'block'): boolean {
  e.style.display = on ? display : 'none'
  return on
}

type Draw = (t: number) => void

function slam(root: HTMLElement, e: Extract<TitleEvent, { kind: 'slam' }>): Draw {
  // per frame only transforms and opacities change: the ink-filtered glyphs raster once
  const box = el('div', 'tt-slam', root)
  const wrap = el('div', 'tt-wordw', box)
  const word = el('div', 'tt-word', wrap)
  word.textContent = e.text
  word.style.fontSize = `${e.size ?? 200}px`
  word.style.backgroundImage = FILLS[e.hue ?? 'ember']
  const hot = el('div', 'tt-word tt-hot', wrap)
  hot.textContent = e.text
  hot.style.fontSize = `${e.size ?? 200}px`
  hot.style.backgroundImage = 'linear-gradient(180deg,#ffffff 0%,#fff4dc 60%,#ffd08a 100%)'
  let sub: HTMLElement | null = null
  if (e.sub) {
    sub = el('div', 'tt-sub', box)
    el('i', '', sub)
    el('span', '', sub).textContent = e.sub
    el('i', '', sub)
  }
  box.style.transform = `translateY(${e.y ?? 0}px)`
  return (t) => {
    if (!show(box, t >= e.at && t < e.until, 'flex')) return
    const k = easeOut(clamp01((t - e.at) / 0.12))
    const out = clamp01((t - (e.until - 0.1)) / 0.1)
    const life = clamp01((t - e.at) / Math.max(0.1, e.until - e.at))
    const land = e.at + 0.1
    const hit = t >= land ? Math.max(0, 1 - (t - land) / 0.4) : 0
    const shake = hit * 8
    const sx = Math.sin(t * 97.3) * shake
    const sy = Math.cos(t * 83.1) * shake * 0.7
    const scale = lerp(1.7, 1, k) * (1 + 0.04 * life) * (1 + 0.14 * out)
    wrap.style.transform = `translate(${sx.toFixed(2)}px, ${sy.toFixed(2)}px) scale(${scale.toFixed(4)})`
    wrap.style.opacity = String((clamp01((t - e.at) / 0.05) * (1 - out)).toFixed(3))
    hot.style.opacity = String((t < land ? 0.85 : hit * hit * 0.85).toFixed(3))
    if (sub) {
      const ks = easeOut(clamp01((t - (e.subAt ?? e.at + 0.18)) / 0.25))
      sub.style.opacity = String((ks * (1 - out)).toFixed(3))
      sub.style.transform = `translateY(${((1 - ks) * 14).toFixed(2)}px)`
    }
  }
}

function tag(root: HTMLElement, e: Extract<TitleEvent, { kind: 'tag' }>): Draw {
  const def = SPELLS[e.spell]
  const col = def && def.kind === 'spell' && e.spell !== 'fireball' && e.spell !== 'scourge' ? COLUMNS[def.column - 1] : null
  const acc = accentCss(e.spell)
  const box = el('div', 'tt-tag', root)
  const kick = el('div', 'tt-kick', box)
  el('i', '', kick)
  el('span', '', kick).textContent = col ? col.name : 'Starting kit'
  kick.style.color = col ? col.hue : '#e9d3b0'
  const name = el('div', 'tt-name', box)
  name.textContent = def?.name ?? e.spell
  name.style.color = acc.text
  name.style.filter = `url(#ink-lg) drop-shadow(0 0 18px ${acc.glow}99)`
  const rule = el('div', 'tt-rule', box)
  rule.style.background = `linear-gradient(90deg, ${acc.text}, ${acc.glow}66 55%, transparent)`
  rule.style.boxShadow = `0 0 12px ${acc.glow}`
  return (t) => {
    if (!show(box, t >= e.at && t < e.until)) return
    const k1 = easeOut(clamp01((t - e.at) / 0.16))
    const k2 = easeOut(clamp01((t - e.at - 0.04) / 0.18))
    const out = ease(clamp01((t - (e.until - 0.1)) / 0.1))
    kick.style.opacity = String(k1 * (1 - out))
    kick.style.transform = `translateX(${((1 - k1) * -28).toFixed(2)}px)`
    name.style.opacity = String(k2 * (1 - out))
    name.style.transform = `translateX(${((1 - k2) * -46).toFixed(2)}px)`
    rule.style.transform = `scaleX(${k2.toFixed(4)})`
    rule.style.opacity = String(1 - out)
  }
}

function flash(root: HTMLElement, e: Extract<TitleEvent, { kind: 'flash' }>): Draw {
  const d = el('div', 'tt-fill', root)
  d.style.background =
    e.color === 'white'
      ? 'radial-gradient(ellipse at 50% 45%,#ffffff 0%,#fff2dc 45%,rgba(255,226,184,.85) 100%)'
      : 'radial-gradient(ellipse at 50% 42%,#fff0d0 0%,#ffb050 30%,rgba(255,96,24,.85) 62%,rgba(90,18,4,.7) 100%)'
  return (t) => {
    const p = (t - e.at) / e.dur
    if (!show(d, p >= 0 && p < 1)) return
    d.style.opacity = String(((e.peak ?? 0.85) * (1 - p) * (1 - p)).toFixed(3))
  }
}

function fade(root: HTMLElement, e: Extract<TitleEvent, { kind: 'fade' }>): Draw {
  const d = el('div', 'tt-fill', root)
  d.style.background = '#000'
  return (t) => {
    if (!show(d, t >= e.at && t < e.until)) return
    d.style.opacity = String(lerp(e.from, e.to, ease((t - e.at) / Math.max(0.01, e.until - e.at))).toFixed(3))
  }
}

function vignette(root: HTMLElement, e: Extract<TitleEvent, { kind: 'vignette' }>): Draw {
  const d = el('div', 'tt-fill', root)
  d.style.background = `radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 52%,rgba(6,2,1,${e.strength ?? 0.42}) 100%)`
  return (t) => void show(d, t >= e.at && t < e.until)
}

function brand(root: HTMLElement, e: Extract<TitleEvent, { kind: 'brand' }>, imgs: HTMLImageElement[]): Draw {
  const box = el('div', 'tt-brand', root)
  const art = el('img', 'tt-brand-art', box) as HTMLImageElement
  art.src = splashUrl
  el('div', 'tt-brand-shade', box)
  const dim = el('div', 'tt-brand-dim', box)
  const glow = el('div', 'tt-brand-glow', box)
  const mark = el('img', 'tt-brand-mark', box) as HTMLImageElement
  mark.src = LOGO
  imgs.push(art, mark)
  return (t) => {
    if (!show(box, t >= e.at && t < e.until)) return
    const life = (t - e.at) / Math.max(0.1, e.until - e.at)
    art.style.transform = `scale(${(1 + 0.08 * ease(life)).toFixed(4)})`
    dim.style.opacity = String((0.2 * (1 - easeOut(clamp01((t - e.at) / 1.0)))).toFixed(3))
    const km = easeOut(clamp01((t - e.mark) / 0.3))
    const pulse = Math.max(0, 1 - Math.abs(t - e.mark - 0.3) / 0.6)
    mark.style.opacity = String(km.toFixed(3))
    mark.style.transform = `translate(-50%, -50%) scale(${(1.3 - 0.3 * km).toFixed(4)})`
    glow.style.opacity = String((km * (0.45 + 0.55 * pulse)).toFixed(3))
  }
}

function end(root: HTMLElement, e: Extract<TitleEvent, { kind: 'end' }>, imgs: HTMLImageElement[]): Draw {
  const box = el('div', 'tt-end', root)
  const bg = el('div', 'tt-end-bg', box)
  const glow = el('div', 'tt-end-glow', box)
  const img = el('img', '', box) as HTMLImageElement
  img.src = LOGO
  imgs.push(img)
  const l1 = el('div', 'tt-end-l1', box)
  l1.textContent = e.line1
  let l2: HTMLElement | null = null
  if (e.line2) {
    l2 = el('div', 'tt-end-l2', box)
    l2.textContent = e.line2
  }
  let l3: HTMLElement | null = null
  if (e.line3) {
    l3 = el('div', 'tt-end-l3', box)
    e.line3.split('·').forEach((part, i) => {
      if (i > 0) el('i', '', l3!)
      el('span', '', l3!).textContent = part.trim()
    })
  }
  return (t) => {
    if (!show(box, t >= e.at && t < e.until, 'flex')) return
    const u = t - e.at
    bg.style.opacity = String(easeOut(clamp01(u / 0.5)))
    const k = easeOut(clamp01(u / 0.45))
    const pulse = Math.max(0, 1 - Math.abs(u - 0.3) / 0.7)
    img.style.opacity = String(k.toFixed(3))
    img.style.transform = `scale(${(1.2 - 0.16 * k - 0.04 * easeOut(clamp01(u / 3))).toFixed(4)})`
    glow.style.opacity = String((k * (0.5 + 0.5 * pulse)).toFixed(3))
    const parts: [HTMLElement | null, number][] = [
      [l1, 0.55],
      [l2, 0.8],
      [l3, 1.05],
    ]
    for (const [p, d] of parts) {
      if (!p) continue
      const kk = easeOut(clamp01((u - d) / 0.35))
      p.style.opacity = String(kk)
      p.style.transform = `translateY(${((1 - kk) * 14).toFixed(2)}px)`
    }
  }
}

const state = { fonts: false, images: false, draws: [] as Draw[], loaded: false }

const style = document.createElement('style')
style.textContent = CSS
document.head.appendChild(style)
const svgNs = 'http://www.w3.org/2000/svg'
const svg = document.createElementNS(svgNs, 'svg')
svg.setAttribute('width', '0')
svg.setAttribute('height', '0')
svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden')
svg.innerHTML = `<defs>${INK.map(
  (s) =>
    `<filter id="${s.id}" x="-25%" y="-60%" width="150%" height="220%" color-interpolation-filters="sRGB"><feMorphology in="SourceAlpha" operator="dilate" radius="${s.dilate}" result="grown"/><feGaussianBlur in="grown" stdDeviation="${s.blur}" result="soft"/><feFlood flood-color="#080402" flood-opacity="${s.opacity}"/><feComposite in2="soft" operator="in" result="halo"/><feMerge><feMergeNode in="halo"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
).join('')}</defs>`
document.body.appendChild(svg)
const root = el('div', 'tt', document.body)

void document.fonts.ready.then(async () => {
  await Promise.all(['200px "Metal Mania"', '700 30px "Barlow Semi Condensed"', '600 28px "Barlow Semi Condensed"', '700 40px "Cinzel"'].map((f) => document.fonts.load(f).catch(() => [])))
  state.fonts = true
})

declare global {
  interface Window {
    __titles: unknown
  }
}

window.__titles = {
  ready: () => state.fonts && state.images,
  async load(spec: TitleSpec): Promise<number> {
    root.textContent = ''
    const imgs: HTMLImageElement[] = []
    state.draws = []
    // paint order = list order: fills first (vignette, fades), words on top
    const order: TitleEvent['kind'][] = ['vignette', 'brand', 'end', 'tag', 'slam', 'flash', 'fade']
    const evs = spec.events.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    for (const e of evs) {
      if (e.kind === 'slam') state.draws.push(slam(root, e))
      else if (e.kind === 'tag') state.draws.push(tag(root, e))
      else if (e.kind === 'flash') state.draws.push(flash(root, e))
      else if (e.kind === 'fade') state.draws.push(fade(root, e))
      else if (e.kind === 'vignette') state.draws.push(vignette(root, e))
      else if (e.kind === 'brand') state.draws.push(brand(root, e, imgs))
      else if (e.kind === 'end') state.draws.push(end(root, e, imgs))
    }
    await Promise.all(imgs.map((i) => i.decode().catch(() => {})))
    state.images = true
    state.loaded = true
    return state.draws.length
  },
  /**
   * Draw the layer at edit time `t`. Returns '' when nothing is on screen, else a hash of
   * the layer's DOM state: equal hashes are equal frames (the capture reuses them).
   */
  render(t: number): string {
    for (const d of state.draws) d(t)
    if (!Array.from(root.children).some((c) => (c as HTMLElement).style.display !== 'none')) return ''
    const html = root.innerHTML
    let h = 2166136261
    for (let i = 0; i < html.length; i++) h = Math.imul(h ^ html.charCodeAt(i), 16777619)
    return `${html.length}:${(h >>> 0).toString(36)}`
  },
}
// no images until a spec loads: ready once fonts are in
state.images = true
