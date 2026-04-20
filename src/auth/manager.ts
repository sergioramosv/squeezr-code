import { AnthropicAuth } from './anthropic.js'
import { OpenAIAuth } from './openai.js'
import { GoogleAuth } from './google.js'
import type { Provider } from '../errors.js'

export interface AuthStatus {
  anthropic: boolean
  openai: boolean
  google: boolean
}

export interface ReimportResult {
  anthropic: boolean
  openai: boolean
  google: boolean
}

export class AuthManager {
  private anthropic = new AnthropicAuth()
  private openai = new OpenAIAuth()
  private google = new GoogleAuth()

  async init(): Promise<AuthStatus> {
    const [anthropic, openai, google] = await Promise.all([
      this.anthropic.load(),
      this.openai.load(),
      this.google.load(),
    ])
    return { anthropic, openai, google }
  }

  async headersFor(provider: Provider): Promise<Record<string, string>> {
    switch (provider) {
      case 'anthropic': return this.anthropic.getHeaders()
      case 'openai': return this.openai.getHeaders()
      case 'google': return this.google.getHeaders()
    }
  }

  isOAuth(provider: Provider): boolean {
    switch (provider) {
      case 'anthropic': return this.anthropic.isOAuthToken()
      default: return false
    }
  }

  async reimport(provider?: Provider): Promise<ReimportResult> {
    if (provider) {
      const result: ReimportResult = { anthropic: false, openai: false, google: false }
      switch (provider) {
        case 'anthropic': result.anthropic = await this.anthropic.reimport(); break
        case 'openai': result.openai = await this.openai.reimport(); break
        case 'google': result.google = await this.google.reimport(); break
      }
      return result
    }
    const [anthropic, openai, google] = await Promise.all([
      this.anthropic.reimport(),
      this.openai.reimport(),
      this.google.reimport(),
    ])
    return { anthropic, openai, google }
  }

  authenticated(): Provider[] {
    const providers: Provider[] = []
    if (this.anthropic.isAuthenticated()) providers.push('anthropic')
    if (this.openai.isAuthenticated()) providers.push('openai')
    if (this.google.isAuthenticated()) providers.push('google')
    return providers
  }

  /** Lanza el OAuth flow del provider indicado. Bloquea hasta completarlo. */
  async login(provider: Provider): Promise<void> {
    switch (provider) {
      case 'anthropic': return this.anthropic.login()
      case 'openai':    return this.openai.login()
      case 'google':    return this.google.login()
    }
  }

  /** ms hasta que expira el token del provider, o null si no hay creds. */
  msUntilExpiry(provider: Provider): number | null {
    switch (provider) {
      case 'anthropic': return this.anthropic.msUntilExpiry()
      case 'openai':    return this.openai.msUntilExpiry()
      case 'google':    return this.google.msUntilExpiry()
    }
  }

  /**
   * Refresca proactivamente todos los tokens que expiren en menos de `bufferMs`.
   * Llamado por el background timer. Silencioso si falla — el siguiente request
   * intentará refresh de nuevo y, si también falla, saltará el flow inline.
   */
  async refreshIfNeeded(bufferMs: number): Promise<void> {
    const providers = this.authenticated()
    await Promise.allSettled(providers.map(async (p) => {
      const ms = this.msUntilExpiry(p)
      if (ms === null) return
      if (ms > bufferMs) return
      // ensureValid hace refresh transparente vía /token
      try { await this.headersFor(p) } catch { /* silencioso */ }
    }))
  }

  getOpenAIAccountId(): string | null {
    return this.openai.getAccountId()
  }

  getProviderInfo(provider: Provider) {
    switch (provider) {
      case 'anthropic': return this.anthropic.getInfo()
      case 'openai': return this.openai.getInfo()
      case 'google': return this.google.getInfo()
    }
  }
}
