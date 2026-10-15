/**
 * Recorded audio assets (generated from the processing manifest; do not edit by hand).
 * Files live in public/audio/<id>.ogg (Opus) and <id>.m4a (AAC, for Safari). Originals and
 * their metadata are archived in art/archive/audio/. All CC0 at download time; credited anyway.
 */

export interface AudioAsset {
  /** a seamless loop (play with loop = true, loopEnd = duration) */
  loop: boolean
  /** exact length in seconds (AAC adds padding past it) */
  duration: number
  /** index into AUDIO_CREDITS */
  credit: number
}

export interface AudioCredit {
  title: string
  creator: string
  license: 'CC0'
  url: string
}

/** Every recording we ship, for the Credits screen and docs/ASSETS.md. */
export const AUDIO_CREDITS: readonly AudioCredit[] = [
  { title: "Lava Loop 4", creator: "Fission9", license: 'CC0', url: "https://freesound.org/people/Fission9/sounds/474852" },
  { title: "Hot Bubbling Mud", creator: "Breviceps", license: 'CC0', url: "https://freesound.org/people/Breviceps/sounds/456806" },
  { title: "AKRICH_Antoine_2016_2017_CouleeDeLave.mp3", creator: "iut_Paris8", license: 'CC0', url: "https://freesound.org/people/iut_Paris8/sounds/390463" },
  { title: "Ambiance_Campfire_Loop_Stereo.wav", creator: "Nox_Sound", license: 'CC0', url: "https://freesound.org/people/Nox_Sound/sounds/558967" },
  { title: "Electric Zap Loop", creator: "Resaural", license: 'CC0', url: "https://freesound.org/people/Resaural/sounds/531421" },
  { title: "Large fan", creator: "MrLindstrom", license: 'CC0', url: "https://freesound.org/people/MrLindstrom/sounds/543964" },
  { title: "Earthquake in cave", creator: "Bertsz", license: 'CC0', url: "https://freesound.org/people/Bertsz/sounds/524307" },
  { title: "Fire: Burning Coal", creator: "qubodup", license: 'CC0', url: "https://freesound.org/people/qubodup/sounds/147252" },
  { title: "Steel chain hard clicking", creator: "ani_music", license: 'CC0', url: "https://freesound.org/people/ani_music/sounds/167916" },
  { title: "ESE - WHOOSH - CALM - Fire Flame.wav", creator: "EpicSoundEffects", license: 'CC0', url: "https://freesound.org/people/EpicSoundEffects/sounds/475879" },
  { title: "JM_FX_Fireball 03.wav", creator: "Julien Matthey", license: 'CC0', url: "https://freesound.org/people/Julien%20Matthey/sounds/346916" },
  { title: "Fire Burst Flash", creator: "Za-Games", license: 'CC0', url: "https://freesound.org/people/Za-Games/sounds/539972" },
  { title: "flame burst ignite bbq barbecue.flac", creator: "kyles", license: 'CC0', url: "https://freesound.org/people/kyles/sounds/637533" },
  { title: "Flamethrower.wav", creator: "MATRIXXX_", license: 'CC0', url: "https://freesound.org/people/MATRIXXX_/sounds/459884" },
  { title: "HQ Flamethrower - Burning", creator: "Quaker540", license: 'CC0', url: "https://freesound.org/people/Quaker540/sounds/214456" },
  { title: "Electrical Shock (Zap).wav", creator: "BigKahuna360", license: 'CC0', url: "https://freesound.org/people/BigKahuna360/sounds/160421" },
  { title: "Taser/High Voltage discharge", creator: "The_Chemical_Workshop", license: 'CC0', url: "https://freesound.org/people/The_Chemical_Workshop/sounds/403252" },
  { title: "Electric zap.wav", creator: "michael_grinnell", license: 'CC0', url: "https://freesound.org/people/michael_grinnell/sounds/512471" },
  { title: "Ice Breaking 5", creator: "giwake", license: 'CC0', url: "https://freesound.org/people/giwake/sounds/666482" },
  { title: "Ice Breaking 1", creator: "giwake", license: 'CC0', url: "https://freesound.org/people/giwake/sounds/666478" },
  { title: "Ice Breaking 3", creator: "giwake", license: 'CC0', url: "https://freesound.org/people/giwake/sounds/666476" },
  { title: "snow block of snow igloo brick put down crunch or hit or pat (works at low level).wav", creator: "kyles", license: 'CC0', url: "https://freesound.org/people/kyles/sounds/450848" },
  { title: "ninja", creator: "Igor1998", license: 'CC0', url: "https://freesound.org/people/Igor1998/sounds/391286" },
  { title: "Sword Clash.wav", creator: "Bird_man", license: 'CC0', url: "https://freesound.org/people/Bird_man/sounds/275159" },
  { title: "Metal Hit 2", creator: "dslrguide", license: 'CC0', url: "https://freesound.org/people/dslrguide/sounds/321482" },
  { title: "Metallic hit", creator: "_jack", license: 'CC0', url: "https://freesound.org/people/_jack/sounds/240213" },
  { title: "Stone Impact Rubble Debris 12", creator: "Sheyvan", license: 'CC0', url: "https://freesound.org/people/Sheyvan/sounds/569508" },
  { title: "Stone Impact Rubble Debris 7", creator: "Sheyvan", license: 'CC0', url: "https://freesound.org/people/Sheyvan/sounds/569503" },
  { title: "Stone Impact Rubble Debris 4", creator: "Sheyvan", license: 'CC0', url: "https://freesound.org/people/Sheyvan/sounds/569500" },
  { title: "Stone Impact Rubble Debris 10", creator: "Sheyvan", license: 'CC0', url: "https://freesound.org/people/Sheyvan/sounds/569506" },
  { title: "rock falling 010.wav", creator: "yottasounds", license: 'CC0', url: "https://freesound.org/people/yottasounds/sounds/232137" },
  { title: "Stone,Block,Drag,Wood,Grind.wav", creator: "Mediaman57", license: 'CC0', url: "https://freesound.org/people/Mediaman57/sounds/347149" },
  { title: "stone door close.wav", creator: "patchytherat", license: 'CC0', url: "https://freesound.org/people/patchytherat/sounds/530987" },
  { title: "Slow Pebble Tumble.wav", creator: "bbrocer", license: 'CC0', url: "https://freesound.org/people/bbrocer/sounds/398698" },
  { title: "Teleport - darker", creator: "GameAudio", license: 'CC0', url: "https://freesound.org/people/GameAudio/sounds/220205" },
  { title: "Teleport - Spacey", creator: "GameAudio", license: 'CC0', url: "https://freesound.org/people/GameAudio/sounds/220193" },
  { title: "Teleport High", creator: "GameAudio", license: 'CC0', url: "https://freesound.org/people/GameAudio/sounds/220162" },
  { title: "Magic Spell 05.wav", creator: "MATRIXXX_", license: 'CC0', url: "https://freesound.org/people/MATRIXXX_/sounds/495453" },
  { title: "Flutter Short.wav", creator: "RutgerMuller", license: 'CC0', url: "https://freesound.org/people/RutgerMuller/sounds/51144" },
  { title: "Fabric Flap.wav", creator: "akennedybrewer", license: 'CC0', url: "https://freesound.org/people/akennedybrewer/sounds/389170" },
  { title: "Swish wipe HZA 16-05-2022.wav", creator: "hz37", license: 'CC0', url: "https://freesound.org/people/hz37/sounds/667419" },
  { title: "Hit 3", creator: "ihitokage", license: 'CC0', url: "https://freesound.org/people/ihitokage/sounds/395359" },
  { title: "Hit 4", creator: "ihitokage", license: 'CC0', url: "https://freesound.org/people/ihitokage/sounds/395358" },
  { title: "Thud2.wav", creator: "BMacZero", license: 'CC0', url: "https://freesound.org/people/BMacZero/sounds/96137" },
  { title: "Thud3.wav", creator: "BMacZero", license: 'CC0', url: "https://freesound.org/people/BMacZero/sounds/96138" },
]

