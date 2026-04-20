import { AnthropicAdapter } from './anthropic.js'
import { OpenAIAdapter } from './openai.js'
import { GoogleAdapter } from './google.js'
import type { APIAdapter, Provider } from './types.js'
import type { AuthManager } from '../auth/manager.js'

export class APIClient {
  private adapters = new Map<Provider, APIAdapter>()

  constructor(
    private auth: AuthManager,
    private proxyPort: number | null,
  ) {}

  getAdapter(provider: Provider): APIAdapter {
    const existing = this.adapters.get(provider)
    if (existing) return existing

    let adapter: APIAdapter

    switch (provider) {
      case 'anthropic':
        adapter = new AnthropicAdapter(
          this.proxyPort,
          () => this.auth.headersFor('anthropic'),
          () => this.auth.isOAuth('anthropic'),
        )
        break
      case 'openai':
        adapter = new OpenAIAdapter(
          () => this.auth.headersFor('openai'),
          () => this.auth.getOpenAIAccountId(),
        )
        break
      case 'google':
        adapter = new GoogleAdapter(
          () => this.auth.headersFor('google'),
        )
        break
    }

    this.adapters.set(provider, adapter)
    return adapter
  }

  providerForModel(model: string): Provider {
    if (model.startsWith('claude-') || model.includes('haiku') || model.includes('sonnet') || model.includes('opus')) {
      return 'anthropic'
    }
    // gpt-5.4, gpt-5.4-mini, gpt-5-codex, o3, o4-mini, ...
    if (model.startsWith('gpt-') || model.startsWith('o3') || model.startsWith('o4') ||
        /^\d/.test(model) /* alias sin prefijo: 5.4-mini, 5-codex, etc. */) {
      return 'openai'
    }
    if (model.startsWith('gemini-')) {
      return 'google'
    }
    return 'anthropic' // default
  }

  closeAll(): void {
    for (const adapter of this.adapters.values()) {
      adapter.close()
    }
    this.adapters.clear()
  }
}
