import { describe, expect, it } from 'vitest'
import { PLAYER_COLORS } from '../../net/session'
import { hex, listNames, teamColor, teamName, winnersText } from './view'

const slot = (id: number, name: string, team: number) => ({ id, name, team })

describe('winner banners read like a sentence', () => {
  it('lists three winners with commas and one "and", never "A and B and C"', () => {
    expect(listNames(['Mira', 'Thorn', 'Vex'])).toBe('Mira, Thorn and Vex')
    expect(listNames(['Mira', 'Thorn'])).toBe('Mira and Thorn')
    expect(listNames(['Mira'])).toBe('Mira')
  })

  it('names the team when a whole team wins in a team mode', () => {
    const slots = [slot(0, 'Ash', 3), slot(1, 'Cinder', 3), slot(2, 'Vex', 1)]
    expect(winnersText(slots, [0, 1], 'teams')).toEqual({ text: 'Purple team', plural: false })
  })

  it('lists names in free for all, even if the slots happen to share a team number', () => {
    const slots = [slot(0, 'Ash', 0), slot(1, 'Cinder', 0)]
    expect(winnersText(slots, [0, 1], 'ffa')).toEqual({ text: 'Ash and Cinder', plural: true })
  })

  it('says nothing for a draw', () => {
    expect(winnersText([slot(0, 'Ash', 0)], [], 'ffa')).toBeNull()
  })
})

describe('team colours', () => {
  it('match the team names the banners use, so "Purple team" is purple on the HUD', () => {
    expect(teamName(3)).toBe('Purple')
    expect(teamColor(3)).toBe(hex(PLAYER_COLORS[3]))
  })
})

describe('colourblind palette on the HUD', () => {
  it('switches team colours and names with the setting, and gives every player a shape so colour is not the only cue', async () => {
    const { useGame } = await import('../../game/store')
    const { PLAYER_COLORS_CB, PLAYER_COLOR_NAMES_CB } = await import('../../game/playerPalette')
    const { playerGlyph } = await import('./view')
    useGame.getState().setSettings({ colorblindPalette: true })
    try {
      expect(teamColor(3)).toBe(hex(PLAYER_COLORS_CB[3]))
      expect(teamName(3)).toBe(PLAYER_COLOR_NAMES_CB[3])
      const glyphs = PLAYER_COLORS.map((c, i) => playerGlyph({ color: c, team: i }, 'ffa', true))
      expect(new Set(glyphs).size).toBe(PLAYER_COLORS.length)
    } finally {
      useGame.getState().setSettings({ colorblindPalette: false })
    }
    expect(playerGlyph({ color: PLAYER_COLORS[0], team: 0 }, 'ffa', false)).toBe('')
  })
})
