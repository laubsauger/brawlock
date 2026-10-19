# Session entry and recovery

The browser wrapper owns one opening action from region discovery through the
HTTP reservation and accepted network connection. Repeated clicks share that
action. A competing entry action cannot create another room while it is pending.
Leave invalidates the action; late HTTP responses cannot dial or replace a newer
session. A failed action releases ownership so an explicit retry can proceed.

`session.isActive()` means an accepted live network room, excluding pending
dials and offline practice. `session.resume()` restores its lobby, match, or
results screen synchronously without another POST, dial, or seat claim.

An accepted dedicated connection or P2P client connection remembers its last
room in `brawlock.lastRoom.v1` in localStorage. The versioned record contains
only the room code, stable local profile/device IDs, and exact backend route:
the original server region ID, or P2P. It contains no private tab reconnect key,
server URL, or display-name identity. The private tab key stays in sessionStorage
and is cached in memory when that storage is unavailable.

On menu entry, `rejoin.restore()` validates the stored record and current
identity once, then checks whether the original room is discoverable. It never
joins automatically. Changing the preferred region does not redirect recovery.
Dedicated recovery checks that region directly; P2P recovery requires its public
listing. A missing room is shown as ended/unavailable, without creating a new
room or switching backend. A P2P host cannot recover its destroyed host process.

The player explicitly joins or retries. Discovery and join failures retain the
target; the rejoin handoff does not clear its own pending controller request.
Dismiss, explicit Leave, and starting another game clear the remembered target.
Malformed records and identity mismatches are discarded. Blocked browser storage
limits recovery to the current tab's in-memory state.

Server identity checks remain authoritative. A same-tab refresh can replace its
connection using the private reconnect key. A closed/reopened tab with a new key
can reclaim a disconnected match seat using its original device/profile proof.
Another live tab cannot take that seat. Lobby departures remove their seats;
rejoining an existing lobby uses normal admission instead of resurrecting a seat.

Quick Play and ranked rooms close when their last connection leaves, unless an
already-issued reservation is pending. Existing reservation expiry and empty-room
sweeping handle that case; fresh HTTP-created rooms retain their existing TTL.
Closure stops the session/clocks and invalidates the browser listing cache.
Custom room lifetimes are unchanged. Recovery does not keep an empty queue alive.

Regression coverage: `src/game/session.test.ts`, `src/net/rejoin.test.ts`, and
`src/net/session.test.ts` cover admission, cancellation, persisted restoration,
exact routes, failed retries, identity changes, and live-tab protection.
The `automatic room last-human cleanup` cases in `src/net/dedicated.test.ts`
cover quick/ranked lobby and match closure, transport loss, pending reservation
arrival/expiry, stopped sessions, removed listings, and retained custom rooms.
