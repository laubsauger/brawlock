"""Icon job list: id -> (color language, subject). Used by run_icons.py."""
KIT = "fiery red-orange rim light and magic glow"
C1 = "fiery red-orange rim light and magic glow (shop column 1, Knockout spells)"
C2 = "arcane cyan-blue rim light and magic glow (shop column 2, Transport spells)"
C3 = "molten orange-gold rim light and magic glow (shop column 3, Damage spells)"
C4 = "violet-magenta rim light and magic glow (shop column 4, Devastator spells)"
C5 = "radiant gold-white rim light and holy glow (shop column 5, Defense spells)"
C6 = "eldritch green rim light and magic glow (shop column 6, Knockbackless spells)"
ACT = "forged bronze and dark steel with a fiery red-orange magic accent (active item)"
ITEM = "forged bronze and steel materials with subtle ember-orange accents (passive item)"
MAST = "an engraved rune sigil cut into a round dark stone-and-iron medallion seen at a slight angle; the engraved sigil glows"

ICONS = {
    # starting kit + active items
    "fireball": (KIT, "Fireball spell. A blazing sphere of fire with a molten white-hot core streaking diagonally forward, a short flame tail trailing behind it, a few embers. Fiery red-orange magic color."),
    "scourge": (KIT + ", leaning blood-red", "Scourge spell: a dark nova. A small hooded, cloaked warlock figure at the center seen from slightly above, arms flung wide, and a blood-red and fiery shockwave ring bursting outward from him in all directions, crackling crimson energy, thin red sacrificial energy also burning on his own robe (the spell costs his own life)."),
    "redirector": (ACT, "Redirector: a glowing fiery projectile trail that bends sharply around a small forged bronze pivot pin (a rune-engraved bolt head), turning about 90 degrees and ending in a bright arrowhead pointing the new direction. The bend around the pivot is the focus."),
    "pact": (ACT + ", blood-red", "Pact: a blood-sealed contract. A rolled parchment scroll, partly unrolled, with a large dripping blood-red wax seal stamped with a horned demonic sigil, and a curved ritual dagger lying across it. The parchment is blank except for a bloody thumbprint; no writing."),
    # column 1 knockout
    "boomerang": (C1, "Boomerang spell: a curved crescent-shaped glowing blade (a curved shuriken) spinning, with its glowing motion trail forming a U-shaped return arc that loops back toward where it came from."),
    "lightning": (C1, "Lightning spell: a single straight, jagged, blinding bolt of red-orange and white lightning shooting horizontally across the icon from lower-left to upper-right, ending in a bright crackling impact burst."),
    "homing": (C1, "Homing spell: a fiery red-orange seeking missile orb following a sinuous S-curved flame trail, curving toward a glowing red target-reticle rune at the upper right. The curving pursuit path is the focus."),
    "twin": (C1, "Twin spell: two identical fiery bolts flying on mirrored curved arcs, one bowing upward and one bowing downward, both converging on a single bright impact point. Symmetrical composition."),
    # column 2 transport
    "teleport": (C2, "Teleport spell: a glowing cyan-blue rune portal circle on the floor, seen at 3/4 view, with a hooded warlock silhouette fading and dissolving upward into arcane cyan particles as it blinks away. The fading silhouette and portal are the focus."),
    "thrust": (C2, "Thrust spell: a hooded warlock dashing forward at great speed, body leaning hard into the charge, wrapped in a cyan-blue speed streak, with a cone-shaped shockwave of arcane force at the front where he will hit."),
    "swap": (C2, "Swap spell: two glowing orbs, one bright cyan and one deep blue, exchanging places, each following a curved arrow-shaped trail around the other so together the trails form a circle of exchange."),
    # column 3 damage
    "cluster": (C3, "Cluster spell: four small molten orange-gold fireballs fanning out from one point in a narrow spread fan, like a shotgun blast, each with a short trail."),
    "drain": (C3, "Drain spell: a molten orange-gold life-draining orb, from which a stream of crimson life essence flows back along a curved path into an open clawed warlock hand at the lower left."),
    "bouncer": (C3, "Bouncer spell: a molten orange-gold energy orb ricocheting along a sharp zigzag path, with small bright impact flashes at each bounce point. The zigzag bounce path is the focus."),
    "recharge": (C3, "Recharge spell: a molten orange-gold energy bolt orb encircled by a glowing circular arrow loop (a refresh symbol made of energy) cycling around it."),
    # column 4 devastator
    "windwalk": (C4, "Windwalk spell: a translucent, half-invisible ghostly hooded warlock figure in mid-stride, body dissolving into swirling violet-magenta wind wisps and speed lines."),
    "meteor": (C4, "Meteor spell: a huge jagged flaming boulder plunging steeply downward from above, wreathed in violet-magenta arcane fire, with a glowing violet impact ring flaring below it where it is about to land."),
    "splitter": (C4, "Splitter spell: one large violet-magenta energy bolt at the left that splits into several smaller child bolts fanning out in pairs to the right."),
    "snowball": (C4, "Snowball spell: a big, heavy rolling ball of packed snow and ice crystals, crackling with violet-magenta energy, leaving a frosty trail and dragging icy debris behind it."),
    # column 5 defense
    "shield": (C5, "Shield spell: a radiant gold-white reflective translucent dome bubble with a hexagonal energy shimmer, and a fireball visibly bouncing off its surface with a bright deflection spark."),
    "rush": (C5, "Rush spell: a cloaked warlock sprinting forward wrapped in a radiant gold-white protective aura; incoming red damage sparks hit the aura and are absorbed into it, turning into golden speed streaks behind him."),
    "alteration": (C5, "Alteration spell: a radiant gold-white bubble containing a hooded warlock silhouette made of golden light, and an incoming fireball just outside; two curved golden exchange arrows link them, showing they swap positions."),
    # column 6 knockbackless
    "gravity": (C6, "Gravity spell: a dark black orb at the center bending eldritch green light around it like a lens, pulling chunks of rock debris and small glowing projectiles spiraling inward in an accretion swirl."),
    "grip": (C6, "Grip spell: a huge spectral eldritch-green clawed hand bursting up from cracked ground, fingers closing in a crushing grip, with glowing green roots wrapping around it, rooting its prey in place."),
    "warpzone": (C6, "Warpzone spell: a swirling circular zone of distorted eldritch-green time-warp ripples, seen at 3/4 view, with a fireball frozen in slow motion inside it, leaving stretched ghost echoes behind it."),
    "magnetize": (C6, "Magnetize spell: a horseshoe magnet forged of dark iron glowing with eldritch green runes, with curved green magnetic field lines bending small glowing projectiles toward its poles."),
    "rockpillar": (C6, "Rockpillar spell: ONE single thick, tall, roughly hexagonal basalt stone column (a pillar, clearly one solid column, not crystals) bursting upward out of a small patch of cracked ground, chunks of rock and dust flying off its base, glowing green rune carvings and cracks running up the column."),
    "link": (C6, "Link spell: a glowing eldritch-green chain tether stretched taut diagonally between two iron shackle hooks, energy crackling along the links, pulling them together."),
    # items
    "ring_of_health": (ITEM, "Ring of Health: a forged bronze ring set with a large glowing red heart-shaped gemstone, warm healing glow."),
    "cursed_ring": (ITEM + ", dark", "Cursed Ring: a blackened iron ring with jagged edges and a dark smoky gem, wreathed in curling black-purple smoke, faint ember glow in the cracks."),
    "cape": (ITEM, "Cape: a flowing dark crimson cloak billowing in the wind, fastened with an ornate bronze clasp at the collar."),
    "armor": (ITEM, "Armor: a heavy runed steel and bronze pauldron (shoulder plate armor) with layered plates and engraved runes glowing faint ember orange."),
    "boots": (ITEM, "Boots: a pair of winged leather boots with bronze buckles and small feathered wings at the ankles, suggesting speed."),
    "pocket_watch": (ITEM, "Pocket Watch: an ornate bronze pocket watch with its lid open, the dial has only tick marks and no numerals, with ghostly slowed time trails echoing the watch hands and a faint swirl of slowed time around it."),
    # masteries
    "mastery_duration": (MAST + " soft gold", "Duration mastery: an hourglass sigil engraved on the medallion, glowing soft gold, with faint runic tick marks around the rim."),
    "mastery_range": (MAST + " cyan", "Range mastery: a long arrow sigil passing through concentric target rings, engraved on the medallion and glowing cyan, the arrow reaching far."),
    "mastery_lifesteal": (MAST + " crimson", "Lifesteal mastery: a fanged blood-drop sigil engraved on the medallion and glowing crimson red, a thin trickle of blood light."),
    "mastery_all": (MAST + " with three colors", "All masteries: three small sigils engraved together on one medallion in a triangle arrangement: an hourglass glowing gold, an arrow glowing cyan, and a blood drop glowing crimson, joined by an engraved ring."),
}

