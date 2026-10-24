CHARACTER AUTHORING PIPELINE — RELEASE HANDOFF

The authoring pages and Blender sources remain developer tools. The fitted 10K
starter now also has an opt-in runtime adapter (../tripo.ts) using the existing
character animation controller, staff grips, cast sockets and match VFX. The
live default remains cc0. Select tripo in the Character Inspector, or use the
preview links below. This is a review candidate, not a new inventory skin.

The reviewed 10K GLB and matching proxy are copied to public/models/warlock/tripo
by stage-tripo-runtime.mjs. Its provenance.json records source names, build ID
and SHA-256 hashes. Re-stage after rebuilding and validating the source meshes:
node src/render/character/pipeline/stage-tripo-runtime.mjs
No source .blend, authoring-only texture bake, or full 20K mesh ships with it.

Runtime and motion review share cloth-material.js, player-look-material.js,
cloth-proxy.js and the recessed face insert. Keep the material deformation and
CPU audit counterpart synchronized when changing cloth behavior.

Review links (append &staff=iron or &staff=bone to change equipped staff):
- Animation/grip: /src/render/character/dev/preview.html?style=tripo&staff=gnarled&studio
- Full effects: /src/render/vfx/dev/b/labB.html?style=tripo&staff=gnarled&ai=0&place=-200_0,200_0&script=0:fireball:t1&every=3
- Script lab: /src/render/vfx/dev/a/labA.html?style=tripo&staff=gnarled&spell=boomerang
- Playable match: /src/render/dev/preview.html?style=tripo&staff=gnarled&inspect
Omit staff for bare-hand casts; &castFrom=palm compares palm origins while holding
one. Lab B's existing grant/script options cover every spell, movement and timing.
The character preview has idle/walk/run, all seven cast categories, cancel,
hit, death, respawn and celebration controls. It previews the character poses;
spell particles and charge-up marks are rendered in the full-effects labs.

The fitted model keeps its original proportions and glove scale. Hand/palm/grip
sockets are measured on its own rig. Staffs use the existing carry, aim, wrist,
finger, slam, ground and recovery layers instead of new baked duplicate clips.
Existing head/back cosmetics are not fitted to this robe and are excluded;
staff cosmetics and player colors work through the existing character contract.

The model-independent pieces are decode-warlock.mjs (meshopt GLB decoding),
cloth-proxy.js (small browser cloth solver) and its standalone regression tests.
The intake, prepare, rig, cloth-authoring and export scripts are reproducible
authoring recipes for the current Tripo experiment. Their fitted dimensions and
part maps are asset-specific; a new model requires a reviewed fitting recipe.

preview.html / preview.js are a development-only motion/material review page:
/src/render/character/pipeline/preview.html
It requires locally generated artifacts under art/source/tripo-warlock-v1/.
The authoring page stays outside production HTML entries. Its reviewed runtime
mesh is staged separately as described above; ongoing edits belong in source art.

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
- Residual local running strain, bend continuity and layer fit in extreme poses.
- Final small-mesh hem quality, retargeted run/death poses and equipment fit.

Current local cloth approach: fitted limb motion plus bounded secondary motion.
The experimental 20K mesh, both reduced meshes and cloth-proxy.json must be built
from the same recipe. The current proxy has 410 nodes across independent garment
sheets; the original render UVs, texture and fabric thickness are preserved.

- The waist retains the imported skinning. Below it, a continuous primary shape
  follows each actual hip-to-knee direction. Frames remove axial thigh twist;
  copying a thigh joint's full rotation swung long skirt panels unnecessarily.
- The upper skirt follows the leg immediately. Lower fabric hangs from a moving
  bend whose angle follows at 18/s. Its support point stays on the actual knee,
  avoiding stretch between delayed and immediate knee positions. Only a narrow support follows that
  bend; the flared hem width does not become a long rotating lever.
- All skirt layers use this same primary shape directly on their source vertices.
  Interpolated proxy offsets supply secondary sway. Rotating fine residuals on
  unrelated small proxy triangles distorted thin fabric and its texture.
- The final visible skirt also uses a local, monotone radial map around fitted
  leg and pelvis capsules. It shares the coarse solver's 6 mm outer / 4 mm
  overlay clearance and preserves radial ordering of thin fabric layers; a hard
  radius clamp would collapse both skins onto one surface. Its displacement
  fades outside each limb. It does not enclose both legs in one wide volume.
- Unvented lower rear fabric additionally follows backward calf travel, distributed
  from the knee down with the same 18/s follow rate. Forward panels and the
  waist are excluded. Rear-side capsule exits keep adjacent vertices behind a
  passing calf: nearest-point clearance alone allowed clear endpoints on
  opposite sides while their connecting triangle crossed the leg. The exit
  preserves thin-layer order and fades through a local silhouette band.
