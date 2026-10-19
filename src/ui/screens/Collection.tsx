import { useEffect, useRef, useState } from 'react'
import { equipCosmetic, loadProgression, purchaseCosmetic, type MatchProgression, type ProgressionReward, type ProgressionSnapshot } from '../../game/progression'
import { useAccount } from '../../game/accountState'
import type { Cosmetic, CosmeticSlot } from '../../game/progressionCatalog'
import { Button, Modal, Segmented } from '../widgets'

export function EmberMark({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2c2 6-4 6-2 10 2-1 3-3 4-4 5 5 6 10 1 13-6 4-13-1-12-7 0-3 2-5 4-7-1 5 2 5 2 3-1-3 1-6 3-8Z" fill="#efaa59" /><path d="M12 14c-3 3-3 6 0 7 4-1 3-4 0-7Z" fill="#ffe5a9" /></svg>
}

function CosmeticMark({ item }: { item: Cosmetic }) {
  const pose = item.slot === 'victory'
  return <svg viewBox="0 0 80 80" width="72" height="72" aria-hidden="true" className="shrink-0">
    <circle cx="40" cy="40" r="34" fill={item.swatch} opacity=".08" />
    <path d="m28 62 6-32 6-6 6 6 7 32-13 6Z" fill="#252126" stroke={item.swatch} strokeWidth="1.6" />
    <path d="m32 28 8-14 9 14-9 6Z" fill="#19171d" stroke={item.swatch} strokeWidth="1.6" />
    <path d="m36 26 4-5 5 5-5 3Z" fill="#0d0c10" />
    {pose ? <>
      <path d={item.id === 'victory-ascendant' ? 'm32 34-12-13-2-10m30 23 12-13 2-10' : 'm32 34-13 8-8-10m37 2 10-15-2-8'} fill="none" stroke={item.swatch} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m30 62-5 8m22-8 7 8" fill="none" stroke={item.swatch} strokeWidth="3" strokeLinecap="round" />
      <path d="m8 14 3 3m58-3-3 3M40 5v4" stroke="#ffe0a6" strokeWidth="1.5" />
    </> : <>
      <path d="m33 33-10 10 2 13 7-3m15-20 10 10-2 13-7-3" fill="#252126" stroke={item.swatch} strokeWidth="1.6" />
      <path d="m33 36 7 5 7-5m-13 8 6 4 6-4m-12 9 6 4 6-4" fill="none" stroke={item.swatch} strokeWidth="2.2" />
    </>}
  </svg>
}

function refreshLabel(remaining: number): string {
  const minutes = Math.max(0, Math.ceil(remaining / 60_000))
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function Collection({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<ProgressionSnapshot | null>(null)
  const [tab, setTab] = useState<'selection' | 'owned'>('selection')
  const [busy, setBusy] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const receivedAt = useRef(0)
  const pendingKeys = useRef(new Map<string, string>())
  const live = useRef(true)
  const publish = (next: ProgressionSnapshot) => { receivedAt.current = performance.now(); setElapsed(0); setState(next) }
  const run = async (action: () => Promise<ProgressionSnapshot>, success?: string) => {
    setBusy(true); setProblem(null); setNotice(null)
    try { const next = await action(); if (live.current) { publish(next); if (success) setNotice(success) } }
    catch (error) { if (live.current) setProblem(error instanceof Error ? error.message : 'Collection request failed.') }
    finally { if (live.current) setBusy(false) }
  }
  useEffect(() => {
    live.current = true
    void run(loadProgression)
    const timer = window.setInterval(() => setElapsed(performance.now() - receivedAt.current), 30_000)
    return () => { live.current = false; window.clearInterval(timer) }
  }, [])
  const remaining = state ? state.refreshAt - state.serverNow - elapsed : 0
  const buy = (item: Cosmetic) => {
    if (!state) return
    const requestKey = `${state.offerId}:${item.id}`
    let requestId = pendingKeys.current.get(requestKey)
    if (!requestId) { requestId = crypto.randomUUID(); pendingKeys.current.set(requestKey, requestId) }
    void run(() => purchaseCosmetic({ itemId: item.id, offerId: state.offerId, requestId }), `${item.name} unlocked.`)
  }
  const equip = (slot: CosmeticSlot, item: Cosmetic | null) => void run(() => equipCosmetic({ slot, itemId: item?.id ?? null }), item ? `${item.name} equipped for your next game.` : 'Starter style equipped for your next game.')

  return <Modal title="Collection" onClose={onClose} width="max-w-2xl" className="h-[min(650px,92dvh)]">
    <div className="flex h-full min-h-0 flex-col gap-4" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ffa85a]/15 pb-3">
        <div className="flex items-center gap-2 text-[#ffe0a6]"><EmberMark size={26} /><span className="tabular text-2xl font-bold">{state ? state.balance.toLocaleString() : '—'}</span><span className="text-sm text-ash">Embers</span></div>
        <Segmented label="Collection view" value={tab} onChange={setTab} options={[{ value: 'selection', label: 'Daily selection' }, { value: 'owned', label: 'Your collection' }]} />
      </div>
      {problem && <div role="alert" className="flex items-center justify-between gap-3 rounded border border-red-400/30 bg-red-950/30 px-3 py-2 text-sm text-red-200"><span>{problem}</span><Button size="sm" disabled={busy} onClick={() => void run(loadProgression)}>Refresh</Button></div>}
      {notice && <p role="status" className="text-sm text-[#b9d8b1]">{notice}</p>}
      {!state ? <p role="status" className="text-sm text-ash">{busy ? 'Opening your collection…' : 'Your collection could not be loaded.'}</p> : <>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {tab === 'selection' ? <>
            <div className="mb-3 flex items-center justify-between gap-3 text-xs text-ash"><span>Permanent cosmetics · no combat bonuses</span><span>{remaining > 0 ? `Refreshes in ${refreshLabel(remaining)} · UTC` : 'New selection available'}{remaining <= 0 && <Button size="sm" disabled={busy} className="ml-2" onClick={() => void run(loadProgression)}>Refresh</Button>}</span></div>
            {state.offers.map((item) => {
              const owned = state.owned.includes(item.id)
              return <div key={item.id} className="flex items-center gap-3 border-t border-[#ffa85a]/10 py-3">
                <CosmeticMark item={item} />
                <div className="min-w-0 flex-1"><div className="text-xs uppercase tracking-wider text-ash">{item.slot === 'victory' ? 'Victory pose' : 'Robe cloth'}</div><h3 className="text-lg font-semibold text-bone">{item.name}</h3><p className="max-w-sm text-sm leading-snug text-ash">{item.description}</p></div>
                {owned ? <span className="min-w-20 text-center text-sm text-[#b9d8b1]">Owned</span> : <Button size="sm" disabled={busy || state.balance < item.price || remaining <= 0} aria-label={`Unlock ${item.name} for ${item.price} Embers`} onClick={() => buy(item)}><span className="flex items-center gap-1.5"><EmberMark size={16} />{item.price}</span></Button>}
              </div>
            })}
          </> : <>
            {(['victory', 'robe'] as const).map((slot) => <div key={slot} className="mb-5">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[#d7b181]">{slot === 'victory' ? 'Victory poses' : 'Robe cloth'}</h3>
              <div className="mb-1 flex items-center justify-between gap-3 border-t border-[#ffa85a]/10 py-2"><div><div className="font-semibold text-bone">{slot === 'victory' ? 'Classic celebrations' : 'Original weave'}</div><p className="text-xs text-ash">{slot === 'victory' ? 'Your original mix of dances, summons and flourishes.' : 'The original warlock cloth.'}</p></div><Button size="sm" disabled={busy || state.equipped[slot] === null} onClick={() => equip(slot, null)}>{state.equipped[slot] === null ? 'Equipped' : 'Equip'}</Button></div>
              {state.catalog.filter((item) => item.slot === slot && state.owned.includes(item.id)).map((item) => <div key={item.id} className="flex items-center gap-3 border-t border-[#ffa85a]/10 py-1.5"><CosmeticMark item={item} /><div className="min-w-0 flex-1"><div className="font-semibold text-bone">{item.name}</div><p className="text-xs text-ash">{item.description}</p></div><Button size="sm" disabled={busy || state.equipped[slot] === item.id} onClick={() => equip(slot, item)}>{state.equipped[slot] === item.id ? 'Equipped' : 'Equip'}</Button></div>)}
            </div>)}
          </>}
        </div>
        <p className="border-t border-[#ffa85a]/15 pt-3 text-xs leading-relaxed text-ash">Earn Embers by finishing official Casual or Ranked games. A played loss earns a base reward; round wins and match victories add a little more. Cosmetics apply when you enter your next game.</p>
      </>}
    </div>
  </Modal>
}

/** A confirmed server receipt, never a client-calculated reward or optimistic balance. */
export function EmberReward({ reward, balance, onCollection }: { reward: ProgressionReward; balance: number; onCollection: () => void }) {
  const [shown, setShown] = useState(reward.total)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(reward.total); return }
    const started = performance.now()
    let frame = 0
    const tick = (at: number) => {
      const t = Math.min(1, (at - started) / 650)
      setShown(Math.round(reward.total * (1 - (1 - t) ** 3)))
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [reward.matchId, reward.total])
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-[#efaa59]/25 bg-[#2a1c12]/70 px-4 py-3">
    <div><div className="flex items-center gap-2 text-[#ffe0a6]"><EmberMark /><strong className="tabular text-xl">+{shown}</strong><span className="font-semibold">Embers</span></div><p className="mt-1 text-xs text-ash">Completed {reward.base}{reward.performance > 0 ? ` · Round wins +${reward.performance}` : ''}{reward.win > 0 ? ` · Match win +${reward.win}` : ''}</p></div>
    <Button size="sm" onClick={onCollection}><span className="tabular">{(balance === reward.balance ? balance - reward.total + shown : balance).toLocaleString()} Embers · Collection</span></Button>
  </div>
}

/** One result read plus explicit retry. Regional delivery can finish after the match UI. */
export function MatchEmbers({ progression, onCollection }: { progression: MatchProgression; onCollection: () => void }) {
  const accountId = useAccount((s) => s.player?.id ?? null)
  const [state, setState] = useState<{ accountId: string | null; matchId: string; snapshot: ProgressionSnapshot | null; problem: string | null; busy: boolean }>({ accountId, matchId: progression.matchId, snapshot: null, problem: null, busy: true })
  const generation = useRef(0)
  const refresh = async () => {
    const current = ++generation.current
    setState({ accountId, matchId: progression.matchId, snapshot: null, problem: null, busy: true })
    try {
      const snapshot = await loadProgression()
      if (current === generation.current) setState({ accountId, matchId: progression.matchId, snapshot, problem: null, busy: false })
    } catch (error) {
      if (current === generation.current) setState({ accountId, matchId: progression.matchId, snapshot: null, problem: error instanceof Error ? error.message : 'Could not check your Embers.', busy: false })
    }
  }
  useEffect(() => {
    if (accountId && progression.status !== 'ineligible') void refresh()
    return () => { generation.current++ }
  }, [accountId, progression.matchId, progression.status])
  if (!accountId) return <p className="text-center text-sm text-ash">Sign in before your next game to earn Embers for cosmetics.</p>
  const current = state.matchId === progression.matchId && state.accountId === accountId ? state : null
  const reward = current?.snapshot?.recentRewards.find((r) => r.matchId === progression.matchId)
  if (reward && current?.snapshot) return <EmberReward reward={reward} balance={current.snapshot.balance} onCollection={onCollection} />
  const ineligible = progression.status === 'ineligible' || (progression.status === 'awarded' && !!current?.snapshot)
  const busy = !ineligible && (!current || current.busy)
  const unavailable = progression.status === 'unavailable'
  return <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 rounded border border-[#efaa59]/15 bg-[#21180f]/60 px-4 py-3 text-sm">
    <div className="flex min-w-0 flex-1 items-center gap-2"><EmberMark /><p className={current?.problem || unavailable ? 'text-red-200' : 'text-ash'} role={current?.problem || unavailable ? 'alert' : 'status'}>{ineligible ? 'No Embers this time. Rewards need a completed official game with active participation.' : busy ? 'Checking your match reward…' : current?.problem ?? (unavailable ? 'The server could not save this match reward. Check reward to see whether it recovered.' : 'Your match reward is waiting for the account service. You can leave safely.')}</p></div>
    {ineligible ? <Button size="sm" onClick={onCollection}>Collection</Button> : <Button size="sm" disabled={busy} onClick={() => void refresh()}>Check reward</Button>}
  </div>
}
