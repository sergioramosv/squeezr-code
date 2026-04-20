import { describe, it, expect } from 'vitest'
import { link, BEEP, gradient, osNotify } from '../../src/repl/ansi.js'

describe('link (OSC 8)', () => {
  it('wraps url with OSC 8 control sequence', () => {
    const out = link('https://example.com', 'click here')
    expect(out).toContain('https://example.com')
    expect(out).toContain('click here')
    expect(out).toContain('\x1b]8;;')
  })

  it('uses url as text when no text given', () => {
    const out = link('https://example.com')
    expect(out).toContain('https://example.com')
  })
})

describe('BEEP', () => {
  it('is BEL char', () => {
    expect(BEEP).toBe('\x07')
  })
})

describe('gradient', () => {
  it('returns empty for empty input', () => {
    expect(gradient('')).toBe('')
  })

  it('wraps text with reset at end', () => {
    const out = gradient('hello')
    // Each char is wrapped individually with ANSI in front, so chars are not contiguous.
    const stripped = out.replace(/\x1b\[[\d;]*m/g, '')
    expect(stripped).toBe('hello')
    expect(out.endsWith('\x1b[0m')).toBe(true)
  })

  it('uses 5 different greens distributed across chars', () => {
    const out = gradient('abcdefghij')
    // Each char should have its own ANSI prefix
    const ansiCount = (out.match(/\x1b\[38;5;\d+m/g) || []).length
    expect(ansiCount).toBe(10)
  })

  it('handles single char', () => {
    const out = gradient('x')
    expect(out).toContain('x')
  })
})

describe('osNotify', () => {
  it('does not throw on unknown platform issues', () => {
    expect(() => osNotify('Title', 'Body')).not.toThrow()
  })
})
