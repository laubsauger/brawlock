"""Prepare the supplied Tripo asset as an isolated, unrigged Blender working file.

Requires tripo-intake.blend and canonical-rig-source.glb in --out. Neither the
original imports nor the game's character are edited. This is asset preparation,
not a runtime character registration or an automatic skinning operation.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[4]
parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True, type=Path)
parser.add_argument('--overwrite', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
out = args.out.resolve()
target = out / 'tripo-warlock-working.blend'
if target.exists() and not args.overwrite:
    raise RuntimeError('Working file already exists. Preserve edits before rebuilding with --overwrite.')
live = ROOT / 'public/models/warlock/warlock.glb'
live_hash = hashlib.sha256(live.read_bytes()).hexdigest()
manifest = json.loads((out / 'originals/manifest.json').read_text())
for item in manifest:
    if hashlib.sha256((out / 'originals' / item['file']).read_bytes()).hexdigest() != item['sha256']:
        raise RuntimeError('An archived input has changed: ' + item['file'])
bpy.ops.wm.open_mainfile(filepath=str(out / 'tripo-intake.blend'))
source = bpy.data.objects['low_00']
if len(source.data.vertices) != 10255 or len(source.data.polygons) != 20078:
    raise RuntimeError('This preparation map is specific to the supplied 10K headless export.')


def collection(name):
    c = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(c)
    return c


def move(obj, target_collection):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    target_collection.objects.link(obj)


working = collection('03_WORKING_Tripo_Garments_UNRIGGED')
review_only = collection('04_REVIEW_Export_Artifact')
rig_reference = collection('05_Canonical_Rig_REFERENCE_UNBOUND')
studio = collection('06_Review_Studio')
for obj in list(bpy.context.scene.objects):
    if obj.type in {'LIGHT', 'CAMERA'}:
        move(obj, studio)
original_low = bpy.data.collections['01_Tripo_10K_ORIGINAL']
original_high = bpy.data.collections['02_Tripo_HIGH_ORIGINAL']
original_low.hide_render = original_low.hide_viewport = True
original_high.hide_render = original_high.hide_viewport = True

# The exported mesh already contains useful disconnected garment surfaces. Split
# along those existing boundaries, preserving every original UV and corner normal.
m = source.data
adjacency = [[] for _ in m.vertices]
for edge in m.edges:
    a, b = edge.vertices
    adjacency[a].append(b)
    adjacency[b].append(a)
seen = set()
components = []
for vertex in m.vertices:
    if vertex.index in seen:
        continue
    queue, indices = [vertex.index], set([vertex.index])
    seen.add(vertex.index)
    while queue:
        current = queue.pop()
        for neighbor in adjacency[current]:
            if neighbor not in seen:
                seen.add(neighbor)
                indices.add(neighbor)
                queue.append(neighbor)
    components.append(indices)

# These representatives are from the measured intake of this exact file. A new
# generation requires a new reviewed map, rather than silently guessing parts.
parts = {
    29: 'Upper_Robe_Hood_and_Sleeves',
    0: 'Outer_Robe_Skirt',
    81: 'Trousers',
    4471: 'Glove_L',
    9526: 'Glove_R',
    1222: 'Boot_L',
    6258: 'Boot_R',
    18: 'Hip_Overlays',
    84: 'Waist_Sash',
    135: 'Front_Tabard',
    306: 'Hanging_Panel_L',
    5309: 'Hanging_Panel_R',
    2392: 'Detached_Triangle_REVIEW',
}
if len(components) != len(parts):
    raise RuntimeError('Unexpected connected surface count.')
report = {
    'status': 'isolated asset preparation; unrigged; not available in game',
    'originals': manifest,
    'parts': [],
    'normal_map': 'absent from supplied GLBs; only base color textures are embedded',
    'cloth': 'separate source surfaces preserved; motion and collision not implemented',
    'baking': 'pending working topology and alignment; detailed source has a head, working source does not',
    'rig': 'existing skeleton and animations retained as hidden, unbound reference',
}
corner_normals = [tuple(n.vector) for n in m.corner_normals]
for indices in components:
    matches = [name for representative, name in parts.items() if representative in indices]
    if len(matches) != 1:
        raise RuntimeError('Unexpected component identity.')
    name = matches[0]
    polygons = [p for p in m.polygons if p.vertices[0] in indices]
    ordered = sorted(indices)
    remap = {old: new for new, old in enumerate(ordered)}
    data = bpy.data.meshes.new(name + '_Mesh')
    data.from_pydata([tuple(m.vertices[i].co) for i in ordered], [],
                     [tuple(remap[v] for v in p.vertices) for p in polygons])
    data.update()
    for material in m.materials:
        data.materials.append(material)
    for source_uv in m.uv_layers:
        dest_uv = data.uv_layers.new(name=source_uv.name)
        for dest_polygon, original_polygon in zip(data.polygons, polygons):
            for dest_loop, original_loop in zip(dest_polygon.loop_indices, original_polygon.loop_indices):
                dest_uv.data[dest_loop].uv = source_uv.data[original_loop].uv
    for dest_polygon, original_polygon in zip(data.polygons, polygons):
        dest_polygon.use_smooth = original_polygon.use_smooth
        dest_polygon.material_index = original_polygon.material_index
    data.normals_split_custom_set([corner_normals[i] for p in polygons for i in p.loop_indices])
    provenance = data.attributes.new('source_vertex_index', 'INT', 'POINT')
    for dest, old in zip(provenance.data, ordered):
        dest.value = old
    obj = bpy.data.objects.new(name, data)
    destination = review_only if name.endswith('_REVIEW') else working
    destination.objects.link(obj)
    obj.matrix_world = source.matrix_world.copy()
    obj['source'] = 'tripo-10k-headless.glb'
    obj['prepared_state'] = 'unrigged; source UVs and normals preserved'
    report['parts'].append({'name': name, 'vertices': len(data.vertices), 'triangles': len(data.polygons),
                            'included_in_working_view': destination == working})
review_only.hide_render = review_only.hide_viewport = True
if sum(p['triangles'] for p in report['parts']) != 20078:
    raise RuntimeError('Partition lost or duplicated source faces.')

before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=str(out / 'canonical-rig-source.glb'))
imported = [o for o in bpy.data.objects if o not in before]
for obj in imported:
    move(obj, rig_reference)
armatures = [o for o in imported if o.type == 'ARMATURE']
if len(armatures) != 1 or len(armatures[0].data.bones) != 65:
    raise RuntimeError('Unexpected canonical skeleton.')
rig = armatures[0]
rig.animation_data.action = None
for track in rig.animation_data.nla_tracks:
    track.mute = True
rig.data.pose_position = 'REST'
rig_reference.hide_render = rig_reference.hide_viewport = True
report['canonical_bones'] = len(rig.data.bones)
report['canonical_clips'] = sorted(a.name for a in bpy.data.actions)

# Render the actual imported garment structure, with no placeholder clothing.
scene = bpy.context.scene
camera = scene.camera
camera.data.ortho_scale = 1.16
camera.location = (1.6, -3, 1.4)
camera.rotation_euler = (Vector((0, 0, 0.5)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
scene.render.filepath = str(out / 'review/working-garments.png')
bpy.ops.render.render(write_still=True)
outer = bpy.data.objects['Outer_Robe_Skirt']
outer.hide_render = True
scene.render.filepath = str(out / 'review/inner-garments.png')
bpy.ops.render.render(write_still=True)
outer.hide_render = False
scene.render.filepath = ''
for image in bpy.data.images:
    if image.has_data and image.source == 'FILE' and not image.packed_file:
        image.pack()
guide = bpy.data.texts.new('START_HERE.txt')
guide.write('TRIPO WARLOCK — REAL ASSET WORKING FILE\n\n'
            '03_WORKING contains 12 real source surfaces, separated without changing UVs or topology.\n'
            'The hood, bodice and sleeves are currently a single connected surface. Further separation is pending.\n'
            '01 and 02 retain untouched lower-detail and detailed imports. Toggle collection visibility to inspect.\n'
            '04 retains one detached triangle for review, hidden from the working view.\n'
            '05 contains our existing 65-bone rig and 13 animations as a hidden reference.\n'
            'The new character is NOT skinned to it yet; body proportions and rest pose need fitting first.\n'
            'No placeholder robe is used. No runtime loader, inventory or equipment registration was changed.\n'
            'Both supplied models contain base color only. Bake normals after finalizing topology and alignment.\n'
            'Do not bake the detailed source head onto the headless hood opening.\n'
            'Next gates: rig fit, skin weights, animated cloth clearance, material masks and lower-detail export.\n')
for area in bpy.context.screen.areas:
    if area.type == 'VIEW_3D':
        area.spaces.active.region_3d.view_distance = 1.8
        area.spaces.active.region_3d.view_location = (0, 0, 0.5)
        area.spaces.active.region_3d.view_rotation = camera.rotation_euler.to_quaternion()
        area.spaces.active.shading.type = 'MATERIAL'
bpy.ops.object.select_all(action='DESELECT')
bpy.context.view_layer.objects.active = bpy.data.objects['Upper_Robe_Hood_and_Sleeves']
bpy.context.view_layer.objects.active.select_set(True)
bpy.ops.wm.save_as_mainfile(filepath=str(target), compress=True)
if hashlib.sha256(live.read_bytes()).hexdigest() != live_hash:
    raise RuntimeError('The shipped character asset changed during preparation.')
report['shipped_asset_sha256'] = live_hash
report['shipped_asset_unchanged'] = True
(out / 'preparation.json').write_text(json.dumps(report, indent=2))
print('PREPARED=' + json.dumps(report))
