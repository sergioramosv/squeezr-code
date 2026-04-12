import { APIClient } from '../api/client.js'
import { AuthManager } from '../auth/manager.js'
import { Brain } from '../brain/brain.js'
import { handleAPIError, sleep } from '../api/retry.js'
import { SQ_TOOLS } from '../tools/definitions.js'
import { executeTool } from '../tools/executor.js'
import { buildSystemPrompt } from '../agent/system.js'
import type {
  AgentEvent,
  AgentLoopOpts,
  NormalizedMessage,
  ToolResult,
  Provider,
} from '../api/types.js'

export interface ProxyConfig {
  defaultModel: string
  permissions: 'default' | 'auto' | 'yolo'
  transplant: {
    warnThreshold: number
    autoThreshold: number
  }
}

/**
 * SqProxy — the internal brain of squeezr-code.
 *
 * All requests from the REPL go through here. The proxy:
 * - Manages auth for all 3 providers (auto-reimport on expiry)
 * - Routes to the correct API adapter
 * - Runs the agentic loop (call → tools → repeat)
 * - Tracks context % via Brain
 * - Handles retries and error recovery
 * - (Phase 2: integrates squeezr-ai compression)
 * - (Phase 3: intelligent routing via Router)
 */
export class SqProxy {
  private apiClient: APIClient
  private auth: AuthManager
  private brain: Brain
  private config: ProxyConfig
  private currentModel: string
  private currentProvider: Provider
  private totalCostUsd = 0

  constructor(auth: AuthManager, config: ProxyConfig) {
    this.auth = auth
    this.config = config
    this.currentModel = config.defaultModel
    this.currentProvider = this.resolveProvider(config.defaultModel)
    this.brain = new Brain(config.defaultModel)
    // No external proxy — direct to APIs
    this.apiClient = new APIClient(auth, null)
  }

  /**
   * Send a user prompt through the full agentic loop.
   * Yields AgentEvents for the REPL to render.
   */
  async *send(
    prompt: string,
    opts?: { model?: string; cwd?: string; askPermission?: (name: string, input: Record<string, unknown>) => Promise<boolean> },
  ): AsyncGenerator<AgentEvent> {
    const model = opts?.model || this.currentModel
    const provider = this.resolveProvider(model)
    const cwd = opts?.cwd || process.cwd()
    const adapter = this.apiClient.getAdapter(provider)
    const systemPrompt = buildSystemPrompt({
      provider,
      model,
      cwd,
      permissions: this.config.permissions,
    })

    const messages: NormalizedMessage[] = []
    messages.push({ role: 'user', content: prompt })

    let consecutiveErrors = 0

    while (true) {
      yield { type: 'api_call_start', timestamp: Date.now(), model }

      // Send request with retry
      try {
        await adapter.sendRequest({
          system: systemPrompt,
          messages,
          tools: SQ_TOOLS,
          model,
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
      let turnInputTokens = 0
      let turnOutputTokens = 0

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
                cwd,
                permissions: this.config.permissions,
                askPermission: opts?.askPermission,
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
            turnInputTokens += chunk.usage.inputTokens
            turnOutputTokens += chunk.usage.outputTokens
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

      // Update brain
      if (turnInputTokens || turnOutputTokens) {
        this.brain.addUsage(turnInputTokens, turnOutputTokens)
        this.totalCostUsd += this.estimateCost(model, turnInputTokens, turnOutputTokens)
        yield {
          type: 'cost',
          timestamp: Date.now(),
          usage: { inputTokens: turnInputTokens, outputTokens: turnOutputTokens },
          cost: { usd: this.totalCostUsd, model },
        }
      }

      // No tool use → done
      if (!hasToolUse) {
        // Context warnings
        const state = this.brain.getState()
        if (state.contextPercent >= this.config.transplant.warnThreshold) {
          yield {
            type: 'transplant',
            timestamp: Date.now(),
            contextPercent: state.contextPercent,
            text: `Context at ${state.contextPercent}%`,
          }
        }
        yield { type: 'done', timestamp: Date.now() }
        return
      }

      // Add assistant + tool results, continue loop
      messages.push({ role: 'assistant', content: assistantContentBlocks as any })
      for (const tr of toolResults) {
        messages.push({ role: 'tool', content: tr.result, toolUseId: tr.id })
      }
    }
  }

  // --- Public getters for the REPL ---

  getBrainState() { return this.brain.getState() }
  getTotalCost() { return this.totalCostUsd }
  getCurrentModel() { return this.currentModel }
  getCurrentProvider() { return this.currentProvider }

  setModel(model: string): void {
    this.currentModel = model
    this.currentProvider = this.resolveProvider(model)
    this.brain.setModel(model)
  }

  // --- Internal ---

  private resolveProvider(model: string): Provider {
    if (model.startsWith('claude-') || model.includes('haiku') || model.includes('sonnet') || model.includes('opus')) {
      return 'anthropic'
    }
    if (model.startsWith('o3') || model.startsWith('o4') || model.startsWith('gpt-')) {
      return 'openai'
    }
    if (model.startsWith('gemini-')) {
      return 'google'
    }
    return 'anthropic'
  }

  private estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    // Pricing per 1M tokens
    const pricing: Record<string, { input: number; output: number }> = {
      'claude-opus-4-20250514': { input: 15.00, output: 75.00 },
      'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
      'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
      'o3': { input: 2.00, output: 8.00 },
      'o4-mini': { input: 0.55, output: 2.20 },
      'gpt-4.1': { input: 2.00, output: 8.00 },
      'gemini-2.5-pro': { input: 1.25, output: 10.00 },
      'gemini-2.5-flash': { input: 0.15, output: 0.60 },
    }
    const p = pricing[model] || { input: 3.00, output: 15.00 }
    return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output
  }

  shutdown(): void {
    this.apiClient.closeAll()
  }
}
