/**
 * Screen areas the HUD is using right now, for the world overlay (nameplate stamps, "Melted"
 * callouts) to step back from instead of drawing under them. Viewport px, written by the HUD
 * when a zone appears and cleared when it goes; a new object each time, so readers can cache.
 */
export interface HudZone {
  left: number
  top: number
  right: number
  bottom: number
}

export const hudZones: { streak: HudZone | null } = { streak: null }
