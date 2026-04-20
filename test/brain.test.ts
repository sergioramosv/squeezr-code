import { describe, it, expect } from 'vitest'
import { getContextLimit, estimateTokens, calculateContextPercent } from '../src/brain/context.js'
import { Brain } from '../src/brain/brain.js'

describe('context utilities', () => {
  it('getContextLimit known models', () => {
    expect(getContextLimit('claude-opus-4-20250514')).toBe(200_000)
    expect(getContextLimit('gpt-4.1')).toBe(1_000_000)
    expect(getContextLimit('gemini-2.5-pro')).toBe(1_000_000)
  })

  it('getContextLimit unknown defaults to 200K', () => {
    expect(getContextLimit('weird-model')).toBe(200_000)
  })

  it('estimateTokens ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(100))).toBe(25)
  })

  it('calculateContextPercent', () => {
    expect(calculateContextPercent(100_000, 'claude-opus-4-20250514')).toBe(50)
    expect(calculateContextPercent(0, 'claude-opus-4-20250514')).toBe(0)
    expect(calculateContextPercent(200_000, 'claude-opus-4-20250514')).toBe(100)
  })
})

describe('Brain', () => {
  it('starts with zero counters', () => {
    const b = new Brain('claude-opus-4-20250514')
    expect(b.getState().turnCount).toBe(0)
    expect(b.getState().totalInputTokens).toBe(0)
    expect(b.getState().model).toBe('claude-opus-4-20250514')
  })

  it('addUsage accumulates input/output and turn count', () => {
    const b = new Brain('claude-opus-4-20250514')
    b.addUsage(100, 200)
    b.addUsage(50, 50)
    const s = b.getState()
    expect(s.totalInputTokens).toBe(150)
    expect(s.totalOutputTokens).toBe(250)
    expect(s.turnCount).toBe(2)
  })

  it('contextPercent reflects last turn (not running total)', () => {
    const b = new Brain('claude-opus-4-20250514')
    b.addUsage(100_000, 0)  // 50% of 200k window
    expect(b.getState().contextPercent).toBe(50)
    b.addUsage(20_000, 0)   // last turn = 20k → 10%
    expect(b.getState().contextPercent).toBe(10)
  })

  it('shouldWarn / shouldTransplant on threshold', () => {
    const b = new Brain('claude-opus-4-20250514')
    b.addUsage(100_000, 0)  // 50%
    expect(b.shouldWarn(40)).toBe(true)
    expect(b.shouldWarn(60)).toBe(false)
    expect(b.shouldTransplant(50)).toBe(true)
  })

  it('setModel changes model', () => {
    const b = new Brain('claude-opus-4-20250514')
    b.setModel('gpt-4.1')
    expect(b.getState().model).toBe('gpt-4.1')
  })

  it('setSubscription stores per provider', () => {
    const b = new Brain('claude-opus-4-20250514')
    b.setSubscription({ provider: 'anthropic', fiveHour: 0.5, fiveHourResetAt: 0, sevenDay: 0.1, sevenDaySonnet: 0.05, sevenDayResetAt: 0, status: 'allowed' })
    expect(b.getState().subscriptions.anthropic).toBeTruthy()
    expect(b.getState().subscriptions.openai).toBeNull()
  })
})
