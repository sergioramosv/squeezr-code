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
