/**
 * Public render API (consumed by src/ui). Everything else in src/render is
 * internal.
 */
export { GpuCanvas } from './GpuCanvas'
export { MatchView, type MatchViewProps } from './MatchView'
export { MenuBackdrop } from './MenuBackdrop'
export { toWorld, toGame, S as RENDER_SCALE, TILE_TOP_H, LAVA_H } from './coords'
export { recenterCamera, zoomCamera, showMoveMarker, cameraListener, cameraParams, ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT } from './cameraRig'
export { renderStats, type RenderStats } from './stats'
export { TIERS, tierConfig, type TierConfig } from './quality'

// Character warlocks: start loading the CC0 rig as soon as the render module is
// imported (the UI imports it during the splash), so matches don't hitch.
import { preloadWarlock } from './character'
export { preloadWarlock, warlockReady, warlockParams } from './character'
void preloadWarlock().catch((err) => console.warn('preloadWarlock failed; using the procedural warlock', err))
