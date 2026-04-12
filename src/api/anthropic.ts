import { APIError } from '../errors.js'
import type { APIAdapter, NormalizedRequest, NormalizedStreamChunk } from './types.js'

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
  type: 'text' | 'tool_use'
  id?: string
  name?: string
  inputJson: string
}

export class AnthropicAdapter implements APIAdapter {
  private baseUrl: string
  private getHeaders: () => Promise<Record<string, string>>
  private currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private contentBlocks: Map<number, ContentBlockState> = new Map()

  constructor(proxyPort: number | null, getHeaders: () => Promise<Record<string, string>>) {
    this.baseUrl = proxyPort !== null
      ? `http://localhost:${proxyPort}`
      : ANTHROPIC_DIRECT_URL
    this.getHeaders = getHeaders
  }

  async sendRequest(req: NormalizedRequest): Promise<void> {
    this.contentBlocks.clear()

    const tools: AnthropicTool[] = req.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: t.parameters,
        required: Object.entries(t.parameters)
          .filter(([, v]) => (v as Record<string, unknown>).required)
          .map(([k]) => k),
      },
    }))

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
      return { role: m.role, content: m.content }
    })

    const headers = await this.getHeaders()
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.model,
        max_tokens: 8096,
        system: req.system,
        messages,
        tools,
        stream: req.stream,
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
    this.currentReader = res.body.getReader()
  }

  async *receiveStream(): AsyncIterable<NormalizedStreamChunk> {
    if (!this.currentReader) return

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
