"""Make two review LODs and bake normals from the unreduced rigged working mesh.

The supplied 2M original stays archived; it is not a matching bake cage for the
headless, remeshed working model. This pass preserves the working surface during
reduction, with source normals and UVs retained in the editable rigged .blend.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector
from importlib import import_module
sys.path.insert(0, str(Path(__file__).resolve().parent))
author = import_module('cloth-authoring')

ROOT = Path(__file__).resolve().parents[4]
parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--overwrite', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
OUT = args.out.resolve()
if (OUT / 'lods.json').exists() and not args.overwrite:
    raise RuntimeError('LOD outputs exist. Preserve edited files before rebuilding with --overwrite.')
source = OUT / 'tripo-warlock-cloth.blend'
source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
live = ROOT / 'public/models/warlock/warlock.glb'
live_hash = hashlib.sha256(live.read_bytes()).hexdigest()
bpy.ops.wm.open_mainfile(filepath=str(source))
scene = bpy.context.scene
collection = bpy.data.collections['07_ANIMATED_Tripo_Test']
rig = next(o for o in collection.objects if o.type == 'ARMATURE')
rig.animation_data.action = None
for bone in rig.pose.bones:
    bone.matrix_basis = Matrix.Identity(4)
rig.data.pose_position = 'REST'
bpy.context.view_layer.update()
originals = [o for o in collection.objects if o.type == 'MESH']
proxy_data, proxy_surfaces = author.make_proxy(originals, rig)
if proxy_data != json.loads((OUT / 'cloth-proxy.json').read_text()):
    raise RuntimeError('Proxy regeneration changed; rebuild bindings together.')
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 1
scene.render.bake.use_selected_to_active = True
scene.render.bake.use_clear = False
scene.render.bake.cage_extrusion = 0.012
scene.render.bake.max_ray_distance = 0.04
scene.render.bake.margin = 4
scene.render.bake.normal_space = 'TANGENT'
scene.render.image_settings.color_mode = 'RGB'
report = {'status': 'isolated review LODs; not registered in game',
          'normal_bake_source': 'unreduced 20,077-triangle headless working surfaces, paired by garment',
          'detailed_original': 'archived separately; no head or face projected onto the headless mesh', 'lods': []}


def deselect():
    bpy.ops.object.select_all(action='DESELECT')


def facing(obj, polygon, role):
    center = polygon.center
    if any(name in role for name in ['Tabard','Hanging_Panel']):
        outward = Vector((0,-1,0))
    elif 'Upper_Robe' in role and abs(center.x) > .28:
        outward = Vector((0,center.y+.085,center.z-1.44))
    else:
        outward = Vector((center.x,center.y,0))
    return int(polygon.normal.dot(outward) >= 0)


def bake_surface(obj, polygons):
    """Bake one side of thin fabric without letting a ray hit its reverse side.

    Preserve full-mesh corner normals: deleting the opposite side must not
    change the tangent basis at the edges of the bake target.
    """
    original=obj.data
    normals=[n.vector.copy() for n in original.corner_normals]
    data=bpy.data.meshes.new('Paired fabric bake surface')
    data.from_pydata([v.co for v in original.vertices],[],[tuple(p.vertices) for p in polygons])
    data.update()
    for material in original.materials: data.materials.append(material)
    uv=data.uv_layers.new(name=original.uv_layers.active.name)
    corner=[]
    for new,old in zip(data.polygons,polygons):
        new.use_smooth=old.use_smooth
        for a,b in zip(new.loop_indices,old.loop_indices):
            uv.data[a].uv=original.uv_layers.active.data[b].uv
            corner.append(normals[b])
    data.normals_split_custom_set(corner)
    copy=bpy.data.objects.new('Paired bake only',data)
    bpy.context.collection.objects.link(copy)
    return copy


for label, ratio, resolution in [('10k', 0.5, 2048), ('5k', 0.25, 2048)]:
    temporary = bpy.data.collections.new('LOD_' + label)
    scene.collection.children.link(temporary)
    normal = bpy.data.images.new('Tripo_Normal_' + label, width=resolution, height=resolution, alpha=False)
    normal.generated_color = (0.5, 0.5, 1, 1)
    normal.colorspace_settings.name = 'Non-Color'
    color = bpy.data.images.new('Tripo_Color_' + label, width=resolution, height=resolution, alpha=False)
    color.colorspace_settings.name = 'sRGB'
    materials = {}
    for original in originals:
        material = original.data.materials[0]
        if material.name in materials: continue
        copy = material.copy(); copy.name = material.name + '_' + label
        nodes = copy.node_tree.nodes
        for node in list(nodes):
            if node.type == 'TEX_IMAGE': nodes.remove(node)
        bsdf = nodes.get('Principled BSDF')
        for link in list(bsdf.inputs['Base Color'].links): copy.node_tree.links.remove(link)
        bsdf.inputs['Base Color'].default_value = (1,1,1,1)
        for name, image in [('Baked_Color_Target', color), ('Baked_Normal_Target', normal)]:
            node = nodes.new('ShaderNodeTexImage'); node.name = name; node.image = image
        materials[material.name] = copy
    objects = []
    for original in originals:
        obj = original.copy()
        obj.data = original.data.copy()
        obj.name = original.name + '_' + label
        temporary.objects.link(obj)
        obj.data.materials[0] = materials[original.data.materials[0].name]
        deselect()
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        # Bake targets are rest-space meshes. Reattach skinning after applying
        # reduction; the Armature modifier must not be applied into geometry.
        for modifier in list(obj.modifiers):
            obj.modifiers.remove(modifier)
        decimate = obj.modifiers.new('Review topology reduction', 'DECIMATE')
        decimate.ratio = ratio
        decimate.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=decimate.name)
        for vertex in obj.data.vertices:
            groups = [(obj.vertex_groups[g.group], g.weight) for g in vertex.groups if g.weight > 0]
            selected = sorted(groups, key=lambda item: -item[1])[:4]
            total = sum(weight for _, weight in selected)
            if total <= 0:
                raise RuntimeError('LOD vertex lost its skin weights: ' + obj.name)
            for group, _ in groups:
                group.remove([vertex.index])
            for group, weight in selected:
                group.add([vertex.index], weight / total, 'REPLACE')
        # New atlas: collapsed source UV islands cannot describe the new topology.
        obj.data.normals_split_custom_set([(0,0,0)] * len(obj.data.loops))
        author.bind_proxy(obj, original.name, proxy_surfaces)
        objects.append(obj)
    deselect()
    for obj in objects: obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=1.1519173, island_margin=0.008)
    bpy.ops.object.mode_set(mode='OBJECT')
    for original, obj in zip(originals, objects):
        thin = not any(name in original.name for name in ['Boot_','Glove_','Trousers'])
        for side in ([0,1] if thin else [None]):
            if thin:
                source_faces=[p for p in original.data.polygons if facing(original,p,original.name)==side]
                target_faces=[p for p in obj.data.polygons if facing(obj,p,original.name)==side]
                if not target_faces: continue
                if not source_faces: raise RuntimeError('A reduced surface lost its matching source side')
                selected_source=bake_surface(original,source_faces)
                selected_target=bake_surface(obj,target_faces)
            else:
                selected_source,selected_target=original,obj
            deselect(); selected_source.select_set(True); selected_target.select_set(True)
            bpy.context.view_layer.objects.active = selected_target
            for kind, target_node in [('DIFFUSE','Baked_Color_Target'), ('NORMAL','Baked_Normal_Target')]:
                for material in materials.values(): material.node_tree.nodes.active = material.node_tree.nodes[target_node]
                scene.render.bake.use_pass_direct = False
                scene.render.bake.use_pass_indirect = False
                scene.render.bake.use_pass_color = True
                bpy.ops.object.bake(type=kind)
            if thin:
                for item in [selected_source,selected_target]:
                    mesh=item.data; bpy.data.objects.remove(item,do_unlink=True); bpy.data.meshes.remove(mesh)
        modifier = obj.modifiers.new('Fitted canonical skeleton', 'ARMATURE'); modifier.object = rig
    color.filepath_raw = str(OUT / ('color-' + label + '.jpg'))
    color.file_format = 'JPEG'; color.save()
    normal.filepath_raw = str(OUT / ('normal-' + label + '.png'))
    normal.file_format = 'PNG'
    normal.save()
    for material in materials.values():
        nodes = material.node_tree.nodes
        material.node_tree.links.new(nodes['Baked_Color_Target'].outputs['Color'], nodes.get('Principled BSDF').inputs['Base Color'])
        target = nodes['Baked_Normal_Target']
        convert = nodes.new('ShaderNodeNormalMap')
        material.node_tree.links.new(target.outputs['Color'], convert.inputs['Color'])
        material.node_tree.links.new(convert.outputs['Normal'], nodes.get('Principled BSDF').inputs['Normal'])
    batches = []
    groups = [(material, [o for o in objects if o.data.materials[0] == material]) for material in materials.values()]
    for material, matching in groups:
        deselect()
        for obj in matching:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = matching[0]
        if len(matching) > 1:
            bpy.ops.object.join()
        joined = matching[0]
        joined.name = material.name
        batches.append(joined)
    rig.data.pose_position = 'POSE'
    deselect()
    rig.select_set(True)
    for obj in batches:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    target = OUT / ('tripo-' + label + '.glb')
    bpy.ops.export_scene.gltf(filepath=str(target), export_format='GLB', use_selection=True,
                             export_animations=True, export_animation_mode='ACTIONS',
                             export_anim_single_armature=True, export_attributes=True, export_extras=True,
                             export_yup=True, export_image_format='AUTO')
    triangles = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in batches)
    report['lods'].append({'file': target.name, 'triangles': triangles, 'meshes': len(batches),
                          'bytes': target.stat().st_size, 'texture_resolution': resolution,
                          'normal': normal.filepath_raw, 'color': color.filepath_raw})
    for obj in list(temporary.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.collections.remove(temporary)
    rig.data.pose_position = 'REST'
if hashlib.sha256(source.read_bytes()).hexdigest() != source_hash or hashlib.sha256(live.read_bytes()).hexdigest() != live_hash:
    raise RuntimeError('A source or shipped asset changed during LOD preparation.')
report['rigged_source_unchanged'] = report['shipped_asset_unchanged'] = True
(OUT / 'lods.json').write_text(json.dumps(report, indent=2))
print('LOD_PROOF=' + json.dumps(report))
