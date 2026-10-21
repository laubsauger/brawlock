import { useEffect, useMemo, useState } from 'react'
import { accountAuth, accountCallbackURL, accountProviders, refreshAccount, saveAccountProfile, signOutAccount, type AccountProvider } from '../../game/account'
import { useAccount } from '../../game/accountState'
import { getProfile } from '../../game/profile'
import { Button, Modal } from '../widgets'
import { PreferredColorPicker } from './PlayerColorPicker'
import { beginAccountReturn, cancelAccountReturn } from '../../game/accountReturn'
import { localEquipment } from '../../game/wardrobe'
import { EMPTY_EQUIPMENT } from '../../game/progressionCatalog'
import { WardrobeStage } from '../../render/WardrobeStage'
import { EmblemBadge } from '../EmblemBadge'

const PROVIDER_LABEL = { google: 'Google', discord: 'Discord', microsoft: 'Microsoft' }

/** Your warlock as others will see it: equipped look, the color being picked, emblem and name. */
function PlayerPreview({ name, color, onWardrobe }: { name: string; color: number | null; onWardrobe?: () => void }) {
  const [worn] = useState(() => localEquipment() ?? EMPTY_EQUIPMENT)
  const outfit = useMemo(() => ({ head: worn.head, back: worn.back, robe: worn.robe, emblem: worn.emblem, staff: worn.staff }), [worn])
  // the wardrobe's fallback when no preferred color is set
  const shown = color ?? 0xff7700
  return <div className="relative min-h-80 overflow-hidden rounded-md border border-[#ffa85a]/15" data-testid="account-preview">
    <WardrobeStage className="absolute inset-0" color={shown} outfit={outfit} view="full" />
    <div className="pointer-events-none absolute right-2 bottom-2 left-2 flex items-center gap-2 rounded bg-black/55 px-3 py-2">
      {worn.emblem && <EmblemBadge emblem={worn.emblem} color={`#${shown.toString(16).padStart(6, '0')}`} size={28} />}
      <span className="min-w-0 flex-1 truncate text-lg font-bold text-bone">{name.trim() || 'Your name'}</span>
      {onWardrobe && <Button size="sm" variant="ghost" className="pointer-events-auto" onClick={onWardrobe}>Wardrobe</Button>}
    </div>
  </div>
}

