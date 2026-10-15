import { useEffect, type ReactNode } from 'react'
import { useGame } from '../../game/store'
import { Button, Kbd } from '../widgets'

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8 break-inside-avoid">
      <h2 className="section-title mb-3 text-[1.9rem]">{title}</h2>
      <div className="space-y-2 text-[1.05rem] leading-relaxed text-[#ecdcc5]">{children}</div>
    </section>
  )
}

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
    <div className="screen-in flex h-full flex-col px-[max(16px,7vw)] py-[max(16px,5vh)]">
      <header className="mb-6 flex items-end justify-between gap-4">
        <h1 className="display text-6xl leading-none text-[#ffd890]">Credits</h1>
        <Button sound="back" onClick={() => setScreen('menu')}>
          Back <Kbd>Esc</Kbd>
        </Button>
      </header>
      <div className="panel min-h-0 flex-1 overflow-y-auto p-8">
        <div className="max-w-5xl columns-1 gap-12 lg:columns-2">
          <Block title="The original game">
            <p>
              Brawlock is a fan remake of Warlock, a Warcraft III custom map, and its Dota 2 successor Warlock Brawl. The game design, rules and numbers are
              theirs; every line of code, art and sound here is new.
            </p>
            <Credit who="Toraxxx, Adynathos, Zymoran" what="creators of Warlock" />
            <Credit who="The Warlock Brawl team" what="the Dota 2 custom game this remake follows" />
          </Block>

          <Block title="Brawlock">
            <Credit who="laubsauger" what="design, code and direction" />
          </Block>

          <Block title="Typefaces">
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

          <Block title="Art and audio">
            <p className="text-ash">Models, textures, icons, sound and music will be credited here with their licenses as they arrive.</p>
          </Block>

          <Block title="Legal">
            <p className="text-ash">
              A non-commercial fan project. Not affiliated with or endorsed by Blizzard Entertainment or Valve. Warcraft is a trademark of Blizzard
              Entertainment; Dota 2 is a trademark of Valve Corporation.
            </p>
          </Block>
        </div>
      </div>
    </div>
  )
}
