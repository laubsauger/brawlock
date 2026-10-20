import { EMPTY_EQUIPMENT, validCosmeticEquipment, type CosmeticEquipment } from './progressionCatalog'
import { safeLocalStorage } from './profile'

/**
 * What this browser's account last had equipped (from the account authority's progression
 * snapshot), so games without the authority in the loop show it too: offline, practice and a
 * peer-to-peer host's own seat. Region-hosted games ignore it and read verified equipment.
 */
const KEY = 'brawlock.equipped.v1'

function read(): CosmeticEquipment | null {
  try {
    const raw = safeLocalStorage()?.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    // stored by an older build with fewer slots: the new slots start empty
    const value: unknown = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...EMPTY_EQUIPMENT, ...parsed } : null
    return validCosmeticEquipment(value) ? value : null
  } catch {
    return null
  }
}

let equipped: CosmeticEquipment | null = read()

export function localEquipment(): CosmeticEquipment | null {
  return equipped
}

/** Record the authority's equipment (null: signed out or no account). */
export function rememberEquipment(value: CosmeticEquipment | null): void {
  equipped = value && validCosmeticEquipment(value) ? { ...value } : null
  try {
    safeLocalStorage()?.setItem(KEY, equipped ? JSON.stringify(equipped) : 'null')
  } catch {
    // storage blocked: the in-memory copy still serves this visit
  }
}
