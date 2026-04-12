import readline from 'node:readline'
import path from 'node:path'
import { agentLoop } from '../agent/loop.js'
import { Brain } from '../brain/brain.js'
import { APIClient } from '../api/client.js'
import { AuthManager } from '../auth/manager.js'
import { Renderer } from './renderer.js'
import { handleCommand } from './commands.js'
import { askPermission } from '../tools/permissions.js'
import { ensureProxy } from '../proxy/proxy.js'
import { getVersion } from '../version.js'
import type { SqConfig } from '../config.js'

export async function startREPL(config: SqConfig): Promise<void> {
  const cwd = process.cwd()
  const projectName = path.basename(cwd)
  const renderer = new Renderer()

  // Init auth
  const auth = new AuthManager()
  const authStatus = await auth.init()

  // Check proxy
  const proxyStatus = await ensureProxy(config.proxy.port)

  // Welcome
  renderer.renderWelcome(getVersion(), authStatus, proxyStatus)

  // Init API client
  const apiClient = new APIClient(auth, config.proxy.port)

  // Init brain
  let currentModel = config.agent.default
  const brain = new Brain(currentModel)

  // Determine provider
  let currentProvider = apiClient.providerForModel(currentModel)

  // Check if we have auth for the default provider
  if (!authStatus[currentProvider]) {
    const available = auth.authenticated()
    if (available.length === 0) {
      console.error('\x1b[31mNo providers authenticated. Run: sq login\x1b[0m')
      process.exit(1)
    }
    // Fallback to first available
    currentProvider = available[0]
    const modelMap: Record<string, string> = {
      anthropic: 'claude-sonnet-4-20250514',
      openai: 'o3',
      google: 'gemini-2.5-pro',
    }
    currentModel = modelMap[currentProvider] || config.agent.default
    brain.setModel(currentModel)
    console.log(`  \x1b[33mDefault provider not available. Using ${currentProvider} (${currentModel})\x1b[0m\n`)
  }

  // REPL
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: renderer.renderStatus({
      project: projectName,
      branch: undefined,
      contextPercent: brain.getState().contextPercent,
      costUsd: 0,
      model: currentModel,
    }),
  })

  let totalCostUsd = 0

  const updatePrompt = () => {
    rl.setPrompt(renderer.renderStatus({
      project: projectName,
      contextPercent: brain.getState().contextPercent,
      costUsd: totalCostUsd,
      model: currentModel,
    }))
  }

  rl.prompt()

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) {
      rl.prompt()
      return
    }

    // Slash commands
    const cmdResult = handleCommand(input, {
      brain,
      model: currentModel,
      setModel: (m: string) => {
        currentModel = m
        currentProvider = apiClient.providerForModel(m)
        brain.setModel(m)
      },
    })

    if (cmdResult) {
      console.log(cmdResult.output)
      if (cmdResult.exit) {
        rl.close()
        apiClient.closeAll()
        process.exit(0)
      }
      updatePrompt()
      rl.prompt()
      return
    }

    // Model override with @model
    let prompt = input
    let model = currentModel
    let provider = currentProvider
    const atMatch = input.match(/^@(\S+)\s+(.+)$/s)
    if (atMatch) {
      const aliases: Record<string, string> = {
        opus: 'claude-opus-4-20250514',
        sonnet: 'claude-sonnet-4-20250514',
        haiku: 'claude-haiku-4-5-20251001',
        o3: 'o3',
        'o4-mini': 'o4-mini',
        'gpt-4.1': 'gpt-4.1',
        'gemini-pro': 'gemini-2.5-pro',
        'gemini-flash': 'gemini-2.5-flash',
      }
      model = aliases[atMatch[1]] || atMatch[1]
      provider = apiClient.providerForModel(model)
      prompt = atMatch[2]
    }

    // Run agent loop
    try {
      const loop = agentLoop(prompt, {
        provider,
        model,
        cwd,
        permissions: config.agent.permissions,
      }, {
        apiClient,
        askPermission: config.agent.permissions === 'yolo' ? undefined : askPermission,
      })

      for await (const event of loop) {
        renderer.renderEvent(event)

        if (event.usage) {
          brain.addUsage(event.usage.inputTokens, event.usage.outputTokens)
        }

        // Simple cost tracking (Anthropic pricing)
        if (event.type === 'cost' && event.usage) {
          const inputCost = (event.usage.inputTokens / 1_000_000) * 3.00
          const outputCost = (event.usage.outputTokens / 1_000_000) * 15.00
          totalCostUsd += inputCost + outputCost
        }

        // Context warning
        if (event.type === 'done') {
          const state = brain.getState()
          if (state.contextPercent >= config.transplant.warn_threshold) {
            console.log(`\n  \x1b[33m⚠ Context at ${state.contextPercent}% — transplant at ${config.transplant.auto_threshold}%\x1b[0m`)
          }
        }
      }
    } catch (err) {
      console.error(`\n  \x1b[31mError: ${err instanceof Error ? err.message : String(err)}\x1b[0m`)
    }

    console.log()
    updatePrompt()
    rl.prompt()
  })

  rl.on('close', () => {
    apiClient.closeAll()
    process.exit(0)
  })
}
