import { useState } from 'react'
import { Button } from '../widgets'

/** The owner's sign-in email, hidden until they ask: the account dialog often ends up on a stream. */
export function PrivateEmail({ email }: { email: string }) {
  const [shown, setShown] = useState(false)
  return <div className="flex min-w-0 items-center gap-2 text-sm text-ash">
    <p className="min-w-0 flex-1">{shown ? <>Signed in as <span className="break-all font-semibold text-bone" data-testid="account-email">{email}</span></> : 'Signed in, email hidden'}</p>
    <Button size="sm" variant="ghost" data-testid="account-email-toggle" data-state={shown ? 'shown' : 'hidden'} aria-pressed={shown} onClick={() => setShown(!shown)}>{shown ? 'Hide' : 'Show email'}</Button>
  </div>
}
