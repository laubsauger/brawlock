# Fleet capacity and cost measurement plan

Status: planned on 2026-10-24. **No load test has been started.** Idle CPU readings and
the configured room limit are not player-capacity measurements.

## Questions to answer

- How many people can remain online in menus, wait in lobbies, or actively play?
- How do ten-player casual rooms, eight-player ranked rooms, and sparse rooms with
  server bots differ in CPU, memory, bandwidth and latency?
- What sustainable load can each region support while the shared US account,
  presence, ratings, monitoring and feedback services remain responsive?
- What does an active player-hour or match cost at realistic occupancy?

Report capacity separately for Europe and US West. Record actual instance size,
CPU model, Node version, source SHA, configuration and other running services at
test time. The US authority has a different workload from a simulation-only region.
One Node simulation process must not be assumed to scale linearly with vCPU count.

## Test target and isolation

Start with a temporary isolated deployment matching each production droplet's
resources and exact release bundle. Reuse the deployment tooling, protected service
boundaries and real regional/account code. Give it separate databases, account
keys, region registration, hostname and monitoring storage. Synthetic identities,
ratings, rewards, analytics and feedback must never enter the live services. Do
not automate Google sign-in or send test events to the production GA property.

The generator runs on another machine, never on the measured droplet. Record its
CPU, event-loop delay and network usage too: an overloaded generator can look like
a failing server. Use a second generator to verify a suspected ceiling.

Provisioning and benchmark execution are a later explicitly authorized task. If
production is ever used instead, require an agreed empty maintenance window,
isolated data and explicit resource limits; never benchmark through real matches.
The harness should reject production origins by default and have a hard deadline,
maximum room/client count and cleanup on interruption.

## Reuse the game instead of inventing a fake workload

The real TCP clients in `src/net/dedicated.test.ts` and account fixtures in
`src/net/accountRanked.test.ts` already exercise admission, WebSockets, active bot
input, prediction, rounds, rematches and cleanup. Extract their reusable client
setup into a headless harness; keep existing regression tests using that setup.
Use real match settings, transport, messages, input cadence and shop purchases.
Each virtual player needs its own device/profile and, where applicable, test
account/play permission. Reused identities would test the single-controller guard
instead of capacity. Preserve the real admission limits and report throttling.

Run three layers, and label their results distinctly:

1. **Simulation baseline:** seeded matches stepped locally, including bot decisions.
   This locates simulation cost; it is not a concurrent-human capacity claim.
2. **Networked players:** independent clients connect through TLS/nginx, enter rooms,
   move, aim, cast, buy varied builds, die, spectate and rematch. Keep receiving and
   acknowledging the real stream. Include projectile-heavy and channeling builds,
   not just idle connections or repeated Fireballs.
3. **Full clients:** run enough real session/prediction clients to verify stream hashes,
   input confirmation, corrections and recovery. Use these as correctness witnesses
   alongside lightweight protocol clients at scale. Separately compare a small
   real-browser sample; browser/GPU capacity is not server capacity.

Check that the selected lightweight workload matches full clients' message rate,
payload sizes and input mix before trusting its larger runs. Server-controlled bots
do not replace remote clients: they cost AI CPU but do not generate remote-player
transport traffic. Measure both.

## Workload matrix

| Case | What to vary | Why |
| --- | --- | --- |
| Menu presence | Guest/signed-in ratio; live menu heartbeats; account/profile reads | Online population is distinct from active match population |
| Waiting lobbies | Rooms, humans per room, discovery polls, readiness and chat | Many small rooms can be expensive differently from full rooms |
| Casual bot-heavy | One/two humans plus bots to ten | Likely low-population workload; includes Brutal/Hard decision cost |
| Casual human-heavy | Ten remote players, zero bots | Real input fan-out and bandwidth ceiling |
| Ranked | Eight players, bot replacements before start, full rounds/final/results | Fixed competitive rules and US rating/reward delivery |
| Representative mix | Measured presence/lobby/match ratios, not guessed marketing CCU | Primary operating-capacity result |
| Arrival/reconnect burst | New identities, reconnects, handoff, departures, discovery | Admission, account authority and room cleanup |
| Completion burst | Many rooms end within the same few seconds | SQLite/ratings/outbox and reward spikes |
| Adverse network | Added RTT/jitter/loss, slow receivers, bounded authority outage | Backpressure and recovery while healthy peers keep playing |

