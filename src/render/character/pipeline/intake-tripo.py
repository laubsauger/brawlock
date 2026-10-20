"""Import and render archived Tripo originals in an isolated Blender file.

Blender --factory-startup -b --python intake-tripo.py -- --out art/source/tripo-warlock-v1
"""
import bpy,json,math,argparse,sys
from pathlib import Path
from mathutils import Vector
from collections import Counter
parser=argparse.ArgumentParser()
parser.add_argument('--out',type=Path,required=True)
parser.add_argument('--overwrite',action='store_true')
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
OUT=args.out.resolve()
if (OUT/'tripo-intake.blend').exists() and not args.overwrite:raise RuntimeError('Intake file exists; preserve edits before --overwrite.')
(OUT/'review').mkdir(parents=True,exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
def coll(name):
 c=bpy.data.collections.new(name);bpy.context.scene.collection.children.link(c);return c
def move(o,c):
 for x in list(o.users_collection):x.objects.unlink(o)
 c.objects.link(o)
def load(name,target):
 before=set(bpy.data.objects);bpy.ops.import_scene.gltf(filepath=str(OUT/'originals'/name),merge_vertices=True)
 objs=[o for o in bpy.data.objects if o not in before]
 for o in objs:move(o,target)
 return [o for o in objs if o.type=='MESH']
lowcol=coll('01_Tripo_10K_ORIGINAL');low=load('tripo-10k-headless.glb',lowcol)
highcol=coll('02_Tripo_HIGH_ORIGINAL');high=load('tripo-high-with-head.glb',highcol)
report=[]
for tag,objs in [('low',low),('high',high)]:
 for i,o in enumerate(objs):
  o.name=f'{tag}_{i:02d}'; used=set(v for p in o.data.polygons for v in p.vertices);pts=[o.matrix_world@o.data.vertices[v].co for v in used]
  lo=[min(v[k]for v in pts)for k in range(3)];hi=[max(v[k]for v in pts)for k in range(3)]
  report.append({'source':tag,'name':o.name,'verts':len(o.data.vertices),'faces':len(o.data.polygons),'tris':sum(len(p.vertices)-2 for p in o.data.polygons),'bounds':[lo,hi],'center':[sum(v[k]for v in pts)/len(pts)for k in range(3)],'polygon_sizes':dict(Counter(len(p.vertices)for p in o.data.polygons))})
print('INTAKE='+json.dumps(report));(OUT/'inspection.json').write_text(json.dumps(report,indent=2))
scene=bpy.context.scene;scene.world=bpy.data.worlds.new('ReviewWorld');scene.world.color=(0.12,0.12,0.12);scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=24;scene.render.resolution_x=1100;scene.render.resolution_y=1100;scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
def aim(o,p):o.rotation_euler=(Vector(p)-o.location).to_track_quat('-Z','Y').to_euler()
d=bpy.data.cameras.new('ReviewCamera');camera=bpy.data.objects.new('ReviewCamera',d);scene.collection.objects.link(camera);d.type='ORTHO';d.ortho_scale=1.16;scene.camera=camera
for n,pos,power in [('Key',(2,-3,4),220),('Fill',(-3,-1,2),150),('Rim',(0,3,3),300)]:
 d=bpy.data.lights.new(n,'AREA');d.energy=power;d.shape='DISK';d.size=3;o=bpy.data.objects.new(n,d);scene.collection.objects.link(o);o.location=pos;aim(o,(0,0,0.5))
for kind in ['low','high']:
 lowcol.hide_render=kind!='low';highcol.hide_render=kind!='high'
 for angle,pos in [('front',(0,-3,0.5)),('rear',(0,3,0.5)),('threequarter',(1.6,-3,1.4))]:
  camera.location=pos;aim(camera,(0,0,0.5));scene.render.filepath=str(OUT/'review'/f'intake-{kind}-{angle}.png');bpy.ops.render.render(write_still=True)
lowcol.hide_render=False;highcol.hide_render=True;highcol.hide_viewport=True
for image in bpy.data.images:
 if image.has_data:image.pack()
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'tripo-intake.blend'),compress=True)
print('SAVED_INTAKE')
