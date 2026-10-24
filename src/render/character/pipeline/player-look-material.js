// Source-texture player tint shared by the game and authoring review.
import { Color } from 'three/webgpu'
import { abs, attribute, clamp, dot, float, floor, fract, faceDirection, max, mix, normalView, positionView, pow, smoothstep, texture, uniform, uv, vec2, vec3 } from 'three/tsl'

import { glyph } from '../materials.ts'

export function attachPlayerLook(material,source,{enabled,albedo,tint,highlights,coat,glow,team,charge}) {
    if(!source.name.startsWith('Tripo_Fabric'))return
    const base=mix(vec3(1),texture(source.map).rgb,albedo).mul(uniform(source.color.clone()))
    // Relative redness keeps the dark painted trim in the player mask too.
    const redness=base.r.sub(max(base.g,base.b)).div(max(base.r,.01))
    const trim=smoothstep(.15,.45,redness)
    const lum=dot(base,vec3(.2126,.7152,.0722)),shade=clamp(lum.div(.05),.25,2.2)
    const fabric=mix(vec3(.056,.052,.064),team.mul(.13),.3).mul(shade)
    const tinted=mix(base,fabric,tint)
    const accent=team.mul(.2).mul(clamp(lum.div(.12),.25,2.2))
    material.colorNode=mix(base,mix(tinted,accent,trim),enabled)
    const rim=pow(float(1).sub(clamp(dot(normalView,positionView.negate().normalize()),0,1)),3)
    // Read the paint at a coarse mip: the woven albedo must never become an
    // emissive noise mask. Only strongly red painted regions carry trim glow.
    const paint=texture(source.map,uv()).level(4).rgb
    const paintRed=paint.r.sub(max(paint.g,paint.b)).div(max(paint.r,.01))
    const luminousTrim=smoothstep(.60,.82,paintRed)
    const p=attribute('position','vec3'),row=float(1.05).sub(p.y).div(.085),cell=fract(row)
    const tabard=float(1).sub(smoothstep(.024,.035,abs(p.x))).mul(smoothstep(.15,.20,p.z))
      .mul(smoothstep(.58,.62,p.y)).mul(float(1).sub(smoothstep(1.015,1.045,p.y)))
      .mul(smoothstep(.3,.7,attribute('normal','vec3').z)).mul(max(faceDirection,0))
      .mul(float(1).sub(luminousTrim))
    // Leave a real gap between glyphs; fract derivatives at cell seams must
    // not turn antialiasing into a bright horizontal divider.
    const gap=smoothstep(.08,.18,cell).mul(float(1).sub(smoothstep(.82,.92,cell)))
    const rune=glyph(floor(row).add(300),vec2(p.x.div(.064).add(.5),cell)).mul(tabard).mul(gap)
    const ink=luminousTrim.mul(.35).add(rune.mul(2.2)).mul(glow).mul(float(1).add(charge.mul(.4)))
    material.emissiveNode=team.mul(ink).add(team.mul(.16).add(vec3(.03,.04,.08)).mul(rim).mul(highlights)).mul(enabled)
    material.sheenNode=mix(uniform(new Color('#342a3a')).mul(.22),mix(vec3(.13,.12,.15),team.mul(.3),.35).mul(highlights),enabled)
    material.specularIntensityNode=mix(mix(.17,.32,trim),float(.1).add(highlights.mul(.5)),enabled)
    material.clearcoatNode=coat.mul(enabled);material.clearcoatRoughness=.6
  }
