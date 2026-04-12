import { APIError } from '../errors.js'
import type { Provider } from '../errors.js'

export interface RecoveryAction {
  action: 'retry' | 'abort'
  delayMs: number
  message: string
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ECONNREFUSED' || code === 'ENETUNREACH' ||
           code === 'ETIMEDOUT' || code === 'ECONNRESET' ||
           code === 'EPIPE' || code === 'UND_ERR_CONNECT_TIMEOUT'
  }
  return false
}

export function handleAPIError(err: unknown, attempt: number, maxRetries = 3): RecoveryAction {
  // Proxy not running
  if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
    return {
      action: attempt <= 1 ? 'retry' : 'abort',
      delayMs: 2000,
      message: attempt <= 1
        ? 'Proxy not reachable, retrying...'
        : 'Proxy not reachable. Run: squeezr start',
    }
  }

  if (err instanceof APIError) {
    // Rate limit
    if (err.statusCode === 429) {
      const delay = err.retryAfterMs || 60_000
      return {
        action: attempt <= maxRetries ? 'retry' : 'abort',
        delayMs: delay,
        message: `Rate limited by ${err.provider}, waiting ${Math.round(delay / 1000)}s...`,
      }
    }

    // Overloaded (Anthropic 529)
    if (err.statusCode === 529 || err.statusCode === 503 || err.statusCode === 502) {
      if (attempt <= maxRetries) {
        const delay = Math.min(1000 * Math.pow(3, attempt - 1), 60_000)
        return {
          action: 'retry',
          delayMs: delay,
          message: `${err.provider} overloaded, retry in ${Math.round(delay / 1000)}s...`,
        }
      }
      return { action: 'abort', delayMs: 0, message: `${err.provider} overloaded after ${maxRetries} retries` }
    }

    // Auth errors — never retry
    if (err.statusCode === 401 || err.statusCode === 403) {
      return {
        action: 'abort',
        delayMs: 0,
        message: `Auth failed for ${err.provider}. Run: sq login ${err.provider}`,
      }
    }

    // Server errors — retry with backoff
    if (err.statusCode >= 500 && attempt <= maxRetries) {
      const delay = 2000 * attempt
      return {
        action: 'retry',
        delayMs: delay,
        message: `${err.provider} server error (${err.statusCode}), retry in ${Math.round(delay / 1000)}s...`,
      }
    }
  }

  // Network errors
  if (isNetworkError(err) && attempt <= maxRetries) {
    return {
      action: 'retry',
      delayMs: 2000 * attempt,
      message: 'Network error, retrying...',
    }
  }

  return {
    action: 'abort',
    delayMs: 0,
    message: `Unrecoverable error: ${err instanceof Error ? err.message : String(err)}`,
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
