"""Small simulation mesh and render bindings; imported only by authoring scripts."""
import bpy
import hashlib, json, statistics, math
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform


def xyz(p):
    return [p.x, p.z, -p.y]  # Blender Z-up to glTF Y-up


def outer_driver(original):
    """Continuous skirt driver; generated thickness/hem fragments are render detail.

    Fit radial samples to the source rather than decimating its layered shell.
    Both sides of the visible fabric then bind to the same driver surface.
    """
    center_y=-.08
    samples=[]
    for vertex in original.data.vertices:
        p=vertex.co
        samples.append((math.atan2(p.x,-(p.y-center_y))%(2*math.pi),p.z,math.hypot(p.x,p.y-center_y)))
    columns,rows=16,10
    heights=[1.175-i*(1.175-.16)/(rows-1) for i in range(rows)]
    points=[]
    for height in heights:
        for column in range(columns):
            angle=column*2*math.pi/columns
            def distance(sample):
                da=abs(sample[0]-angle);da=min(da,2*math.pi-da)
                return (da/.3)**2+((sample[1]-height)/.14)**2
            near=sorted(samples,key=distance)[:12]
            weights=[1/(.04+distance(sample)) for sample in near]
            radius=sum(sample[2]*weight for sample,weight in zip(near,weights))/sum(weights)
            points.append((radius*math.sin(angle),center_y-radius*math.cos(angle),height))
    faces=[]
    for row in range(rows-1):
        for column in range(columns):
            a=row*columns+column;b=row*columns+(column+1)%columns;c=a+columns;d=b+columns
            faces.extend([(a,c,b),(b,c,d)])
    mesh=bpy.data.meshes.new('Continuous outer cloth driver')
    mesh.from_pydata(points,[],faces);mesh.update()
    obj=bpy.data.objects.new('Continuous outer cloth driver',mesh)
    bpy.context.collection.objects.link(obj)
    motion=mesh.attributes.new('_WL_CLOTH','FLOAT_VECTOR','POINT')
    for vertex in mesh.vertices:
        z=vertex.co.z/1.85
        free=min(1,max(0,(.635-z)/.5))**1.4
        motion.data[vertex.index].vector=(free,max(0,.635-z)*1.85,1)
        top=min(1,max(0,(z-.57)/.065))
        for name,weight in [('spine_01',top),('pelvis',1-top)]:
            if weight:
                group=obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
                group.add([vertex.index],weight,'REPLACE')
    return obj


OVERLAY_PARTS=('Hip_Overlays','Front_Tabard','Hanging_Panel')