- Foot capsule endpoints include the source boot's measured toe reach beyond
  the ball joint. Foot radii cover the measured weighted forefoot, including toe
  corners omitted by the old mid-foot 95th-percentile fit; thigh radii stay fitted.
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
motion test does not establish visible nonpenetration. Cuff seams, cloth-layer
intersections and fallen poses remain under review. Fitted capsules approximate the body and
cannot certify clearance against every animated trouser/boot triangle. The
experimental model is available for opt-in integration review; it has not passed
visual acceptance as the production default.
verify-cloth-garment.mjs samples the actual deformed skirt edges against animated
trouser/boot triangles every 60 Hz frame over three walk/run loops, covering
cold start and sustained motion. It also
measures deformed/rest edge lengths for garment edges at least 1.5 cm long.
It writes garment-surface-motion.json with overall/rear crossing counts, stretch
percentiles and worst edges/poses. It intentionally fails while crossings or
edges stretched beyond twice their rest length remain. That threshold catches
gross rubber-like deformation; passing does not certify realistic fabric strain,
continuous surface clearance, smooth bending, or visual acceptance.

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
walking offset-travel jump limit is 3.5 cm per 60 Hz frame. It writes a separate evidence
record; it is not a visible-surface or texture acceptance check.
node src/render/character/pipeline/verify-cloth-garment.mjs
The working-mesh garment diagnostic described above checks both leg crossings
and visible stretch. Inspect the recorded worst edges and poses when it fails.
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

The runtime adapter is an explicit integration review step. Approval of the
authoring tools alone does not promote the model to the production default.

LOCAL FOLLOW-UP AFTER THE PIPELINE CHECKPOINT

The rear trim removes only 53 triangles from the small central red tip below
the patterned hem: all triangle vertices must be below 0.34 m and within 0.09 m
of the centerline, with red coverage at least 90% over 15 UV samples. The upper
lining and patterned hem are preserved. The earlier centroid-based mask removed
too much fabric. build-cloth-proxy.py records the reviewed face IDs, bounds and
the original retained-triangle hash in rear-cut.json. The independent GLB check
proves that no additional outer-panel geometry changed during trimming/export.
The working mesh has 20,024 triangles. The source LOD studies retain the original
4K texture (10,007 / 5,094 triangles). The archived
rig and shipped character remain unchanged. Rebuild the cloth mesh, proxy and
both source LODs together.

The rear center seam is split along 40 existing edges below the belt, with no
patterned faces deleted. _WL_REAR_SIDE survives both small meshes. Each tail
opens for its own backward calf travel or forward raised knee: the knee can
catch the rear tail before the ankle passes behind the hip. An 18/s filter keeps
release continuous. Ownership blends over 30 cm below the seam at rest, widening
to 45 cm with the same own-leg release to avoid a sharp change between shared
waist and individual leg motion. Rounded lateral
capsule exits expand their contact footprint from 12 to 18 cm with the filtered
leg release, easing neighbouring cloth aside before the leg reaches it without
adding that flare at rest. They preserve layer order and bypass unused radial
conformation.

Collider definitions keep semantic limb joints separate from their endpoint
drivers. A thigh volume's socket follows the pelvis, and its distal fitted
offset follows the thigh. Previously the thigh rotated the fitted socket while
calf flexion torqued its distal offset by up to 48 mm, producing false contacts
and stretching neighbouring fabric apart. Endpoint offsets are authored in their
driver's local frame, and the validator proves their exported rest positions.

Garment motion is explicit in each legCloth definition and _WL_MOTION_PROFILE:
0 = leg-driven skirt, 1 = center tabard, 2 = short hip overlay. The center tabard
shares one average leg blend across its width and has its authored 1.15 m waist
attachment. The short hip overlay follows its imported waist skinning with
bounded secondary motion and body contacts; thighs no longer pull it apart.
These profiles replace the earlier _WL_CENTER_PANEL flag. Missing or mixed
artifacts fail validation and loading; regenerate the complete local set.

The two side panels originally intersected the trousers near their attachments.
A measured forward height field moves them at most 26.23 mm, fading out toward
the lower hem. It preserves UVs, topology, width and fabric thickness; custom
normals use the field's inverse transpose. In the 1.05–1.15 m attachment band,
all three front panels blend toward the torso components of barycentric weights
from the underlying trouser surface. These belt-hung panels exclude individual
thigh influences: opposing thighs previously pulled adjacent waist vertices in
different directions. The lower fabric follows the existing leg-motion profiles.
The side roots retain 8 mm of source clearance. waist-fit.json records the fitting
recipe; its parameters, shifts and generated skin bindings participate in proxy
build matching. The GLB validator independently checks source clearance and fully
bound torso weights against exported trouser triangles, plus the absence of
thigh bindings.

The fine render contact path now includes the pelvis collider, which was
previously used only by the coarse solver. Both paths share their cloth
clearance constants. This prevents otherwise fitted front cloth from slipping
through the central hip surface in running poses.

