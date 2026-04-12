import type { Provider } from '../errors.js'

export type { Provider }

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
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
}

export interface NormalizedStreamChunk {
  type: 'text' | 'tool_use' | 'usage' | 'done'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheRead?: number
  }
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
    | 'tool_start'
    | 'tool_result'
    | 'cost'
    | 'error'
    | 'done'
    | 'api_call_start'
    | 'transplant'
  timestamp: number
  text?: string
  tool?: { name: string; input?: unknown; result?: string }
  usage?: { inputTokens: number; outputTokens: number }
  cost?: { usd: number; model: string }
  error?: string
  model?: string
  contextPercent?: number
  isError?: boolean
}

export interface AgentLoopOpts {
  provider: Provider
  model: string
  cwd: string
  systemPrompt?: string
  appendSystemPrompt?: string
  permissions: 'default' | 'auto' | 'yolo'
  messages?: NormalizedMessage[]
  proxyPort?: number
}

export interface ToolResult {
  id: string
  result: string
  isError?: boolean
}
