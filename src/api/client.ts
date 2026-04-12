import { AnthropicAdapter } from './anthropic.js'
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
        )
        break
      case 'openai':
        // TODO: Phase 1 week 5-6 — OpenAI WebSocket adapter
        throw new Error('OpenAI adapter not yet implemented')
      case 'google':
        // TODO: Phase 1 week 5-6 — Google REST adapter
        throw new Error('Google adapter not yet implemented')
    }

    this.adapters.set(provider, adapter)
    return adapter
  }

  providerForModel(model: string): Provider {
    if (model.startsWith('claude-') || model.includes('haiku') || model.includes('sonnet') || model.includes('opus')) {
      return 'anthropic'
    }
    if (model.startsWith('o3') || model.startsWith('o4') || model.startsWith('gpt-')) {
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