Use several fixed seeds/build mixes and both room sizes. Keep time scale at **1×**
for capacity runs; accelerated test clocks are only for functional regression tests.
One full match must include shopping, combat, deaths, results, rematch and cleanup.

## Ramp, soak and guardrails

Begin with one room and baseline latency from a nearby generator. Ramp room count
through 1, 2, 4, 8 and then smaller increments near the first degraded point. Hold
each stage for at least five minutes and several complete matches; do not count
connections that have not reached sustained combat. Repeat the boundary at least
three times, then soak the proposed operating load for one to two hours to expose
memory growth, accumulated queues and cleanup leaks. Set an overall time/cost cap
before running; failed safety limits stop the ramp rather than opening more rooms.

Proposed initial acceptance limits, to confirm before execution:

- At least 99% of each room's expected simulation ticks delivered over steady
  windows, with no persistent tick backlog. Aggregate steps/s grows with room count
  and must not be mistaken for one room's tick rate.
- Added p95 RTT/input-confirmation delay below 50 ms versus the same generator's
  unloaded baseline; investigate p99 and spikes separately. Record actual inputs
  applied per second, not only commands sent.
- No deterministic-stream failures, lost valid inputs or unexplained disconnects.
- No growing socket/outbox/authority queue; successful end-of-match persistence and
  return to baseline after all synthetic clients leave.
- Maintain CPU/memory/network headroom. Initially stop increasing load above 85%
  of the measured bottleneck for 30 seconds, sustained raw loop p95 above 50 ms,
  or repeated per-room backlog above 250 ms. These are test guardrails, not claims
  about present capacity. The raw event-loop histogram's ~20 ms baseline is normal.

Separate generator frame/scheduling stalls, server loop stalls and network RTT.
Never subtract a frame duration from RTT to manufacture a network-only number.

## Measurements and output

Extend the existing operations monitoring rather than install a second dashboard
first. Collect timestamped one-second JSONL samples and a compact HTML/CSV summary:

- Host CPU/core, steal, available RAM, swap, bandwidth and connection counts.
- Game process CPU, RSS/heap, GC pauses, event-loop p50/p95/p99/max; per-room tick
  lag and simulation time, bot decision time, serialization and outbound bytes.
- Account/presence/read/write latency, SQLite transaction time, authority RPC and
  outbox queue depth/age; completion burst delivery time and failures.
- Per-client RTT/jitter, input acknowledgment, applied input count, stream checks,
  corrections, disconnects, socket queued bytes, and generator scheduling delay.
- Median/p95/p99 values, trends during soak, and post-cleanup resource levels.

Retain source/config/seed manifests and raw samples with each result. Identify the
first bottleneck before suggesting a larger machine or room sharding. A change to
worker/process topology requires its own design for discovery, ownership and the
global single-controller rule; it is not part of this benchmark sprint.

## Turn measurements into economics

Publish **maximum passing**, **recommended operating**, and **burst/recovery** load
separately. Initially reserve 25–35% below the repeatable measured ceiling, then
validate the recommended point with the soak and mixed workload. Do not extrapolate
from one room's CPU percentage or claim all configured rooms fit in memory.

Use actual provider invoices and bandwidth counters, dated when the test runs:

- Active slots = sustainable rooms × mean humans per active room. Report bots apart.
- Monthly active player-hours = sustainable active slots × hours in month × measured
  utilization. Menu-only presence is not an active player-hour.
- Fleet cost/player-hour = (region costs + allocated shared authority/monitoring costs
  + incremental traffic/storage costs) ÷ actual active player-hours.
- Match cost = player-hour cost × match duration in hours × mean human participants,
  plus separately measured session/media overhead where it is not already counted.
- Egress = measured bytes/player-second × active player-seconds. Account for the
  current separate Pages media hosting, region-to-authority traffic, included
  transfer allowance and overage rates without counting any twice.

Show low/base/high utilization and match-duration scenarios. Compare those costs
with net receipts per purchase and expected lifetime play hours to inform pricing;
server cost alone does not determine a sustainable game price. Do not plug public
list prices or theoretical maximum occupancy into a sales break-even claim.

## Deliverables and next step

First implementation slice: a bounded CLI harness and one-room correctness report
against an isolated deployment, then a small repeatable ramp with automatic cleanup.
Follow with the workload matrix, boundary repeats, soak and a per-region capacity /
cost worksheet. Until those exist, the honest concurrent-player capacity is unknown.
