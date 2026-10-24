"""Isolated Blender authoring starter. Never writes the shipped model or game data.

Blender --factory-startup -b --python build-kit.py -- --out art/source/warlock-kit-v1
Run decode-warlock.mjs first. --overwrite explicitly rebuilds generated authoring files.
"""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[4]
parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--overwrite', action='store_true')
parser.add_argument('--render', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
OUT = args.out.resolve()
SOURCE = OUT / 'rig-source.glb'
BLEND = OUT / 'warlock-kit-v1.blend'
if not SOURCE.is_file():
    raise RuntimeError('Decode the existing warlock into OUT/rig-source.glb first.')
if BLEND.exists() and not args.overwrite:
    raise RuntimeError('Authoring file exists; use another output directory or --overwrite.')
if OUT == (ROOT / 'public/models/warlock').resolve():
    raise RuntimeError('The authoring output must be separate from the shipped character.')
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'review').mkdir(exist_ok=True)
live = ROOT / 'public/models/warlock/warlock.glb'
live_hash = hashlib.sha256(live.read_bytes()).hexdigest()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(SOURCE))
rigs = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
if len(rigs) != 1:
    raise RuntimeError('Expected exactly one existing character rig.')
rig = rigs[0]
required = ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head']
required += [f'{name}_{side}' for side in ['l', 'r'] for name in ['upperarm', 'lowerarm', 'hand', 'thigh', 'calf', 'foot']]
for name in required:
    if name not in rig.data.bones:
        raise RuntimeError('Missing canonical bone: ' + name)
if rig.matrix_world != Matrix.Identity(4):
    raise RuntimeError('The canonical authoring rig must have an identity object transform.')
actions = {a.name: a for a in bpy.data.actions}
for name in ['idle', 'walk', 'run', 'castEnter', 'castLoop', 'castShoot', 'castExit', 'death']:
    if name not in actions:
        raise RuntimeError('Missing canonical animation: ' + name)
rig.animation_data.action = None
for track in rig.animation_data.nla_tracks:
    track.mute = True
rig.data.pose_position = 'REST'
bpy.context.view_layer.update()
legacy = {o.name: o for o in bpy.context.scene.objects if o.type == 'MESH' and o.name.startswith('Male_Ranger_')}


def collection(name):
    c = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(c)
    return c


def move(obj, target):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    target.objects.link(obj)


source_collection = collection('00_Original_REFERENCE_ONLY')
for obj in legacy.values():
    move(obj, source_collection)
rig_collection = collection('01_Shared_Rig_and_Controls')
move(rig, rig_collection)
lods = [collection('02_Kit_HIGH'), collection('03_Kit_LOW')]
studio = collection('04_Preview_Studio_NOT_EXPORTED')
controls = bpy.data.objects.new('KIT_CONTROLS', None)
rig_collection.objects.link(controls)
controls.empty_display_type = 'PLAIN_AXES'
controls.empty_display_size = 0.1
controls.location = (1.2, 0, 0)
properties = {
    'show_hood': (True, 'Hood on hides the covered head; off exposes the placeholder head.'),
    'show_upper': (True, 'Upper robe on hides the covered torso.'),
    'show_sleeves': (True, 'Sleeves on hide the underlying arms.'),
    'show_skirt': (True, 'Split lower robe. Legs and boots remain present through its openings.'),
    'show_cape': (True, 'Separate shoulder-mounted cloth piece.'),
    'show_ornaments': (False, 'Simple socket/finish examples; final ornamental meshes are separate work.'),
    'detail': (0, '0 = HIGH mesh, 1 = LOW mesh. Same rig and animation library.'),
    'finish': (0, '0 = Void/burgundy/violet, 1 = Ember/charcoal/orange. Authoring finishes only.'),
}
for key, (value, description) in properties.items():
    controls[key] = value
    controls.id_properties_ui(key).update(description=description)
    if type(value) is int:
        controls.id_properties_ui(key).update(min=0, max=1)


