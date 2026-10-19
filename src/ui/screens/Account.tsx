import { useEffect, useState } from 'react'
import { accountAuth, accountCallbackURL, accountProviders, refreshAccount, saveAccountProfile, signOutAccount, type AccountProvider } from '../../game/account'
import { useAccount } from '../../game/accountState'
import { getProfile } from '../../game/profile'
import { Button, Modal } from '../widgets'
import { PreferredColorPicker } from './PlayerColorPicker'

const PROVIDER_LABEL = { google: 'Google', discord: 'Discord', microsoft: 'Microsoft' }

export function Account({ onClose, rankedRegion, onContinue, initialProblem }: { onClose: () => void; rankedRegion?: string; onContinue?: () => void; initialProblem?: string }) {
  const player = useAccount((state) => state.player)
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
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setProblem(null); setNotice(null)
    try { await action() } catch (error) { setProblem(error instanceof Error ? error.message : 'Account request failed.') }
    finally { setBusy(false) }
  }
  useEffect(() => { void run(load).then(() => { if (initialProblem) setProblem(initialProblem) }) }, [])
  const check = (result: { error: { message?: string } | null }) => { if (result.error) throw new Error(result.error.message ?? 'Sign-in could not be completed.') }
  const callbackURL = accountCallbackURL(window.location.origin, import.meta.env.BASE_URL, rankedRegion)

  return <Modal title={player ? 'Your account' : 'Sign in'} onClose={onClose} width="max-w-md">
    <div className="flex min-h-72 flex-col gap-4" aria-busy={busy}>
      {problem && <p role="alert" className="rounded border border-red-400/40 bg-red-950/40 p-3 text-sm text-red-200">{problem}</p>}
      {notice && <p role="status" className="text-sm text-[#a5d6ce]">{notice}</p>}
      {rankedRegion && <p className="rounded border border-[#aaa9c8]/30 bg-[#28212b] px-3 py-2 text-sm text-[#e7d9ee]">{player?.profile ? 'Your account is ready for ranked.' : player ? 'Choose your player name to enter ranked.' : 'Sign in to play ranked and keep your Elo across computers.'}</p>}
      {!player ? <>
        <p className="text-sm leading-relaxed text-ash">Keep your account across computers. Casual games are also available as a guest.</p>
        <div className="flex flex-col gap-2">
          {providers.map((provider) => <Button key={provider} disabled={busy} onClick={() => void run(async () => {
            check(await accountAuth.signIn.social({ provider, callbackURL, errorCallbackURL: callbackURL }))
          })}>Continue with {PROVIDER_LABEL[provider]}</Button>)}
          <Button disabled={busy} variant="ghost" onClick={() => void run(async () => {
            check(await accountAuth.signIn.passkey())
            await load()
          })}>Sign in with a passkey</Button>
        </div>
        <p className="text-xs leading-relaxed text-ash">First time? Use a sign-in provider, then add a passkey to your account. Your email stays private.</p>
      </> : <>
        <label className="flex flex-col gap-2 text-sm text-ash">{player.profile ? 'Player name' : 'Choose your player name'}
          <input className="field" aria-label="Account player name" autoComplete="nickname" spellCheck={false} maxLength={16} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="-mt-2 text-xs text-ash">3–16 letters, numbers or underscores. Start with a letter.{player.profile ? ' Changing your name releases the old one.' : ''}</p>
        <div className={busy ? 'pointer-events-none opacity-60' : ''}><PreferredColorPicker color={color} onChange={setColor} /></div>
        <Button variant="primary" disabled={busy || name.trim().length < 3} onClick={() => void run(async () => {
          const saved = await saveAccountProfile({ name, color }, !!player.profile)
          if (saved.profile) { setName(saved.profile.name); setColor(saved.profile.color) }
          setNotice(player.profile ? 'Player name and color saved.' : 'Your player name is reserved.')
        })}>{player.profile ? 'Save player' : 'Reserve player name'}</Button>
        {rankedRegion && player.profile && <Button variant="primary" disabled={busy} onClick={onContinue}>Continue to ranked</Button>}
        <Button disabled={busy} onClick={() => void run(async () => {
          check(await accountAuth.passkey.addPasskey({ name: `Brawlock · ${player.profile?.name ?? 'Player'}` }))
          setNotice('Passkey added. You can use it to sign in next time.')
        })}>Add a passkey</Button>
        <details className="text-sm text-ash"><summary className="cursor-pointer">Link another sign-in</summary>
          <p className="my-2 text-xs leading-relaxed">Use the same email with your other provider. Linking keeps both sign-ins on this account.</p>
          <div className="flex flex-wrap gap-2">{providers.map((provider) => <Button key={provider} size="sm" disabled={busy} onClick={() => void run(async () => {
            check(await accountAuth.linkSocial({ provider, callbackURL }))
          })}>{PROVIDER_LABEL[provider]}</Button>)}</div>
        </details>
        <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await signOutAccount(); setName(getProfile().name); setColor(getProfile().color) })}>Sign out</Button>
      </>}
      {busy && <p role="status" className="text-xs text-ash">Please wait…</p>}
    </div>
  </Modal>
}
