"""Build additive cloth authoring data without changing the rig source or live asset."""
import argparse, json, sys
from pathlib import Path
import bpy
from mathutils import Matrix
sys.path.insert(0,str(Path(__file__).resolve().parent))
from importlib import import_module
author = import_module('cloth-authoring')
parser=argparse.ArgumentParser(); parser.add_argument('--out',type=Path,required=True)
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:]); out=args.out.resolve()
bpy.ops.wm.open_mainfile(filepath=str(out/'tripo-warlock-rigged.blend'))
collection=bpy.data.collections['07_ANIMATED_Tripo_Test']
rig=next(o for o in collection.objects if o.type=='ARMATURE')
parts=[o for o in collection.objects if o.type=='MESH']
rig.animation_data.action=None; rig.data.pose_position='REST'
for bone in rig.pose.bones: bone.matrix_basis=Matrix.Identity(4)
bpy.context.view_layer.update()
data,surfaces=author.make_proxy(parts,rig)
for obj in parts: author.bind_proxy(obj,obj.name,surfaces)
(out/'cloth-proxy.json').write_text(json.dumps(data,separators=(',',':')))
rig.data.pose_position='POSE'
bpy.ops.object.select_all(action='DESELECT'); rig.select_set(True)
for obj in parts: obj.select_set(True)
bpy.context.view_layer.objects.active=rig
bpy.ops.export_scene.gltf(filepath=str(out/'tripo-rig-test.glb'),export_format='GLB',use_selection=True,
    export_animations=True,export_animation_mode='ACTIONS',export_anim_single_armature=True,
    export_attributes=True,export_extras=True,export_yup=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out/'tripo-warlock-cloth.blend'),compress=True)
print('CLOTH_PROXY='+json.dumps({'particles':len(data['positions']),'triangles':len(data['triangles']), 'constraints':len(data['edges']),'garments':data['garments']}))
