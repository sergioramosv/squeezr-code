import { APIError } from '../errors.js'
import type { APIAdapter, NormalizedRequest, NormalizedStreamChunk, SubscriptionUsage } from './types.js'

const ANTHROPIC_DIRECT_URL = 'https://api.anthropic.com'

interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

interface AnthropicMessage {
  role: string
  content: unknown
}

interface ContentBlockState {
  type: 'text' | 'tool_use' | 'thinking'
  id?: string
  name?: string
  inputJson: string
}

// Preamble obligatoria cuando usamos un OAuth token de Claude Code contra /v1/messages.
// La API de Anthropic rechaza el token si el system prompt no empieza con este bloque.
const CLAUDE_CODE_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude."

export class AnthropicAdapter implements APIAdapter {
  private baseUrl: string
  private getHeaders: () => Promise<Record<string, string>>
  private isOAuth: () => boolean
  private currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private contentBlocks: Map<number, ContentBlockState> = new Map()
  /** Chunk de uso de suscripción pendiente de emitir en el primer tick del stream. */
  private pendingSubscription: SubscriptionUsage | null = null

  constructor(
    proxyPort: number | null,
    getHeaders: () => Promise<Record<string, string>>,
    isOAuth: () => boolean = () => false,
  ) {
    this.baseUrl = proxyPort !== null
      ? `http://localhost:${proxyPort}`
      : ANTHROPIC_DIRECT_URL
    this.getHeaders = getHeaders
    this.isOAuth = isOAuth
  }

  async sendRequest(req: NormalizedRequest): Promise<void> {
    this.contentBlocks.clear()

    // Normaliza las parameters al formato JSON Schema draft 2020-12 que pide Anthropic:
    // - `required` nunca va dentro de una property (debe ser un array en el objeto padre)
    // - solo dejamos las keys reconocidas por JSON Schema en cada property
    const tools: AnthropicTool[] = req.tools.map(t => {
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [paramName, paramDef] of Object.entries(t.parameters)) {
        const def = paramDef as Record<string, unknown>
        const { required: isRequired, ...clean } = def
        properties[paramName] = clean
        if (isRequired) required.push(paramName)
      }
      return {
        name: t.name,
        description: t.description,
        input_schema: {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      }
    })
    // Prompt caching: marcar la ÚLTIMA tool con cache_control cachea todo el
    // bloque de tools (mismo entre turnos). El modelo ve cache_hit y paga
    // 0.1x en lugar de 1x esos input tokens. TTL ephemeral = 5 min.
    if (tools.length > 0) {
      (tools[tools.length - 1] as unknown as Record<string, unknown>).cache_control = { type: 'ephemeral' }
    }

    const messages: AnthropicMessage[] = req.messages.map(m => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.toolUseId,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          }],
        }
      }
      // Multimodal: traduce bloques `image` al formato de Anthropic
      // ({ type: 'image', source: { type: 'base64', media_type, data } }).
      if (Array.isArray(m.content)) {
        const translated = m.content.map(b => {
          if (b.type === 'image' && b.imageBase64 && b.imageMediaType) {
            return {
              type: 'image',
              source: { type: 'base64', media_type: b.imageMediaType, data: b.imageBase64 },
            }
          }
          return b
        })
        return { role: m.role, content: translated as unknown as AnthropicMessage['content'] }
      }
      return { role: m.role, content: m.content }
    })

    const headers = await this.getHeaders()

    // Con OAuth, el system DEBE empezar con la preamble de Claude Code.
    // Se envía como array de bloques para no perder el prompt real del agente.
    // El último bloque lleva cache_control para que Anthropic cachee el
    // system prompt entero (mismo entre turnos → 90% descuento en reused
    // tokens). TTL ephemeral = 5 min de inactividad.
    const systemPayload = this.isOAuth()
      ? [
          { type: 'text', text: CLAUDE_CODE_PREAMBLE },
          { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
        ]
      : [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.model,
        max_tokens: 8096,
        system: systemPayload,
        messages,
        tools,
        stream: req.stream,
        // Extended thinking: solo si el prompt incluía "think"/"think hard"/etc.
        // Anthropic requiere max_tokens > thinking.budget_tokens.
        ...(req.thinkingBudget && req.thinkingBudget > 0 ? {
          thinking: { type: 'enabled', budget_tokens: req.thinkingBudget },
          max_tokens: Math.max(8096, req.thinkingBudget + 4096),
        } : {}),
      }),
    })

    if (!res.ok) {
      const retryAfter = res.headers.get('retry-after')
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500
      const body = await res.text().catch(() => '')
      throw new APIError(
        'anthropic',
        res.status,
        `${res.statusText}: ${body}`,
        retryable,
        retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined,
      )
    }

    if (!res.body) throw new APIError('anthropic', 0, 'No response body', false)

    // Captura uso de suscripción (ventanas 5h / 7d) que Anthropic devuelve en cada respuesta.
    this.pendingSubscription = parseSubscriptionHeaders(res.headers)

    this.currentReader = res.body.getReader()
  }

  async *receiveStream(): AsyncIterable<NormalizedStreamChunk> {
    if (!this.currentReader) return

    // Emite el uso de suscripción como primer chunk para que el Brain/REPL lo capten pronto.
    if (this.pendingSubscription) {
      yield { type: 'subscription', subscription: this.pendingSubscription }
      this.pendingSubscription = null
    }

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await this.currentReader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (!data || data === '[DONE]') continue

        let event: Record<string, unknown>
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }

        const chunks = this.processEvent(event)
        for (const chunk of chunks) {
          yield chunk
        }
      }
    }
  }

  private processEvent(event: Record<string, unknown>): NormalizedStreamChunk[] {
    const type = event.type as string
    const chunks: NormalizedStreamChunk[] = []

    switch (type) {
      case 'message_start': {
        const message = event.message as Record<string, unknown>
        const usage = message?.usage as Record<string, number>
        if (usage) {
          chunks.push({
            type: 'usage',
            usage: {
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              cacheRead: usage.cache_read_input_tokens || 0,
            },
          })
        }
        break
      }

      case 'content_block_start': {
        const idx = event.index as number
        const block = event.content_block as Record<string, unknown>
        if (block.type === 'text') {
          this.contentBlocks.set(idx, { type: 'text', inputJson: '' })
        } else if (block.type === 'thinking') {
          this.contentBlocks.set(idx, { type: 'thinking', inputJson: '' })
        } else if (block.type === 'tool_use') {
          this.contentBlocks.set(idx, {
            type: 'tool_use',
            id: block.id as string,
            name: block.name as string,
            inputJson: '',
          })
        }
        break
      }

      case 'content_block_delta': {
        const idx = event.index as number
        const delta = event.delta as Record<string, unknown>
        const block = this.contentBlocks.get(idx)

        if (delta.type === 'text_delta' && delta.text) {
          chunks.push({ type: 'text', text: delta.text as string })
        }

        // Extended thinking: Anthropic emite el razonamiento interno como
        // bloques `thinking` con su propio tipo de delta.
        if (delta.type === 'thinking_delta' && delta.thinking) {
          chunks.push({ type: 'thinking', text: delta.thinking as string })
        }

        if (delta.type === 'input_json_delta' && block) {
          block.inputJson += delta.partial_json as string
        }
        break
      }

      case 'content_block_stop': {
        const idx = event.index as number
        const block = this.contentBlocks.get(idx)
        if (block?.type === 'tool_use') {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(block.inputJson || '{}')
          } catch { /* malformed — send empty */ }
          chunks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input,
          })
        }
        break
      }

      case 'message_delta': {
        const usage = (event.usage as Record<string, number>) || {}
        if (usage.output_tokens) {
          chunks.push({
            type: 'usage',
            usage: { inputTokens: 0, outputTokens: usage.output_tokens },
          })
        }
        break
      }

      case 'message_stop': {
        chunks.push({ type: 'done' })
        break
      }
    }

    return chunks
  }

  async sendToolResult(_toolUseId: string, _result: string): Promise<void> {
    // For Anthropic, tool results are sent as part of the next sendRequest call
  }

  close(): void {
    this.currentReader?.cancel()
    this.currentReader = null
  }
}

