import { SQ_TOOLS } from '../tools/definitions.js'
import { executeTool } from '../tools/executor.js'
import { buildSystemPrompt } from './system.js'
import { handleAPIError, sleep } from '../api/retry.js'
import type { APIClient } from '../api/client.js'
import type {
  AgentEvent,
  AgentLoopOpts,
  NormalizedMessage,
  NormalizedStreamChunk,
  ToolResult,
} from '../api/types.js'

export interface AgentLoopDeps {
  apiClient: APIClient
  askPermission?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>
}

export async function* agentLoop(
  prompt: string,
  opts: AgentLoopOpts,
  deps: AgentLoopDeps,
): AsyncGenerator<AgentEvent> {
  const messages: NormalizedMessage[] = opts.messages ? [...opts.messages] : []
  const systemPrompt = buildSystemPrompt(opts)
  const provider = opts.provider
  const adapter = deps.apiClient.getAdapter(provider)

  messages.push({ role: 'user', content: prompt })

  let consecutiveErrors = 0

  while (true) {
    yield {
      type: 'api_call_start',
      timestamp: Date.now(),
      model: opts.model,
    }

    // Send request with retry
    try {
      await adapter.sendRequest({
        system: systemPrompt,
        messages,
        tools: SQ_TOOLS,
        model: opts.model,
        stream: true,
      })
      consecutiveErrors = 0
    } catch (err) {
      consecutiveErrors++
      const recovery = handleAPIError(err, consecutiveErrors)
      yield { type: 'error', timestamp: Date.now(), error: recovery.message }
      if (recovery.action === 'retry') {
        await sleep(recovery.delayMs)
        continue
      }
      yield { type: 'done', timestamp: Date.now() }
      return
    }

    // Process stream
    let hasToolUse = false
    const toolResults: ToolResult[] = []
    const assistantContentBlocks: unknown[] = []
    let totalInputTokens = 0
    let totalOutputTokens = 0

    try {
      for await (const chunk of adapter.receiveStream()) {
        if (chunk.type === 'text') {
          assistantContentBlocks.push({ type: 'text', text: chunk.text })
          yield { type: 'text', timestamp: Date.now(), text: chunk.text }
        }

        if (chunk.type === 'tool_use') {
          hasToolUse = true
          const toolInput = chunk.input || {}

          assistantContentBlocks.push({
            type: 'tool_use',
            id: chunk.id,
            name: chunk.name,
            input: toolInput,
          })

          yield {
            type: 'tool_start',
            timestamp: Date.now(),
            tool: { name: chunk.name!, input: toolInput },
          }

          try {
            const result = await executeTool(chunk.name!, toolInput, {
              cwd: opts.cwd,
              permissions: opts.permissions,
              askPermission: deps.askPermission,
            })
            toolResults.push({ id: chunk.id!, result })
            yield {
              type: 'tool_result',
              timestamp: Date.now(),
              tool: { name: chunk.name!, result },
            }
          } catch (toolErr) {
            const errorMsg = `Tool '${chunk.name}' failed: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`
            toolResults.push({ id: chunk.id!, result: errorMsg, isError: true })
            yield {
              type: 'tool_result',
              timestamp: Date.now(),
              tool: { name: chunk.name!, result: errorMsg },
              isError: true,
            }
          }
        }

        if (chunk.type === 'usage' && chunk.usage) {
          totalInputTokens += chunk.usage.inputTokens
          totalOutputTokens += chunk.usage.outputTokens
        }
      }
    } catch (streamErr) {
      consecutiveErrors++
      const recovery = handleAPIError(streamErr, consecutiveErrors)
      yield { type: 'error', timestamp: Date.now(), error: recovery.message }
      if (recovery.action === 'retry') {
        await sleep(recovery.delayMs)
        continue
      }
      yield { type: 'done', timestamp: Date.now() }
      return
    }

    // Emit cost
    if (totalInputTokens || totalOutputTokens) {
      yield {
        type: 'cost',
        timestamp: Date.now(),
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      }
    }

    // No tool use → agent done
    if (!hasToolUse) {
      yield { type: 'done', timestamp: Date.now() }
      return
    }

    // Add assistant message + tool results, continue loop
    messages.push({ role: 'assistant', content: assistantContentBlocks as any })
    for (const tr of toolResults) {
      messages.push({
        role: 'tool',
        content: tr.result,
        toolUseId: tr.id,
      })
    }
  }
}
