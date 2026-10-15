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
