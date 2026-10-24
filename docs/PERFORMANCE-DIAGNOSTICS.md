# Investigating ping spikes

Click the top-left connection readout or press **F3** during the affected game. Network histories are joined by local frame timing and dedicated-server measurements. **F2**, or Settings → Interface → **Show FPS**, adds scene FPS beside RTT, including in offline matches. Hover the readout for a quick summary; opening the detailed graph dismisses that tooltip.

| Measurement | What it shows |
|---|---|
| Ping, jitter, loss, update age | The game connection, including time waiting for either application's event loop |
| Local frame average/max; frames over 50 ms | Delays on this page, including CPU contention or GPU/frame scheduling stalls |
| Local scheduling stall | Worst delay beyond the shared 100 ms timer's expected cadence over the last five seconds; independent of GPU/rAF cadence. A low FPS cap alone does not create this warning |
| Scene FPS / page FPS | The optional counter uses the renderer's scene FPS, respecting the FPS cap; diagnostics measure the UI's separate animation-frame cadence |
| Render CPU / GPU | Existing renderer timings; missing/rejected GPU timestamps say “not measured,” which does not mean the GPU stopped rendering |
| Server process CPU | 100% means one fully occupied core; multiple process threads can exceed 100% |
| Server loop p95/max | Raw Node event-loop delay; the monitor's 20 ms resolution normally produces an idle baseline near 20 ms |
| Simulation average/max; steps/s | Measured simulation step calls across the server's rooms; excludes serialization and stats recording, and is not a per-player FPS target |
| Health RTT | A separate HTTP round trip to every region at once, still subject to local and server processing delays |

Compare the timing of spikes. Local frame stalls with stable server measurements support a client-side explanation. Server CPU/loop/simulation spikes support a server-side explanation. High RTT with neither signal leaves the network path as a possibility. When every region's health RTT spikes together, local scheduling and the shared network path are both candidates; one region spiking alone points to that server or its route. The operations dashboard's per-region internet anchor helps compare the server's external network path. These measurements alone cannot identify Wi-Fi versus an ISP route. Several causes can coexist.

The compact readout flags recent local scheduling stalls even with FPS hidden. Timing-related warnings add “local device stall observed” when those observations overlap, while keeping measured RTT, grades, packet loss and networking behavior unchanged. No local frame or timer duration is subtracted from RTT: a WebSocket round trip cannot isolate network transit from processing at both ends.

Use **Copy recent samples** to retain at most 30 local one-second observation windows. The JSON includes timestamps, connection measurements and the most recent server snapshot for correlation; server snapshots are refreshed every three seconds. It does not contain player names, device IDs or room codes. No telemetry is uploaded automatically.

Local frame/scheduling sampling runs once for the app lifetime, using the shared HUD rAF and one 10 Hz timer. Hidden time resets these baselines. Opening F3 starts server polling and the bounded copyable history; closing it aborts polling and stops that history. Hidden tabs do not poll. Server measurements use one cached one-second sampler and fixed counters; health reads do not run benchmarks. Missing or unsampled telemetry is shown explicitly rather than as zero load.

The 2026-10-19 read-only infrastructure spot check found approximately 0% Brawlock process CPU on both hosts and no host CPU steal. This was an idle one-second observation, not evidence about the user's earlier match. Collect a sample during an actual spike before changing networking or server size.