export const AUDIO_ASSETS = {
  bed_lava: { loop: true, duration: 12.007, credit: 0 },
  bed_bubbles: { loop: true, duration: 10.007, credit: 1 },
  bed_flow: { loop: true, duration: 10.007, credit: 2 },
  fire_loop: { loop: true, duration: 8.007, credit: 3 },
  zap_loop: { loop: true, duration: 3.006, credit: 4 },
  fan_loop: { loop: true, duration: 3.006, credit: 5 },
  rumble: { loop: false, duration: 3.006, credit: 6 },
  coal_crackle: { loop: false, duration: 4.006, credit: 7 },
  chain_clicks: { loop: false, duration: 1.857, credit: 8 },
  fire_whoosh_a: { loop: false, duration: 1.506, credit: 9 },
  fire_whoosh_b: { loop: false, duration: 1.206, credit: 10 },
  fire_burst: { loop: false, duration: 0.756, credit: 11 },
  flame_ignite: { loop: false, duration: 0.806, credit: 12 },
  flame_jet: { loop: false, duration: 2.207, credit: 13 },
  flame_roar: { loop: false, duration: 1.206, credit: 14 },
  zap_a: { loop: false, duration: 0.607, credit: 15 },
  zap_b: { loop: false, duration: 0.607, credit: 15 },
  zap_c: { loop: false, duration: 0.406, credit: 16 },
  zap_spark: { loop: false, duration: 0.227, credit: 17 },
  ice_a: { loop: false, duration: 1.006, credit: 18 },
  ice_b: { loop: false, duration: 0.356, credit: 19 },
  ice_c: { loop: false, duration: 0.306, credit: 20 },
  snow_crunch: { loop: false, duration: 0.556, credit: 21 },
  blade_swish: { loop: false, duration: 0.857, credit: 22 },
  clang_a: { loop: false, duration: 0.556, credit: 23 },
  clang_ring: { loop: false, duration: 1.407, credit: 24 },
  clank: { loop: false, duration: 0.233, credit: 25 },
  debris_a: { loop: false, duration: 0.806, credit: 26 },
  debris_b: { loop: false, duration: 0.707, credit: 27 },
  debris_c: { loop: false, duration: 0.806, credit: 28 },
  debris_d: { loop: false, duration: 0.906, credit: 29 },
  rock_fall: { loop: false, duration: 0.733, credit: 30 },
  stone_drag: { loop: false, duration: 0.756, credit: 31 },
  stone_door: { loop: false, duration: 2.006, credit: 32 },
  pebbles: { loop: false, duration: 1.006, credit: 33 },
  tele_out: { loop: false, duration: 0.506, credit: 34 },
  tele_in: { loop: false, duration: 0.607, credit: 35 },
  tele_high: { loop: false, duration: 0.857, credit: 36 },
  magic_cast: { loop: false, duration: 1.006, credit: 37 },
  cloth_flutter: { loop: false, duration: 0.457, credit: 38 },
  cloth_flap: { loop: false, duration: 0.457, credit: 39 },
  swish: { loop: false, duration: 0.447, credit: 40 },
  hit_a: { loop: false, duration: 0.656, credit: 41 },
  hit_b: { loop: false, duration: 0.485, credit: 42 },
  thud_a: { loop: false, duration: 0.556, credit: 43 },
  thud_b: { loop: false, duration: 0.424, credit: 44 },
} satisfies Record<string, AudioAsset>

export type AssetId = keyof typeof AUDIO_ASSETS