def variable(driver, key):
    v = driver.variables.new()
    v.name = key
    v.type = 'SINGLE_PROP'
    v.targets[0].id = controls
    v.targets[0].data_path = f'["{key}"]'


def set_control(key, value):
    controls[key] = value
    controls.update_tag()
    bpy.context.view_layer.update()


def visibility(obj, lod, feature=None, uncovered=False):
    for prop in ['hide_render', 'hide_viewport']:
        driver = obj.driver_add(prop).driver
        for old in list(driver.variables):
            driver.variables.remove(old)
        variable(driver, 'detail')
        expr = f'detail != {lod}'
        if feature:
            variable(driver, feature)
            expr += f' or {feature}' if uncovered else f' or not {feature}'
        driver.expression = expr


def material(name, base, roughness=0.7, metal=0.0, ember=None, glow=False):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*base, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*base, 1)
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Metallic'].default_value = metal
    if ember:
        for i in range(3):
            d = p.inputs['Base Color'].driver_add('default_value', i).driver
            variable(d, 'finish')
            d.expression = f'{base[i]}*(1-finish)+{ember[i]}*finish'
    if glow:
        p.inputs['Emission Color'].default_value = (*base, 1)
        p.inputs['Emission Strength'].default_value = 2.5
        for i in range(3):
            d = p.inputs['Emission Color'].driver_add('default_value', i).driver
            variable(d, 'finish')
            d.expression = f'{base[i]}*(1-finish)+{ember[i]}*finish'
    return m


cloth = material('Kit_Fabric_Primary_DYE', (0.025, 0.021, 0.03), ember=(0.022, 0.018, 0.015))
lining = material('Kit_Lining_Secondary_DYE', (0.17, 0.025, 0.045), ember=(0.19, 0.038, 0.008))
leather = material('Kit_Leather', (0.035, 0.027, 0.025), 0.58)
metal = material('Kit_Metal', (0.19, 0.16, 0.15), 0.34, 0.8)
glow = material('Kit_Glow_Accent', (0.38, 0.008, 0.8), 0.3, 0.2, (1.0, 0.06, 0.002), True)
dark = material('Kit_Hood_Interior', (0.001, 0.001, 0.002), 1.0)
dark.node_tree.nodes.get('Principled BSDF').inputs['Specular IOR Level'].default_value = 0
under = material('Kit_Underlayer', (0.045, 0.041, 0.042), 0.8)
models = [[], []]


def skin(obj, weights):
    obj.parent = rig
    obj.matrix_parent_inverse = Matrix.Identity(4)
    mod = obj.modifiers.new('Shared Canonical Skeleton', 'ARMATURE')
    mod.object = rig
    for index, groups in enumerate(weights):
        total = sum(groups.values())
        if total <= 0:
            raise RuntimeError('Unweighted vertex: ' + obj.name)
        for bone, weight in groups.items():
            if bone not in rig.data.bones:
                raise RuntimeError('Unknown deform bone: ' + bone)
            group = obj.vertex_groups.get(bone) or obj.vertex_groups.new(name=bone)
            group.add([index], weight / total, 'REPLACE')


def mesh(name, vertices, faces, weights, uv, motion, lod, feature=None, uncovered=False, mat=cloth):
    data = bpy.data.meshes.new(name + '_Mesh')
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name + f'_LOD{lod}', data)
    lods[lod].objects.link(obj)
    data.materials.append(mat)
    data.materials.append(lining)
    layer = data.uv_layers.new(name='UVMap')
    for poly in data.polygons:
        poly.use_smooth = True
        for loop in poly.loop_indices:
            layer.data[loop].uv = uv[data.loops[loop].vertex_index]
    # Named authoring attributes are exported explicitly; runtime cloth adaptation is separate.
    attr = data.attributes.new('_WL_CLOTH', 'FLOAT_VECTOR', 'POINT')
    for i, value in enumerate(motion):
        attr.data[i].vector = value
    dye = data.attributes.new('_WL_DYE', 'FLOAT_VECTOR', 'POINT')
    for item in dye.data:
        item.vector = (1, 0, 0)
    skin(obj, weights)
    obj['kit_piece'] = name
    obj['kit_lod'] = lod
    obj['cloth_attribute'] = '_WL_CLOTH: mobility, distance_from_anchor_m, region'
    visibility(obj, lod, feature, uncovered)
    models[lod].append(obj)
    return obj


