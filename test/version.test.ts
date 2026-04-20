import { describe, it, expect } from 'vitest'
import { getVersion } from '../src/version.js'

describe('getVersion', () => {
  it('returns a non-empty version string', () => {
    const v = getVersion()
    expect(typeof v).toBe('string')
    expect(v.length).toBeGreaterThan(0)
  })

  it('returns semver-shaped version', () => {
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('errors module', () => {
  it('AuthError carries provider and prefixes message', async () => {
    const { AuthError } = await import('../src/errors.js')
    const err = new AuthError('anthropic', 'expired')
    expect(err.provider).toBe('anthropic')
    expect(err.message).toContain('anthropic')
    expect(err.message).toContain('expired')
    expect(err.name).toBe('AuthError')
  })

  it('APIError carries statusCode + retry info', async () => {
    const { APIError } = await import('../src/errors.js')
    const err = new APIError('openai', 429, 'rate limited', true, 5000)
    expect(err.provider).toBe('openai')
    expect(err.statusCode).toBe(429)
    expect(err.retryable).toBe(true)
    expect(err.retryAfterMs).toBe(5000)
    expect(err.name).toBe('APIError')
  })

  it('ToolError carries toolName', async () => {
    const { ToolError } = await import('../src/errors.js')
    const err = new ToolError('Bash', 'failed')
    expect(err.toolName).toBe('Bash')
    expect(err.name).toBe('ToolError')
  })

  it('BudgetExceededError carries budget + spent', async () => {
    const { BudgetExceededError } = await import('../src/errors.js')
    const err = new BudgetExceededError(10, 12.50)
    expect(err.budgetUsd).toBe(10)
    expect(err.spentUsd).toBe(12.50)
    expect(err.message).toContain('12.50')
    expect(err.message).toContain('10.00')
  })
})
