/**
 * Game cursors, Dota style: a dark-metal claw pointer for menus and the HUD
 * (an ember-lit variant over anything clickable), a move variant over the
 * arena, and a targeting reticle tinted by the spell's column color while a
 * Normal-cast / held aim is active, red with a slash when the spell can't fire.
 *
 * Small SVGs as data URIs at 32 px with a 64 px copy for hi-dpi (image-set),
 * hotspots in 32 px coordinates. installCursors() publishes the static ones as
 * CSS custom properties (--cursor-default / --cursor-lit / --cursor-move);
 * the arena sets reticles directly on the viewport (reticleCursor).
 */

const wrap = (body: string, size: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${body}</svg>`
const uri = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`

/** Best supported cursor value: image-set, then -webkit-image-set, then plain 32 px. */
function cursorValue(body: string, hx: number, hy: number, fallback: string): string {
  const one = uri(wrap(body, 32))
  const two = uri(wrap(body, 64))
  const candidates = [`image-set(${one} 1x, ${two} 2x) ${hx} ${hy}, ${fallback}`, `-webkit-image-set(${one} 1x, ${two} 2x) ${hx} ${hy}, ${fallback}`]
  try {
    for (const c of candidates) if (CSS.supports('cursor', c)) return c
  } catch {
    /* no CSS.supports: plain url below */
  }
  return `${one} ${hx} ${hy}, ${fallback}`
}

/** Claw-shaped pointer, tip at (3, 2). `rim` lights the edge, `ember` the knuckle rivet. */
function claw(rim: string, ember: string, light = false): string {
  const shape =
    'M3 2C9.2 7.2 16 12.2 22.6 17.3L14.7 18.7L19.1 27.2C18.5 28.4 16.7 29.2 15.5 28.8L10.9 20.7L4.5 25.9C3.6 18 3.2 10 3 2Z'
  return (
    `<defs><linearGradient id="m" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${light ? '#8a7563' : '#6b5a4c'}"/><stop offset="0.55" stop-color="#2e2520"/><stop offset="1" stop-color="#140e0b"/>` +
    `</linearGradient></defs>` +
    // dark halo keeps it readable over bright lava
    `<path d="${shape}" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="3.2" stroke-linejoin="round"/>` +
    `<path d="${shape}" fill="url(#m)" stroke="${rim}" stroke-width="1.1" stroke-linejoin="round"/>` +
    // lit leading edge and a talon groove
    `<path d="M4.3 5.2C4.8 11 5.1 16.3 5.5 21.4" fill="none" stroke="#ffd59a" stroke-opacity="${light ? '.95' : '.6'}" stroke-width=".9" stroke-linecap="round"/>` +
    `<path d="M7 9.5L15.5 16.2" fill="none" stroke="#000" stroke-opacity=".45" stroke-width=".8" stroke-linecap="round"/>` +
    `<circle cx="9.2" cy="15.8" r="1.5" fill="${ember}"/>` +
    (light ? `<circle cx="9.2" cy="15.8" r="3" fill="${ember}" fill-opacity=".25"/>` : '')
  )
}

/** Claw plus a small ember ground ring: "right click moves here". */
function moveClaw(): string {
  return (
    claw('#c99a62', '#ff7a2a') +
    `<ellipse cx="24" cy="27" rx="5.2" ry="2.4" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="2.6"/>` +
    `<ellipse cx="24" cy="27" rx="5.2" ry="2.4" fill="none" stroke="#ffb347" stroke-width="1.2"/>`
  )
}

function reticle(color: string, invalid: boolean): string {
  const c = invalid ? '#ff3b30' : color
  const ticks = 'M16 1.5v7M16 23.5v7M1.5 16h7M23.5 16h7'
  return (
    `<circle cx="16" cy="16" r="9" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="4"/>` +
    `<path d="${ticks}" stroke="#000" stroke-opacity=".55" stroke-width="4" stroke-linecap="round"/>` +
    `<circle cx="16" cy="16" r="9" fill="none" stroke="${c}" stroke-width="2"/>` +
    `<path d="${ticks}" stroke="${c}" stroke-width="2" stroke-linecap="round"/>` +
    (invalid
      ? `<path d="M9.6 22.4L22.4 9.6" stroke="#000" stroke-opacity=".55" stroke-width="4" stroke-linecap="round"/><path d="M9.6 22.4L22.4 9.6" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`
      : `<circle cx="16" cy="16" r="1.8" fill="#fff6dc"/>`)
  )
}

let installed = false
let staticCursors = { default: 'default', lit: 'pointer', move: 'crosshair' }

/** Publish the static cursors as CSS variables on :root. Safe to call more than once. */
export function installCursors(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  staticCursors = {
    default: cursorValue(claw('#b88d5c', '#c2410c'), 3, 2, 'default'),
    lit: cursorValue(claw('#ffd77a', '#ff8a2a', true), 3, 2, 'pointer'),
    move: cursorValue(moveClaw(), 3, 2, 'crosshair'),
  }
  const root = document.documentElement.style
  root.setProperty('--cursor-default', staticCursors.default)
  root.setProperty('--cursor-lit', staticCursors.lit)
  root.setProperty('--cursor-move', staticCursors.move)
}

export function moveCursor(): string {
  installCursors()
  return staticCursors.move
}

const reticles = new Map<string, string>()
/** Targeting reticle in a spell's color; red with a slash when the cast is invalid. */
export function reticleCursor(color: string, invalid: boolean): string {
  const key = invalid ? 'invalid' : color
  let v = reticles.get(key)
  if (!v) {
    v = cursorValue(reticle(color, invalid), 16, 16, 'crosshair')
    reticles.set(key, v)
  }
  return v
}