def grid(name, rows, cols, fn, lod, feature, mat=cloth):
    vertices, weights, uvs, motion, faces = [], [], [], [], []
    for i in range(rows + 1):
        for j in range(cols + 1):
            point, bones, free, length, region = fn(i / rows, j / cols)
            vertices.append(point)
            weights.append(bones)
            uvs.append((j / cols, 1 - i / rows))
            motion.append((free, length, region))
    for i in range(rows):
        for j in range(cols):
            a = i * (cols + 1) + j
            faces.append((a, a + 1, a + cols + 2, a + cols + 1))
    return mesh(name, vertices, faces, weights, uvs, motion, lod, feature, mat=mat)


def extract(source_name, name, lod, mat, feature=None, uncovered=False, material_name=None, hand_region=False):
    src = legacy[source_name]
    polygons = [p for p in src.data.polygons if material_name is None or src.data.materials[p.material_index].name == material_name]
    if hand_region:
        # The source palm and fingers use different materials. Keep the complete
        # wrist/hand region; selecting the skin material alone leaves floating fingers.
        polygons = [p for p in polygons if min(abs(src.data.vertices[v].co.x) for v in p.vertices) >= 0.64]
    if not polygons:
        raise RuntimeError('No source polygons for ' + name)
    used = sorted(set(v for p in polygons for v in p.vertices))
    ids = {v: i for i, v in enumerate(used)}
    vertices, weights = [], []
    for index in used:
        v = src.data.vertices[index]
        vertices.append(tuple(src.matrix_world @ v.co))
        entries = sorted([(src.vertex_groups[g.group].name, g.weight) for g in v.groups if src.vertex_groups[g.group].name in rig.data.bones], key=lambda item: -item[1])[:4]
        weights.append(dict(entries))
    obj = mesh(name, vertices, [tuple(ids[v] for v in p.vertices) for p in polygons], weights,
               [(0, 0)] * len(vertices), [(0, 0, 0)] * len(vertices), lod, feature, uncovered, mat)
    if lod == 1 and name == 'Body_Boots':
        bpy.context.view_layer.objects.active = obj
        decimate = obj.modifiers.new('LOW Boot Topology', 'DECIMATE')
        decimate.ratio = 0.45
        bpy.ops.object.modifier_move_up(modifier=decimate.name)
        bpy.ops.object.modifier_apply(modifier=decimate.name)
    return obj


def tube(name, a, b, radius, bone, lod, feature=None, uncovered=False, mat=under):
    a, b = Vector(a), Vector(b)
    axis = (b - a).normalized()
    u = axis.cross(Vector((0, 1, 0))).normalized()
    v = axis.cross(u).normalized()
    cols = 12 if lod == 0 else 8
    def point(t, s):
        angle = s * math.tau
        p = a.lerp(b, t) + radius * (u * math.cos(angle) + v * math.sin(angle))
        return tuple(p), {bone: 1}, 0, 0, 0
    obj = grid(name, 3, cols, point, lod, None, mat)
    visibility(obj, lod, feature, uncovered)
    return obj


