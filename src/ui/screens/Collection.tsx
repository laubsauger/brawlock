import { useEffect, useMemo, useRef, useState } from 'react'
import { equipCosmetic, loadProgression, purchaseCosmetic, type MatchProgression, type ProgressionReward, type ProgressionSnapshot } from '../../game/progression'
import { useAccount } from '../../game/accountState'
import { getProfile } from '../../game/profile'
import { COSMETICS, COSMETIC_SLOTS, EMPTY_EQUIPMENT, type Cosmetic, type CosmeticEquipment, type CosmeticId, type CosmeticSlot, type VictoryCosmeticId } from '../../game/progressionCatalog'
import { WardrobeStage, type StageControls, type StagePose, type ThumbRequest, type WardrobeView } from '../../render/WardrobeStage'
import { NO_OUTFIT, type Outfit } from '../../render/character/wardrobe'
import { victoryStyle, type VictoryStyle } from '../../render/character/victoryPose'
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

const SLOT_LABEL: Record<CosmeticSlot, string> = { head: 'Head', back: 'Back', robe: 'Robe', emblem: 'Emblem', staff: 'Staff', victory: 'Victory' }
const SLOT_NONE: Record<CosmeticSlot, { name: string; description: string }> = {
  head: { name: 'Bare hood', description: 'Nothing on your head.' },
  back: { name: 'Nothing', description: 'A clean silhouette.' },
  robe: { name: 'Original robe', description: 'The classic warlock cloth.' },
  emblem: { name: 'Plain cape', description: 'Nothing printed on your back.' },
  staff: { name: 'Bare hands', description: 'Spells leave from your palms.' },
  victory: { name: 'Classic celebrations', description: 'Your original mix of dances, summons and flourishes.' },
}
/** where the stage looks while browsing a slot */
const SLOT_VIEW: Record<CosmeticSlot, WardrobeView> = { head: 'head', back: 'back', robe: 'full', emblem: 'back', staff: 'full', victory: 'full' }

function StageIcon({ d }: { d: string }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
}

const POSES: { value: StagePose; label: string }[] = [{ value: 'idle', label: 'Idle' }, { value: 'walk', label: 'Walk' }, { value: 'run', label: 'Run' }, { value: 'cast', label: 'Cast' }, { value: 'victory', label: 'Victory' }]
const TURN = Math.PI / 4

const toOutfit = (e: CosmeticEquipment): Outfit => ({ head: e.head, back: e.back, robe: e.robe, emblem: e.emblem, staff: e.staff })

/**
 * The wardrobe: your warlock in 3D wearing what you try on, every piece with a rendered
 * picture, and buying and equipping in one place. Guests can browse and try everything on;
 * Embers and ownership need an account.
 */
