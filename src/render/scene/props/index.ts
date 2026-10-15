/**
 * Environment props (pillars + caldera rim dressing).
 *
 * Swap-in for the render core:
 *   import { Environment, Obstacles } from './props'
 * replaces scene/Environment and scene/Obstacles with the same public API.
 */
export { createObstacleVisual, type ObstacleVisual, type ObstacleVisualOpts } from './obstacle'
export { PropObstacles, PropObstacles as Obstacles, OBSTACLE_MAX_HP } from './obstacles'
export { preloadLooks } from './materials'
export { createArenaDressing, PropEnvironment, PropEnvironment as Environment, type ArenaDressing, type ArenaDressingOpts } from './dressing'