def make_proxy(parts, rig):
    data = {'version': 1, 'positions': [[0, 0, 0]], 'skin': [[]],
            'mobility': [0], 'region': [0], 'contact':[[0,0,0]],'drape':[[0,0,0]],
            'triangles': [[0, 0, 0]], 'edges': [], 'garments': [], 'layers': [], 'sleeves': [], 'garmentEnvelopes': [], 'legCloth': [], 'clearance': [0]}
    surfaces = {}
    for original in parts:
        motion = original.data.attributes['_WL_CLOTH']
        if 'Upper_Robe' in original.name:
            # The underarm is part of the sleeve structure. Only the hanging
            # forearm cuff gets a gravity attachment; an upper-arm attachment
            # left half of the flap hanging near the hip as the wrist moved.
            for vertex in original.data.vertices:
                side='l' if vertex.co.x>0 else 'r'
                elbow=abs(rig.data.bones['lowerarm_'+side].head_local.x)
                t=min(1,max(0,(abs(vertex.co.x)-elbow)/.08))
                free=min(1,max(0,(1.43745-vertex.co.z)/.185))*t*t*(3-2*t)
                motion.data[vertex.index].vector.x=free
        if not any(v.vector.x > 0 for v in motion.data):
            continue
        if 'Outer_Robe' in original.name:
            obj=outer_driver(original)
        else:
            obj = original.copy()
            obj.data = original.data.copy()
            bpy.context.collection.objects.link(obj)
        for mod in list(obj.modifiers):
            obj.modifiers.remove(mod)
        # Keep a pinned band around each free area, including the sleeve roots.
        bm = bmesh.new(); bm.from_mesh(obj.data)
        layer = bm.verts.layers.float_vector['_WL_CLOTH']
        if 'Upper_Robe' in original.name:
            free_faces={f for f in bm.faces if any(v[layer].x>.025 for v in f.verts)}
            seam_faces=free_faces|{neighbour for face in free_faces for vertex in face.verts for neighbour in vertex.link_faces}
            remove=[f for f in bm.faces if f not in seam_faces]
        else:
            remove = [f for f in bm.faces if all(v[layer].z == 0 for v in f.verts)]
        bmesh.ops.delete(bm, geom=remove, context='FACES')
        # A simulation surface must not contain the two almost coincident skins
        # of the generated fabric thickness. Keep the outward sheet for skirts;
        # its render mesh still retains both sides and the original ragged hem.
        if 'Upper_Robe' in original.name:
            bm.normal_update()
            inward=[]
            for f in bm.faces:
                center=f.calc_center_median()
                outward=Vector((0,center.y+.085,center.z-1.45)).normalized()
                if f.normal.dot(outward)<.05:inward.append(f)
            bmesh.ops.delete(bm,geom=inward,context='FACES')
        else:
            bm.normal_update()
            inward = []
            for f in bm.faces:
                center = f.calc_center_median()
                if 'Outer_Robe' in original.name or 'Hip_Overlays' in original.name:
                    outward = Vector((center.x,center.y,0)).normalized()
                else:
                    outward = Vector((0,-1,0))
                if f.normal.dot(outward) < .05:
                    inward.append(f)
            bmesh.ops.delete(bm,geom=inward,context='FACES')
        if 'Upper_Robe' not in original.name:
            bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.009)
            bmesh.ops.dissolve_degenerate(bm,edges=list(bm.edges),dist=.004)
        bmesh.ops.delete(bm,geom=[v for v in bm.verts if not v.link_faces],context='VERTS')
        bm.to_mesh(obj.data); bm.free()
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True); bpy.context.view_layer.objects.active = obj
        target = len(obj.data.vertices) if 'Outer_Robe' in original.name else 90 if 'Upper_Robe' in original.name else 22
        mod = obj.modifiers.new('Simulation proxy only', 'DECIMATE')
        mod.ratio = min(1, target / max(1, len(obj.data.vertices)))
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
        bm=bmesh.new();bm.from_mesh(obj.data)
        bmesh.ops.delete(bm,geom=[v for v in bm.verts if not v.link_faces],context='VERTS')
        bm.to_mesh(obj.data);bm.free()
        mesh = obj.data; mesh.calc_loop_triangles()
        offset = len(data['positions'])
        face_offset = len(data['triangles'])
        points = [v.co.copy() for v in mesh.vertices]
        faces = [tuple(t.vertices) for t in mesh.loop_triangles]
        motion = mesh.attributes['_WL_CLOTH']
        minimum = min(v.vector.x for v in motion.data)
        maximum = max(v.vector.x for v in motion.data)
        for v in mesh.vertices:
            data['positions'].append(xyz(v.co))
            data['clearance'].append(.006)
            weights = sorted([(obj.vertex_groups[g.group].name, g.weight) for g in v.groups if g.weight > 0], key=lambda x: -x[1])[:4]
            total = sum(w for _, w in weights)
            if total <= 0: raise RuntimeError('Unweighted proxy vertex')
            data['skin'].append([[name, weight / total] for name, weight in weights])
            free, _, region = motion.data[v.index].vector
            # Pin the top edge, rather than pinning the whole garment to pelvis.
            pinned=free<=minimum+1e-6 if 'Outer_Robe' in original.name else free<=minimum+max(.025,(maximum-minimum)*.09)
            data['mobility'].append(0 if pinned else float(free))
            data['region'].append(int(round(region)))
            if 'Upper_Robe' in original.name:
                contact=Vector((0,0,0))
                anchor=v.co.copy();anchor.z=max(anchor.z,1.397)
                side='l' if v.co.x>0 else 'r'
                segments=[]
                for left,right in [('upperarm_'+side,'lowerarm_'+side),('lowerarm_'+side,'hand_'+side)]:
                    a=rig.data.bones[left].head_local;b=rig.data.bones[right].head_local
                    axis=(b-a).normalized();length=(b-a).length
                    along=max(0,min(1,(v.co-a).dot(axis)/length))
                    center=a+(b-a)*along
                    segments.append(((v.co-center).length_squared,left,right,along,axis,center))
                _,left,right,along,axis,center=min(segments,key=lambda entry:entry[0])
                down=Vector((0,0,-1));front=axis.cross(down).normalized()
                relative=v.co-center
                radius=.055 if left.startswith('upperarm') else .05
                data['sleeves'].append([len(data['positions'])-1,left,right,along,relative.dot(down),relative.dot(front),radius])
            else:
                contact=Vector((0,0,0)) if 'Outer_Robe' in original.name else Vector((v.co.x,v.co.y,0)).normalized() if 'Hip_Overlays' in original.name else Vector((0,-1,0))
                anchor=v.co.copy()
                if 'Hip_Overlays' in original.name:
                    angle=math.atan2(v.co.x/.14,(v.co.y+.08)/.10)
                    anchor=Vector((.14*math.sin(angle),-.08+.10*math.cos(angle),1.183))
            data['contact'].append(xyz(contact));data['drape'].append(xyz(anchor))
        adjacent = {}
        for a, b, c in faces:
            data['triangles'].append([a+offset, b+offset, c+offset])
            for i, j, opposite in [(a,b,c),(b,c,a),(c,a,b)]:
                adjacent.setdefault(tuple(sorted((i,j))), []).append(opposite)
        constraints = {}
        for (a,b), opposite in adjacent.items():
            constraints[(a,b)] = 1
            if len(opposite) == 2:
                constraints.setdefault(tuple(sorted(opposite)), .18)
        for (a,b), stiffness in constraints.items():
            data['edges'].append([a+offset,b+offset,(points[a]-points[b]).length,stiffness])
        data['garments'].append({'name':original.name,'start':offset,'count':len(points),
                                 'pinned':sum(m == 0 for m in data['mobility'][offset:])})
        if 'Upper_Robe' not in original.name:
            padding=.014 if 'Outer_Robe' in original.name else .018 if 'Hip_Overlays' in original.name else .010 if 'Front_Tabard' in original.name else .006
            data['legCloth'].append({'name':original.name,'nodes':list(range(offset,offset+len(points))),'padding':padding})
        surfaces[original.name] = (BVHTree.FromPolygons(points, faces, all_triangles=True), points, faces, offset, face_offset)
        bpy.data.objects.remove(obj, do_unlink=True)
    if len(data['positions']) > 512: raise RuntimeError('Proxy particle budget exceeded')
    # Fit a compact convex clothing envelope in the pelvis joint frame.
    # Individual folded triangles can give adjacent cuff points opposing
    # exit directions. Support planes contain the actual source garment and
    # remain convex as the attachment joint moves. This affects cuffs only.
    inverse_hip=rig.data.bones['pelvis'].matrix_local.inverted()
    samples=[]
    for original in parts:
        if not any(name in original.name for name in ['Outer_Robe','Hip_Overlays','Front_Tabard','Hanging_Panel','Waist_Sash']):continue
        samples.extend(inverse_hip@v.co for v in original.data.vertices if .65<=v.co.z<=1.2)
    if len(samples)<100:raise RuntimeError('Insufficient robe samples for cuff clearance envelope')
    planes=[];witnesses=[];supports=[]
    for x in [-1,0,1]:
        for y in [-1,0,1]:
            for z in [-1,0,1]:
                if not (x or y or z):continue
                normal=Vector((x,y,z)).normalized()
                support=max(samples,key=lambda point:point.dot(normal))
                planes.append([*normal,support.dot(normal)]);supports.append(support.copy())
                witnesses.append(xyz(rig.data.bones['pelvis'].matrix_local@support))
    # Fine render detail can extend beyond a coarse sleeve triangle. Reserve
    # that measured support radius, including ragged tips, in the cuff gap.
    upper=next(part for part in parts if 'Upper_Robe' in part.name)
    sleeve_tree=surfaces[upper.name][0]
    detail=0.0
    for vertex in upper.data.vertices:
        mobility=upper.data.attributes['_WL_CLOTH'].data[vertex.index].vector.x
        t=min(1,max(0,mobility/.12));freedom=t*t*(3-2*t)
        if freedom>0:detail=max(detail,sleeve_tree.find_nearest(vertex.co)[3]*freedom)
    center=sum(supports,Vector())/len(supports)
    data['garmentEnvelopes'].append({'joint':'pelvis','planes':planes,'center':list(center),
                                   'gap':.006+detail,'restWitnesses':witnesses})
    # Each cloth piece retains its own sheet and source thickness. Clearance
    # is the local inward detail behind that sheet, never the distance to a
    # different garment layer.
    for original in parts:
        if original.name not in surfaces or 'Upper_Robe' in original.name:continue
        tree,points,faces,offset,_=surfaces[original.name]
        for vertex in original.data.vertices:
            if original.data.attributes['_WL_CLOTH'].data[vertex.index].vector.x<=0:continue
            nearest,normal,face,_=tree.find_nearest(vertex.co)
            gap=.006+max(0,-(vertex.co-nearest).dot(normal))
            for i in faces[face]:data['clearance'][offset+i]=max(data['clearance'][offset+i],gap)
    # Center each leg capsule on the actual garment/body surface. Joint axes
    # alone were offset toward the outside/back and inflated the visible gap.
    by_name={obj.name:obj for obj in parts}
    colliders=[];collider_rest=[]
    for side in ['l','r']:
        for start,end,part in [('thigh_','calf_','Tripo_Trousers'),('calf_','foot_','Tripo_Trousers'),('foot_','ball_','Tripo_Boot_'+side.upper())]:
            left,right=start+side,end+side
            a=rig.data.bones[left].head_local;b=rig.data.bones[right].head_local;ab=b-a
            obj=by_name[part];offsets=[]
            for vertex in obj.data.vertices:
                groups={obj.vertex_groups[g.group].name:g.weight for g in vertex.groups}
                t=(vertex.co-a).dot(ab)/ab.length_squared
                if groups.get(left,0)>.45 and .15<t<.85:offsets.append(vertex.co-a-ab*t)
            if len(offsets)<12:raise RuntimeError('Insufficient body samples to fit '+left)
            center=Vector([statistics.median(p[i] for p in offsets) for i in range(3)])
            distances=sorted((p-center).length for p in offsets)
            radius=distances[int(.95*len(distances))]+.004
            end=b+center
            if start=='foot_':
                # The ball joint is inside the boot, not at its toe. Fit the
                # end hemisphere to the actual toe reach without widening it.
                direction=ab.normalized()
                tip=max((vertex.co-a-center).dot(direction) for vertex in obj.data.vertices)
                extension=max(0,tip-ab.length-radius+.006)
                end+=direction*extension
            local_a=rig.data.bones[left].matrix_local.inverted()@(a+center)
            local_b=rig.data.bones[right].matrix_local.inverted()@end
            # glTF converts the armature's world frame to Y-up, but preserves
            # each joint's local axes. Local offsets must stay in bone space;
            # xyz(local_a) would rotate the offset a second time.
            colliders.append([left,right,radius,'leg',list(local_a),list(local_b)])
            collider_rest.append([xyz(a+center),xyz(end)])
        for start,end,radius in [('upperarm_','lowerarm_',.055),('lowerarm_','hand_',.05)]:
            colliders.append([start+side,end+side,radius,'arm',[0,0,0],[0,0,0]])
            collider_rest.append([xyz(rig.data.bones[start+side].head_local),xyz(rig.data.bones[end+side].head_local)])
    # Short central hip capsule fills the gap between the two thigh surfaces.
    a=rig.data.bones['pelvis'].head_local.copy();a.y=-.07;a.z=1.05
    b=a.copy();b.z=1.10
    inv=rig.data.bones['pelvis'].matrix_local.inverted()
    colliders.append(['pelvis','pelvis',.115,'body',list(inv@a),list(inv@b)])
    collider_rest.append([xyz(a),xyz(b)])
    data['colliders']=colliders
    data['colliderRest']=collider_rest
    data['id'] = hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()[:16]
    surfaces['__id__'] = data['id']
    return data, surfaces