export function Collection({ onClose, onSignIn }: { onClose: () => void; onSignIn?: () => void }) {
  const signedIn = useAccount((s) => !!s.player)
  const [state, setState] = useState<ProgressionSnapshot | null>(null)
  const [slot, setSlot] = useState<CosmeticSlot>('head')
  const [busy, setBusy] = useState(signedIn)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [view, setView] = useState<WardrobeView>('head')
  const [pose, setPose] = useState<StagePose>('idle')
  const stage = useRef<StageControls | null>(null)
  // the outfit on the stage: equipped pieces, with whatever you clicked tried on top
  const [tryOn, setTryOn] = useState<Partial<Record<CosmeticSlot, CosmeticId | null>>>({})
  const [pics, setPics] = useState<Record<string, string>>({})
  const pendingKeys = useRef(new Map<string, string>())
  const live = useRef(true)
  const run = async (action: () => Promise<ProgressionSnapshot>, success?: string) => {
    setBusy(true); setProblem(null); setNotice(null)
    try { const next = await action(); if (live.current) { setState(next); if (success) setNotice(success) } }
    catch (error) { if (live.current) setProblem(error instanceof Error ? error.message : 'Wardrobe request failed.') }
    finally { if (live.current) setBusy(false) }
  }
  useEffect(() => {
    live.current = true
    if (signedIn) void run(loadProgression)
    return () => { live.current = false }
  }, [signedIn])
  const catalog = state?.catalog ?? COSMETICS
  const owned = new Set(state?.owned ?? [])
  const equipped: CosmeticEquipment = state?.equipped ?? EMPTY_EQUIPMENT
  const worn = { ...equipped, ...tryOn } as CosmeticEquipment
  const outfit = useMemo(() => toOutfit(worn), [worn.head, worn.back, worn.robe, worn.emblem, worn.staff])
  const color = getProfile().color ?? 0xff7700
  const thumbs = useMemo<ThumbRequest[]>(() => COSMETICS.filter((c) => c.slot !== 'victory').map((c) => ({
    key: c.id,
    outfit: { ...NO_OUTFIT, [c.slot]: c.id },
    view: c.slot === 'head' ? 'head' : c.slot === 'robe' || c.slot === 'staff' ? 'full' : 'back',
  })), [])
  const pick = (next: CosmeticSlot) => {
    setSlot(next)
    setView(SLOT_VIEW[next])
    // the victory tab plays the pose; leaving it stops the celebration
    if (next === 'victory') setPose('victory')
    else if (pose === 'victory') setPose('idle')
  }
  const selectedId = worn[slot]
  const selected = catalog.find((c) => c.id === selectedId) ?? null
  // one request id per offer and item, so a retried purchase is never charged twice
  const purchase = (offerId: string, item: Cosmetic) => {
    const requestKey = `${offerId}:${item.id}`
    let requestId = pendingKeys.current.get(requestKey)
    if (!requestId) { requestId = crypto.randomUUID(); pendingKeys.current.set(requestKey, requestId) }
    return purchaseCosmetic({ itemId: item.id, offerId, requestId })
  }
  const buy = (item: Cosmetic) => {
    if (!state) return
    void run(() => purchase(state.offerId, item), `${item.name} unlocked. Equip it to wear it.`)
  }
  const equip = (target: CosmeticSlot, item: Cosmetic | null) => void run(async () => {
    const next = await equipCosmetic({ slot: target, itemId: item?.id ?? null })
    setTryOn((t) => ({ ...t, [target]: undefined }))
    return next
  }, item ? `${item.name} equipped. It shows from your next game.` : `${SLOT_NONE[target].name} equipped.`)
  // the tried-on look: every slot that differs from what is equipped, and what it costs to own
  const lookSlots = COSMETIC_SLOTS.filter((k) => tryOn[k] !== undefined && tryOn[k] !== equipped[k])
  const tryOnChanged = lookSlots.length > 0
  const toUnlock = lookSlots.map((k) => catalog.find((c) => c.id === tryOn[k])).filter((c): c is Cosmetic => !!c && !owned.has(c.id))
  const lookCost = toUnlock.reduce((sum, c) => sum + c.price, 0)
  const wearLook = () => {
    if (!state) return
    const { offerId } = state
    void run(async () => {
      try {
        for (const item of toUnlock) await purchase(offerId, item)
        let next = state
        for (const k of lookSlots) next = await equipCosmetic({ slot: k, itemId: tryOn[k] ?? null })
        setTryOn({})
        return next
      } catch (error) {
        // part of the look may already be bought or worn: show what the authority has now
        const now = await loadProgression().catch(() => null)
        if (now && live.current) setState(now)
        throw error
      }
    }, toUnlock.length > 0 ? `Unlocked ${toUnlock.length === 1 ? toUnlock[0].name : `${toUnlock.length} pieces`} and wore this look. It shows from your next game.` : 'Look equipped. It shows from your next game.')
  }

  const itemCard = (item: Cosmetic | null) => {
    const id = item?.id ?? null
    const isWorn = worn[slot] === id
    const isEquipped = equipped[slot] === id
    const has = !item || owned.has(item.id)
    return <button key={id ?? 'none'} type="button" onClick={() => setTryOn((t) => ({ ...t, [slot]: id }))}
      aria-pressed={isWorn} aria-label={`${item?.name ?? SLOT_NONE[slot].name}${isEquipped ? ', equipped' : has ? ', owned' : `, ${item!.price} Embers`}`}
      className={`group relative flex flex-col overflow-hidden rounded-md border text-left transition ${isWorn ? 'border-gold bg-[#2a1c12]' : 'border-[#ffa85a]/15 bg-black/30 hover:border-[#ffa85a]/45'}`}>
      <div className="relative aspect-square w-full bg-[#0d0a0a]">
        {item && pics[item.id] ? <img src={pics[item.id]} alt="" className="h-full w-full object-cover" draggable={false} />
          : item?.slot === 'victory' ? <div className="flex h-full items-center justify-center"><CosmeticMark item={item} /></div>
          : <div className="flex h-full items-center justify-center text-xs text-ash">{item ? 'Rendering…' : '—'}</div>}
        {isEquipped && <span className="absolute top-1 left-1 rounded bg-[#1d3a1f]/90 px-1.5 py-0.5 text-[0.65rem] font-bold tracking-wider text-[#b9e8b1] uppercase">Equipped</span>}
      </div>
      <div className="flex items-center justify-between gap-1 px-2 py-1.5">
        <span className="truncate text-sm font-semibold text-bone">{item?.name ?? SLOT_NONE[slot].name}</span>
        {item && !has && <span className="flex shrink-0 items-center gap-0.5 text-xs text-[#ffe0a6]"><EmberMark size={12} />{item.price}</span>}
      </div>
    </button>
  }

  return <Modal title="Wardrobe" onClose={onClose} width="max-w-6xl" className="h-[min(780px,94dvh)]">
    <div className="flex h-full min-h-0 flex-col gap-3" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ffa85a]/15 pb-3">
        <div className="flex items-center gap-2 text-[#ffe0a6]"><EmberMark size={26} /><span className="tabular text-2xl font-bold">{state ? state.balance.toLocaleString() : '—'}</span><span className="text-sm text-ash">Embers</span></div>
        <Segmented label="Wardrobe slot" value={slot} onChange={pick} options={COSMETIC_SLOTS.map((v) => ({ value: v, label: SLOT_LABEL[v] }))} />
      </div>
      {problem && <div role="alert" className="flex items-center justify-between gap-3 rounded border border-red-400/30 bg-red-950/30 px-3 py-2 text-sm text-red-200"><span>{problem}</span><Button size="sm" disabled={busy} onClick={() => void run(loadProgression)}>Refresh</Button></div>}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="relative min-h-64 overflow-hidden rounded-md border border-[#ffa85a]/15">
          <WardrobeStage className="absolute inset-0" color={color} outfit={outfit} view={view} pose={pose} victory={victoryPreview(worn.victory)} controls={stage} thumbs={thumbs} onThumbs={setPics} />
          <div className="absolute top-2 right-2 left-2 flex flex-wrap items-start justify-between gap-2">
            <Segmented label="Pose" value={pose} onChange={setPose} options={POSES} />
            <div className="flex gap-1" title="Drag to turn, scroll to zoom">
              <Button size="sm" variant="ghost" aria-label="Turn left" onClick={() => stage.current?.turn(-TURN)}><StageIcon d="M15 5 8 12l7 7" /></Button>
              <Button size="sm" variant="ghost" aria-label="Turn right" onClick={() => stage.current?.turn(TURN)}><StageIcon d="m9 5 7 7-7 7" /></Button>
              <Button size="sm" variant="ghost" aria-label="Zoom out" onClick={() => stage.current?.zoom(1 / 1.25)}><StageIcon d="M5 12h14" /></Button>
              <Button size="sm" variant="ghost" aria-label="Zoom in" onClick={() => stage.current?.zoom(1.25)}><StageIcon d="M5 12h14M12 5v14" /></Button>
            </div>
          </div>
          <div className="absolute right-2 bottom-2 left-2 flex flex-wrap items-center justify-between gap-2">
            <Segmented label="Camera" value={view} onChange={setView} options={[...(SLOT_VIEW[slot] !== 'full' ? [{ value: SLOT_VIEW[slot], label: SLOT_VIEW[slot] === 'back' ? 'Back' : 'Close' }] : []), { value: 'full' as const, label: 'Full' }, { value: 'game', label: 'In game' }]} />
            {tryOnChanged && <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setTryOn({})}>Back to equipped</Button>
              {signedIn && state && <Button size="sm" variant="primary" disabled={busy || state.balance < lookCost} onClick={wearLook}
                aria-label={lookCost > 0 ? `Unlock ${toUnlock.length} pieces for ${lookCost} Embers and wear this look` : 'Wear this look'}
                title={state.balance < lookCost ? `${lookCost - state.balance} more Embers needed` : undefined}>
                {lookCost > 0 ? <span className="flex items-center gap-1.5">Get this look <EmberMark size={16} />{lookCost}</span> : 'Wear this look'}
              </Button>}
            </div>}
          </div>
        </div>
        <div className="flex min-h-0 flex-col gap-3">
          <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-3 gap-2 overflow-y-auto pr-1 lg:grid-cols-4">
            {itemCard(null)}
            {catalog.filter((c) => c.slot === slot).map((c) => itemCard(c))}
          </div>
          <div className="rounded-md border border-[#ffa85a]/15 bg-black/30 p-3">
            <div className="text-xs tracking-wider text-ash uppercase">{SLOT_LABEL[slot]}</div>
            <h3 className="text-lg font-semibold text-bone">{selected?.name ?? SLOT_NONE[slot].name}</h3>
            <p className="mb-3 text-sm leading-snug text-ash">{selected?.description ?? SLOT_NONE[slot].description}</p>
            {notice && <p role="status" className="mb-2 text-sm text-[#b9d8b1]">{notice}</p>}
            {!signedIn ? <div className="flex flex-wrap items-center gap-3">
                {onSignIn && <Button size="sm" variant="primary" onClick={onSignIn}>Sign in</Button>}
                <p className="text-sm text-[#f0d9b8]">{onSignIn ? 'to' : 'Sign in to'} earn Embers and unlock pieces. Try anything on.</p>
              </div>
              : !selected ? <Button size="sm" disabled={busy || equipped[slot] === null} onClick={() => equip(slot, null)}>{equipped[slot] === null ? 'Equipped' : `Wear ${SLOT_NONE[slot].name.toLowerCase()}`}</Button>
              : owned.has(selected.id) ? <Button size="sm" variant="primary" disabled={busy || equipped[slot] === selected.id} onClick={() => equip(slot, selected)}>{equipped[slot] === selected.id ? 'Equipped' : 'Equip'}</Button>
              : <Button size="sm" variant="primary" disabled={busy || !state || state.balance < selected.price} aria-label={`Unlock ${selected.name} for ${selected.price} Embers`} onClick={() => buy(selected)}><span className="flex items-center gap-1.5">Unlock <EmberMark size={16} />{selected.price}</span></Button>}
            {signedIn && state && selected && !owned.has(selected.id) && state.balance < selected.price && <p className="mt-2 text-xs text-ash">{selected.price - state.balance} more Embers needed.</p>}
          </div>
        </div>
      </div>
      <p className="border-t border-[#ffa85a]/15 pt-2 text-xs leading-relaxed text-ash">Looks only: same hitbox, no combat effect, glow in your player color. Embers come from official Casual and Ranked games.</p>
    </div>
  </Modal>
}

function victoryPreview(id: CosmeticId | null): VictoryStyle {
  return victoryStyle(0, 0, id as VictoryCosmeticId | null)
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
