// Context window sizes per model (in tokens)
const MODEL_CONTEXT: Record<string, number> = {
  // Anthropic
  'claude-opus-4-20250514': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  // OpenAI
  'o3': 200_000,
  'o4-mini': 200_000,
  'gpt-4.1': 1_000_000,
  // Google
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
}

const DEFAULT_CONTEXT = 200_000

export function getContextLimit(model: string): number {
  return MODEL_CONTEXT[model] ?? DEFAULT_CONTEXT
}

export function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English/code
  return Math.ceil(text.length / 4)
}

export function calculateContextPercent(
  totalTokensUsed: number,
  model: string,
): number {
  const limit = getContextLimit(model)
  return Math.round((totalTokensUsed / limit) * 100)
}