for lod in [0, 1]:
    detail = 1 if lod == 0 else 0.45
    count = lambda n: max(4, round(n * detail))
    extract('Male_Ranger_Arms', 'Body_Gloves', lod, leather, hand_region=True)
    extract('Male_Ranger_Feet_Boots', 'Body_Boots', lod, leather)
    extract('Male_Ranger_Legs', 'Body_Legs', lod, under)
    extract('Male_Ranger_Body', 'Body_Torso', lod, under, 'show_upper', True)
    extract('Male_Ranger_Arms', 'Body_Arms', lod, under, 'show_sleeves', True, 'MI_Ranger')
    # A replaceable exposed-head placeholder, omitted whenever the hood covers it.
    head = rig.data.bones['Head'].head_local
    tube('Body_Head_Placeholder', head + Vector((0, 0, -0.04)), head + Vector((0, 0, 0.18)), 0.095,
         'Head', lod, 'show_hood', True)

    def torso(t, s):
        z = 1.0 + 0.5 * t
        angle = s * math.tau
        rx = 0.15 + 0.07 * math.sin(t * math.pi * 0.75)
        ry = 0.105 + 0.03 * t
        point = (rx * math.sin(angle), 0.015 - ry * math.cos(angle), z)
        weights = {'spine_01': max(0.0, 1 - 2 * t), 'spine_03': max(0.0, 2 * t - 1), 'spine_02': 1 - abs(2 * t - 1)}
        return point, {k: v for k, v in weights.items() if v > 0}, 0, 0, 0
    grid('Robe_Upper', count(16), count(28), torso, lod, 'show_upper')

    for side, sign in [('l', 1), ('r', -1)]:
        def sleeve(t, s, side=side, sign=sign):
            angle = s * math.tau
            x = sign * (0.18 + 0.51 * t)
            radius = 0.085 + 0.045 * t ** 2
            y = 0.066 + math.cos(angle) * radius
            z = 1.455 + math.sin(angle) * radius - 0.055 * t ** 3
            blend = min(1, max(0, (t - 0.35) / 0.35))
            bones = {f'upperarm_{side}': 1 - blend, f'lowerarm_{side}': blend}
            return (x, y, z), {k: v for k, v in bones.items() if v > 0}, max(0, math.sin(angle) * -1) * t ** 3, 0.25 * t, 4
        grid('Sleeve_' + side.upper(), count(18), count(20), sleeve, lod, 'show_sleeves')

    panels = [('Front_L', 0.23, 1.80), ('Front_R', -1.80, -0.23), ('Back_L', 1.45, math.pi + 0.05), ('Back_R', -math.pi - 0.05, -1.45)]
    for name, start, end in panels:
        def skirt(t, s, start=start, end=end):
            angle = start + (end - start) * s
            rx = 0.17 + 0.24 * t ** 0.8
            ry = 0.12 + 0.13 * t
            hem = 0.08 * (0.5 + 0.5 * math.cos(s * math.pi * 6))
            z = 0.995 - 0.84 * t + hem * t ** 8
            return (rx * math.sin(angle), 0.02 - ry * math.cos(angle), z), {'pelvis': 1}, t ** 1.6, 0.84 * t, 1
        grid('Skirt_' + name, count(24), count(16), skirt, lod, 'show_skirt')

    def sash(t, s):
        angle = s * math.tau
        return (0.174 * math.sin(angle), 0.015 - 0.133 * math.cos(angle), 0.985 + 0.075 * t), {'pelvis': 1}, 0, 0, 0
    grid('Sash', 3, count(28), sash, lod, 'show_upper', lining)

    def tabard(t, s):
        width = 0.075 + 0.015 * math.sin(t * math.pi)
        x = (s * 2 - 1) * width
        z = 0.99 - 0.64 * t + 0.07 * abs(2 * s - 1) * t ** 6
        return (x, -0.133 - 0.13 * t, z), {'pelvis': 1}, t ** 1.5, 0.64 * t, 2
    grid('Front_Tabard', count(22), count(12), tabard, lod, 'show_skirt', lining)

    def cape(t, s):
        x = (2 * s - 1) * (0.17 + 0.19 * t)
        y = 0.15 + 0.14 * t + 0.015 * math.sin(s * math.pi * 8) * t
        z = 1.47 - 1.22 * t + 0.07 * math.cos(s * math.pi * 4) * t ** 8
        return (x, y, z), {'spine_03': 1}, t ** 1.6, 1.22 * t, 3
    grid('Cape', count(26), count(18), cape, lod, 'show_cape', lining)

    # Open-faced hood: the rear surface wraps around the head, edges frame the void.
    def hood(t, s):
        z = 1.49 + 0.37 * t
        taper = max(0.06, math.sin((1 - t) * math.pi / 2))
        angle = 0.76 + s * (math.tau - 1.52)
        x = 0.16 * taper * math.sin(angle)
        y = 0.015 - 0.16 * taper * math.cos(angle)
        return (x, y, z), {'Head': 1}, 0, 0, 0
    grid('Hood', count(16), count(24), hood, lod, 'show_hood')
    face_points = [(-0.09, -0.033, 1.55), (0.09, -0.033, 1.55), (0.085, -0.033, 1.71), (0, -0.033, 1.78), (-0.085, -0.033, 1.71)]
    mesh('Hood_Void', face_points, [(0, 1, 2, 3, 4)], [{'Head': 1}] * 5, [(0, 0)] * 5, [(0, 0, 0)] * 5, lod, 'show_hood', mat=dark)
    for sign in [-1, 1]:
        x = sign * 0.045
        points = [(x - 0.023, -0.04, 1.666), (x + 0.023, -0.04, 1.666), (x + sign * 0.018, -0.04, 1.68)]
        mesh('Eye_' + ('L' if sign > 0 else 'R'), points, [(0, 1, 2)], [{'Head': 1}] * 3,
             [(0, 0)] * 3, [(0, 0, 0)] * 3, lod, 'show_hood', mat=glow)

    points = [(0, -0.17, 1.36), (0.045, -0.17, 1.29), (0, -0.17, 1.22), (-0.045, -0.17, 1.29), (0, -0.20, 1.29), (0, -0.15, 1.29)]
    faces = [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4), (1, 0, 5), (2, 1, 5), (3, 2, 5), (0, 3, 5)]
    mesh('Chest_Gem_EXAMPLE', points, faces, [{'spine_03': 1}] * 6, [(0, 0)] * 6, [(0, 0, 0)] * 6,
         lod, 'show_ornaments', mat=glow)

