import type { Provider } from '../errors.js'

export type { Provider }

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
  /** Para bloques `image`: base64 data + mime (image/png, image/jpeg, ...). */
  imageBase64?: string
  imageMediaType?: string
}

export interface NormalizedMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[]
  toolUseId?: string
  isKeyMessage?: boolean
  isPinned?: boolean
}

export interface NormalizedRequest {
  system: string
  messages: NormalizedMessage[]
  tools: ToolDef[]
  model: string
  stream: boolean
  /** Budget de extended thinking en tokens. 0 = deshabilitado. Solo Anthropic. */
  thinkingBudget?: number
}

export interface SubscriptionUsage {
  /** Provider al que pertenece este snapshot. */
  provider: Provider
  /** % de la ventana de 5h ya consumido (0–1), agregado. */
  fiveHour: number
  /** % de la ventana de 5h consumido por Sonnet específicamente (0–1).
   *  Anthropic devuelve un header per-model; usamos éste en la status bar
   *  cuando el modelo activo es un Sonnet, que es lo que muestra Claude Code. */
  fiveHourSonnet: number
  /** Igual, para la familia Opus. */
  fiveHourOpus: number
  /** Igual, para la familia Haiku. */
  fiveHourHaiku: number
  /** Timestamp unix (ms) en el que resetea la ventana de 5h. */
  fiveHourResetAt: number
  /** % del límite semanal (0–1). */
  sevenDay: number
  /** % del límite semanal específico de Sonnet (0–1), solo aplica a Anthropic. */
  sevenDaySonnet: number
  /** Timestamp unix (ms) del reset semanal. */
  sevenDayResetAt: number
  /** allowed | warning | limited | ... (tal cual lo devuelve el proveedor). */
  status: string
  /** Qué límite es el dominante ahora mismo. */
  representative: string
  /** Tipo de suscripción (max, plus, pro, ...). Solo informativo. */
  plan?: string
}

export interface NormalizedStreamChunk {
  type: 'text' | 'thinking' | 'tool_use' | 'usage' | 'subscription' | 'done'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheRead?: number
  }
  subscription?: SubscriptionUsage
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface APIAdapter {
  sendRequest(req: NormalizedRequest): Promise<void>
  receiveStream(): AsyncIterable<NormalizedStreamChunk>
  sendToolResult(toolUseId: string, result: string): Promise<void>
  close(): void
}

export interface AgentEvent {
  type:
    | 'text'
    | 'thinking'
    | 'tool_start'
    | 'tool_result'
    | 'cost'
    | 'subscription'
    | 'error'
    | 'done'
    | 'api_call_start'
    | 'transplant'
    | 'recap'
  timestamp: number
  text?: string
  tool?: { name: string; input?: unknown; result?: string }
  usage?: { inputTokens: number; outputTokens: number; cacheRead?: number }
  cost?: { usd: number; model: string }
  subscription?: SubscriptionUsage
  error?: string
  model?: string
  contextPercent?: number
  isError?: boolean
  /** Para `recap`: tiempo total del turno en segundos. */
  elapsedSec?: number
}

export interface AgentLoopOpts {
  provider: Provider
  model: string
  cwd: string
  systemPrompt?: string
  appendSystemPrompt?: string
  permissions: 'default' | 'accept-edits' | 'plan' | 'bypass' | 'auto' | 'yolo'
  messages?: NormalizedMessage[]
  proxyPort?: number
}

export interface ToolResult {
  id: string
  result: string
  isError?: boolean
}
