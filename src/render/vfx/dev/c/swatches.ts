/**
 * Dev-only palette review sheet (VFX workstream C). Not part of the app build.
 *   npx vite --port 5196 -> http://localhost:5196/src/render/vfx/dev/c/swatches.html
 * Every spell's identity pair as a glowing orb + trail over dark stone and over lava,
 * repeated under simulated deuteranopia / protanopia / tritanopia (Machado 2009).
 */
import { SPELL_PALETTE } from '../../palette'

const ORDER = [
  'fireball', 'boomerang', 'lightning', 'homing', 'twin', 'scourge', 'pact',
  'teleport', 'thrust', 'swap', 'cluster', 'drain', 'bouncer', 'recharge',
  'windwalk', 'meteor', 'splitter', 'snowball', 'shield', 'rush', 'alteration',
  'gravity', 'grip', 'warpzone', 'magnetize', 'rockpillar', 'link', 'redirector',
]

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')

function stone(g: CanvasRenderingContext2D, w: number, h: number) {
  g.fillStyle = '#25232a'
  g.fillRect(0, 0, w, h)
  // tile seams + grain (dark runed stone)
  for (let i = 0; i < 260; i++) {
    const v = 28 + Math.random() * 22
    g.fillStyle = `rgba(${v},${v - 2},${v + 4},0.5)`
    g.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 6, 2 + Math.random() * 6)
  }
  g.strokeStyle = 'rgba(0,0,0,0.6)'
  g.lineWidth = 2
  g.strokeRect(w * 0.5, -2, w, h * 0.55)
}

function lava(g: CanvasRenderingContext2D, w: number, h: number) {
  const gr = g.createLinearGradient(0, 0, w, h)
  gr.addColorStop(0, '#2a0904')
  gr.addColorStop(0.5, '#5a1406')
  gr.addColorStop(1, '#2a0904')
  g.fillStyle = gr
  g.fillRect(0, 0, w, h)
  for (let i = 0; i < 14; i++) {
    g.strokeStyle = `rgba(255,${90 + Math.random() * 60},20,${0.35 + Math.random() * 0.4})`
    g.lineWidth = 1 + Math.random() * 2.5
    g.beginPath()
    let x = Math.random() * w
    let y = Math.random() * h
    g.moveTo(x, y)
    for (let k = 0; k < 4; k++) g.lineTo((x += (Math.random() - 0.5) * 40), (y += (Math.random() - 0.5) * 30))
    g.stroke()
  }
}

function orb(g: CanvasRenderingContext2D, w: number, h: number, core: number, accent: number) {
  const cx = w * 0.62
  const cy = h * 0.55
  g.globalCompositeOperation = 'lighter'
  // trail
  const tg = g.createLinearGradient(cx, cy, 6, cy + 8)
  tg.addColorStop(0, hex(accent))
  tg.addColorStop(1, 'rgba(0,0,0,0)')
  g.strokeStyle = tg
  g.lineWidth = 10
  g.lineCap = 'round'
  g.beginPath()
  g.moveTo(cx, cy)
  g.quadraticCurveTo(w * 0.35, cy + 4, 6, cy + 8)
  g.stroke()
  // glow
  const r = h * 0.42
  const gg = g.createRadialGradient(cx, cy, 0, cx, cy, r)
  gg.addColorStop(0, hex(core))
  gg.addColorStop(0.22, hex(core))
  gg.addColorStop(0.38, hex(accent))
  gg.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = gg
  g.beginPath()
  g.arc(cx, cy, r, 0, Math.PI * 2)
  g.fill()
  g.globalCompositeOperation = 'source-over'
  // flat chips: accent (identity) and core
  g.fillStyle = hex(accent)
  g.fillRect(w - 26, h - 16, 20, 12)
  g.fillStyle = hex(core)
  g.fillRect(w - 50, h - 16, 20, 12)
}

function section(title: string, filter: string, bg: 'stone' | 'lava') {
  const h2 = document.createElement('h2')
  h2.textContent = title
  document.getElementById('root')!.append(h2)
  const grid = document.createElement('div')
  grid.className = 'grid'
  if (filter) grid.style.filter = `url(#${filter})`
  for (const id of ORDER) {
    const p = SPELL_PALETTE[id]
    const cell = document.createElement('div')
    cell.className = 'cell'
    const c = document.createElement('canvas')
    c.width = 220
    c.height = 84
    const g = c.getContext('2d')!
    if (bg === 'stone') stone(g, c.width, c.height)
    else lava(g, c.width, c.height)
    if (p) orb(g, c.width, c.height, p.core, p.accent)
    const l = document.createElement('div')
    l.className = 'lbl'
    l.textContent = p ? id : `${id} (missing)`
    cell.append(c, l)
    grid.append(cell)
  }
  document.getElementById('root')!.append(grid)
}

section('Normal vision: over dark stone', '', 'stone')
section('Normal vision: over lava', '', 'lava')
section('Deuteranopia (simulated)', 'deut', 'stone')
section('Protanopia (simulated)', 'prot', 'stone')
section('Tritanopia (simulated)', 'trit', 'stone')
const n = document.createElement('div')
n.className = 'note'
n.textContent = 'left chip = core (hot centre), right chip = accent (identity: rim, trail, decal). Ordered by shop column; items last in row 1.'
document.getElementById('root')!.append(n)
