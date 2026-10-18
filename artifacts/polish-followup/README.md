# Playtest follow-up

Implemented and staged; publication awaits the fresh approval requested after automatic review rejected the follow-up commit. The previous live release remains `6cd960a`.

- Integrated approved R01 physical-impact and R05 shield-reflection recordings, credits and reproduction settings. Includes the separately documented existing Fireball whoosh tail reductions. Rejected candidates and the undecided thunder candidate remain unused. Audition tools/pages and future soundtrack proposals are outside the staged release.
- Homing travel replaces the 1180 Hz whistle and 2400 Hz hiss with warm low-mid propulsion and soft pulsing air. Per-voice budget decreases from 10 nodes / 4 sources to 9 / 3. Existing lifetime, fade, spatial and volume paths remain intact. No subjective listening approval is claimed.
- Nemesis marker now outlines the entire name/health/knockback badge in red, with a static soft glow and dark tint. Identity across rounds and renames remains intact; replacements do not inherit it.
- Main menu has Play, Quick play and Browse games. Play shares Solo / Online setup; backend selection stays explicit. Browse has Host a game, opening that setup with public listing visibly selected. No room is opened before onboarding completion.
- New-version notice persists with a Reload game button. Reload preserves guests and dedicated-server owners. Completed/cancelled invites are cleared so they cannot hijack a later reload; local peer hosts are not mistakenly rejoined.

Validation: 964 tests across 86 files passed; TypeScript, production build and whitespace checks passed. Actual browser checks covered desktop and 390-pixel menu/setup/browser layouts, explicit backend and listing selection, pre-session guide, Escape behavior, persistent reload across transient toasts, preserved room codes, and nemesis rename/replacement tracking. Existing large-chunk/Three warnings remain.

Protocol remains 6 and netcode remains `73190d1c8b01`; this release needs only a client deployment and no dedicated-server restart.

Screens: [menu](menu-desktop.png), [mobile menu](menu-mobile.png), [Play setup](play-desktop.png), [mobile Play setup](play-mobile.png), [browser](browser-mobile.png), [reload](reload-mobile.png), [nemesis](nemesis.png).
