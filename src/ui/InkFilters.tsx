/**
 * Readability halos that follow the shape of the text (not a box): the glyph
 * alpha is dilated, blurred and filled with dark ink, then the glyphs are
 * drawn on top. Applied with CSS `filter: url(#ink-sm|md|lg|xl)` (classes .ink-*
 * in index.css). Small HUD labels hug tightly, big banners get a wide soft halo. Mounted once at the app root.
 */
const INK = '#080402'

const SPECS: { id: string; dilate: number; blur: number; opacity: number }[] = [
  { id: 'ink-sm', dilate: 1, blur: 1.6, opacity: 0.92 },
  { id: 'ink-md', dilate: 2, blur: 3.5, opacity: 0.88 },
  { id: 'ink-lg', dilate: 4, blur: 9, opacity: 0.8 },
  // countdown digits, FIGHT and round banners: thick enough to hold over the brightest lava
  { id: 'ink-xl', dilate: 8, blur: 14, opacity: 0.94 },
]

export function InkFilters() {
  return (
    <svg width="0" height="0" aria-hidden focusable="false" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
      <defs>
        {SPECS.map((s) => (
          <filter key={s.id} id={s.id} x="-25%" y="-60%" width="150%" height="220%" colorInterpolationFilters="sRGB">
            <feMorphology in="SourceAlpha" operator="dilate" radius={s.dilate} result="grown" />
            <feGaussianBlur in="grown" stdDeviation={s.blur} result="soft" />
            <feFlood floodColor={INK} floodOpacity={s.opacity} />
            <feComposite in2="soft" operator="in" result="halo" />
            <feMerge>
              <feMergeNode in="halo" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        ))}
      </defs>
    </svg>
  )
}
