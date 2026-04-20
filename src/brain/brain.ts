import { calculateContextPercent } from './context.js'
import type { SubscriptionUsage, Provider } from '../api/types.js'

export interface BrainState {
  totalInputTokens: number
  totalOutputTokens: number
  model: string
  contextPercent: number
  turnCount: number
  /** Último snapshot del uso de suscripción, uno por provider. */
  subscriptions: Record<Provider, SubscriptionUsage | null>
}

export class Brain {
  private state: BrainState

  constructor(model: string) {
    this.state = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      model,
      contextPercent: 0,
      turnCount: 0,
      subscriptions: { anthropic: null, openai: null, google: null },
    }
  }

  setSubscription(usage: SubscriptionUsage): void {
    this.state.subscriptions[usage.provider] = usage
  }

  addUsage(inputTokens: number, outputTokens: number): void {
    // Totales acumulados sirven para coste y estadísticas.
    this.state.totalInputTokens += inputTokens
    this.state.totalOutputTokens += outputTokens
    this.state.turnCount++
    // Ocupación real de la ventana = tamaño del último turno.
    // Anthropic ya incluye todo el historial en input_tokens de cada request,
    // así que sumarlo turno a turno duplicaría el historial N veces.
    this.state.contextPercent = calculateContextPercent(
      inputTokens + outputTokens,
      this.state.model,
    )
  }

  setModel(model: string): void {
    this.state.model = model
  }

  getState(): BrainState {
    return { ...this.state }
  }

  shouldWarn(threshold: number): boolean {
    return this.state.contextPercent >= threshold
  }

  shouldTransplant(threshold: number): boolean {
    return this.state.contextPercent >= threshold
  }

  reset(): void {
    this.state.totalInputTokens = 0
    this.state.totalOutputTokens = 0
    this.state.contextPercent = 0
    this.state.turnCount = 0
  }
}
