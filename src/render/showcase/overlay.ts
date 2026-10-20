/**
 * Showcase overlay: plain DOM over the match canvas, written once per captured
 * frame from the video clock (no CSS animations or transitions: the capture
 * runs on a virtual clock, so every motion here is a function of `vt`).
 *
 * Typography follows the game: Metal Mania titles, Cinzel display caps,
 * Barlow Semi Condensed body; text sits on glyph-following ink halos
 * (filters #ink-sm/md/lg from ui/InkFilters), never on boxes.
 */
import { SPELL_PALETTE, baseSpellId } from '../vfx/palette'
import { clamp01, easeOut, ease } from './cam'
import type { LowerThird, OverlaySpec } from './types'
import splashUrl from '../../../art/brand/splash.png'

const CSS = `
.sc-ov{position:absolute;inset:0;pointer-events:none;overflow:hidden;font-family:"Barlow Semi Condensed",system-ui,sans-serif;color:#f2e4cf;-webkit-font-smoothing:antialiased}
.sc-logo{position:absolute;left:44px;top:34px;height:52px;opacity:.9;filter:drop-shadow(0 2px 6px rgba(0,0,0,.8))}
.sc-lower{position:absolute;left:84px;bottom:92px;max-width:1100px}
.sc-kicker{display:flex;align-items:center;gap:12px;font-weight:700;font-size:19px;letter-spacing:.34em;text-transform:uppercase;filter:url(#ink-sm);white-space:nowrap}
.sc-kicker i{display:inline-block;width:9px;height:9px;transform:rotate(45deg);box-shadow:0 0 10px currentColor}
.sc-name{font-family:"Metal Mania","Cinzel",serif;font-size:84px;line-height:1;margin-top:4px;white-space:nowrap;letter-spacing:.01em}
.sc-rule{height:3px;margin:10px 0 12px;border-radius:2px;transform-origin:0 50%}
.sc-line{font-weight:500;font-size:29px;line-height:1.2;filter:url(#ink-md);text-shadow:0 1px 1px rgba(0,0,0,.6);white-space:nowrap}
.sc-card{position:absolute;left:0;right:0;top:118px;text-align:center}
.sc-card-t{font-family:"Metal Mania","Cinzel",serif;font-size:132px;line-height:1;letter-spacing:.02em}
.sc-card-s{margin-top:10px;font-weight:700;font-size:22px;letter-spacing:.42em;text-transform:uppercase;filter:url(#ink-md)}
.sc-fade{position:absolute;inset:0;background:#000}
.sc-hero{position:absolute;left:0;right:0;top:0;bottom:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.sc-hero img{width:1000px;filter:drop-shadow(0 8px 30px rgba(0,0,0,.85)) drop-shadow(0 0 60px rgba(255,90,20,.35))}
.sc-tag{margin-top:26px;font-family:"Cinzel",serif;font-weight:700;font-size:34px;letter-spacing:.2em;color:#ffe2b8;filter:url(#ink-lg);text-shadow:0 2px 0 #3b0a02}
.sc-end{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 46%,rgba(30,10,4,.55) 0%,rgba(6,3,2,.92) 62%,#050202 100%)}
.sc-end img{width:980px;filter:drop-shadow(0 0 70px rgba(255,90,20,.35))}
.sc-end-l1{margin-top:34px;font-family:"Cinzel",serif;font-weight:700;font-size:36px;letter-spacing:.16em;color:#ffe2b8}
.sc-end-l2{margin-top:16px;font-weight:600;font-size:22px;letter-spacing:.42em;text-transform:uppercase;color:#c9b39a}
.sc-brand{position:absolute;inset:0;overflow:hidden;background:#000}
.sc-brand-art{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:50% 46%}
.sc-brand-shade{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 55%,rgba(0,0,0,0) 38%,rgba(4,2,1,.55) 100%),linear-gradient(180deg,rgba(3,2,6,.55) 0%,rgba(3,2,6,.12) 34%,rgba(0,0,0,0) 55%)}
.sc-brand-mark{position:absolute;left:50%;top:21%;width:1040px;transform-origin:50% 50%}
.sc-brand-flash{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,#ffd9a0 0%,#ff7a2a 35%,#5a1204 75%,#000 100%);mix-blend-mode:screen}
.sc-noplates .bl-plate{display:none!important}
.sc-nonums .bl-num,.sc-nonums .bl-call{display:none!important}
.sc-nostamps .bl-stampw,.sc-nostamps .bl-bounty{display:none!important}
.sc-no-world-overlay .bl-ov,.sc-no-world-overlay .bl-locator{display:none!important}
`

