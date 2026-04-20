import { describe, it, expect } from 'vitest'
import { classifyPromptForRouter } from '../../src/repl/repl.js'

const fullAuth = { anthropic: true, openai: true, google: true }

describe('classifyPromptForRouter', () => {
  it('returns null when no anthropic auth', () => {
    expect(classifyPromptForRouter('hi', { ...fullAuth, anthropic: false })).toBeNull()
  })

  it('routes complex keywords to opus', () => {
    expect(classifyPromptForRouter('design pattern for this architecture', fullAuth)).toBe('opus')
    expect(classifyPromptForRouter('refactor this module', fullAuth)).toBe('opus')
    expect(classifyPromptForRouter('do a security audit', fullAuth)).toBe('opus')
    expect(classifyPromptForRouter('this algorithm is broken', fullAuth)).toBe('opus')
  })

  it('routes Spanish complex keywords to opus', () => {
    expect(classifyPromptForRouter('necesito un algoritmo eficiente', fullAuth)).toBe('opus')
  })

  it('routes think hard / ultrathink to opus', () => {
    expect(classifyPromptForRouter('please think hard about this', fullAuth)).toBe('opus')
    expect(classifyPromptForRouter('think harder about it', fullAuth)).toBe('opus')
    expect(classifyPromptForRouter('ultrathink', fullAuth)).toBe('opus')
  })

  it('routes short factual questions to haiku', () => {
    expect(classifyPromptForRouter('what is rust?', fullAuth)).toBe('haiku')
    expect(classifyPromptForRouter('how do you say hello in french?', fullAuth)).toBe('haiku')
    expect(classifyPromptForRouter('translate ola', fullAuth)).toBe('haiku')
  })

  it('routes very short prompts to haiku', () => {
    expect(classifyPromptForRouter('hi', fullAuth)).toBe('haiku')
  })

  it('routes medium prompts to sonnet', () => {
    const mid = 'I would like to know how to set up authentication for my new full-stack app'
    expect(classifyPromptForRouter(mid, fullAuth)).toBe('sonnet')
  })
})
