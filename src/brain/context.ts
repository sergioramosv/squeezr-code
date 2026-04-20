// Context window sizes per model (in tokens).
//
// Two layers of lookup:
//   1. Exact match on the full model ID (e.g. "claude-sonnet-4-5-20250929").
//   2. Pattern match on family + generation (e.g. anything matching
//      /sonnet-4-[5-9]/ maps to 1_000_000) — handles forward-compatible
//      date-suffixed IDs without requiring every variant to be listed.
//
// If neither matches, the per-family default applies.

const MODEL_CONTEXT: Record<string, number> = {
  // Anthropic — exact IDs
  'claude-opus-4-20250514': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-sonnet-4-5-20250929': 1_000_000,
  'claude-opus-4-6-20260301': 1_000_000,

  // OpenAI
  'o3': 200_000,
  'o4-mini': 200_000,
  'gpt-4.1': 1_000_000,
  'gpt-5': 400_000,
  'gpt-5-codex': 400_000,

  // Google
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-3.1-pro-high': 2_000_000,
}

// Pattern fallbacks — ordered; first match wins.
const MODEL_CONTEXT_PATTERNS: Array<{ re: RegExp; limit: number }> = [
  // Claude Sonnet 4.5 and later → 1M native context
  { re: /claude-sonnet-4-[5-9](?:-|$)/, limit: 1_000_000 },
  // Claude Opus 4.5 and later → 1M native context
  { re: /claude-opus-4-[5-9](?:-|$)/, limit: 1_000_000 },
  // Claude Haiku 4.5+ → 200k
  { re: /claude-haiku-4-[5-9](?:-|$)/, limit: 200_000 },
  // Generic fallbacks
  { re: /^gemini-/, limit: 1_000_000 },
  { re: /^gpt-5/, limit: 400_000 },
  { re: /^claude-/, limit: 200_000 },
]

const DEFAULT_CONTEXT = 200_000

export function getContextLimit(model: string): number {
  const exact = MODEL_CONTEXT[model]
  if (exact) return exact
  for (const { re, limit } of MODEL_CONTEXT_PATTERNS) {
    if (re.test(model)) return limit
  }
  return DEFAULT_CONTEXT
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
  if (limit <= 0) return 0
  if (totalTokensUsed <= 0) return 0
  // Clamp to [0, 100]. Going over 100% is either a stale MODEL_CONTEXT
  // entry (unknown model, underestimated window) or a reporting bug —
  // in either case, showing "102%" is strictly worse than showing "100%".
  const raw = (totalTokensUsed / limit) * 100
  if (raw >= 100) return 100
  return Math.round(raw)
}
