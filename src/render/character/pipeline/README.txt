CHARACTER AUTHORING PIPELINE — RELEASE HANDOFF

These are isolated developer tools. They do not change the live character loader,
inventory, equipment catalog, default model, or production HTML build entries.
Generated GLBs, textures, .blend files and screenshots stay in ignored art/source/.
The experimental model and its current visual state are not release content.

The model-independent pieces are decode-warlock.mjs (meshopt GLB decoding),
cloth-proxy.js (small browser cloth solver) and its standalone regression tests.
The intake, prepare, rig, cloth-authoring and export scripts are reproducible
authoring recipes for the current Tripo experiment. Their fitted dimensions and
part maps are asset-specific; a new model requires a reviewed fitting recipe.

preview.html / preview.js are a development-only motion/material review page:
/src/render/character/pipeline/preview.html
It requires locally generated artifacts under art/source/tripo-warlock-v1/.
Do not add the page or model to production build entries for this handoff.
The viewer is the place for ongoing visual corrections; the live model stays put.

Local checks that need no generated model:
node --test src/render/character/pipeline/cloth-proxy.test.mjs
node --check src/render/character/pipeline/preview.js
node --check src/render/character/pipeline/cloth-proxy.js

Asset checks (after generating the local artifacts):
node src/render/character/pipeline/validate-tripo.mjs

Generation order (Blender executable must be installed):
1. decode-warlock.mjs: decode public/models/warlock/warlock.glb for Blender.
2. intake-tripo.py: inspect and archive the supplied generation.
3. prepare-tripo.py: separate existing garment components without destroying UVs.
4. rig-tripo.py: fit a copied canonical rig and bind the experimental garments.
5. build-cloth-proxy.py: build review cloth data and the unreduced inspection GLB.
6. export-source-lods.py: make small review meshes using the original materials.
Pass --out art/source/tripo-warlock-v1 to Blender scripts; preserve edited source
copies before rebuilding. The scripts print evidence records and fail on invalid
rig, geometry, weights, bindings or unexpected inputs.

export-tripo-lods.py is a separate bake experiment. Its thin-fabric ray bakes were
rejected visually and are not selected in the viewer or required for release.
validate-tripo.mjs can inspect those too with --include-bake-studies after --out's
directory argument. Finite data and passing checks are not visual acceptance.

Known visual work still in progress:
- Inner panels, sleeve drape, collision fitting and garment intersections.
- Recessed hood void and colored eyes on the new headless character.
- Final small-mesh hem quality, retargeted run/death poses and equipment fit.

Do not treat the presence of these tools in a release commit as approval of the
experimental model. Integration remains a separate explicit step after review.