The actual-mesh garment gate now passes: zero sampled leg crossings and no edges
over the unchanged 2x gross-defect threshold in walk and run (every frame at
60 Hz over three loops: 244 / 169 samples). Maximum edge stretch is 1.89x walking
and 1.97x running.
The previous build had 189 over-limit running edge samples. The diagnostic
always checks every frame because sparse sampling missed earlier rear-seam
spikes. These measurements do
not establish continuous collision clearance, realistic material strain,
self-contact, or visual acceptance. Cuff/layer intersections and fallen poses
also remain under review. The runtime model is still an opt-in review candidate.

Player color treatment is available in the preview's expandable controls. It
uses the game's lobby palette, custom color, highlights, clearcoat, accent glow
and optional matching eyes. The ten-color lineup loads ten actors. This adapts
painted red accents; it is not the production material's UV mask or a recovered
Tripo PBR export. Leather keeps its separate response.

PLAYER TRIM AND MODULAR FITTINGS

Both review pages and the runtime share the same source-paint trim shader.
Emission samples the strongly red paint at mip 4, separate from the full-detail
albedo, so woven fabric detail does not become emissive speckling. The original
texture option remains available for source comparison. Player treatment starts
with the purple lobby color in the authoring page. Glow strength is adjustable.
The narrow front-panel rune column reuses the legacy glyph alphabet, ends at
0.58 m (above the lower ornament), is masked off the reverse fabric face, and
leaves a gap at row boundaries to avoid fract-derivative horizontal dividers.

tripoAccessories.ts builds independent shoulder, hood, chest, belt and wrist
slots, merged into one additional skinned draw. Crescent/etched shoulder shells
follow a curved upper-arm profile; cuffs wrap the forearm; small stones have
open metal bezels and faceted geometry. Front settings are placed by ray fitting
the source garment. They are measured in bind space, so changing equipment while
posed does not bake the current animation into it. All emission reads player
color and existing cast/hit/death state. The source robe geometry/UVs stay intact.

The default is the small fitted stones/cuffs with no shoulder shell, preserving
the source robe silhouette. Shoulder variants remain optional fitting studies.
Motion review: Shoulder ornaments select and sigil-fittings checkbox.
Character review: shoulder variant buttons and sigil-fittings button.
Match Inspector: tripoShoulders and tripoSigils; these update without rebuilding
characters or resetting cloth. These are fitting studies, not shop catalog items.
A full crescent set adds 3,528 triangles and one draw per scene/shadow pass.

Focused proof:
npx vitest run src/render/character/tripoAccessories.test.ts
The tests cover independent slots, the geometry budget, valid rigid skinning,
curved depth, finite normals/positions, and unchanged bind geometry when swapping
accessories during animation. Browser review also covers colors, the three LOD
sources, cast categories and rear/front/gameplay views.

FITTED LONG CAPE AND COLOR REVIEW

The optional cape is a separate 576-triangle shoulder-to-knee back panel. Its
upper attachment samples the actual robe's skin weights and central back
surface. The loose lower portion hangs under gravity instead of inheriting the
spine's rotation. The robe's cloth supports and fitted leg capsules inform its
drape. Contacts spread across neighbouring strips, and each column is sampled
by its original fabric arc length, so the hem lifts when contact uses up fabric.
Bounded, critically damped springs add motion without a free sheet that can
fold into a knot. Physics work is capped at two steps per frame with no backlog.
The attachment inverse is calculated from the current mesh world matrix, so
pawn translation, rotation and scale do not get applied twice.

The cape uses a quiet patch of source fabric, restrained player-color trim and
the equipped emblem from the existing shared atlas. Letter emblems read from
behind. It adds no separate inventory or catalog. Match Inspector exposes
tripoCape. Character preview has a Cape checkbox, Back view/Front view buttons
and back-emblem selector. Named previous/next color controls cycle the ten actual
lobby colors; color and emblem selections survive style rebuilds. Motion review
has the same cape/emblem choices and visible color cycling controls.

Playback drives cape simulation, including pause, speed and timeline seeking.
Actual matches print Outfit.emblem. Preview pages start with Moon and Star;
No emblem gives plain cloth. Legacy back/head cosmetic shapes still require
their own fitting. This is a constrained gameplay drape, not general cloth
self-collision or garment tailoring for arbitrary costumes.

Focused proof:
npx vitest run src/render/character/tripoCape.test.ts
Tests cover geometry/UV orientation, rig weights, model-space attachment under
translation/rotation/scale, length preservation, pause/reset, bounded hitch
work and sustained gusts. Browser checks exercise color cycling, all three
source meshes, long-running idle/walk/run motion, casting, death, pause/seek
and real-match equipment. Cape physics timing and maximum fibre edge length
are exposed by review.inspect().capePhysics.
