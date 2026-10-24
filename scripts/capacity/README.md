# Capacity measurements

These operator tools use a temporary isolated process on the existing **Europe**
host, frozen committed game code, real headless prediction clients and separate
databases. Run only during an authorized empty maintenance window. They do not
estimate account/presence capacity or create real ratings, rewards or GA events.

Build from the explicitly selected deployed commit, then keep these bundles fixed
through the baseline. Exporting a commit reads Git without checking out or changing
the working tree. Current uncommitted bot/game changes are excluded. The small
capacity entry points and shared testing client come from this working tree.

```sh
node scripts/capacity/build.mjs a25274d
node scripts/capacity/fleet.mjs eu pilot
node scripts/capacity/fleet.mjs eu ceiling-humans
node scripts/capacity/fleet.mjs eu ceiling-bots
node scripts/capacity/fleet.mjs eu bot-cost-rooms
node scripts/capacity/fleet.mjs eu components
```

Each command acquires the release fleet lock, checks the region is empty/open,
installs an independent 14-minute cleanup timer, drains admissions and starts a
nonroot service with a 384 MiB heap, 512 MiB cgroup limit and hard runtime deadline.
Network traffic uses independent **direct WSS connections over the existing
nginx/TLS endpoint**. SSH only provisions, starts, stops and collects logs; there
is no SSH port forward. A temporary `/_capacity/<run>/` route allows only the
generator's source IP, disables access logs and points at the isolated loopback
port. Normal completion/interruption removes that exact route, validates/reloads
nginx, stops the synthetic service and reopens production. The independent timer
does the same if the operator process dies. Scripts/configuration are root-owned;
only the synthetic data directory is writable by the service user.

The runner checks that the private monitoring endpoint identifies this exact
capacity run before creating clients. Production per-connection message/byte
limits remain in force. Only isolated per-IP arrival/room/connection limits are
raised because one generator shares one address. This is not an admission-rate
benchmark. The production health endpoint is sampled independently alongside
isolated server monitoring to expose shared network delays.

Human-heavy ramps use 4/6/8/10/12/16 rooms of ten clients. Bot-heavy ramps use
4/8/12/16/24/32 rooms, each with one client and nine server bots (Hard, with one
Medium and one Brutal). Each stage warms for ten seconds, then samples for 75
seconds. Shop time is eight seconds, time scale stays **1×**, and clients move,
cast, purchase, receive/verify streams and automatically ready for rematches.
The pilot uses 1/2/4 rooms at 60 seconds in each mix.

Ceiling runs stop on ten consecutive samples over 150% process CPU (one full core
is 100%), RSS above 400 MiB, sustained simulation delivery below 58.8 Hz per room,
five samples of excessive generator scheduling delay, five samples with input-ack
p95 over 500 ms, a desync or a disconnect.
The pilot's CPU threshold is 95%. These short runs identify observed degradation;
they do not certify a safe operating load. Inspect raw logs for rate limiting,
backpressure and internet-link limits before attributing failure to server CPU.
Confirm a boundary with repeats and a longer soak before advertising capacity.

`bot-cost-rooms` holds four rooms/one real client each and compares 1/4/9
server bots for 120 seconds per roster, with the same warmup. It also captures a
1 ms sampled CPU profile of the complete process; attribute it with
`node scripts/capacity/profile.mjs artifacts/capacity/<run>`. Profile overhead is
present in all three roster cases. Source maps stay in ignored local artifacts.

`components` runs three fixed seeds for Medium, Hard and Brutal with ten combatants,
300 simulated seconds each, and warmup. It separately times AI `think` and core
`step`, with alive-combat and all-phase per-bot costs. It runs accelerated offline,
normalizes work to 60 ticks/second, and excludes cloning, hashes, bot input plans,
network serialization/transport, rendering and accounts. **AI decision cost is not
the total cost of a bot seat.** Keep it separate from whole networked-room costs.

Each run copies its runtime bundles to prevent later builds from changing its clients.
Results, frozen bundles/source, private configs and raw JSONL are ignored under
`artifacts/capacity/<region>-<time>/`. Keep baseline and comparison results for at
least 30 days; there is no automatic deletion. Never publish private config/token
files. The run's `operator.json` identifies the local PID; send SIGTERM to that PID
to request normal cleanup. If local cleanup fails, leave the timer installed and
inspect the named systemd service, nginx route and `deploy/maintenance.sh status`.
The timer does not survive a host reboot; the transient test service and nginx
route should be inspected after one. A production PM2 restart clears no databases.

See [the measurement plan](../../docs/CAPACITY-TEST-PLAN.md) and
[the baseline report](../../docs/research/capacity-2026-10-24.md).
