export type Provider = 'anthropic' | 'openai' | 'google'

export class AuthError extends Error {
  constructor(
    public provider: Provider,
    message: string,
  ) {
    super(`[auth:${provider}] ${message}`)
    this.name = 'AuthError'
  }
}

export class APIError extends Error {
  constructor(
    public provider: Provider,
    public statusCode: number,
    message: string,
    public retryable: boolean = false,
    public retryAfterMs?: number,
  ) {
    super(`[api:${provider}] ${statusCode} ${message}`)
    this.name = 'APIError'
  }
}

export class ToolError extends Error {
  constructor(
    public toolName: string,
    message: string,
  ) {
    super(`[tool:${toolName}] ${message}`)
    this.name = 'ToolError'
  }
}

export class BudgetExceededError extends Error {
  constructor(
    public budgetUsd: number,
    public spentUsd: number,
  ) {
    super(`Daily budget exceeded: $${spentUsd.toFixed(2)} / $${budgetUsd.toFixed(2)}`)
    this.name = 'BudgetExceededError'
  }
}
