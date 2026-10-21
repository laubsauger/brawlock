/**
 * The options a player last chose for their own custom rooms (offline, peer-to-peer, server
 * custom games), so the next room they open starts from them instead of the defaults.
 * Quick play and ranked rooms keep their queue presets; "Reset to defaults" clears this.
 */
import { DEFAULT_SETTINGS, type MatchSettings } from '../sim'
import { sanitizeSettingsPatch } from '../net/protocol'
import { safeLocalStorage, type KV } from './profile'

const KEY = 'brawlock.roomOptions.v1'

/** Saved choices that differ from the defaults (empty: nothing to apply). */
export function savedRoomOptions(kv: KV | null = safeLocalStorage()): Partial<MatchSettings> {
  try {
    const saved = sanitizeSettingsPatch(JSON.parse(kv?.getItem(KEY) ?? 'null'), DEFAULT_SETTINGS)
    return withoutDefaults(saved)
  } catch {
    return {}
  }
}

/** An owner changed their room's options: remember them for the next room. */
export function rememberRoomOptions(patch: Partial<MatchSettings>, kv: KV | null = safeLocalStorage()): void {
  try {
    const next = withoutDefaults({ ...savedRoomOptions(kv), ...sanitizeSettingsPatch(patch, DEFAULT_SETTINGS) })
    kv?.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage full or blocked: the room still changes, only the memory is lost */
  }
}

function withoutDefaults(options: Partial<MatchSettings>): Partial<MatchSettings> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(options)) if (v !== (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k]) out[k] = v
  return out as Partial<MatchSettings>
}