def bind_proxy(obj, garment, surfaces):
    obj['cloth_proxy_id'] = surfaces['__id__']
    for name in ['_WL_PROXY_INDICES','_WL_PROXY_WEIGHTS','_WL_PROXY_FACE']:
        if name in obj.data.attributes: obj.data.attributes.remove(obj.data.attributes[name])
    indices = obj.data.attributes.new('_WL_PROXY_INDICES','FLOAT_VECTOR','POINT')
    weights = obj.data.attributes.new('_WL_PROXY_WEIGHTS','FLOAT_VECTOR','POINT')
    face_ids = obj.data.attributes.new('_WL_PROXY_FACE','FLOAT','POINT')
    motion = obj.data.attributes['_WL_CLOTH']
    for v in obj.data.vertices:
        if garment not in surfaces or motion.data[v.index].vector.x <= 0:
            weights.data[v.index].vector = (1,0,0)
            continue
        tree, points, faces, offset, face_offset = surfaces[garment]
        nearest, _, face, _ = tree.find_nearest(v.co)
        a,b,c = faces[face]
        bary = barycentric_transform(nearest,points[a],points[b],points[c],Vector((1,0,0)),Vector((0,1,0)),Vector((0,0,1)))
        bary = Vector([max(0,x) for x in bary]); bary /= sum(bary)
        indices.data[v.index].vector = (a+offset,b+offset,c+offset)
        weights.data[v.index].vector = bary
        face_ids.data[v.index].value = face + face_offset
