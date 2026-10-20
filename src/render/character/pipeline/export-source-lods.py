"""Compare reduction using the untouched Tripo material/UVs, without a ray bake."""
import bpy, argparse, json, sys, hashlib
from pathlib import Path
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform
from importlib import import_module
sys.path.insert(0,str(Path(__file__).resolve().parent))
author=import_module('cloth-authoring')
parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True)
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:]);out=args.out.resolve()
bpy.ops.wm.open_mainfile(filepath=str(out/'tripo-warlock-cloth.blend'))
collection=bpy.data.collections['07_ANIMATED_Tripo_Test']
rig=next(o for o in collection.objects if o.type=='ARMATURE');rig.animation_data.action=None
rig.data.pose_position='REST'
for bone in rig.pose.bones:bone.matrix_basis=Matrix.Identity(4)
bpy.context.view_layer.update()
originals=[o for o in collection.objects if o.type=='MESH']
data,surfaces=author.make_proxy(originals,rig)
if data!=json.loads((out/'cloth-proxy.json').read_text()):raise RuntimeError('Proxy data changed')
records=[]
cloth_budget={
    'Tripo_Outer_Robe_Skirt':.38,'Tripo_Upper_Robe_Hood_and_Sleeves':.31,
    'Tripo_Hip_Overlays':.3,'Tripo_Front_Tabard':.4,
    'Tripo_Hanging_Panel_L':.4,'Tripo_Hanging_Panel_R':.4,
    'Tripo_Waist_Sash':.15,'Tripo_Trousers':.08,
    'Tripo_Boot_L':.1,'Tripo_Boot_R':.1,'Tripo_Glove_L':.1,'Tripo_Glove_R':.1,
}
for label,ratio in [('5k',.25),('10k',.5)]:
    parts=[]
    for original in originals:
        obj=original.copy();obj.data=original.data.copy();bpy.context.collection.objects.link(obj)
        for mod in list(obj.modifiers):obj.modifiers.remove(mod)
        bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
        # Spend the small LOD's geometry on its moving silhouette. Uniform
        # reduction wasted a quarter of the budget on small boots and gloves.
        mod=obj.modifiers.new('Source UV reduction study','DECIMATE')
        mod.ratio=cloth_budget[original.name] if label=='5k' else ratio
        mod.use_collapse_triangulate=True
        bpy.ops.object.modifier_apply(modifier=mod.name)
        # Decimation also interpolates custom corner normals across folds. On
        # a thin shell that can point a visible triangle toward the inner skin.
        # Transfer normals from the matching side of the original surface.
        source=original.data
        tree=BVHTree.FromPolygons([v.co for v in source.vertices],[tuple(p.vertices) for p in source.polygons],all_triangles=True)
        corner=[n.vector.copy() for n in source.corner_normals]
        normals=[]
        for polygon in obj.data.polygons:
            for loop_index in polygon.loop_indices:
                point=obj.data.vertices[obj.data.loops[loop_index].vertex_index].co
                candidates=[item for item in tree.find_nearest_range(point,.06) if source.polygons[item[2]].normal.dot(polygon.normal)>.15]
                if not candidates:raise RuntimeError('Reduced face has no compatible source surface: '+original.name)
                nearest,_,face,_=min(candidates,key=lambda item:item[3])
                face=source.polygons[face];a,b,c=[source.vertices[i].co for i in face.vertices]
                bary=barycentric_transform(nearest,a,b,c,Vector((1,0,0)),Vector((0,1,0)),Vector((0,0,1)))
                normal=sum((corner[loop]*weight for loop,weight in zip(face.loop_indices,bary)),Vector()).normalized()
                normals.append(normal)
        obj.data.normals_split_custom_set(normals)
        for vertex in obj.data.vertices:
            groups=[(obj.vertex_groups[g.group],g.weight) for g in vertex.groups if g.weight>0]
            selected=sorted(groups,key=lambda x:-x[1])[:4];total=sum(w for _,w in selected)
            if total<=0:raise RuntimeError('Unweighted source LOD vertex')
            for group,_ in groups:group.remove([vertex.index])
            for group,weight in selected:group.add([vertex.index],weight/total,'REPLACE')
        author.bind_proxy(obj,original.name,surfaces)
        mod=obj.modifiers.new('Fitted canonical skeleton','ARMATURE');mod.object=rig
        parts.append(obj)
    batches=[]
    groups=[(material,[o for o in parts if o.data.materials[0]==material]) for material in {o.data.materials[0] for o in parts}]
    for material,objects in groups:
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects:obj.select_set(True)
        bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join()
        objects[0].name=material.name+'_original_'+label;batches.append(objects[0])
    rig.data.pose_position='POSE'
    bpy.ops.object.select_all(action='DESELECT');rig.select_set(True)
    for obj in batches:obj.select_set(True)
    bpy.context.view_layer.objects.active=rig
    target=out/('tripo-'+label+'-original.glb')
    bpy.ops.export_scene.gltf(filepath=str(target),export_format='GLB',use_selection=True,
        export_animations=True,export_animation_mode='ACTIONS',export_anim_single_armature=True,
        export_attributes=True,export_extras=True,export_yup=True)
    records.append({'file':target.name,'triangles':sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in batches),'meshes':len(batches),'material':'original Tripo, original UVs, 4K base color, no normal texture'})
    for obj in batches:bpy.data.objects.remove(obj,do_unlink=True)
    rig.data.pose_position='REST'
(out/'source-lods.json').write_text(json.dumps(records,indent=2))
print('SOURCE_LODS='+json.dumps(records))