for name, bone, offset in [('Socket_Palm_L', 'hand_l', (0.08, -0.02, -0.025)), ('Socket_Palm_R', 'hand_r', (-0.08, -0.02, -0.025)),
                            ('Socket_Staff_L', 'hand_l', (0.08, 0.01, -0.03)), ('Socket_Head', 'Head', (0, 0, 0.14)),
                            ('Socket_Back', 'spine_03', (0, 0.16, 0))]:
    obj = bpy.data.objects.new(name, None)
    rig_collection.objects.link(obj)
    obj.parent = rig
    obj.parent_type = 'BONE'
    obj.parent_bone = bone
    obj.empty_display_size = 0.04
    obj.empty_display_type = 'ARROWS'
    obj.matrix_world = rig.matrix_world @ Matrix.Translation(rig.data.bones[bone].head_local + Vector(offset))
    obj['prototype_socket'] = True

source_collection.hide_render = True
source_collection.hide_viewport = True
rig.show_in_front = True
rig.data.display_type = 'STICK'
scene = bpy.context.scene
scene.render.fps = 24
scene.world = bpy.data.worlds.new('Kit_Preview_World')
scene.world.color = (0.13, 0.13, 0.13)
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 24
scene.render.resolution_x = 900
scene.render.resolution_y = 1050
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'AgX'


def aim(obj, point):
    obj.rotation_euler = (Vector(point) - obj.location).to_track_quat('-Z', 'Y').to_euler()


