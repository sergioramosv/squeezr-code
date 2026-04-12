import { APIError } from '../errors.js'
import type { APIAdapter, NormalizedRequest, NormalizedStreamChunk } from './types.js'

interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

interface AnthropicMessage {
  role: string
  content: unknown
}

export class AnthropicAdapter implements APIAdapter {
  private baseUrl: string
  private getHeaders: () => Promise<Record<string, string>>
  private currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private fullContent: unknown[] = []

  constructor(proxyPort: number, getHeaders: () => Promise<Record<string, string>>) {
    this.baseUrl = `http://localhost:${proxyPort}`
    this.getHeaders = getHeaders
  }

  async sendRequest(req: NormalizedRequest): Promise<void> {
    this.fullContent = []

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
      throw new APIError(
        'anthropic',
        res.status,
        `${res.statusText}: ${await res.text().catch(() => '')}`,
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
        if (data === '[DONE]') return

        let event: Record<string, unknown>
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }

        const type = event.type as string

        if (type === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown>
          if (delta.type === 'text_delta') {
            yield { type: 'text', text: delta.text as string }
          }
          if (delta.type === 'input_json_delta') {
            // Accumulate tool input JSON — handled in content_block_stop
          }
        }

        if (type === 'content_block_start') {
          const block = event.content_block as Record<string, unknown>
          if (block.type === 'tool_use') {
            this.fullContent.push(block)
          }
        }

        if (type === 'content_block_stop') {
          const idx = event.index as number
          const block = this.fullContent[idx]
          if (block && (block as Record<string, unknown>).type === 'tool_use') {
            const tb = block as Record<string, unknown>
            yield {
              type: 'tool_use',
              id: tb.id as string,
              name: tb.name as string,
              input: tb.input as Record<string, unknown>,
            }
          }
        }

        if (type === 'message_delta') {
          const usage = (event.usage as Record<string, number>) || {}
          if (usage.output_tokens) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: 0,
                outputTokens: usage.output_tokens,
              },
            }
          }
        }

        if (type === 'message_start') {
          const message = event.message as Record<string, unknown>
          const usage = message?.usage as Record<string, number>
          if (usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: usage.input_tokens || 0,
                outputTokens: usage.output_tokens || 0,
                cacheRead: usage.cache_read_input_tokens || 0,
              },
            }
          }
        }

        if (type === 'message_stop') {
          yield { type: 'done' }
        }
      }
    }
  }

  async sendToolResult(_toolUseId: string, _result: string): Promise<void> {
    // For Anthropic, tool results are sent as part of the next sendRequest call
    // This is a no-op — the loop handles adding tool results to messages
  }

  close(): void {
    this.currentReader?.cancel()
    this.currentReader = null
  }
}
