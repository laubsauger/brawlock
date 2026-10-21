# Investigating ping spikes

Open **F3** during the affected game. The existing network histories are joined by local frame timing and dedicated-server measurements. **F2** remains the detailed render overlay.

| Measurement | What it shows |
|---|---|
| Ping, jitter, loss, update age | The game connection, including time waiting for either application's event loop |
| Local frame average/max; frames over 50 ms | Delays on this page, including CPU contention or GPU/frame scheduling stalls |
| Render CPU / GPU | Existing renderer timings; unavailable GPU timestamps are explicitly marked |
| Server process CPU | 100% means one fully occupied core; multiple process threads can exceed 100% |
| Server loop p95/max | Raw Node event-loop delay; the monitor's 20 ms resolution normally produces an idle baseline near 20 ms |
| Simulation average/max; steps/s | Measured simulation step calls across the server's rooms; excludes serialization and stats recording, and is not a per-player FPS target |
| Health RTT | A separate HTTP round trip to every region at once, still subject to local and server processing delays |

Compare the timing of spikes. Local frame stalls with stable server measurements support a client-side explanation. Server CPU/loop/simulation spikes support a server-side explanation. High RTT with neither signal leaves the network path as a possibility. When every region's health RTT spikes together, the cause is on this device's side of the route (Wi-Fi, router, ISP); one region spiking alone points to that server or its route. The operations dashboard's per-region internet anchor tells the server side apart. These measurements alone cannot identify Wi-Fi versus an ISP route. Several causes can coexist.

Use **Copy recent samples** to retain at most 30 local one-second observation windows. The JSON includes timestamps, connection measurements and the most recent server snapshot for correlation; server snapshots are refreshed every three seconds. It does not contain player names, device IDs or room codes. No telemetry is uploaded automatically.

Opening F3 starts the client measurements. Closing it aborts polling and stops collection; hidden tabs do not poll, and hidden time is excluded from local frame timing. Server measurements use one cached one-second sampler and fixed counters; health reads do not run benchmarks. Missing or unsampled telemetry is shown explicitly rather than as zero load.

The 2026-10-19 read-only infrastructure spot check found approximately 0% Brawlock process CPU on both hosts and no host CPU steal. This was an idle one-second observation, not evidence about the user's earlier match. Collect a sample during an actual spike before changing networking or server size.