cam_data = bpy.data.cameras.new('Preview_Camera')
cam = bpy.data.objects.new('Preview_Camera', cam_data)
studio.objects.link(cam)
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 2.25
cam.location = (2.6, -5, 2.5)
aim(cam, (0, 0, 0.92))
scene.camera = cam
for name, location, power, size in [('Key', (2, -4, 5), 550, 4), ('Fill', (-3, -1, 2.5), 350, 3), ('Rim', (0, 3, 3), 650, 2.5)]:
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = power
    data.shape = 'DISK'
    data.size = size
    obj = bpy.data.objects.new(name, data)
    studio.objects.link(obj)
    obj.location = location
    aim(obj, (0, 0, 1))

guide = bpy.data.texts.new('START_HERE.txt')
guide.write('BRAWLOCK MODULAR KIT — ISOLATED AUTHORING PROTOTYPE\n\n'
            'This file does not replace or register any live character/equipment.\n'
            'Select KIT_CONTROLS; Object Properties > Custom Properties.\n'
            'show_hood / show_upper / show_sleeves toggle clothing and expose the covered body region automatically.\n'
            'Legs, gloves and boots remain real skinned meshes. Original meshes are retained in 00_Original_REFERENCE_ONLY.\n'
            'detail: 0 HIGH, 1 LOW. finish: 0 Void, 1 Ember.\n'
            'Choose an action on Armature in the Action Editor; all 13 original clips are retained.\n'
            'Garments contain _WL_CLOTH authoring attributes but are NOT a Blender cloth simulation.\n'
            'The standalone preview must adapt these attributes before runtime cloth is considered proven.\n'
            'Save an edited copy before rerunning the builder with --overwrite.\n')

proof = {'version': 1, 'status': 'authoring prototype; not registered in game', 'source_sha256': live_hash,
         'bones': len(rig.data.bones), 'clips': sorted(actions), 'lods': [], 'poses': [],
         'coverage': {'head': 'hidden when show_hood', 'torso': 'hidden when show_upper', 'arms': 'hidden when show_sleeves',
                      'legs': 'retained: exposed through front split', 'gloves': 'retained', 'boots': 'retained'},
         'cloth': {'attribute': '_WL_CLOTH', 'channels': ['mobility', 'anchor_distance_m', 'region'],
                   'regions': {'0': 'rigid', '1': 'skirt', '2': 'tabard', '3': 'cape', '4': 'sleeve'},
                   'runtime_status': 'requires isolated adapter; existing shader is untouched'}}
rig.data.pose_position = 'POSE'
for bone in rig.pose.bones:
    bone.matrix_basis = Matrix.Identity(4)
proof['coverage_checks'] = []
for feature, prefix in [('show_hood', 'Body_Head_Placeholder'), ('show_upper', 'Body_Torso'), ('show_sleeves', 'Body_Arms')]:
    body = next(o for o in models[0] if o.name.startswith(prefix))
    set_control(feature, False)
    if body.hide_render:
        raise RuntimeError('Covered body did not become visible: ' + feature)
    set_control(feature, True)
    if not body.hide_render:
        raise RuntimeError('Covered body did not become hidden: ' + feature)
    proof['coverage_checks'].append({'feature': feature, 'passed': True})


def export_batches(visible):
    # Keep the editable wardrobe pieces separate in the .blend. Batch only
    # temporary export copies by material to avoid one draw per garment panel.
    temporary = collection('EXPORT_TEMPORARY')
    groups = {}
    for obj in visible:
        key = obj.data.materials[0].name
        copy = obj.copy()
        copy.data = obj.data.copy()
        copy.animation_data_clear()
        copy.hide_viewport = copy.hide_render = False
        temporary.objects.link(copy)
        groups.setdefault(key, []).append(copy)
    batches = []
    for name, copies in groups.items():
        bpy.ops.object.select_all(action='DESELECT')
        for obj in copies:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = copies[0]
        bpy.ops.object.join()
        joined = copies[0]
        joined.name = 'Export_' + name
        joined['authoring_pieces'] = [o['kit_piece'] for o in visible if o.data.materials[0].name == name]
        batches.append(joined)
    return temporary, batches