const LOGO = '/brand/wordmark.webp'

function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag)
  e.className = cls
  parent.appendChild(e)
  return e
}

function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0')
}

function lum(n: number): number {
  const c = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * c((n >> 16) & 255) + 0.7152 * c((n >> 8) & 255) + 0.0722 * c(n & 255)
}

function mixHex(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/**
 * Readable title colour for a spell: the palette accent, lifted toward the core
 * when the accent is too dark to read over the scene (Meteor, Gravity, Scourge).
 */
export function accentCss(spell: string): { text: string; glow: string } {
  const p = SPELL_PALETTE[baseSpellId(spell)]
  if (!p) return { text: '#ffd9a8', glow: '#ff7a2a' }
  let c = p.accent
  let k = 0
  while (lum(c) < 0.16 && k < 6) {
    k++
    c = mixHex(p.accent, p.core, k / 6)
  }
  return { text: hex(c), glow: hex(p.accent === c ? p.accent : mixHex(p.accent, p.core, 0.35)) }
}

export class ShowcaseOverlay {
  readonly root: HTMLDivElement
  private logo: HTMLImageElement
  private lower: HTMLElement
  private kicker: HTMLElement
  private kickerText: HTMLElement
  private name: HTMLElement
  private rule: HTMLElement
  private line: HTMLElement
  private card: HTMLElement
  private cardT: HTMLElement
  private cardS: HTMLElement
  private fade: HTMLElement
  private hero: HTMLElement
  private heroImg: HTMLImageElement
  private tag: HTMLElement
  private end: HTMLElement
  private endImg: HTMLImageElement
  private host: HTMLElement
  private brand: HTMLElement
  private brandArt: HTMLImageElement
  private brandMark: HTMLImageElement
  private brandFlash: HTMLElement

  constructor(parent: HTMLElement, host: HTMLElement) {
    this.host = host
    const st = document.createElement('style')
    st.textContent = CSS
    document.head.appendChild(st)
    this.root = el('div', 'sc-ov', parent) as HTMLDivElement
    this.logo = el('img', 'sc-logo', this.root) as HTMLImageElement
    this.logo.src = LOGO
    this.lower = el('div', 'sc-lower', this.root)
    this.kicker = el('div', 'sc-kicker', this.lower)
    el('i', '', this.kicker)
    this.kickerText = el('span', '', this.kicker)
    this.name = el('div', 'sc-name', this.lower)
    this.rule = el('div', 'sc-rule', this.lower)
    this.line = el('div', 'sc-line', this.lower)
    this.card = el('div', 'sc-card', this.root)
    this.cardT = el('div', 'sc-card-t', this.card)
    this.cardS = el('div', 'sc-card-s', this.card)
    this.hero = el('div', 'sc-hero', this.root)
    this.heroImg = el('img', '', this.hero) as HTMLImageElement
    this.heroImg.src = LOGO
    this.tag = el('div', 'sc-tag', this.hero)
    this.end = el('div', 'sc-end', this.root)
    this.endImg = el('img', '', this.end) as HTMLImageElement
    this.endImg.src = LOGO
    el('div', 'sc-end-l1', this.end).textContent = 'Knock rival warlocks into the lava'
    el('div', 'sc-end-l2', this.end).textContent = 'In-engine footage · WebGPU · Ultra'
    this.brand = el('div', 'sc-brand', this.root)
    this.brandArt = el('img', 'sc-brand-art', this.brand) as HTMLImageElement
    this.brandArt.src = splashUrl
    el('div', 'sc-brand-shade', this.brand)
    this.brandMark = el('img', 'sc-brand-mark', this.brand) as HTMLImageElement
    this.brandMark.src = LOGO
    this.brandFlash = el('div', 'sc-brand-flash', this.brand)
    this.fade = el('div', 'sc-fade', this.root)
    this.update(null, 0, 1)
  }

  /** images decoded (wait before the first captured frame) */
  async ready(): Promise<void> {
    await Promise.all([this.logo, this.heroImg, this.endImg, this.brandArt, this.brandMark].map((i) => i.decode().catch(() => {})))
  }

  private setLower(l: LowerThird, vt: number, dur: number): void {
    const at = l.at ?? 0.25
    const until = l.until ?? dur - 0.3
    const tin = clamp01((vt - at) / 0.45)
    const tout = clamp01((vt - (until - 0.3)) / 0.3)
    const on = vt >= at && vt <= until
    this.lower.style.display = on ? 'block' : 'none'
    if (!on) return
    const acc = l.color ? { text: l.color, glow: l.color } : accentCss(l.spell ?? '')
    const kc = l.kickerColor ?? acc.text
    if (this.name.textContent !== l.name) this.name.textContent = l.name
    if (this.kickerText.textContent !== l.kicker) this.kickerText.textContent = l.kicker
    if (this.line.textContent !== l.line) this.line.textContent = l.line
    this.kicker.style.color = kc
    this.name.style.color = acc.text
    this.name.style.filter = `url(#ink-lg) drop-shadow(0 0 18px ${acc.glow}99)`
    this.name.style.textShadow = '0 3px 0 rgba(20,6,2,.9)'
    this.rule.style.background = `linear-gradient(90deg, ${acc.text}, ${acc.glow}66 55%, transparent)`
    this.rule.style.boxShadow = `0 0 12px ${acc.glow}`
    const a = easeOut(tin)
    const k1 = easeOut(clamp01((vt - at) / 0.35))
    const k2 = easeOut(clamp01((vt - at - 0.08) / 0.4))
    const k3 = easeOut(clamp01((vt - at - 0.18) / 0.45))
    const out = 1 - ease(tout)
    this.kicker.style.opacity = String(k1 * out)
    this.kicker.style.transform = `translateX(${(1 - k1) * -24}px)`
    this.name.style.opacity = String(k2 * out)
    this.name.style.transform = `translateX(${(1 - k2) * -36}px)`
    this.rule.style.width = `${Math.round(440 * a)}px`
    this.rule.style.opacity = String(out)
    this.line.style.opacity = String(k3 * out)
    this.line.style.transform = `translateY(${(1 - k3) * 10}px)`
  }

  /**
   * Write the overlay for video time `vt` of a shot lasting `dur` seconds.
   * No speed / debug readouts by design: only the wordmark, lower thirds and cards.
   */
  update(o: OverlaySpec | null, vt: number, dur: number): void {
    const spec = o ?? {}
    // world overlay toggles
    this.host.classList.toggle('sc-noplates', spec.plates === false)
    this.host.classList.toggle('sc-nonums', spec.nums === false)
    this.host.classList.toggle('sc-nostamps', spec.stamps === false)
    this.host.classList.toggle('sc-no-world-overlay', spec.plates === false && spec.nums === false && spec.stamps === false)
    // corner logo
    const heroOn = !!spec.hero && vt >= spec.hero.at && vt <= (spec.hero.until ?? dur)
    const endOn = !!spec.end && vt >= spec.end.at
    this.logo.style.display = spec.logo === false || heroOn || endOn || !!spec.brand ? 'none' : 'block'
    // lower third
    const lowers = spec.lower ? (Array.isArray(spec.lower) ? spec.lower : [spec.lower]) : []
    const cur = lowers.find((l) => vt >= (l.at ?? 0.25) && vt <= (l.until ?? dur - 0.3))
    if (cur) this.setLower(cur, vt, dur)
    else this.lower.style.display = 'none'
    // chapter card
    const c = spec.card
    if (c && vt >= c.at && vt <= c.until) {
      this.card.style.display = 'block'
      const tin = easeOut(clamp01((vt - c.at) / 0.35))
      const tout = ease(clamp01((vt - (c.until - 0.35)) / 0.35))
      if (this.cardT.textContent !== c.title) this.cardT.textContent = c.title
      if (this.cardS.textContent !== (c.sub ?? '')) this.cardS.textContent = c.sub ?? ''
      this.cardT.style.color = c.color
      this.cardT.style.filter = `url(#ink-lg) drop-shadow(0 0 26px ${c.color}aa)`
      this.cardT.style.textShadow = '0 4px 0 rgba(20,6,2,.9)'
      this.cardS.style.color = '#f6e3c6'
      this.card.style.opacity = String(tin * (1 - tout))
      const sc = 1.14 - 0.14 * tin + 0.04 * tout
      this.card.style.transform = `scale(${sc.toFixed(4)})`
      this.cardT.style.letterSpacing = `${(0.02 + 0.06 * (1 - tin)).toFixed(3)}em`
    } else this.card.style.display = 'none'
    // hero wordmark
    if (heroOn && spec.hero) {
      this.hero.style.display = 'flex'
      const t = vt - spec.hero.at
      const k = easeOut(clamp01(t / 1.4))
      const until = spec.hero.until ?? dur
      const out = ease(clamp01((vt - (until - 0.6)) / 0.6))
      this.heroImg.style.opacity = String(k * (1 - out))
      this.heroImg.style.transform = `scale(${(1.1 - 0.1 * k + 0.03 * out).toFixed(4)})`
      this.heroImg.style.filter = `drop-shadow(0 8px 30px rgba(0,0,0,.85)) drop-shadow(0 0 ${Math.round(30 + 50 * k)}px rgba(255,90,20,${(0.2 + 0.25 * k).toFixed(2)})) blur(${((1 - k) * 8).toFixed(2)}px)`
      const tg = spec.hero.tagline ?? ''
      if (this.tag.textContent !== tg) this.tag.textContent = tg
      const k2 = easeOut(clamp01((t - 0.9) / 0.8))
      this.tag.style.opacity = String(k2 * (1 - out))
      this.tag.style.transform = `translateY(${(1 - k2) * 12}px)`
    } else this.hero.style.display = 'none'
    // branded intro: splash art with a slow push-in, the wordmark lands with an ember glow,
    // then a warm flash burns to black (the cold open fades up from black)
    const b = spec.brand
    if (b) {
      this.brand.style.display = 'block'
      const t = vt - b.at
      const kb = t / Math.max(0.1, dur - b.at)
      this.brandArt.style.transform = `scale(${(1.0 + 0.07 * ease(kb)).toFixed(4)})`
      this.brandArt.style.filter = `brightness(${(0.82 + 0.18 * easeOut(clamp01(t / 1.2))).toFixed(3)})`
      const land = b.mark ?? 1.5
      const km = easeOut(clamp01((t - land) / 0.55))
      const glow = Math.max(0, 1 - Math.abs(t - land - 0.45) / 0.6)
      this.brandMark.style.opacity = String(km)
      this.brandMark.style.transform = `translate(-50%, -50%) scale(${(1.16 - 0.16 * km).toFixed(4)})`
      this.brandMark.style.filter = `blur(${((1 - km) * 10).toFixed(2)}px) drop-shadow(0 6px 26px rgba(0,0,0,.85)) drop-shadow(0 0 ${Math.round(40 + 70 * glow)}px rgba(255,${Math.round(110 + 60 * glow)},40,${(0.35 + 0.45 * glow).toFixed(2)}))`
      const out = b.out ?? dur - 0.9
      const flash = Math.max(0, 1 - Math.abs(t - out) / 0.22)
      this.brandFlash.style.opacity = String((flash * 0.55).toFixed(3))
      this.brandFlash.style.display = flash > 0.001 ? 'block' : 'none'
    } else this.brand.style.display = 'none'
    // end card
    if (endOn && spec.end) {
      this.end.style.display = 'flex'
      const t = vt - spec.end.at
      const k = easeOut(clamp01(t / 1.0))
      this.end.style.opacity = String(k)
      this.endImg.style.transform = `scale(${(1.06 - 0.06 * easeOut(clamp01(t / 2.4))).toFixed(4)})`
    } else this.end.style.display = 'none'
    // fades
    let f = 0
    if (spec.fadeIn) f = Math.max(f, 1 - ease(clamp01(vt / spec.fadeIn)))
    if (spec.fadeOut) f = Math.max(f, ease(clamp01((vt - (dur - spec.fadeOut)) / spec.fadeOut)))
    this.fade.style.display = f > 0.001 ? 'block' : 'none'
    this.fade.style.opacity = String(f)
  }
}