/**
 * Extrae el uso de la suscripción de Claude (Max / Pro) desde los headers de /v1/messages.
 *
 * Anthropic devuelve en cada respuesta headers `anthropic-ratelimit-unified-*` con
 * las ventanas de 5 horas y 7 días. Son la única fuente fiable del % real de uso
 * de la suscripción (no va en el body de la respuesta).
 *
 * Devuelve null si no hay headers de rate limit (p. ej. porque estamos usando una API key
 * en vez de OAuth, o porque la cuenta no es de suscripción).
 */
function parseSubscriptionHeaders(headers: Headers): SubscriptionUsage | null {
  const fiveHour = headers.get('anthropic-ratelimit-unified-5h-utilization')
  if (!fiveHour) return null

  const num = (h: string | null): number => (h ? parseFloat(h) || 0 : 0)
  const ts = (h: string | null): number => (h ? parseInt(h, 10) * 1000 : 0)

  return {
    provider: 'anthropic',
    fiveHour: num(fiveHour),
    fiveHourResetAt: ts(headers.get('anthropic-ratelimit-unified-5h-reset')),
    sevenDay: num(headers.get('anthropic-ratelimit-unified-7d-utilization')),
    sevenDaySonnet: num(headers.get('anthropic-ratelimit-unified-7d_sonnet-utilization')),
    sevenDayResetAt: ts(headers.get('anthropic-ratelimit-unified-7d-reset')),
    status: headers.get('anthropic-ratelimit-unified-status') || 'unknown',
    representative: headers.get('anthropic-ratelimit-unified-representative-claim') || 'five_hour',
  }
}
