import readline from 'node:readline'
import path from 'node:path'
import { SqProxy } from '../proxy/core.js'
import { AuthManager } from '../auth/manager.js'
import { Renderer } from './renderer.js'
import { handleCommand } from './commands.js'
import { askPermission } from '../tools/permissions.js'
import { getVersion } from '../version.js'
import type { SqConfig } from '../config.js'

export async function startREPL(config: SqConfig): Promise<void> {
  const cwd = process.cwd()
  const projectName = path.basename(cwd)
  const renderer = new Renderer()

  // Init auth
  const auth = new AuthManager()
  const authStatus = await auth.init()

  // Init the internal proxy (the brain of sq)
  const proxy = new SqProxy(auth, {
    defaultModel: config.agent.default,
    permissions: config.agent.permissions,
    transplant: {
      warnThreshold: config.transplant.warn_threshold,
      autoThreshold: config.transplant.auto_threshold,
    },
  })

  // Welcome
  renderer.renderWelcome(getVersion(), authStatus)

  // Check if we have auth for the default provider
  const defaultProvider = proxy.getCurrentProvider()
  if (!authStatus[defaultProvider]) {
    const available = auth.authenticated()
    if (available.length === 0) {
      console.error('\x1b[31mNo providers authenticated. Run: sq login\x1b[0m')
      process.exit(1)
    }
    const modelMap: Record<string, string> = {
      anthropic: 'claude-sonnet-4-20250514',
      openai: 'o3',
      google: 'gemini-2.5-pro',
    }
    proxy.setModel(modelMap[available[0]] || config.agent.default)
    console.log(`  \x1b[33mDefault provider not available. Using ${available[0]} (${proxy.getCurrentModel()})\x1b[0m\n`)
  }

  // REPL
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: renderer.renderStatus({
      project: projectName,
      contextPercent: 0,
      costUsd: 0,
      model: proxy.getCurrentModel(),
    }),
  })

  const updatePrompt = () => {
    rl.setPrompt(renderer.renderStatus({
      project: projectName,
      contextPercent: proxy.getBrainState().contextPercent,
      costUsd: proxy.getTotalCost(),
      model: proxy.getCurrentModel(),
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
      brain: { getState: () => proxy.getBrainState() } as any,
      model: proxy.getCurrentModel(),
      setModel: (m: string) => proxy.setModel(m),
    })

    if (cmdResult) {
      console.log(cmdResult.output)
      if (cmdResult.exit) {
        rl.close()
        proxy.shutdown()
        process.exit(0)
      }
      updatePrompt()
      rl.prompt()
      return
    }

    // Model override with @model
    let prompt = input
    let overrideModel: string | undefined
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
      overrideModel = aliases[atMatch[1]] || atMatch[1]
      prompt = atMatch[2]
    }

    // Send through the proxy
    try {
      const events = proxy.send(prompt, {
        model: overrideModel,
        cwd,
        askPermission: config.agent.permissions === 'yolo' ? undefined : askPermission,
      })

      for await (const event of events) {
        renderer.renderEvent(event)
      }
    } catch (err) {
      console.error(`\n  \x1b[31mError: ${err instanceof Error ? err.message : String(err)}\x1b[0m`)
    }

    console.log()
    updatePrompt()
    rl.prompt()
  })

  rl.on('close', () => {
    proxy.shutdown()
    process.exit(0)
  })
}
