import { calculateContextPercent } from './context.js'

export interface BrainState {
  totalInputTokens: number
  totalOutputTokens: number
  model: string
  contextPercent: number
  turnCount: number
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
    }
  }

  addUsage(inputTokens: number, outputTokens: number): void {
    this.state.totalInputTokens += inputTokens
    this.state.totalOutputTokens += outputTokens
    this.state.turnCount++
    this.state.contextPercent = calculateContextPercent(
      this.state.totalInputTokens + this.state.totalOutputTokens,
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
