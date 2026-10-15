/**
 * Spell VFX module registrations. VFX workstreams append one import per
 * module here; each module calls registerSpellVfx() at import time.
 *
 *   import './lightning'
 *
 * Fireball, Scourge and Teleport are still drawn by the built-in handlers in
 * scene/MatchWorld.ts and scene/Projectiles.ts; a module registered for one
 * of those spells takes over (built-ins are skipped for claimed spells).
 */
export {}

// ---- workstream A (columns 1-3: Knockout, Transport, Damage; items Redirector, Pact) ----
import './homing'
import './boomerang'
import './lightning'
// ---- end workstream A ----

// ---- workstream B (columns 4-6: Devastator, Defense, Knockbackless) ----
import './meteor'
import './splitter'
import './snowball'
// ---- end workstream B ----
