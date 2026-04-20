import { describe, it, expect } from 'vitest'
import { handleAPIError, sleep } from '../../src/api/retry.js'
import { APIError } from '../../src/errors.js'

describe('handleAPIError', () => {
  describe('proxy/connection refused', () => {
    it('attempt 1 retries', () => {
      const err = new Error('refused') as NodeJS.ErrnoException
      err.code = 'ECONNREFUSED'
      const r = handleAPIError(err, 1)
      expect(r.action).toBe('retry')
      expect(r.delayMs).toBe(2000)
    })

    it('attempt 2 aborts', () => {
      const err = new Error('refused') as NodeJS.ErrnoException
      err.code = 'ECONNREFUSED'
      const r = handleAPIError(err, 2)
      expect(r.action).toBe('abort')
      expect(r.message).toContain('squeezr start')
    })
  })

  describe('rate limit (429)', () => {
    it('retries with retryAfterMs', () => {
      const err = new APIError('openai', 429, 'too many', false, 5000)
      const r = handleAPIError(err, 1)
      expect(r.action).toBe('retry')
      expect(r.delayMs).toBe(5000)
    })

    it('retries with default 60s if no retryAfter', () => {
      const r = handleAPIError(new APIError('openai', 429, 'rl'), 1)
      expect(r.delayMs).toBe(60_000)
    })

    it('aborts after maxRetries', () => {
      const r = handleAPIError(new APIError('openai', 429, 'rl'), 5, 3)
      expect(r.action).toBe('abort')
    })
  })

  describe('overload (529, 503, 502)', () => {
    it('529 retries with backoff', () => {
      const r = handleAPIError(new APIError('anthropic', 529, 'overloaded'), 1)
      expect(r.action).toBe('retry')
      expect(r.delayMs).toBe(1000)
    })

    it('503 retries', () => {
      const r = handleAPIError(new APIError('anthropic', 503, 'unavail'), 1)
      expect(r.action).toBe('retry')
    })

    it('502 retries', () => {
      const r = handleAPIError(new APIError('anthropic', 502, 'bad gw'), 1)
      expect(r.action).toBe('retry')
    })

    it('exponential backoff scales up', () => {
      const r1 = handleAPIError(new APIError('anthropic', 529, 'x'), 1)
      const r2 = handleAPIError(new APIError('anthropic', 529, 'x'), 2)
      const r3 = handleAPIError(new APIError('anthropic', 529, 'x'), 3)
      expect(r1.delayMs).toBeLessThan(r2.delayMs)
      expect(r2.delayMs).toBeLessThan(r3.delayMs)
    })

    it('aborts after max retries', () => {
      const r = handleAPIError(new APIError('anthropic', 529, 'x'), 10, 3)
      expect(r.action).toBe('abort')
    })

    it('caps backoff at 60s', () => {
      const r = handleAPIError(new APIError('anthropic', 529, 'x'), 10)
      expect(r.delayMs).toBeLessThanOrEqual(60_000)
    })
  })

  describe('auth errors (401, 403)', () => {
    it('401 aborts immediately', () => {
      const r = handleAPIError(new APIError('openai', 401, 'unauth'), 1)
      expect(r.action).toBe('abort')
      expect(r.message).toContain('sq login openai')
    })

    it('403 aborts immediately', () => {
      const r = handleAPIError(new APIError('openai', 403, 'forbidden'), 1)
      expect(r.action).toBe('abort')
    })
  })

  describe('5xx server errors', () => {
    it('500 retries with linear backoff', () => {
      const r = handleAPIError(new APIError('openai', 500, 'oops'), 1)
      expect(r.action).toBe('retry')
      expect(r.delayMs).toBe(2000)
    })

    it('500 backoff scales', () => {
      const r = handleAPIError(new APIError('openai', 500, 'x'), 3)
      expect(r.delayMs).toBe(6000)
    })
  })

  describe('network errors', () => {
    it('ETIMEDOUT retries', () => {
      const err = new Error('timed out') as NodeJS.ErrnoException
      err.code = 'ETIMEDOUT'
      const r = handleAPIError(err, 1)
      expect(r.action).toBe('retry')
    })

    it('ECONNRESET retries', () => {
      const err = new Error('reset') as NodeJS.ErrnoException
      err.code = 'ECONNRESET'
      const r = handleAPIError(err, 1)
      expect(r.action).toBe('retry')
    })

    it('ENETUNREACH retries', () => {
      const err = new Error('unreach') as NodeJS.ErrnoException
      err.code = 'ENETUNREACH'
      expect(handleAPIError(err, 1).action).toBe('retry')
    })

    it('aborts after max retries', () => {
      const err = new Error('x') as NodeJS.ErrnoException
      err.code = 'ETIMEDOUT'
      expect(handleAPIError(err, 10, 3).action).toBe('abort')
    })
  })

  describe('unknown errors', () => {
    it('aborts with message', () => {
      const r = handleAPIError(new Error('weird'), 1)
      expect(r.action).toBe('abort')
      expect(r.message).toContain('weird')
    })

    it('handles non-Error rejection', () => {
      const r = handleAPIError('strange', 1)
      expect(r.action).toBe('abort')
      expect(r.message).toContain('strange')
    })
  })
})

describe('sleep', () => {
  it('resolves after roughly the given time', async () => {
    const start = Date.now()
    await sleep(50)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })

  it('returns Promise<void>', async () => {
    const r = await sleep(0)
    expect(r).toBeUndefined()
  })
})
