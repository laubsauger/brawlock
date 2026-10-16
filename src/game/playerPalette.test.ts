import { describe, expect, test } from 'vitest'
import { PLAYER_COLORS } from '../net/session'
import { PLAYER_COLORS_CB, PLAYER_COLOR_NAMES, PLAYER_COLOR_NAMES_CB, PLAYER_GLYPHS, displayColor, paletteColor } from './playerPalette'

// sRGB hex -> OKLab, plus Machado 2009 (severity 1) colour-vision simulation in linear RGB
const s2l = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const lin = (h: number) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255].map(s2l)
function oklab([r, g, b]: number[]): number[] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
const CVD: Record<string, number[][]> = {
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
}
const see = (h: number, mode: string | null) => {
  const c = lin(h)
  if (!mode) return oklab(c)
  return oklab(CVD[mode].map((r) => Math.max(0, Math.min(1, r[0] * c[0] + r[1] * c[1] + r[2] * c[2]))))
}
function closestPair(pal: readonly number[], mode: string | null): number {
  let best = Infinity
  for (let i = 0; i < pal.length; i++) {
    for (let j = i + 1; j < pal.length; j++) {
      const a = see(pal[i], mode)
      const b = see(pal[j], mode)
      best = Math.min(best, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
    }
  }
  return best
}

describe('colourblind player palette', () => {
  test('index-aligned with the standard palette (team names and slots follow the index)', () => {
    expect(PLAYER_COLORS_CB.length).toBe(PLAYER_COLORS.length)
    expect(PLAYER_COLOR_NAMES.length).toBe(PLAYER_COLORS.length)
    expect(PLAYER_COLOR_NAMES_CB.length).toBe(PLAYER_COLORS.length)
    expect(new Set(PLAYER_GLYPHS).size).toBe(PLAYER_COLORS.length)
  })

  // the point of the option: every pair of players stays tellable apart for red-green
  // colour blindness (the standard set has near-identical pairs: blue/purple ~0.006)
  test.each(['deuteranopia', 'protanopia'])('%s: no two players closer than 0.1 OKLab', (mode) => {
    expect(closestPair(PLAYER_COLORS_CB, mode)).toBeGreaterThan(0.1)
    expect(closestPair(PLAYER_COLORS_CB, mode)).toBeGreaterThan(closestPair(PLAYER_COLORS, mode))
  })

  test('tritanopia and normal vision do not get worse', () => {
    expect(closestPair(PLAYER_COLORS_CB, 'tritanopia')).toBeGreaterThanOrEqual(closestPair(PLAYER_COLORS, 'tritanopia') - 1e-3)
    expect(closestPair(PLAYER_COLORS_CB, null)).toBeGreaterThan(0.13)
  })

  test('displayColor swaps palette colours by index and leaves other colours alone', () => {
    for (let i = 0; i < PLAYER_COLORS.length; i++) {
      expect(displayColor(PLAYER_COLORS[i], true)).toBe(PLAYER_COLORS_CB[i])
      expect(displayColor(PLAYER_COLORS[i], false)).toBe(PLAYER_COLORS[i])
    }
    expect(displayColor(0x123456, true)).toBe(0x123456)
    expect(paletteColor(1, true)).toBe(PLAYER_COLORS_CB[1])
    expect(paletteColor(11, false)).toBe(PLAYER_COLORS[1])
  })
})
