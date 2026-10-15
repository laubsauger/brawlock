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
