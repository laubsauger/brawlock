import type { Cosmetic, CosmeticEquipment, CosmeticId, CosmeticSlot } from '../src/game/progressionCatalog'
export const PROGRESSION_POLICY: 1
export const PROGRESSION_SCHEMA: string
export class ProgressionError extends Error { status: number }
export interface ProgressionParticipant {
  accountId: string
  completed: boolean
  aliveSeconds: number
  casts: number
  damageDealt: number
  walked: number
  roundsPlayed: number
  roundsWon: number
  won: boolean
}
export interface ProgressionReceipt {
  matchId: string
  queue: 'quick' | 'ranked'
  rulesVersion: 1
  completedAt: number
  durationSeconds: number
  players: ProgressionParticipant[]
}
export interface ProgressionReward { matchId: string; completedAt: number; base: number; performance: number; win: number; total: number; balance: number }
export interface ProgressionSnapshot {
  policy: 1
  serverNow: number
  offerId: string
  refreshAt: number
  balance: number
  catalog: readonly Cosmetic[]
  offers: readonly Cosmetic[]
  owned: CosmeticId[]
  equipped: CosmeticEquipment
  recentRewards: ProgressionReward[]
}
export interface ProgressionPurchase { itemId: CosmeticId; offerId: string; requestId: string }
export interface ProgressionEquip { slot: CosmeticSlot; itemId: CosmeticId | null }
interface Database {
  exec(sql: string): void
  // Node SQLite and the existing test bridge expose this common prepared-statement seam.
  prepare(sql: string): any
}
export function createProgression(db: Database, options?: { now?: () => number }): {
  snapshot(userId: string): ProgressionSnapshot
  recordMatch(receipt: ProgressionReceipt): { duplicate: boolean; rewards: { accountId: string; base: number; performance: number; win: number; balance: number }[] }
  purchase(userId: string, request: ProgressionPurchase): ProgressionSnapshot
  equip(userId: string, request: ProgressionEquip): ProgressionSnapshot
  equipment(userId: string): CosmeticEquipment
}
