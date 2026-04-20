import { AuthError, APIError } from '../errors.js'
import type { Provider } from '../errors.js'
import { getLoadedModels } from '../api/models.js'

const RESET = '\x1b[0m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const YELLOW = '\x1b[33m'

const REIMPORT_HINT: Record<Provider, string> = {
  anthropic: 're-import auth with `claude setup-token` and restart sq',
  openai: 're-import auth with `codex login` and restart sq',
  google: 're-import auth with `gemini auth` and restart sq',
}

/**
 * Convierte cualquier error que llegue al REPL en un mensaje corto y accionable
 * con colores ANSI ya incrustados. El llamador solo hace `console.error(formatError(err))`.
 */
export function formatError(err: unknown): string {
  if (err instanceof AuthError) {
    const hint = REIMPORT_HINT[err.provider] || 're-import auth and retry'
    return `${RED}✖ ${err.provider} auth expired or invalid.${RESET} ${DIM}${hint}.${RESET}`
  }

  if (err instanceof APIError) {
    const p = err.provider
    const status = err.statusCode
    const msg = err.message || ''

    if (status === 401) {
      return `${RED}✖ Token rejected by ${p} (401).${RESET} ${DIM}${REIMPORT_HINT[p]}.${RESET}`
    }
    if (status === 403 && /cloudflare|blocked/i.test(msg)) {
      return `${RED}✖ Blocked by Cloudflare (403).${RESET} ${DIM}VPN or corporate network? Try another network.${RESET}`
    }
    if (status === 403) {
      return `${RED}✖ Access denied by ${p} (403).${RESET} ${DIM}${msg.slice(0, 200)}${RESET}`
    }
    if (status === 404 || /not.?found|no such model|requested entity/i.test(msg)) {
      const similar = suggestModels(p)
      const hint = similar ? `try: ${similar}` : 'use /model to see available models'
      return `${RED}✖ Model not found on ${p}.${RESET} ${DIM}${hint}.${RESET}`
    }
    if (status === 429) {
      const wait = err.retryAfterMs
        ? `wait ${Math.ceil(err.retryAfterMs / 1000)}s`
        : 'wait a few seconds'
      return `${YELLOW}✖ Rate limit on ${p} (429).${RESET} ${DIM}${wait} or change model with /model.${RESET}`
    }
    if (status === 400 && /context.?length|token.?limit|too many tokens|maximum context/i.test(msg)) {
      return `${YELLOW}✖ Context overflow.${RESET} ${DIM}use /compact to summarize history, or /clear to start a new turn.${RESET}`
    }
    if (status === 400 && /invalid.?request|malformed/i.test(msg)) {
      return `${RED}✖ Invalid request to ${p}.${RESET} ${DIM}${msg.slice(0, 200)}${RESET}`
    }
    if (status >= 500) {
      return `${RED}✖ Server error from ${p} (${status}).${RESET} ${DIM}retry in a few seconds.${RESET}`
    }
    return `${RED}✖ ${p} ${status}: ${msg.slice(0, 200)}${RESET}`
  }

  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED') {
      return `${RED}✖ No connection.${RESET} ${DIM}firewall or DNS? (${code})${RESET}`
    }
    if (/not yet implemented/i.test(err.message)) {
      return `${RED}✖ Adapter not yet implemented.${RESET} ${DIM}use another model with /model.${RESET}`
    }
    return `${RED}✖ ${err.message}${RESET}`
  }

  return `${RED}✖ ${String(err)}${RESET}`
}

/** Devuelve una lista corta de aliases cargados para el provider. */
function suggestModels(p: Provider): string {
  try {
    const models = getLoadedModels().filter(m => m.provider === p).slice(0, 3)
    if (models.length === 0) return ''
    return models.map(m => m.alias).join(', ')
  } catch {
    return ''
  }
}