# ---------------------------------------------------------------------------------------------
# Pass 2 (2026-10-16): icons recolored to each spell's identity colors from
# src/render/vfx/palette.ts (accent = dominant rim/trail color, core = hot center), so an icon
# and its in-game effect read as the same spell. Same mechanic metaphors as pass 1.
NOFIRE = " The dominant color must be the identity color above; no orange fire unless stated."
ICONS.update({
    "lightning": ("electric white-blue: blinding white core (#f2f8ff) with electric sky-blue glow (#67b5f8)." + NOFIRE,
                  "Lightning spell: a single straight, jagged, blinding bolt of electric white-blue lightning with a thick bright main channel, shooting across the icon from lower-left to upper-right, small side branches, ending in a bright crackling blue-white impact burst."),
    "homing": ("hot magenta-red (#e03467) with a hot pink core (#ff86c0)." + NOFIRE,
               "Homing spell: a magenta-pink arcane missile orb following a sinuous S-curved magenta-red energy trail, curving toward a glowing magenta target-reticle rune at the upper right. The curving pursuit path is the focus."),
    "twin": ("pale gold-orange (#ffb85e) with a very light pale-gold core (#fff0b0); light and luminous, much paler than lava." + NOFIRE,
             "Twin spell: two identical luminous pale-gold energy bolts flying on mirrored curved arcs, one bowing upward and one bowing downward, both converging on a single bright pale-gold impact point. Symmetrical composition."),
    "boomerang": ("dark forged steel with a red-copper glowing edge (#be6f49) and light peach-copper highlights (#ffc8a8); metallic, not fire." + NOFIRE,
                  "Boomerang spell: a curved crescent-shaped throwing blade of dark forged steel (a curved shuriken) spinning, its sharpened edge glowing red-copper, with a thin red-copper motion trail forming a U-shaped return arc that loops back toward where it came from. No flames."),
    "redirector": ("polished bronze (#9b6942) with warm cream highlights (#ffe0b8); metallic glow, not fire." + NOFIRE,
                   "Redirector: a glowing bronze energy streak that bends sharply around a small forged bronze pivot pin (a rune-engraved bolt head), turning about 90 degrees and ending in a bright bronze arrowhead pointing the new direction. The bend around the pivot is the focus."),
    "cluster": ("amber (#c18a21), darker and browner than gold, with a pale amber-cream core (#ffe6a0); resin-like amber glow." + NOFIRE,
                "Cluster spell: exactly four small amber-glowing bolts fanning out from one launch point at the lower left in a spread fan, like a shotgun blast, each with a short amber trail. Count: four bolts."),
    "drain": ("sickly dark olive green (#3c5305) with a pale lime core (#d0f0a0); dark and toxic." + NOFIRE,
              "Drain spell: a dark clawed warlock hand at the lower left pulling a stream of sickly green life essence along twisting leech-like tendrils from a pale green glowing orb at the upper right."),
    "bouncer": ("pure bright yellow (#e4e04a) with a very light yellow-white core (#fffcb0); crackling electric spark." + NOFIRE,
                "Bouncer spell: a bright yellow crackling spark orb ricocheting along a sharp zigzag path, with small yellow impact flashes at each bounce point. The zigzag bounce path is the focus."),
    "recharge": ("purple (#9945e4) with a light lilac core (#e9c8ff)." + NOFIRE,
                 "Recharge spell: a purple energy bolt orb encircled by a glowing purple circular arrow loop (a refresh symbol made of energy) cycling around it."),
    "alteration": ("silver glass: clear glass and polished silver, warm grey (#aeafa6) with white highlights (#ffffff); low saturation, no gold." + NOFIRE,
                   "Alteration spell: a clear silver-glass bubble containing a hooded warlock silhouette made of silver light, and a small incoming projectile just outside it; two curved polished-silver exchange arrows link them, showing they swap positions."),
    "gravity": ("black-violet: a near-black core (#15092d) with violet light (#b48cff) bent around it; the darkest icon of the set." + NOFIRE,
                "Gravity spell: a pitch-black orb at the center bending violet light around it like a gravitational lens, a violet accretion swirl pulling dark rock debris and small glowing projectiles spiraling inward."),
    "warpzone": ("teal (#37a297) with a pale aqua core (#b8fff2)." + NOFIRE,
                 "Warpzone spell: a swirling circular zone of distorted teal time-warp ripples, seen at 3/4 view, with a pale aqua projectile orb frozen in slow motion inside it, leaving stretched teal ghost echoes behind it."),
    "magnetize": ("steel blue (#39679c) with a pale ice-blue core (#d0e4ff)." + NOFIRE,
                  "Magnetize spell: a horseshoe magnet forged of dark blued steel with glowing steel-blue runes, with curved blue magnetic field lines bending small glowing projectiles toward its poles."),
    "rockpillar": ("earth brown basalt (#755640) with warm sand highlights (#d9c2a0); natural stone, no green glow." + NOFIRE,
                   "Rockpillar spell: ONE single thick, tall, roughly hexagonal brown basalt stone column (a pillar, clearly one solid column, not crystals) bursting upward out of cracked earth, chunks of rock and dust flying off its base, faint warm sand-colored rune carvings on the column."),
    "thrust": ("palest cyan-white (#b4f0f2) with a white core (#f4ffff); a pale shockwave, clearly lighter and whiter than an arcane cyan." + NOFIRE,
               "Thrust spell: a hooded warlock dashing forward at great speed, body leaning hard into the charge, wrapped in a pale cyan-white speed streak, with a cone-shaped white shockwave of force at the front where he will hit."),
    "swap": ("violet (#906afe) with a light lavender core (#e6d8ff) and thin cyan edge highlights." + NOFIRE,
             "Swap spell: two glowing orbs, one bright violet and one deep violet, exchanging places, each following a curved arrow-shaped trail around the other so together the trails form a circle of exchange."),
    "windwalk": ("pale grey-white, nearly colorless (#c8cbce, #ffffff): cool ghostly wind, no purple, no strong hue." + NOFIRE,
                 "Windwalk spell: a translucent, half-invisible ghostly hooded warlock figure in mid-stride, body dissolving into swirling pale grey-white wind wisps and speed lines."),
    "meteor": ("deep dark violet fire (#491b8b) with a pale pink-violet hot core (#ffd6f0); darker and more violet than magenta.",
               "Meteor spell: a huge jagged boulder plunging steeply downward from above, wreathed in deep violet arcane fire, with a glowing violet impact ring flaring below it where it is about to land."),
    "snowball": ("ice blue (#7ad0f9) with a near-white frost core (#f0fbff); no purple." + NOFIRE,
                 "Snowball spell: a big, heavy rolling ball of packed snow and ice crystals glowing ice blue, leaving a frosty trail and dragging icy debris behind it."),
    "link": ("chain green: cool emerald (#27b35f) with a pale mint core (#cfffcf); cooler and bluer than lime." + NOFIRE,
             "Link spell: a glowing emerald-green chain tether stretched taut diagonally between two iron shackle hooks, energy crackling along the links, pulling them together."),
    "pact": ("dark wine-red and blood (#8d133c) with pale rose highlights (#ffd0d0); dark, blood-soaked." + NOFIRE,
             "Pact: a blood-sealed contract. A dark, aged parchment scroll soaked and stained with dark wine-red blood, partly unrolled, with a large dripping dark wine-red wax seal stamped with a horned sigil, and a curved ritual dagger lying across it, faint wine-red glow. The parchment has no writing."),
    "rush": ("saturated flame orange-gold (#fc9206) with a bright yellow core (#fff0a8); clearly more orange and saturated than a pale holy gold.",
             "Rush spell: a cloaked warlock sprinting forward wrapped in a blazing orange-gold flame aura; incoming red damage sparks hit the aura and are absorbed into it, streaming out behind him as orange-gold speed streaks."),
})
