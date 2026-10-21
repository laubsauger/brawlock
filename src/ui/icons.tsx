import { useState, type ReactNode } from 'react'
import { ASSET_BASE } from '../lib/assets'
import { hueFor, MASTERY_HUE } from './data/catalog'

/** Navigation glyphs share the same warm, fine stroke as the engraved controls. */
export function MenuGlyph({ kind, size = 18 }: { kind: 'profile' | 'edit' | 'record' | 'settings' | 'credits' | 'guide' | 'spells' | 'region'; size?: number }) {
  const paths = {
    profile: <><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></>,
    edit: <><path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z" /></>,
    record: <><path d="M8 3h8v5c0 4-2 6-4 6s-4-2-4-6ZM8 5H4v3c0 3 2 4 5 4M16 5h4v3c0 3-2 4-5 4M12 14v6M8 21h8" /></>,
    settings: <><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 3v6M16 9v6M10 15v6" /></>,
    credits: <><circle cx="12" cy="12" r="9" /><path d="M12 10v7M12 6.5v.5" /></>,
    guide: <><path d="M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1ZM12 5v15" /></>,
    region: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z" /></>,
    spells: <><path d="M10 4c.6 3 2 4.4 5 5-3 .6-4.4 2-5 5-.6-3-2-4.4-5-5 3-.6 4.4-2 5-5ZM17.5 13.5c.3 1.5 1 2.2 2.5 2.5-1.5.3-2.2 1-2.5 2.5-.3-1.5-1-2.2-2.5-2.5 1.5-.3 2.2-1 2.5-2.5Z" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>{paths[kind]}</svg>
}

/**
 * Placeholder spell / item / mastery sigils: one stroked glyph per id on a
 * glowing disc tinted by the shop column hue. Final icon art replaces the
 * glyph table; the component API stays.
 */
const G: Record<string, ReactNode> = {
  fireball: (
    <>
      <circle cx="15" cy="9" r="4.6" fill="currentColor" stroke="none" />
      <path d="M11.6 12.4 4 20M10.6 9.6 5 14.2M14.4 13.4 9.8 19" />
    </>
  ),
  scourge: (
    <>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="6.2" />
      <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3 7 7M17 17l1.7 1.7M5.3 18.7 7 17M17 7l1.7-1.7" />
    </>
  ),
  teleport: (
    <>
      <circle cx="6.5" cy="17.5" r="3" strokeDasharray="2 2" />
      <circle cx="17.5" cy="6.5" r="3.2" fill="currentColor" stroke="none" />
      <path d="M8.6 14.8C9.5 9.5 11.5 7.6 14 6.9" strokeDasharray="1.6 2.2" />
    </>
  ),
  boomerang: <path d="M5 19C4.5 9 9 4.5 19.5 4.5 11 7.5 9 11 9.5 19.5Z" fill="currentColor" fillOpacity=".25" />,
  lightning: <path d="M13.5 2 6 13h5l-2 9 9-13h-5l2-7Z" fill="currentColor" fillOpacity=".3" />,
  homing: (
    <>
      <circle cx="17.5" cy="6.5" r="3" />
      <circle cx="17.5" cy="6.5" r=".8" fill="currentColor" />
      <path d="M4 20c0-6 3-10.5 9.5-11.5M11 6l2.6 2.5L11 11.2" />
    </>
  ),
  twin: (
    <>
      <path d="M4 20C4 11 8 6 18 6M4 20c9 0 14-4 14-14" />
      <circle cx="18" cy="6" r="1.8" fill="currentColor" />
    </>
  ),
  thrust: <path d="M5 12h12.5M13.5 7l5 5-5 5M3 8h5M3 16h5" />,
  swap: <path d="M5 8h13M15 5l3 3-3 3M19 16H6M9 13l-3 3 3 3" />,
  cluster: (
    <>
      <path d="M12 21 6.4 10M12 21l-1.9-12M12 21l1.9-12M12 21l5.6-11" strokeOpacity=".45" />
      <circle cx="6.1" cy="9.4" r="2" fill="currentColor" />
      <circle cx="9.9" cy="8.2" r="2" fill="currentColor" />
      <circle cx="14.1" cy="8.2" r="2" fill="currentColor" />
      <circle cx="17.9" cy="9.4" r="2" fill="currentColor" />
    </>
  ),
  drain: (
    <>
      <path d="M12 3s-6.5 7.4-6.5 11.6a6.5 6.5 0 0 0 13 0C18.5 10.4 12 3 12 3Z" />
      <path d="M9 15a3 3 0 0 0 3 3" />
    </>
  ),
  bouncer: (
    <>
      <path d="M3 18 8 6l5 10 5-11 3 7" />
      <circle cx="8" cy="6" r="1.5" fill="currentColor" />
      <circle cx="13" cy="16" r="1.5" fill="currentColor" />
      <circle cx="18" cy="5" r="1.5" fill="currentColor" />
    </>
  ),
  recharge: <path d="M19 12a7 7 0 1 1-3.2-5.9M16.4 2.6l-.4 3.8 3.8.6" />,
  windwalk: <path d="M3 8h11a3 3 0 1 0-3-3M3 13h15a3 3 0 1 1-3 3M3 18h7" />,
  meteor: (
    <>
      <circle cx="15" cy="15" r="5" fill="currentColor" fillOpacity=".3" />
      <path d="M11 11 3 3M14 9.6 8.5 2.5M9.6 14 2.5 8.5" />
    </>
  ),
  splitter: (
    <>
      <path d="M3 12h8M11 12l7.5-6.5M11 12h9M11 12l7.5 6.5" />
      <circle cx="11" cy="12" r="2" fill="currentColor" />
    </>
  ),
  snowball: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 7v10M7.7 9.5l8.6 5M7.7 14.5l8.6-5" />
    </>
  ),
  shield: (
    <>
      <circle cx="12" cy="12" r="8" strokeWidth="2.4" />
      <path d="M7.5 9.5A5 5 0 0 1 11 6.8" />
    </>
  ),
  rush: <path d="M5 6l6 6-6 6M12 6l6 6-6 6" />,
  alteration: <path d="M5.5 9.5A7 7 0 0 1 18 8.5M18.5 5.5 18 8.5l-3-.4M18.5 14.5A7 7 0 0 1 6 15.5M5.5 18.5 6 15.5l3 .4" />,
  gravity: (
    <>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
      <circle cx="12" cy="12" r="6" strokeDasharray="2.4 2.2" />
      <circle cx="12" cy="12" r="9.5" strokeOpacity=".4" />
    </>
  ),
  grip: <path d="M4 20.5h16M7 20.5V11a5 5 0 0 1 10 0v9.5M10 20.5V12a2 2 0 0 1 4 0v8.5" />,
  warpzone: <path d="M12 12a1.5 1.5 0 1 1 1.5 1.5 3.5 3.5 0 1 1-3.5-3.5 5.5 5.5 0 1 1 5.5 5.5 7.5 7.5 0 1 1-7.5-7.5" />,
  magnetize: <path d="M6 4v8a6 6 0 0 0 12 0V4h-3v8a3 3 0 0 1-6 0V4ZM6 7.5h3M15 7.5h3" />,
  rockpillar: <path d="M5 21h14M8 21V7.5M16 21V7.5M6 7.5h12M7 4h10M11 11l1.5 2.5L11 16" />,
  link: (
    <>
      <rect x="2.8" y="10.2" width="10" height="5.6" rx="2.8" transform="rotate(-45 7.8 13)" />
      <rect x="11.2" y="8.2" width="10" height="5.6" rx="2.8" transform="rotate(-45 16.2 11)" />
    </>
  ),
  ring_of_health: (
    <>
      <circle cx="12" cy="14.5" r="6" />
      <path d="M12 3.5v5M9.5 6h5" />
    </>
  ),
  cursed_ring: (
    <>
      <circle cx="12" cy="14.5" r="6" />
      <path d="M9.6 3.6l4.8 4.8M14.4 3.6l-4.8 4.8" />
    </>
  ),
  cape: <path d="M7 3h10l3 18-8-3.2L4 21 7 3ZM9.5 3 12 8l2.5-5" />,
  armor: <path d="M5 5.2 9 3c1 1.8 2 2.6 3 2.6S14 4.8 15 3l4 2.2-1 7c-.6 4.5-3 7.4-6 8.8-3-1.4-5.4-4.3-6-8.8Z" />,
  boots: <path d="M7 3h5.5v9.5l6.5 2.2c1.4.5 1.6 2.4 1.2 4.3H6.5Z" />,
  pocket_watch: (
    <>
      <circle cx="12" cy="14" r="7" />
      <path d="M12 14v-4M12 14l3 1.6M12 7V4M10 4h4" />
    </>
  ),
  redirector: (
    <>
      <path d="M4.5 18.5C4.5 10 8.5 6 16.5 6M13.5 3l3.5 3-3.5 3" />
      <circle cx="4.5" cy="18.5" r="1.8" fill="currentColor" />
    </>
  ),
  pact: (
    <>
      <circle cx="12" cy="12" r="9" strokeOpacity=".5" />
      <path d="M12 3.6 16.9 18.8 4 9.4h16L7.1 18.8Z" />
    </>
  ),
  duration: <path d="M7 3h10M7 21h10M8 3c0 5 1.5 7 4 9 2.5-2 4-4 4-9M8 21c0-5 1.5-7 4-9 2.5 2 4 4 4 9" />,
  range: (
    <>
      <path d="M3.5 20.5 19 5M13 4.5h6.5V11" />
      <circle cx="5.5" cy="18.5" r="1.6" fill="currentColor" />
    </>
  ),
  lifesteal: <path d="M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11ZM9 14.5c1 1.6 2 2.2 3 2.2s2-.6 3-2.2" />,
  all: (
    <>
      <circle cx="12" cy="6" r="2.4" />
      <circle cx="6" cy="16.5" r="2.4" />
      <circle cx="18" cy="16.5" r="2.4" />
      <path d="M12 12v6M9 15h6" />
    </>
  ),
  empty: <path d="M12 8v8M8 12h8" strokeOpacity=".35" />,
}

