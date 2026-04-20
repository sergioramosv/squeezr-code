import { describe, it, expect, vi, afterEach } from 'vitest'
import { detectImageProtocol, renderInlineImage, printImagePaste } from '../../src/repl/inline-image.js'

describe('detectImageProtocol', () => {
  const origTermProgram = process.env.TERM_PROGRAM
  const origTerm = process.env.TERM
  afterEach(() => {
    if (origTermProgram === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = origTermProgram
    if (origTerm === undefined) delete process.env.TERM
    else process.env.TERM = origTerm
  })

  it('returns iterm2 for iTerm', () => {
    process.env.TERM_PROGRAM = 'iTerm.app'
    expect(detectImageProtocol()).toBe('iterm2')
  })

  it('returns iterm2 for WezTerm', () => {
    process.env.TERM_PROGRAM = 'WezTerm'
    expect(detectImageProtocol()).toBe('iterm2')
  })

  it('returns kitty when TERM contains kitty', () => {
    delete process.env.TERM_PROGRAM
    process.env.TERM = 'xterm-kitty'
    expect(detectImageProtocol()).toBe('kitty')
  })

  it('returns none for unknown terminal', () => {
    delete process.env.TERM_PROGRAM
    process.env.TERM = 'xterm-256color'
    expect(detectImageProtocol()).toBe('none')
  })
})

describe('renderInlineImage', () => {
  it('returns false when proto is none', () => {
    const orig = process.env.TERM_PROGRAM
    delete process.env.TERM_PROGRAM
    const origTerm = process.env.TERM
    process.env.TERM = 'dumb'
    expect(renderInlineImage('xxx', 'label')).toBe(false)
    if (orig !== undefined) process.env.TERM_PROGRAM = orig
    if (origTerm !== undefined) process.env.TERM = origTerm
  })
})

describe('printImagePaste', () => {
  it('writes a fallback message when terminal does not support inline', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const orig = process.env.TERM_PROGRAM
    delete process.env.TERM_PROGRAM
    printImagePaste('[Image #1]', 'aGVsbG8=', 'image/png', 5)
    expect(writeSpy).toHaveBeenCalled()
    writeSpy.mockRestore()
    if (orig !== undefined) process.env.TERM_PROGRAM = orig
  })
})