export function Account({ onClose, rankedRegion, onContinue, initialProblem, mode, onWardrobe }: { onClose: () => void; rankedRegion?: string; onContinue?: () => void; initialProblem?: string; mode?: 'onboarding' | 'settings'; onWardrobe?: () => void }) {
  const player = useAccount((state) => state.player)
  const [settingsView] = useState(() => mode === 'settings' || (!mode && !!player?.profile && !rankedRegion))
  const [providers, setProviders] = useState<AccountProvider[]>([])
  const [busy, setBusy] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [name, setName] = useState(getProfile().name)
  const [color, setColor] = useState<number | null>(getProfile().color)
  const load = async () => {
    const [config, account] = await Promise.all([accountProviders(), refreshAccount()])
    setProviders(config.providers)
    if (account?.profile) { setName(account.profile.name); setColor(account.profile.color) }
    return account
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setProblem(null); setNotice(null)
    try { await action() } catch (error) { setProblem(error instanceof Error ? error.message : 'Account request failed.') }
    finally { setBusy(false) }
  }
  const complete = () => { if (rankedRegion) onContinue?.(); else onClose() }
  useEffect(() => { void run(async () => {
    const account = await load()
    if (account?.profile && !settingsView && !initialProblem) complete()
    if (initialProblem) setProblem(initialProblem)
  }) }, [])
  const check = (result: { error: { message?: string } | null }) => { if (result.error) throw new Error(result.error.message ?? 'Sign-in could not be completed.') }
  const oauth = async (action: (callbackURL: string) => Promise<{ error: { message?: string } | null }>, settings = false) => {
    const callbackURL = beginAccountReturn(accountCallbackURL(window.location.origin, import.meta.env.BASE_URL, rankedRegion), settings)
    try { check(await action(callbackURL)) }
    catch (error) { cancelAccountReturn(); throw error }
  }
  const editingSettings = settingsView && !!player?.profile

  return <Modal title={player ? editingSettings ? 'Account settings' : 'Set up your player' : 'Sign in'} onClose={onClose} width={player ? 'max-w-3xl' : 'max-w-md'} help={false}>
    <div className={player ? 'grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]' : ''}>
    {player && <PlayerPreview name={name} color={color} onWardrobe={editingSettings ? onWardrobe : undefined} />}
    <div className="flex min-h-72 flex-col gap-4" aria-busy={busy}>
      {problem && <p role="alert" className="rounded border border-red-400/40 bg-red-950/40 p-3 text-sm text-red-200">{problem}</p>}
      {notice && <p role="status" className="text-sm text-[#a5d6ce]">{notice}</p>}
      {rankedRegion && !player && <p className="rounded border border-[#aaa9c8]/30 bg-[#28212b] px-3 py-2 text-sm text-[#e7d9ee]">Sign in to play ranked and keep your Elo across computers.</p>}
      {!player ? <>
        <p className="text-sm leading-relaxed text-ash">Keep your account across computers. Casual games are also available as a guest.</p>
        <div className="flex flex-col gap-2">
          {providers.map((provider) => <Button key={provider} disabled={busy} onClick={() => void run(() => oauth((callbackURL) => accountAuth.signIn.social({ provider, callbackURL, errorCallbackURL: callbackURL })))}>Continue with {PROVIDER_LABEL[provider]}</Button>)}
          <Button disabled={busy} variant="ghost" onClick={() => void run(async () => {
            check(await accountAuth.signIn.passkey())
            const account = await load()
            if (account?.profile && !settingsView) complete()
          })}>Sign in with a passkey</Button>
        </div>
        <p className="text-xs leading-relaxed text-ash">First time? Use a sign-in provider, then add a passkey to your account. Your email stays private.</p>
        <p className="text-xs leading-relaxed text-ash">Read our <a href={`${import.meta.env.BASE_URL}privacy.html`} target="_blank" rel="noopener noreferrer" className="text-bone underline underline-offset-2">Privacy Policy<span className="sr-only"> (opens in a new tab)</span></a> and <a href={`${import.meta.env.BASE_URL}terms.html`} target="_blank" rel="noopener noreferrer" className="text-bone underline underline-offset-2">Terms of Service<span className="sr-only"> (opens in a new tab)</span></a>.</p>
      </> : <>
        <p className="min-w-0 text-sm text-ash">Signed in as <span className="break-all font-semibold text-bone">{player.email}</span></p>
        <form className="flex flex-col gap-4" onSubmit={(event) => {
          event.preventDefault()
          if (busy || name.trim().length < 3) return
          void run(async () => {
            const saved = await saveAccountProfile({ name, color }, !!player.profile)
            if (saved.profile) { setName(saved.profile.name); setColor(saved.profile.color) }
            if (editingSettings) setNotice('Player name and color saved.')
            else complete()
          })
        }}>
        <label className="flex flex-col gap-2 text-sm text-ash">Player name
          <input className="field" aria-label="Account player name" autoComplete="nickname" spellCheck={false} maxLength={16} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="-mt-2 text-xs text-ash">3–16 letters, numbers or underscores. Start with a letter.{editingSettings ? ' Changing your name releases the old one.' : ''}</p>
        <fieldset disabled={busy} className={busy ? 'min-w-0 opacity-60' : 'min-w-0'}><PreferredColorPicker color={color} onChange={setColor} /></fieldset>
        <Button type="submit" variant="primary" disabled={busy || name.trim().length < 3}>{editingSettings ? 'Save player' : rankedRegion ? 'Save and play ranked' : 'Finish setup'}</Button>
        </form>
        {editingSettings ? <details className="border-t border-white/10 pt-3 text-sm text-ash"><summary className="cursor-pointer">Sign-in methods</summary>
        <div className="mt-3 flex flex-col gap-3"><Button disabled={busy} onClick={() => void run(async () => {
          check(await accountAuth.passkey.addPasskey({ name: `Brawlock · ${player.profile?.name ?? 'Player'}` }))
          setNotice('Passkey added. You can use it to sign in next time.')
        })}>Add a passkey</Button>
        <details className="text-sm text-ash"><summary className="cursor-pointer">Link another sign-in</summary>
          <p className="my-2 text-xs leading-relaxed">Use the same email with your other provider. Linking keeps both sign-ins on this account.</p>
          <div className="flex flex-wrap gap-2">{providers.map((provider) => <Button key={provider} size="sm" disabled={busy} onClick={() => void run(() => oauth((callbackURL) => accountAuth.linkSocial({ provider, callbackURL }), true))}>{PROVIDER_LABEL[provider]}</Button>)}</div>
        </details>
        <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await signOutAccount(); setName(getProfile().name); setColor(getProfile().color) })}>Sign out</Button>
        </div></details> : <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(async () => { await signOutAccount(); setName(getProfile().name); setColor(getProfile().color) })}>Use another account</Button>}
      </>}
      {busy && <p role="status" className="text-xs text-ash">Please wait…</p>}
    </div>
    </div>
  </Modal>
}
