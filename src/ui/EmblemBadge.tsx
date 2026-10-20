import { useMemo } from 'react'
import type { EmblemCosmeticId } from '../game/progressionCatalog'
import { drawEmblem } from '../render/character/emblemArt'

const cache = new Map<string, string>()

/** The emblem printed in `color` on a transparent square, as a data URL (cached per look). */
function badgeUrl(id: EmblemCosmeticId, color: string, px: number): string {
  const key = `${id}|${color}|${px}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = px
  const c = canvas.getContext('2d')
  let url = ''
  if (c) {
    c.fillStyle = c.strokeStyle = '#fff'
    drawEmblem(c, id, px)
    // tint the coverage with the player colour
    c.globalCompositeOperation = 'source-in'
    c.fillStyle = color
    c.fillRect(0, 0, px, px)
    url = canvas.toDataURL()
  }
  cache.set(key, url)
  return url
}

/**
 * A player's badge: their equipped cape emblem in their colour on a dark tile, so players are
 * told apart at a glance in rosters and boards. Renders nothing without an emblem.
 */
export function EmblemBadge({ emblem, color, size = 26, className = '' }: { emblem: EmblemCosmeticId | null | undefined; color: string; size?: number; className?: string }) {
  const px = Math.round(size * Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1))
  const url = useMemo(() => (emblem ? badgeUrl(emblem, color, px) : ''), [emblem, color, px])
  if (!emblem || !url) return null
  return <span className={`emblem-badge ${className}`} style={{ width: size, height: size, borderColor: `${color}88`, boxShadow: `0 0 8px ${color}44` }} aria-hidden>
    <img src={url} alt="" width={size} height={size} draggable={false} />
  </span>
}
