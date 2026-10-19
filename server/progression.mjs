// Account-owned Embers and permanent cosmetics. Only the authority records rewards.
import { createHash } from 'node:crypto'
import { COSMETICS, EMPTY_EQUIPMENT } from '../src/game/progressionCatalog.ts'

export const PROGRESSION_POLICY = 1
export const PROGRESSION_SCHEMA = `
CREATE TABLE progression_wallet (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0)
);
CREATE TABLE progression_match (
  match_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  queue TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  policy INTEGER NOT NULL
);
CREATE TABLE progression_reward (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL REFERENCES progression_match(match_id),
  base INTEGER NOT NULL, performance INTEGER NOT NULL, win INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  PRIMARY KEY(user_id, match_id)
);
CREATE INDEX progression_reward_recent ON progression_reward(user_id, match_id);
CREATE TABLE progression_owned (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, item_id)
);
CREATE TABLE progression_equipped (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK(slot IN ('victory', 'robe')),
  item_id TEXT NOT NULL,
  PRIMARY KEY(user_id, slot),
  FOREIGN KEY(user_id, item_id) REFERENCES progression_owned(user_id, item_id)
);
CREATE TABLE progression_purchase (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  price INTEGER NOT NULL,
  purchased_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, request_id)
);
`

export class ProgressionError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const fail = (status, message) => { throw new ProgressionError(status, message) }
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const only = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k))
const int = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max
const accountId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v)
const key = (v) => typeof v === 'string' && /^[A-Za-z0-9:_-]{8,128}$/.test(v)
const DAY = 86_400_000

function validateReceipt(r) {
  if (!only(r, ['matchId', 'queue', 'rulesVersion', 'completedAt', 'durationSeconds', 'players'])
    || !key(r.matchId) || !['quick', 'ranked'].includes(r.queue) || r.rulesVersion !== PROGRESSION_POLICY
    || !int(r.completedAt, 9_000_000_000_000) || !int(r.durationSeconds, 86_400)
    || !Array.isArray(r.players) || r.players.length > 10) fail(400, 'Invalid official progression receipt.')
  const ids = new Set()
  for (const p of r.players) {
    if (!only(p, ['accountId', 'completed', 'aliveSeconds', 'casts', 'damageDealt', 'walked', 'roundsPlayed', 'roundsWon', 'won'])
      || !accountId(p.accountId) || ids.has(p.accountId) || typeof p.completed !== 'boolean' || typeof p.won !== 'boolean'
      || typeof p.aliveSeconds !== 'number' || !Number.isFinite(p.aliveSeconds) || p.aliveSeconds < 0 || p.aliveSeconds > r.durationSeconds + 1
      || !['casts', 'damageDealt', 'walked'].every((k) => int(p[k], 1_000_000_000_000))
      || !int(p.roundsPlayed, 10000) || !int(p.roundsWon, p.roundsPlayed)) fail(400, 'Invalid official progression participant.')
    ids.add(p.accountId)
  }
}

function daily(now) {
  const day = Math.floor(now / DAY)
  // Three of four items, shared globally. No per-player offers or local-clock prices.
  const omitted = ((day % COSMETICS.length) + COSMETICS.length) % COSMETICS.length
  return { offerId: `embers-v1:${day}`, refreshAt: (day + 1) * DAY, offers: COSMETICS.filter((_, i) => i !== omitted) }
}

