# Scene color grading

The output grade opens dim stone and cloth detail while preserving the existing warm lava/cool floor separation. ACES Filmic exposure remains 1.05. Bloom strengths, effects intensity, vignette, hurt feedback and hue-preserving HDR ceilings are unchanged.

`src/render/colorGrade.ts` applies one scene-linear scalar gain to RGB before ACES. Deep shadows retain at least 97% of their original linear value; black remains black. Readable midtones receive up to 10% more linear light. The lift fades away as the brightest channel rises from 0.12 to 0.65, leaving colored emissive highlights untouched. This preserves RGB ratios before tone mapping rather than tinting player identities. The existing low-tier output and medium/high composite use the same grade. DOM nameplates, HUD and menus are outside it.

The grade adds arithmetic to the existing output shader. It adds no render pass, texture, render target, geometry or draw submission. This is an SDR visual finish, not actual HDR-display output.

## Fixed-scene proof, 2026-10-19

An isolated production fixture compares the original output pipeline against the grade at **960×600, DPR 1** on low, medium and high. Four compositions use a frozen eight-player arena, a combat snapshot with six spell colors, an oblique menu-like composition and a winner close-up. The world and shader clock are held; rendering is advanced manually with no running simulation or animation loop. A same-page A/B/B/A sequence checks throughput after warming each pipeline.

| Measurement | Low | Medium | High |
| --- | ---: | ---: | ---: |
| Arena floor luminance increase | 8.77% | 8.77% | 8.76% |
| Combat floor luminance increase | 9.37% | 9.30% | 9.29% |
| Combat emissive lava luminance change | 0.14% | 0.14% | 0.15% |
| Paired throughput before → after, ms/frame | 0.950 → 0.933 | 1.800 → 1.958 | 2.213 → 2.213 |
| Arena geometries, before = after | 84 | 84 | 84 |
| Arena textures, before = after | 50 | 61 | 64 |

Throughput includes CPU submission and GPU completion on a contested development machine; these sub-millisecond deltas are not a precise standalone GPU timing claim. The observed largest paired median increase is 0.158 ms. Raw Apple tile-GPU summed pass timestamps are unsuitable here, so the bounded queue-completion probe supplies the reported measurements.

The captures introduce **no additional white pixels** in any composition/tier pair. All 541–542 solid text pixels in the fixture HUD remain byte-identical. Existing shadow refresh/culling can change the instantaneous draw counters between frames; sampled arena counts stay around 203–239 draws and 162k–273k triangles. Texture counts include the existing post targets; the grade does not increase them. Visual review confirms more readable floor texture, retained dark crevices, colored spell cores and distinct player colors. Focused lighting/render assessment: 2.0 → 2.2 on the 0–3 visual scorecard; this does not re-score unchanged art or claim a full-game visual upgrade.

Local ignored evidence: `artifacts/color-grade/` contains 24 before/after PNGs, `results.json`, `metrics.json` and `paired-cost.json`. The comparison was built once under `/private/tmp/brawlock-grade-build`, avoiding shared-checkout hot reloads. The private capture/measurement scripts are `/private/tmp/brawlock-color-grade-proof.cjs`, `/private/tmp/brawlock-grade-metrics.cjs` and `/private/tmp/brawlock-grade-paired.cjs`. All owned browser contexts were closed; existing frozen QA pages were left untouched.

`src/render/colorGrade.test.ts` checks the production grading expression for monotonic luminance, preserved black/shadow detail, existing HDR ceilings, all ten player color ratios and unchanged colored highlights. Four tests, TypeScript and the production fixture build pass. This pass changes output color only; it does not establish new animation or gameplay behavior.
