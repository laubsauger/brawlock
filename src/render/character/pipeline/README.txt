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
- Cuff seams, deep folds and floor/body conflicts in fallen poses.
- Eye shape and placement inside the new recessed hood void.
- Final small-mesh hem quality, retargeted run/death poses and equipment fit.

Current local cloth approach: fitted limb motion plus bounded secondary motion.
The experimental 20K mesh, both reduced meshes and cloth-proxy.json must be built
from the same recipe. The current proxy has 410 nodes across independent garment
sheets; the original render UVs, texture and fabric thickness are preserved.

- The waist retains the imported skinning. Below it, a continuous primary shape
  follows each actual hip-to-knee direction. Frames remove axial thigh twist;
  copying a thigh joint's full rotation swung long skirt panels unnecessarily.
- The upper skirt follows the leg immediately. Lower fabric hangs from a moving
  bend with an 18/s exponential follow rate. Only a narrow support follows that
  bend; the flared hem width does not become a long rotating lever.
- All skirt layers use this same primary shape directly on their source vertices.
  Interpolated proxy offsets supply secondary sway. Rotating fine residuals on
  unrelated small proxy triangles distorted thin fabric and its texture.
- The final visible skirt also uses a local, monotone radial map around fitted
  leg capsules. It preserves radial ordering of thin fabric layers; a hard
  radius clamp would collapse both skins onto one surface. Its displacement
  fades outside each limb. It does not enclose both legs in one wide volume.
- Lower rear fabric additionally follows backward calf travel, distributed
  from the knee down with the same 18/s follow rate. Forward panels and the
  waist are excluded. Rear-side capsule exits keep adjacent vertices behind a
  passing calf: nearest-point clearance alone allowed clear endpoints on
  opposite sides while their connecting triangle crossed the leg. The exit
  preserves thin-layer order and fades through a local silhouette band.
- Foot capsule endpoints include the source boot's measured toe reach beyond
  the ball joint (about 5 cm here). Their fitted radii remain unchanged.
- Critically damped secondary springs have explicit mobility-based travel bounds.
  Tangent constraints prevent secondary lag from moving farther into a nearby
  limb; contact corrections do not become velocity impulses. The review floor
  remains the final constraint for coarse nodes and visible fine hem tips.
- Hanging forearm cloth uses transported gravity frames, avoiding forearm roll.
  A fitted convex source-robe envelope gives cuffs a compact clearance goal.
  The upper arm is structural sleeve cloth, not a second free cuff attachment.
- Mesh attributes share an interleaved GPU buffer, staying within WebGPU's eight
  vertex-buffer minimum. Animation is sampled at no more than 20 ms per step.

This is an approximation, not a general cloth self-collision solver. Passing a
motion test does not establish visible nonpenetration. Some actual mesh edges
still cross the body or another cloth layer, especially in fast/fallen poses;
cuff seams also remain under review. Fitted capsules approximate the body and
cannot certify clearance against every animated trouser/boot triangle. The
experimental model has not passed visual acceptance for production integration.
The rear-contact review samples the actual deformed skirt edges against the
animated trouser/boot triangles every four 60 Hz frames over walk/run loops.
In that diagnostic, rear crossings changed from 136 to 0 for walk and 702 to
230 for run. Forward-side crossing counts were unchanged. These are sampled
edge intersections, not a guarantee of continuous or complete surface clearance;
fast running folds and sleeve/robe contacts still need visual work.

The preview's fabric response is matte with modest highlights on red trim;
leather pieces retain their separate material. This is a preview approximation
using the supplied base color, not recovered Tripo roughness/normal maps. The
source GLBs contain only the 4K base color. Recessed eyes curve with the face
insert and blink periodically, with hit/hitHead reaction blinks.
The face/glow material is opaque: glow falls off into black, avoiding transparent
depth-writing rectangles over the void. Ambient occlusion is an optional preview
checkbox, off by default. It matches the game's half-resolution, depth-derived
GTAO settings; turning it off uses the original direct render path without AO.

Local/generated verification:
node --test src/render/character/pipeline/cloth-proxy.test.mjs
node src/render/character/pipeline/validate-tripo.mjs
node src/render/character/pipeline/verify-cloth-motion.mjs
The motion check runs real walk/run loops and throw/death through settlement,
checking finite data, floor clearance, secondary bounds and frame flips. Its
walking jump limit remains 3.5 cm per 60 Hz frame. It writes a separate evidence
record; it is not a visible-surface or texture acceptance check.
node src/render/character/pipeline/verify-cloth-surfaces.mjs
This slower diagnostic checks actual cuff edges against the visible robe across
all 13 clips. It intentionally fails while intersections remain. It does not
certify arbitrary garment self-contact. cloth-deformation.js mirrors the review
shader so geometry audits use the same primary shape and final clearance map.

For another model, review its garment partitions, pin/mobility masks, attachment
frames, fitted colliders, thickness and LODs. The current leg/hood dimensions and
canonical joint names are specific to this authoring recipe. Keep decorative
solid pieces skinned; do not expand the simulated mask onto solid wrist details.
The 10K/5K exports combine the source pieces into two material batches, so their
per-vertex region tags control cloth behavior rather than exported object names.

Collider endpoints are joint-local Blender vectors: glTF preserves those local
axes while converting the armature world frame. Do not apply xyz() to offsets.
The export validator compares all endpoints with authored world reference points
and checks that the upper hood carries no arm weights.

Do not treat the presence of these tools in a release commit as approval of the
experimental model. Integration remains a separate explicit step after review.
