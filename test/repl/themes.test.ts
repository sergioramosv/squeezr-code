import { describe, it, expect } from 'vitest'
import { theme, setTheme, RESET } from '../../src/repl/themes.js'

describe('themes', () => {
  it('default theme is dark', () => {
    setTheme('dark')
    const t = theme()
    expect(t.primary).toBe('\x1b[36m')
  })

  it('switches to light', () => {
    setTheme('light')
    const t = theme()
    expect(t.primary).toBe('\x1b[34m')
  })

  it('switches to solarized', () => {
    setTheme('solarized')
    expect(theme().primary).toContain('38;5;33')
  })

  it('switches to nord', () => {
    setTheme('nord')
    expect(theme().primary).toContain('38;5;110')
  })

  it('unknown theme falls back to dark', () => {
    setTheme('xxx')
    expect(theme().primary).toBe('\x1b[36m')
  })

  it('exports RESET', () => {
    expect(RESET).toBe('\x1b[0m')
  })

  it('themes have all required fields', () => {
    for (const name of ['dark', 'light', 'solarized', 'nord']) {
      setTheme(name)
      const t = theme()
      expect(t.primary).toBeTruthy()
      expect(t.secondary).toBeTruthy()
      expect(t.success).toBeTruthy()
      expect(t.warning).toBeTruthy()
      expect(t.error).toBeTruthy()
      expect(t.user).toBeTruthy()
      expect(t.assistant).toBeTruthy()
      expect(t.bar).toBeTruthy()
    }
  })
})
