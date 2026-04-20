import { describe, it, expect } from 'vitest'
import { resolveFamilyShortcut, getLoadedModels } from '../../src/api/models.js'
import type { ModelInfo } from '../../src/api/models.js'

const mkAnthropic = (alias: string, id?: string): ModelInfo => ({
  id: id || alias, alias, label: alias, provider: 'anthropic', implemented: true,
})
const mkGoogle = (alias: string, id?: string): ModelInfo => ({
  id: id || alias, alias, label: alias, provider: 'google', implemented: true,
})

describe('resolveFamilyShortcut', () => {
  const models: ModelInfo[] = [
    mkAnthropic('opus-4.5', 'claude-opus-4-5'),
    mkAnthropic('opus-4.7', 'claude-opus-4-7'),
    mkAnthropic('sonnet-4.6', 'claude-sonnet-4-6'),
    mkAnthropic('haiku-4.5', 'claude-haiku-4-5'),
    mkGoogle('pro-2.5', 'gemini-2.5-pro'),
    mkGoogle('flash-2.5', 'gemini-2.5-flash'),
  ]

  it('returns latest opus', () => {
    expect(resolveFamilyShortcut('opus', models)).toBe('claude-opus-4-7')
  })

  it('returns latest sonnet', () => {
    expect(resolveFamilyShortcut('sonnet', models)).toBe('claude-sonnet-4-6')
  })

  it('returns latest haiku', () => {
    expect(resolveFamilyShortcut('haiku', models)).toBe('claude-haiku-4-5')
  })

  it('returns latest pro (google)', () => {
    expect(resolveFamilyShortcut('pro', models)).toBe('gemini-2.5-pro')
  })

  it('returns latest flash', () => {
    expect(resolveFamilyShortcut('flash', models)).toBe('gemini-2.5-flash')
  })

  it('case insensitive', () => {
    expect(resolveFamilyShortcut('OPUS', models)).toBe('claude-opus-4-7')
  })

  it('returns null for unknown family', () => {
    expect(resolveFamilyShortcut('weird', models)).toBeNull()
  })

  it('returns null when no models in family', () => {
    expect(resolveFamilyShortcut('opus', [])).toBeNull()
  })
})

describe('getLoadedModels', () => {
  it('returns array (possibly empty)', () => {
    expect(Array.isArray(getLoadedModels())).toBe(true)
  })
})
