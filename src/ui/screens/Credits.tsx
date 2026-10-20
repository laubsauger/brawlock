import { FeedbackButton } from '../FeedbackButton'
import { useEffect, type ReactNode } from 'react'
import { useGame } from '../../game/store'
import { Button, Kbd } from '../widgets'
import { AUDIO_CREDITS } from '../../audio'

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8 break-inside-avoid">
      <h2 className="section-title mb-3 text-[1.9rem]">{title}</h2>
      <div className="space-y-2 text-[1.05rem] leading-relaxed text-[#ecdcc5]">{children}</div>
    </section>
  )
}

/** Freesound titles are often raw file names ("Ambiance_Campfire_Loop_Stereo.wav"); show them as words. */
function cleanTitle(t: string): string {
  return t.replace(/\.(mp3|wav|flac|ogg|aiff?)$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Third-party art that ships, from docs/ASSETS.md (everything else is original, made for Brawlock). */
const QUATERNIUS_PACKS = [
  { title: 'Modular Character Outfits - Fantasy', what: 'rig, hood, boots, gauntlets, sleeves, tunic', url: 'https://quaternius.itch.io/modular-character-outfits-fantasy' },
  { title: 'Universal Animation Library', what: 'animation clips', url: 'https://quaternius.itch.io/universal-animation-library' },
  { title: 'Universal Animation Library 2', what: 'animation clips', url: 'https://quaternius.itch.io/universal-animation-library-2' },
  { title: 'Universal Base Characters', what: 'skeleton reference', url: 'https://quaternius.itch.io/universal-base-characters' },
]

function Credit({ who, what }: { who: string; what: ReactNode }) {
  return (
    <p>
      <span className="font-bold text-bone">{who}</span>
      <span className="text-ash">: </span>
      {what}
    </p>
  )
}

export function Credits() {
  const setScreen = useGame((s) => s.setScreen)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setScreen('menu')
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setScreen])

  return (
    <div className="screen-in mx-auto flex h-full w-full max-w-[1280px] flex-col px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <h1 className="display text-6xl leading-none text-[#ffd890]">Credits</h1>
        <div className="flex flex-wrap items-center gap-2">
          <FeedbackButton />
          <Button sound="back" onClick={() => setScreen('menu')}>
            Back <Kbd>Esc</Kbd>
          </Button>
        </div>
      </header>
      <div className="panel min-h-0 flex-1 overflow-y-auto p-8">
        <div className="grid grid-cols-1 gap-x-12 lg:grid-cols-2 xl:grid-cols-3">
          <div>
            <Block title="The original game">
              <p>
                Brawlock is a fan remake of Warlock, a Warcraft III custom map, and its Dota 2 successor Warlock Brawl. The game design, rules and numbers are
                theirs; no code, art or sound is taken from the original.
              </p>
              <Credit who="Toraxxx, Adynathos, Zymoran" what="creators of Warlock" />
              <Credit who="The Warlock Brawl team" what="the Dota 2 custom game this remake follows" />
            </Block>

            <Block title="Brawlock">
              <Credit who="laubsauger" what="design, code and direction" />
            </Block>

            <Block title="Typefaces">
              <Credit who="Metal Mania" what="by Open Window, SIL Open Font License 1.1" />
              <Credit who="Cinzel" what="by Natanael Gama, SIL Open Font License 1.1" />
              <Credit who="Barlow Semi Condensed" what="by Jeremy Tribby, SIL Open Font License 1.1" />
            </Block>

            <Block title="Built with">
              <Credit who="three.js" what="MIT License" />
              <Credit who="React and React Three Fiber" what="MIT License" />
              <Credit who="PeerJS" what="MIT License" />
              <Credit who="zustand" what="MIT License" />
              <Credit who="Vite and Tailwind CSS" what="MIT License" />
            </Block>
          </div>

          <div>
            <Block title="Audio">
              <p className="text-ash">Recorded layers under the synthesized sound, all CC0 (public domain dedication) from Freesound.</p>
              <ul className="well max-h-[min(620px,58vh)] divide-y divide-[rgba(255,170,100,0.08)] overflow-y-auto px-3 py-1" aria-label="Audio credits">
                {AUDIO_CREDITS.map((c) => (
                  <li key={c.url} className="flex items-baseline justify-between gap-3 py-1.5 text-[0.98rem]">
                    <span className="min-w-0">
                      <a href={c.url} target="_blank" rel="noopener noreferrer" className="font-semibold break-words text-bone underline decoration-[rgba(255,170,100,0.35)] underline-offset-2 hover:text-gold">
                        {cleanTitle(c.title)}
                      </a>
                      <span className="text-ash"> by {c.creator}</span>
                    </span>
                    <span className="chip shrink-0">{c.license}</span>
                  </li>
                ))}
              </ul>
            </Block>
          </div>

          <div>
            <Block title="Art">
              <p className="text-ash">The warlock is built on CC0 (public domain) packs by Quaternius; its robe, cape, runes and materials are made for Brawlock.</p>
              <ul className="well divide-y divide-[rgba(255,170,100,0.08)] px-3 py-1" aria-label="Art credits">
                {QUATERNIUS_PACKS.map((p) => (
                  <li key={p.url} className="flex items-baseline justify-between gap-3 py-1.5 text-[0.98rem]">
                    <span className="min-w-0">
                      <a href={p.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-bone underline decoration-[rgba(255,170,100,0.35)] underline-offset-2 hover:text-gold">
                        {p.title}
                      </a>
                      <span className="text-ash"> by Quaternius, {p.what}</span>
                    </span>
                    <span className="chip shrink-0">CC0</span>
                  </li>
                ))}
              </ul>
              <Credit who="Spell and item icons, arena textures, splash art and logo" what="original work for Brawlock, generated from our own prompts" />
            </Block>

            <Block title="Legal">
              <p className="text-ash">
                A non-commercial fan project. Not affiliated with or endorsed by Blizzard Entertainment or Valve. Warcraft is a trademark of Blizzard
                Entertainment; Dota 2 is a trademark of Valve Corporation.
              </p>
              <p>Operated by Promp' Industries. <a className="text-bone underline underline-offset-2" href="mailto:stayprompin@gmail.com">stayprompin@gmail.com</a></p>
              <p className="flex flex-wrap gap-x-4 gap-y-2">
                <a className="text-bone underline underline-offset-2" href={`${import.meta.env.BASE_URL}privacy.html`} target="_blank" rel="noopener noreferrer">Privacy Policy<span className="sr-only"> (opens in a new tab)</span></a>
                <a className="text-bone underline underline-offset-2" href={`${import.meta.env.BASE_URL}terms.html`} target="_blank" rel="noopener noreferrer">Terms of Service<span className="sr-only"> (opens in a new tab)</span></a>
              </p>
            </Block>
          </div>
        </div>
      </div>
    </div>
  )
}