/** Ids with painted icons in public/icons (256 px) and public/icons/128. Masteries use a mastery_ prefix. */
const ART_IDS = new Set([
  'fireball', 'scourge', 'redirector', 'pact', 'boomerang', 'lightning', 'homing', 'twin', 'teleport', 'thrust', 'swap',
  'cluster', 'drain', 'bouncer', 'recharge', 'windwalk', 'meteor', 'splitter', 'snowball', 'shield', 'rush', 'alteration',
  'gravity', 'grip', 'warpzone', 'magnetize', 'rockpillar', 'link', 'ring_of_health', 'cursed_ring', 'cape', 'armor',
  'boots', 'pocket_watch', 'mastery_duration', 'mastery_range', 'mastery_lifesteal', 'mastery_all',
])

function artFile(id: string): string | null {
  const file = id === 'duration' || id === 'range' || id === 'lifesteal' || id === 'all' ? `mastery_${id}` : id
  return ART_IDS.has(file) ? file : null
}

/** Files that failed once: render the glyph from then on instead of refetching. */
const failedArt = new Set<string>()

/**
 * Spell / item / mastery icon: the painted art, or the SVG sigil (tinted by
 * the shop column hue) when there is no art or it fails to load.
 */
export function Sigil({ id, size = 40, hue, dim = false }: { id: string | null; size?: number; hue?: string; dim?: boolean }) {
  const [, bump] = useState(0)
  const file = id ? artFile(id) : null
  if (file && !failedArt.has(file)) {
    const base = ASSET_BASE
    return (
      <img
        src={`${base}icons/128/${file}.png`}
        srcSet={`${base}icons/128/${file}.png 128w, ${base}icons/${file}.png 256w`}
        sizes={`${size}px`}
        width={size}
        height={size}
        alt=""
        aria-hidden
        draggable={false}
        decoding="async"
        onError={() => {
          failedArt.add(file)
          bump((n) => n + 1)
        }}
        style={{ display: 'block', width: size, height: size, opacity: dim ? 0.5 : 1, filter: dim ? 'grayscale(0.7)' : undefined }}
      />
    )
  }
  return <Glyph id={id} size={size} hue={hue} dim={dim} />
}

function Glyph({ id, size, hue, dim }: { id: string | null; size: number; hue?: string; dim: boolean }) {
  const color = hue ?? (id === 'duration' || id === 'range' || id === 'lifesteal' || id === 'all' ? MASTERY_HUE : hueFor(id))
  const glyph = (id && G[id]) ?? G.empty
  const gid = `sg-${id ?? 'empty'}`
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ color, display: 'block', opacity: dim ? 0.5 : 1 }}>
      <defs>
        <radialGradient id={gid} cx="50%" cy="40%" r="65%">
          <stop offset="0" stopColor={color} stopOpacity=".34" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </radialGradient>
      </defs>
      {id && <rect x="0" y="0" width="24" height="24" rx="4" fill={`url(#${gid})`} />}
      <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {glyph}
      </g>
    </svg>
  )
}
