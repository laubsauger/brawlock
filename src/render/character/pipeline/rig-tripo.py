"""Fit a copied canonical skeleton and skin the actual Tripo working surfaces.

All writes stay in --out. The source working file, original rig and game assets
remain unchanged. This asset-specific fitting map preserves the generated shape.
"""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

ROOT = Path(__file__).resolve().parents[4]
parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--overwrite', action='store_true')
parser.add_argument('--render', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
OUT = args.out.resolve()
TARGET = OUT / 'tripo-warlock-rigged.blend'
if TARGET.exists() and not args.overwrite:
    raise RuntimeError('Rigged file exists. Preserve edited copies before --overwrite.')
live = ROOT / 'public/models/warlock/warlock.glb'
live_hash = hashlib.sha256(live.read_bytes()).hexdigest()
working_path = OUT / 'tripo-warlock-working.blend'
working_hash = hashlib.sha256(working_path.read_bytes()).hexdigest()
bpy.ops.wm.open_mainfile(filepath=str(working_path))
source_collection = bpy.data.collections['03_WORKING_Tripo_Garments_UNRIGGED']
canonical = next(o for o in bpy.data.collections['05_Canonical_Rig_REFERENCE_UNBOUND'].objects if o.type == 'ARMATURE')
canonical.data.pose_position = 'REST'
scene = bpy.context.scene
animated = bpy.data.collections.new('07_ANIMATED_Tripo_Test')
scene.collection.children.link(animated)
rig = canonical.copy()
rig.data = canonical.data.copy()
rig.name = 'Tripo_Armature'
animated.objects.link(rig)
rig.hide_viewport = rig.hide_render = False
rig.hide_set(False)
rig.animation_data.action = None
for track in rig.animation_data.nla_tracks:
    track.mute = True
rig.show_in_front = True
rig.data.display_type = 'STICK'
SCALE = 1.85


def interpolate(value, points):
    if value <= points[0][0]:
        i = 0
    elif value >= points[-1][0]:
        i = len(points) - 2
    else:
        i = next(i for i in range(len(points) - 1) if points[i][0] <= value <= points[i + 1][0])
    a, b = points[i], points[i + 1]
    return a[1] + (b[1] - a[1]) * (value - a[0]) / (b[0] - a[0])


def fit_point(point):
    x, y, z = point
    height = interpolate(z, [(0, 0), (0.0152, 0.020), (0.0865, 0.060), (0.5424, 0.300),
                            (0.9491, 0.550), (0.9712, 0.555), (1.072, 0.660), (1.1778, 0.700),
                            (1.3109, 0.740), (1.4555, 0.784), (1.5205, 0.825), (1.5998, 0.880), (1.8, 1.0)]) * SCALE
    width = interpolate(z, [(0, 2.25), (0.55, 2.15), (0.9712, 1.7), (1.072, 1.15), (1.3109, 1)])
    body_x = x * width
    body_y = y * 0.8 - 0.04
    if z < 1.0:
        body_y = y * 0.85 - 0.065
    arm = min(1, max(0, (abs(x) - 0.09) / 0.09)) * min(1, max(0, (z - 1.22) / 0.14))
    # Source sleeve cross-sections put the shoulder near X=.19, elbow=.44
    # and wrist=.74 metres. The previous shoulder was .268m out and .085m
    # forward, outside the sleeve's deltoid centre, twisting the armpit in idle.
    arm_x = math.copysign(interpolate(abs(x), [(0, 0), (0.0314, 0.015), (0.1919, 0.105),
                                             (0.4429, 0.238), (0.6832, 0.400), (0.9244, 0.500)]) * SCALE, x)
    arm_y = interpolate(abs(x),[(0,-.04),(.1919,-.03),(.4429,-.04),(.6832,-.07),(.9244,-.07)])+(y-.0654)*.8
    arm_z = interpolate(abs(x),[(0,1.48),(.1919,1.48),(.4429,1.46),(.6832,1.45),(.9244,1.45)])+(z-1.4555)*.8
    return Vector((body_x * (1 - arm) + arm_x * arm, body_y * (1 - arm) + arm_y * arm, height*(1-arm)+arm_z*arm))


# Move each rest joint while retaining its original local axes. This lets the
# existing rotation curves act in their original coordinate systems. Bone tails
# are display aids; GLB skinning depends on joint transforms and inverse binds.
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
for bone in rig.data.edit_bones:
    if bone.name == 'root':
        continue
    old_head = bone.head.copy()
    direction = bone.tail - bone.head
    fitted = fit_point(old_head)
    bone.head = fitted
    bone.tail = fitted + direction * 0.8
bpy.ops.object.mode_set(mode='OBJECT')
axes_error = max(1 - abs(canonical.data.bones[b.name].matrix_local.to_quaternion().dot(b.matrix_local.to_quaternion()))
                 for b in rig.data.bones)
if axes_error > 1e-5:
    raise RuntimeError('Fitting changed the canonical bone coordinate systems.')

# Build a fitted weight-transfer surface from the actual original body pieces.
# The Tripo geometry itself is only uniformly scaled; its proportions and UVs
# remain intact. No legacy body surface is included in the rendered character.
reference_objects = [o for o in bpy.data.collections['05_Canonical_Rig_REFERENCE_UNBOUND'].objects
                     if o.type == 'MESH' and o.name in {'Male_Ranger_Arms', 'Male_Ranger_Body',
                                                       'Male_Ranger_Feet_Boots', 'Male_Ranger_Legs'}]
if len(reference_objects) != 4:
    raise RuntimeError('Missing canonical weight-transfer surfaces.')
points, triangles, weights = [], [], []
for obj in reference_objects:
    offset = len(points)
    obj.data.calc_loop_triangles()
    points.extend(fit_point(obj.matrix_world @ v.co) for v in obj.data.vertices)
    for vertex in obj.data.vertices:
        groups = {obj.vertex_groups[g.group].name: g.weight for g in vertex.groups
                  if obj.vertex_groups[g.group].name in rig.data.bones}
        if not groups:
            raise RuntimeError('Unweighted canonical reference vertex.')
        weights.append(groups)
    triangles.extend(tuple(offset + i for i in tri.vertices) for tri in obj.data.loop_triangles)
bvh = BVHTree.FromPolygons(points, triangles, all_triangles=True)


def transfer(point):
    nearest, _, index, distance = bvh.find_nearest(point)
    if nearest is None or distance > 0.35:
        raise RuntimeError('Unmatched body vertex; review the fitting landmarks.')
    tri = triangles[index]
    bary = barycentric_transform(nearest, *(points[i] for i in tri),
                                 Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
    result = {}
    for i, influence in zip(tri, bary):
        for bone, value in weights[i].items():
            result[bone] = result.get(bone, 0) + value * max(0, influence)
    result = dict(sorted(result.items(), key=lambda item: -item[1])[:4])
    total = sum(result.values())
    if total <= 0:
        raise RuntimeError('Weight transfer produced no influence.')
    return {bone: value / total for bone, value in result.items() if value > 1e-6}


def joint_blend(value, keys):
    if value <= keys[0][0]:
        return {keys[0][1]: 1.0}
    if value >= keys[-1][0]:
        return {keys[-1][1]: 1.0}
    for (a, left), (b, right) in zip(keys, keys[1:]):
        if a <= value <= b:
            t = (value - a) / (b - a)
            return {left: 1 - t, right: t}


def upper_weights(point):
    # Loose sleeves and a deep hood opening are far from a fitted body surface.
    # Use garment landmarks here so nearest-surface transfer cannot pull a
    # shoulder onto a neck or a hanging cuff onto a finger.
    x, _, z = point
    body = joint_blend(z, [(0.66, 'spine_01'), (0.70, 'spine_02'), (0.76, 'spine_03'),
                           (0.815, 'neck_01'), (0.855, 'Head')])
    side = 'l' if x > 0 else 'r'
    distance=abs(x)*SCALE
    shoulder=min(1,max(0,(distance-.11)/.11))
    elbow=min(1,max(0,(distance-.36)/.15))
    shoulder=shoulder*shoulder*(3-2*shoulder)
    elbow=elbow*elbow*(3-2*elbow)
    arm={'clavicle_'+side:1-shoulder,'upperarm_'+side:shoulder*(1-elbow),'lowerarm_'+side:shoulder*elbow}
    t = min(1, max(0, (distance-.105)/.11))
    t = t * t * (3 - 2 * t)
    # Hood/collar edges can be as wide as the shoulders. Width alone must not
    # give them arm weights; the sleeve surface ends below 1.575m in this mesh.
    hood = min(1,max(0,(z*SCALE-1.575)/.05))
    t *= 1-hood*hood*(3-2*hood)
    result = {bone: weight * (1 - t) for bone, weight in body.items()}
    for bone, weight in arm.items():
        result[bone] = result.get(bone, 0) + weight * t
    return {bone: weight for bone, weight in result.items() if weight > 1e-6}


report = {'status': 'isolated rig and skinning candidate; not registered in game', 'scale': SCALE,
          'canonical_axes_error': axes_error, 'bones': len(rig.data.bones), 'parts': [], 'poses': []}
parts = []
materials = {}
for role in ['Fabric', 'Leather']:
    material = next(iter(source_collection.objects)).data.materials[0].copy()
    material.name = 'Tripo_' + role
    material.use_backface_culling = False
    materials[role] = material
for original in source_collection.objects:
    obj = original.copy()
    obj.data = original.data.copy()
    obj.name = 'Tripo_' + original.name
    animated.objects.link(obj)
    obj.data.transform(Matrix.Scale(SCALE, 4))
    obj.data.materials[0] = materials['Leather' if original.name.startswith(('Boot_', 'Glove_')) else 'Fabric']
    obj.parent = rig
    obj.matrix_parent_inverse = Matrix.Identity(4)
    modifier = obj.modifiers.new('Fitted canonical skeleton', 'ARMATURE')
    modifier.object = rig
    motion = obj.data.attributes.new('_WL_CLOTH', 'FLOAT_VECTOR', 'POINT')
    for vertex in obj.data.vertices:
        p = vertex.co
        normalized = p / SCALE
        role = original.name
        free = length = region = 0.0
        if role in {'Outer_Robe_Skirt', 'Front_Tabard', 'Hanging_Panel_L', 'Hanging_Panel_R', 'Hip_Overlays'}:
            anchor = 0.635 if role != 'Hip_Overlays' else 0.63
            length = max(0, anchor - normalized.z) * SCALE
            free = min(1, max(0, (anchor - normalized.z) / 0.5)) ** 1.4
            region = 1 if role == 'Outer_Robe_Skirt' else 2
            top = min(1, max(0, (normalized.z - 0.57) / 0.065))
            groups = {'spine_01': top, 'pelvis': 1 - top}
        elif role == 'Waist_Sash':
            groups = {'spine_01': 1.0}
        elif role == 'Upper_Robe_Hood_and_Sleeves':
            groups = upper_weights(normalized)
            if abs(normalized.x) > 0.15:
                free = min(1, max(0, (0.777 - normalized.z) / 0.10))
                length = max(0, 0.777 - normalized.z) * SCALE
                region = 4
        else:
            groups = transfer(p)
        total = sum(groups.values())
        for name, weight in groups.items():
            group = obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
            group.add([vertex.index], weight / total, 'REPLACE')
        motion.data[vertex.index].vector = (free, length, region)
    obj['rig_state'] = 'candidate; skin and cloth clearance require motion review'
    parts.append(obj)
    report['parts'].append({'name': obj.name, 'triangles': len(obj.data.polygons), 'vertices': len(obj.data.vertices)})
source_collection.hide_viewport = source_collection.hide_render = True
rig.data.pose_position = 'POSE'
actions = {a.name: a for a in bpy.data.actions}
report['clips'] = sorted(actions)
report['triangles'] = sum(p['triangles'] for p in report['parts'])
scene.render.resolution_x = scene.render.resolution_y = 1000
scene.camera.data.ortho_scale = 2.3
scene.camera.location = (3, -5, 2.4)
scene.camera.rotation_euler = (Vector((0, 0, 0.9)) - scene.camera.location).to_track_quat('-Z', 'Y').to_euler()
for name, fraction in [('idle', 0.3), ('walk', 0.2), ('run', 0.25), ('castShoot', 0.45), ('slam', 0.45)]:
    action = actions[name]
    rig.animation_data.action = action
    rig.animation_data.action_slot = action.slots[0]
    frame = action.frame_range.x + fraction * (action.frame_range.y - action.frame_range.x)
    scene.frame_set(int(frame), subframe=frame % 1)
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    all_points = [obj.evaluated_get(deps).matrix_world @ Vector(p) for obj in parts
                  for p in obj.evaluated_get(deps).bound_box]
    lo = [min(p[i] for p in all_points) for i in range(3)]
    hi = [max(p[i] for p in all_points) for i in range(3)]
    if any(not math.isfinite(v) for v in lo + hi) or max(hi[i] - lo[i] for i in range(3)) > 4:
        raise RuntimeError('Invalid deformation bounds: ' + name)
    report['poses'].append({'clip': name, 'frame': frame, 'bounds': [lo, hi]})
    if args.render:
        scene.render.filepath = str(OUT / 'review' / ('rig-' + name + '.png'))
        bpy.ops.render.render(write_still=True)

# Export one complete, uncompressed inspection asset before reducing geometry.
rig.animation_data.action = None
scene.frame_set(0)
for bone in rig.pose.bones:
    bone.matrix_basis = Matrix.Identity(4)
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
for obj in parts:
    obj.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(filepath=str(OUT / 'tripo-rig-test.glb'), export_format='GLB', use_selection=True,
                         export_animations=True, export_animation_mode='ACTIONS', export_anim_single_armature=True,
                         export_attributes=True, export_extras=True, export_yup=True)
rig.animation_data.action = actions['idle']
rig.animation_data.action_slot = actions['idle'].slots[0]
scene.frame_set(12)
scene.frame_start = 0
scene.frame_end = int(actions['idle'].frame_range.y)
for area in bpy.context.screen.areas:
    if area.type == 'VIEW_3D':
        area.spaces.active.region_3d.view_distance = 3.4
        area.spaces.active.region_3d.view_location = (0, 0, 0.9)
        area.spaces.active.region_3d.view_rotation = scene.camera.rotation_euler.to_quaternion()
guide = bpy.data.texts.new('RIG_REVIEW.txt')
guide.write('ACTUAL TRIPO RIG CANDIDATE\n\n'
            '07 contains the generated model and a separately fitted copy of the canonical skeleton.\n'
            'No placeholder garment is used. The original rig and source meshes are unchanged.\n'
            'Use the Armature Action Editor to inspect all 13 original clips.\n'
            'Skirt and hanging panels currently follow pelvis; _WL_CLOTH stores motion weights for the isolated viewer.\n'
            'This Blender file does not yet simulate cloth or solve leg collisions.\n'
            'No production character, equipment, inventory or loader has been changed.\n')
bpy.ops.wm.save_as_mainfile(filepath=str(TARGET), compress=True)
if hashlib.sha256(live.read_bytes()).hexdigest() != live_hash or hashlib.sha256(working_path.read_bytes()).hexdigest() != working_hash:
    raise RuntimeError('An input or shipped asset changed during rig preparation.')
report['working_source_unchanged'] = report['shipped_asset_unchanged'] = True
(OUT / 'rigging.json').write_text(json.dumps(report, indent=2))
print('RIG_PROOF=' + json.dumps(report))