for lod in [0, 1]:
    set_control('detail', lod)
    visible = [o for o in models[lod] if not o.hide_render]
    if not visible:
        raise RuntimeError('LOD export has no visible geometry: ' + str(lod))
    for obj in visible:
        for v in obj.data.vertices:
            weights = [g.weight for g in v.groups if obj.vertex_groups[g.group].name in rig.data.bones]
            if not weights or abs(sum(weights) - 1) > 0.005:
                raise RuntimeError('Invalid skin weights: ' + obj.name)
    temporary, batches = export_batches(visible)
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    for obj in batches:
        obj.select_set(True)
    for obj in rig_collection.objects:
        if obj.get('prototype_socket'):
            obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    target = OUT / ('prototype-high.glb' if lod == 0 else 'prototype-low.glb')
    bpy.ops.export_scene.gltf(filepath=str(target), export_format='GLB', use_selection=True,
                             export_animations=True, export_animation_mode='ACTIONS', export_attributes=True,
                             export_extras=True, export_yup=True, export_anim_single_armature=True)
    triangles = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in visible)
    proof['lods'].append({'level': lod, 'file': target.name, 'bytes': target.stat().st_size,
                          'triangles': triangles, 'export_batches': len(batches), 'meshes': [o.name for o in visible]})
    for obj in list(temporary.objects):
        data = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(data)
    bpy.data.collections.remove(temporary)

set_control('detail', 0)
for name, frame in [('idle', 12), ('run', 8), ('castShoot', 6)]:
    rig.animation_data.action = actions[name]
    rig.animation_data.action_slot = actions[name].slots[0]
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    points = []
    for obj in models[0]:
        if obj.hide_render:
            continue
        evaluated = obj.evaluated_get(deps)
        points.extend(evaluated.matrix_world @ Vector(v) for v in evaluated.bound_box)
    lo = [min(p[i] for p in points) for i in range(3)]
    hi = [max(p[i] for p in points) for i in range(3)]
    if any(not math.isfinite(v) for v in lo + hi) or max(hi[i] - lo[i] for i in range(3)) > 4:
        raise RuntimeError('Invalid animated bounds: ' + name)
    proof['poses'].append({'clip': name, 'frame': frame, 'bounds': [lo, hi]})
    if args.render:
        scene.render.filepath = str(OUT / 'review' / f'{name}.png')
        bpy.ops.render.render(write_still=True)

rig.animation_data.action = None
scene.frame_set(0)
for bone in rig.pose.bones:
    bone.matrix_basis = Matrix.Identity(4)
set_control('detail', 0)
set_control('finish', 0)
if args.render:
    cam.location = (0, -5, 0.95)
    aim(cam, (0, 0, 0.95))
    scene.render.filepath = str(OUT / 'review' / 'tpose-front.png')
    bpy.ops.render.render(write_still=True)
    cam.location = (2.6, -5, 2.5)
    aim(cam, (0, 0, 0.92))
for area in bpy.context.screen.areas:
    if area.type == 'VIEW_3D':
        area.spaces.active.region_3d.view_distance = 3.2
        area.spaces.active.region_3d.view_location = (0, 0, 0.9)
        area.spaces.active.region_3d.view_rotation = cam.rotation_euler.to_quaternion()
        area.spaces.active.shading.type = 'MATERIAL'
bpy.ops.object.select_all(action='DESELECT')
controls.select_set(True)
bpy.context.view_layer.objects.active = controls
scene.frame_end = 60
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
if hashlib.sha256(live.read_bytes()).hexdigest() != live_hash:
    raise RuntimeError('The shipped asset changed during authoring.')
proof['shipped_asset_unchanged'] = True
(OUT / 'manifest.json').write_text(json.dumps(proof, indent=2))
print('KIT_PROOF=' + json.dumps(proof))
