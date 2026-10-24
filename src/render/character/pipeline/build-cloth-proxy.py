"""Build additive cloth authoring data without changing the rig source or live asset."""
import argparse, json, sys, bmesh, hashlib, math
from array import array
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
# Remove only the small central red tip below the patterned hem. Preserve the
# upper lining, patterned panels, source UVs, custom normals and skin weights.
outer=next(o for o in parts if o.name=='Tripo_Outer_Robe_Skirt')
mesh=outer.data
image=next(n.image for n in mesh.materials[0].node_tree.nodes if n.type=='TEX_IMAGE')
width,height=image.size;pixels=array('f',[0])*len(image.pixels);image.pixels.foreach_get(pixels)
selected=set()
for face in mesh.polygons:
    points=[mesh.vertices[i].co for i in face.vertices]
    if not(face.center.y>.07 and max(p.z for p in points)<=.34 and max(abs(p.x) for p in points)<=.09):continue
    if len(points)!=3:raise RuntimeError('Rear tip selection requires source triangles')
    corners=[mesh.uv_layers.active.data[i].uv for i in face.loop_indices]
    red_samples=0;samples=0
    for a in range(5):
        for b in range(5-a):
            uv=corners[0]*(a/4)+corners[1]*(b/4)+corners[2]*(1-(a+b)/4)
            x=int(uv.x*width)%width;y=int(uv.y*height)%height
            red,green,blue=pixels[(y*width+x)*4:(y*width+x)*4+3]
            red_samples+=red>green*1.6 and red>blue*1.25;samples+=1
    if red_samples>=samples*.9:selected.add(face.index)
if len(selected)!=53:raise RuntimeError('Rear tip selection changed; review the source before trimming')
# Preserve the exact source triangles everywhere outside the reviewed tip.
def geometry_key(face):
    return '|'.join(sorted(','.join(str(math.floor(x*1e5+.5)) for x in author.xyz(mesh.vertices[i].co)) for i in face.vertices))
retained=[geometry_key(f) for f in mesh.polygons if f.index not in selected]
retained_hash=hashlib.sha256('\n'.join(sorted(retained)).encode()).hexdigest()
source_outer_count=len(mesh.polygons)
removed_bounds=[[min(mesh.vertices[i].co[j] for f in mesh.polygons if f.index in selected for i in f.vertices),max(mesh.vertices[i].co[j] for f in mesh.polygons if f.index in selected for i in f.vertices)] for j in range(3)]
source_normals=[n.vector.copy() for n in mesh.corner_normals]
normal_by_corner={(f.index,mesh.loops[i].vertex_index):source_normals[i] for f in mesh.polygons for i in f.loop_indices}
bm=bmesh.new();bm.from_mesh(mesh)
face_id=bm.faces.layers.int.new('_review_face');vertex_id=bm.verts.layers.int.new('_review_vertex')
for f in bm.faces:f[face_id]=f.index
for v in bm.verts:v[vertex_id]=v.index
bmesh.ops.delete(bm,geom=[f for f in bm.faces if f.index in selected],context='FACES')
bmesh.ops.delete(bm,geom=[v for v in bm.verts if not v.link_faces],context='VERTS')
normals=[normal_by_corner[(f[face_id],loop.vert[vertex_id])] for f in bm.faces for loop in f.loops]
bm.faces.layers.int.remove(face_id);bm.verts.layers.int.remove(vertex_id)
bm.to_mesh(mesh);bm.free();mesh.normals_split_custom_set(normals);mesh.update()
(out/'rear-cut.json').write_text(json.dumps({'removedTriangles':len(selected),'workingTriangles':20077-len(selected),'selection':'small central red tip only; patterned hem and upper lining preserved','removedFaceIds':sorted(selected),'removedBounds':removed_bounds,'sourceOuterTriangles':source_outer_count,'retainedOuterTriangles':len(retained),'retainedGeometryHash':retained_hash},indent=2))
print('REAR_CUT='+json.dumps({'removedTriangles':len(selected)}))
# Open the existing rear center seam up to the seat, without deleting fabric.
bm=bmesh.new();bm.from_mesh(mesh)
face_id=bm.faces.layers.int.new('_review_face');vertex_id=bm.verts.layers.int.new('_review_vertex')
for f in bm.faces:f[face_id]=f.index
for v in bm.verts:v[vertex_id]=v.index
normal_by_corner={(f.index,mesh.loops[i].vertex_index):mesh.corner_normals[i].vector.copy() for f in mesh.polygons for i in f.loop_indices}
seams=[]
for edge in bm.edges:
    if len(edge.link_faces)!=2:continue
    a,b=[f.calc_center_median() for f in edge.link_faces]
    if min(a.y,b.y)>-.04 and max(a.z,b.z)<1.13 and a.x*b.x<0:seams.append(edge)
if len(seams)!=40:raise RuntimeError('Rear center seam changed; review before splitting')
bmesh.ops.split_edges(bm,edges=seams)
side=bm.verts.layers.float.new('_WL_REAR_SIDE')
for v in bm.verts:
    rear=[f.calc_center_median().x for f in v.link_faces if f.calc_center_median().y>-.04]
    v[side]=1 if v.co.x>.001 else -1 if v.co.x<-.001 else 0
    if abs(v.co.x)<=.001 and rear and v.co.z<1.13:
        if min(rear)>=0:v[side]=1
        elif max(rear)<=0:v[side]=-1

normals=[normal_by_corner[(f[face_id],loop.vert[vertex_id])] for f in bm.faces for loop in f.loops]
bm.faces.layers.int.remove(face_id);bm.verts.layers.int.remove(vertex_id)
bm.to_mesh(mesh);bm.free();mesh.normals_split_custom_set(normals);mesh.update()
for obj in parts:
    if obj!=outer:obj.data.attributes.new('_WL_REAR_SIDE','FLOAT','POINT')
print('REAR_VENT_SEAM_EDGES='+str(len(seams)))
rig.animation_data.action=None; rig.data.pose_position='REST'
for bone in rig.pose.bones: bone.matrix_basis=Matrix.Identity(4)
bpy.context.view_layer.update()
waist_fit=author.fit_panel_waists(parts)
(out/'waist-fit.json').write_text(json.dumps({'profile':author.WAIST_FIT,'panels':waist_fit},indent=2))
print('WAIST_FIT='+json.dumps(waist_fit))
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