export function createProgression(db, { now = Date.now } = {}) {
  // Preparing every statement makes an incomplete schema a startup error.
  const user = db.prepare('SELECT id FROM user WHERE id = ?')
  const wallet = db.prepare('SELECT balance FROM progression_wallet WHERE user_id = ?')
  const ensure = db.prepare('INSERT OR IGNORE INTO progression_wallet(user_id) VALUES (?)')
  const credit = db.prepare('UPDATE progression_wallet SET balance = balance + ? WHERE user_id = ?')
  const debit = db.prepare('UPDATE progression_wallet SET balance = balance - ? WHERE user_id = ? AND balance >= ?')
  const priorMatch = db.prepare('SELECT fingerprint FROM progression_match WHERE match_id = ?')
  const addMatch = db.prepare('INSERT INTO progression_match VALUES (?, ?, ?, ?, ?)')
  const addReward = db.prepare('INSERT INTO progression_reward VALUES (?, ?, ?, ?, ?, ?)')
  const rewardsForMatch = db.prepare(`SELECT user_id AS accountId, base, performance, win, balance_after AS balance FROM progression_reward WHERE match_id = ? ORDER BY user_id`)
  const recent = db.prepare(`SELECT r.match_id AS matchId, m.completed_at AS completedAt, r.base, r.performance, r.win, r.balance_after AS balance
    FROM progression_reward r JOIN progression_match m USING(match_id) WHERE r.user_id = ? ORDER BY m.completed_at DESC, m.match_id DESC LIMIT 5`)
  const owned = db.prepare('SELECT item_id AS itemId FROM progression_owned WHERE user_id = ? ORDER BY item_id')
  const owns = db.prepare('SELECT 1 FROM progression_owned WHERE user_id = ? AND item_id = ?')
  const acquire = db.prepare('INSERT INTO progression_owned VALUES (?, ?, ?)')
  const equipment = db.prepare('SELECT slot, item_id AS itemId FROM progression_equipped WHERE user_id = ?')
  const setEquipment = db.prepare('INSERT INTO progression_equipped VALUES (?, ?, ?) ON CONFLICT(user_id, slot) DO UPDATE SET item_id = excluded.item_id')
  const clearEquipment = db.prepare('DELETE FROM progression_equipped WHERE user_id = ? AND slot = ?')
  const previousPurchase = db.prepare('SELECT offer_id AS offerId, item_id AS itemId FROM progression_purchase WHERE user_id = ? AND request_id = ?')
  const addPurchase = db.prepare('INSERT INTO progression_purchase VALUES (?, ?, ?, ?, ?, ?)')
  const requireUser = (id) => { if (!accountId(id) || !user.get(id)) fail(404, 'Account not found.') }
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE')
    try { const result = work(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function getEquipment(id) {
    requireUser(id)
    return Object.assign({ ...EMPTY_EQUIPMENT }, Object.fromEntries(equipment.all(id).map((r) => [r.slot, r.itemId])))
  }
  function snapshot(id) {
    requireUser(id)
    const serverNow = now()
    return {
      policy: PROGRESSION_POLICY, serverNow, ...daily(serverNow),
      balance: wallet.get(id)?.balance ?? 0,
      catalog: COSMETICS, owned: owned.all(id).map((r) => r.itemId), equipped: getEquipment(id),
      recentRewards: recent.all(id).map((r) => ({ ...r, total: r.base + r.performance + r.win })),
    }
  }
  function recordMatch(receipt) {
    validateReceipt(receipt)
    // Canonicalize field and seat order so identical retries survive serialization changes.
    const canonical = [receipt.matchId, receipt.queue, receipt.rulesVersion, receipt.completedAt, receipt.durationSeconds,
      [...receipt.players].sort((a, b) => a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0).map((p) => [p.accountId, p.completed, p.aliveSeconds, p.casts, p.damageDealt, p.walked, p.roundsPlayed, p.roundsWon, p.won])]
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
    return transaction(() => {
      const previous = priorMatch.get(receipt.matchId)
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail(409, 'A different result already owns this match receipt.')
        return { duplicate: true, rewards: rewardsForMatch.all(receipt.matchId) }
      }
      // Verify all identities before writing: a missing account never gives partial rewards.
      for (const p of receipt.players) requireUser(p.accountId)
      addMatch.run(receipt.matchId, fingerprint, receipt.queue, receipt.completedAt, PROGRESSION_POLICY)
      for (const p of receipt.players) {
        if (receipt.durationSeconds < 120 || !p.completed || p.aliveSeconds < 30 || p.roundsPlayed < 2 || p.casts < 5 || (p.damageDealt < 100 && p.walked < 500)) continue
        const base = 20, performance = Math.min(5, p.roundsWon * 2), win = p.won ? 5 : 0
        ensure.run(p.accountId)
        credit.run(base + performance + win, p.accountId)
        addReward.run(p.accountId, receipt.matchId, base, performance, win, wallet.get(p.accountId).balance)
      }
      return { duplicate: false, rewards: rewardsForMatch.all(receipt.matchId) }
    })
  }
  function purchase(id, request) {
    requireUser(id)
    if (!only(request, ['itemId', 'offerId', 'requestId']) || !key(request.requestId) || typeof request.offerId !== 'string' || request.offerId.length > 64) fail(400, 'Invalid purchase request.')
    transaction(() => {
      const previous = previousPurchase.get(id, request.requestId)
      if (previous) {
        if (previous.itemId !== request.itemId || previous.offerId !== request.offerId) fail(409, 'This purchase request was already used.')
        return
      }
      const at = now(), selection = daily(at)
      if (selection.offerId !== request.offerId) fail(409, 'The daily selection changed. Refresh before buying.')
      const item = selection.offers.find((v) => v.id === request.itemId)
      if (!item) fail(400, 'This cosmetic is not in the daily selection.')
      if (owns.get(id, item.id)) fail(409, 'You already own this cosmetic.')
      ensure.run(id)
      if (!debit.run(item.price, id, item.price).changes) fail(409, 'You need more Embers for this cosmetic.')
      acquire.run(id, item.id, at)
      addPurchase.run(id, request.requestId, request.offerId, item.id, item.price, at)
    })
    return snapshot(id)
  }
  function equip(id, request) {
    requireUser(id)
    if (!only(request, ['slot', 'itemId']) || !['victory', 'robe'].includes(request.slot)) fail(400, 'Invalid cosmetic slot.')
    transaction(() => {
      if (request.itemId === null) { clearEquipment.run(id, request.slot); return }
      if (!COSMETICS.some((item) => item.id === request.itemId && item.slot === request.slot)) fail(400, 'That cosmetic does not fit this slot.')
      if (!owns.get(id, request.itemId)) fail(403, 'Unlock this cosmetic before equipping it.')
      setEquipment.run(id, request.slot, request.itemId)
    })
    return snapshot(id)
  }
  return { snapshot, recordMatch, purchase, equip, equipment: getEquipment }
}
