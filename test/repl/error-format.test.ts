import { describe, it, expect } from 'vitest'
import { formatError } from '../../src/repl/error-format.js'
import { AuthError, APIError } from '../../src/errors.js'

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('formatError', () => {
  describe('AuthError', () => {
    it('formats anthropic auth error with hint', () => {
      const out = formatError(new AuthError('anthropic', 'token expired'))
      const s = stripAnsi(out)
      expect(s).toContain('anthropic')
      expect(s).toContain('claude setup-token')
    })

    it('formats openai auth error with hint', () => {
      const out = formatError(new AuthError('openai', 'bad'))
      expect(stripAnsi(out)).toContain('codex login')
    })

    it('formats google auth error with hint', () => {
      const out = formatError(new AuthError('google', 'bad'))
      expect(stripAnsi(out)).toContain('gemini auth')
    })
  })

  describe('APIError', () => {
    it('401 → token rejected', () => {
      const out = formatError(new APIError('anthropic', 401, 'Unauthorized'))
      expect(stripAnsi(out)).toContain('Token rejected')
      expect(stripAnsi(out)).toContain('401')
    })

    it('403 cloudflare → block message', () => {
      const out = formatError(new APIError('openai', 403, 'cloudflare blocked'))
      expect(stripAnsi(out)).toContain('Cloudflare')
    })

    it('403 generic → access denied', () => {
      const out = formatError(new APIError('openai', 403, 'forbidden'))
      expect(stripAnsi(out)).toContain('Access denied')
    })

    it('404 → model not found + hint', () => {
      const out = formatError(new APIError('anthropic', 404, 'no such model'))
      expect(stripAnsi(out)).toContain('Model not found')
    })

    it('400 with not found message → model not found path', () => {
      const out = formatError(new APIError('anthropic', 400, 'requested entity was not found'))
      expect(stripAnsi(out)).toContain('Model not found')
    })

    it('429 → rate limit + wait suggestion', () => {
      const out = formatError(new APIError('openai', 429, 'too many requests'))
      expect(stripAnsi(out)).toContain('Rate limit')
      expect(stripAnsi(out)).toContain('429')
    })

    it('429 with retryAfterMs uses specific wait', () => {
      const err = new APIError('openai', 429, 'rl', false, 5000)
      expect(stripAnsi(formatError(err))).toContain('wait 5s')
    })

    it('400 context-length → context overflow', () => {
      const out = formatError(new APIError('anthropic', 400, 'maximum context length exceeded'))
      expect(stripAnsi(out)).toContain('Context overflow')
    })

    it('400 invalid → invalid request', () => {
      const out = formatError(new APIError('openai', 400, 'invalid request body malformed'))
      expect(stripAnsi(out)).toContain('Invalid request')
    })

    it('500+ → server error', () => {
      const out = formatError(new APIError('google', 500, 'oops'))
      expect(stripAnsi(out)).toContain('Server error')
    })

    it('502 → server error', () => {
      const out = formatError(new APIError('google', 502, 'bad gateway'))
      expect(stripAnsi(out)).toContain('Server error')
    })

    it('unknown status → generic with status code', () => {
      const out = formatError(new APIError('openai', 418, "I'm a teapot"))
      expect(stripAnsi(out)).toContain('418')
    })
  })

  describe('NodeJS errors', () => {
    it('ENOTFOUND → no connection', () => {
      const err = new Error('dns failed') as NodeJS.ErrnoException
      err.code = 'ENOTFOUND'
      expect(stripAnsi(formatError(err))).toContain('No connection')
    })

    it('ECONNREFUSED → no connection', () => {
      const err = new Error('refused') as NodeJS.ErrnoException
      err.code = 'ECONNREFUSED'
      expect(stripAnsi(formatError(err))).toContain('No connection')
    })

    it('"not yet implemented" → adapter hint', () => {
      const err = new Error('this provider is not yet implemented')
      expect(stripAnsi(formatError(err))).toContain('Adapter not yet implemented')
    })

    it('plain Error → message after ✖', () => {
      const out = formatError(new Error('boom'))
      expect(stripAnsi(out)).toContain('boom')
    })
  })

  describe('non-Error', () => {
    it('falls back to String()', () => {
      const out = formatError('weird thing')
      expect(stripAnsi(out)).toContain('weird thing')
    })
  })
})
