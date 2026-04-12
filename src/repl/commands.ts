import type { Brain } from '../brain/brain.js'

export interface CommandContext {
  brain: Brain
  model: string
  setModel: (model: string) => void
}

export interface CommandResult {
  output: string
  exit?: boolean
}

type CommandHandler = (args: string, ctx: CommandContext) => CommandResult

const commands: Record<string, CommandHandler> = {
  help: () => ({
    output: `Available commands:
  /model <name>       Change model (e.g. /model opus, /model o3, /model gemini-2.5-pro)
  /status             Show context %, model, cost
  /checkpoint [name]  Save checkpoint (coming soon)
  /restore [id]       Restore checkpoint (coming soon)
  /help               Show this help
  /exit               Exit sq`,
  }),

  exit: () => ({ output: 'Goodbye!', exit: true }),
  quit: () => ({ output: 'Goodbye!', exit: true }),

  model: (args, ctx) => {
    const name = args.trim()
    if (!name) return { output: `Current model: ${ctx.model}` }

    const aliases: Record<string, string> = {
      'opus': 'claude-opus-4-20250514',
      'sonnet': 'claude-sonnet-4-20250514',
      'haiku': 'claude-haiku-4-5-20251001',
      'o3': 'o3',
      'o4-mini': 'o4-mini',
      'o4': 'o4-mini',
      'gpt-4.1': 'gpt-4.1',
      'gemini-pro': 'gemini-2.5-pro',
      'gemini-flash': 'gemini-2.5-flash',
      'gemini-2.5-pro': 'gemini-2.5-pro',
      'gemini-2.5-flash': 'gemini-2.5-flash',
    }

    const resolved = aliases[name] || name
    ctx.setModel(resolved)
    return { output: `Model set to: ${resolved}` }
  },

  status: (_args, ctx) => {
    const state = ctx.brain.getState()
    return {
      output: `  Model:    ${state.model}
  Context:  ${state.contextPercent}% (${state.totalInputTokens + state.totalOutputTokens} tokens)
  Turns:    ${state.turnCount}`,
    }
  },

  checkpoint: () => ({ output: 'Checkpoints coming in Phase 2' }),
  restore: () => ({ output: 'Restore coming in Phase 2' }),
}

export function handleCommand(input: string, ctx: CommandContext): CommandResult | null {
  if (!input.startsWith('/')) return null
  const [cmd, ...rest] = input.slice(1).split(' ')
  const handler = commands[cmd]
  if (!handler) return { output: `Unknown command: /${cmd}. Type /help for available commands.` }
  return handler(rest.join(' '), ctx)
}
