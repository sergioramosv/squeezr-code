import { describe, it, expect } from 'vitest'
import { APIClient } from '../../src/api/client.js'

const fakeAuth: any = {
  headersFor: async () => ({ Authorization: 'Bearer x' }),
  isOAuth: () => false,
  getOpenAIAccountId: () => 'acct_x',
}

describe('APIClient', () => {
  describe('providerForModel', () => {
    const client = new APIClient(fakeAuth, null)

    it('routes claude-* to anthropic', () => {
      expect(client.providerForModel('claude-opus-4-7')).toBe('anthropic')
    })

    it('routes haiku/sonnet/opus aliases to anthropic', () => {
      expect(client.providerForModel('haiku')).toBe('anthropic')
      expect(client.providerForModel('sonnet')).toBe('anthropic')
      expect(client.providerForModel('opus')).toBe('anthropic')
    })

    it('routes gpt-* to openai', () => {
      expect(client.providerForModel('gpt-5.4')).toBe('openai')
    })

    it('routes o3, o4-mini to openai', () => {
      expect(client.providerForModel('o3')).toBe('openai')
      expect(client.providerForModel('o4-mini')).toBe('openai')
    })

    it('routes 5.4-mini-style aliases to openai', () => {
      expect(client.providerForModel('5.4-mini')).toBe('openai')
    })

    it('routes gemini-* to google', () => {
      expect(client.providerForModel('gemini-2.5-pro')).toBe('google')
    })

    it('defaults to anthropic for unknown model', () => {
      expect(client.providerForModel('weird-model')).toBe('anthropic')
    })
  })

  describe('getAdapter', () => {
    it('returns adapter for each provider', () => {
      const client = new APIClient(fakeAuth, null)
      const a = client.getAdapter('anthropic')
      expect(a).toBeTruthy()
      const o = client.getAdapter('openai')
      expect(o).toBeTruthy()
      const g = client.getAdapter('google')
      expect(g).toBeTruthy()
    })

    it('caches adapter (same instance on second call)', () => {
      const client = new APIClient(fakeAuth, null)
      expect(client.getAdapter('anthropic')).toBe(client.getAdapter('anthropic'))
    })
  })

  describe('closeAll', () => {
    it('does not throw when no adapters', () => {
      const client = new APIClient(fakeAuth, null)
      expect(() => client.closeAll()).not.toThrow()
    })

    it('closes all created adapters', () => {
      const client = new APIClient(fakeAuth, null)
      client.getAdapter('anthropic')
      client.getAdapter('openai')
      expect(() => client.closeAll()).not.toThrow()
    })
  })
})
