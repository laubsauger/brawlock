// Review adaptation of the game's readable cloth palette, sheen and rim.
// Tripo's red paint supplies an accent mask; it does not have the game's UV tags.
import { Color } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { attachPlayerLook } from './player-look-material.js'
import { PLAYER_COLOR_OPTIONS } from '../../../net/lobbyColors.ts'

export function createPlayerLookControls() {
  const $=id=>document.getElementById(id)
  const mode=$('playerLook')
  for(const [i,{name}]of PLAYER_COLOR_OPTIONS.entries())mode.add(new Option(name,String(i)))
  mode.add(new Option('Ten-color lineup','palette'));mode.add(new Option('Custom color','custom'))
  mode.value='3'
  for(const [id,direction] of [['previousColor',-1],['nextColor',1]])$(id).addEventListener('click',()=>{
    const current=/^\d+$/.test(mode.value)?Number(mode.value):-1
    mode.value=String(current<0?(direction>0?0:colors.length-1):(current+direction+colors.length)%colors.length)
    mode.dispatchEvent(new Event('input',{bubbles:true}))
  })
  const enabled=uniform(0),albedo=uniform(1),tint=uniform(.35),highlights=uniform(.35),coat=uniform(.03),glow=uniform(.45),charge=uniform(0)
  const colors=PLAYER_COLOR_OPTIONS.map(({color})=>uniform(new Color(color)))
  const attach=(material,source,index)=>attachPlayerLook(material,source,{enabled,albedo,tint,highlights,coat,glow,team:colors[index%colors.length],charge})
  function refresh(faces) {
    enabled.value=mode.value==='original'?0:1
    albedo.value=$('albedo').checked?1:0
    tint.value=Number($('playerTint').value);highlights.value=Number($('playerHighlights').value)
    coat.value=Number($('playerCoat').value);glow.value=Number($('playerGlow').value)
    for(let i=0;i<colors.length;i++) {
      if(mode.value==='original')continue
      const color=mode.value==='custom'?$('playerCustom').value:PLAYER_COLOR_OPTIONS[mode.value==='palette'?i:Number(mode.value)].color
      colors[i].value.set(color)
    }
    const follow=enabled.value>0&&$('playerEyes').checked
    faces.forEach((face,i)=>face.setColor(follow?colors[i%colors.length].value:$('eyeColor').value))
    $('eyeColor').disabled=follow;$('playerCustom').disabled=mode.value!=='custom'
    for(const id of ['playerTint','playerHighlights','playerCoat','playerGlow'])$(id).disabled=!enabled.value
  }
  return {attach,refresh,color(index){return enabled.value?colors[index%colors.length].value:$('eyeColor').value}}
}
