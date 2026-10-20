"""Small simulation mesh and render bindings; imported only by authoring scripts."""
import bpy
import hashlib, json
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform


def xyz(p):
    return [p.x, p.z, -p.y]  # Blender Z-up to glTF Y-up


def make_proxy(parts, rig):
    data = {'version': 1, 'positions': [[0, 0, 0]], 'skin': [[]],
            'mobility': [0], 'region': [0], 'triangles': [[0, 0, 0]], 'edges': [], 'garments': []}
    surfaces = {}
    for original in parts:
        motion = original.data.attributes['_WL_CLOTH']
        if not any(v.vector.x > 0 for v in motion.data):
            continue
        obj = original.copy()
        obj.data = original.data.copy()
        bpy.context.collection.objects.link(obj)
        for mod in list(obj.modifiers):
            obj.modifiers.remove(mod)
        # Keep a pinned band around each free area, including the sleeve roots.
        bm = bmesh.new(); bm.from_mesh(obj.data)
        layer = bm.verts.layers.float_vector['_WL_CLOTH']
        remove = [f for f in bm.faces if all(v[layer].z == 0 for v in f.verts)]
        bmesh.ops.delete(bm, geom=remove, context='FACES')
        # A simulation surface must not contain the two almost coincident skins
        # of the generated fabric thickness. Keep the outward sheet for skirts;
        # its render mesh still retains both sides and the original ragged hem.
        if 'Upper_Robe' not in original.name:
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
        target = 100 if 'Outer_Robe' in original.name else 50 if 'Upper_Robe' in original.name else 22
        mod = obj.modifiers.new('Simulation proxy only', 'DECIMATE')
        mod.ratio = min(1, target / max(1, len(obj.data.vertices)))
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
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
            weights = sorted([(obj.vertex_groups[g.group].name, g.weight) for g in v.groups if g.weight > 0], key=lambda x: -x[1])[:4]
            total = sum(w for _, w in weights)
            if total <= 0: raise RuntimeError('Unweighted proxy vertex')
            data['skin'].append([[name, weight / total] for name, weight in weights])
            free, _, region = motion.data[v.index].vector
            # Pin the top edge, rather than pinning the whole garment to pelvis.
            data['mobility'].append(0 if free <= minimum + max(.025, (maximum-minimum)*.09) else float(free))
            data['region'].append(int(round(region)))
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
        surfaces[original.name] = (BVHTree.FromPolygons(points, faces, all_triangles=True), points, faces, offset, face_offset)
        bpy.data.objects.remove(obj, do_unlink=True)
    if len(data['positions']) > 512: raise RuntimeError('Proxy particle budget exceeded')
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
