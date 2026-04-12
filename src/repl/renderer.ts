import type { AgentEvent } from '../api/types.js'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const BLUE = '\x1b[34m'

export class Renderer {
  private isStreaming = false

  renderEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'api_call_start':
        if (event.model) {
          process.stdout.write(`\n  ${DIM}[${event.model}]${RESET} `)
        }
        this.isStreaming = false
        break

      case 'text':
        if (event.text) {
          process.stdout.write(event.text)
          this.isStreaming = true
        }
        break

      case 'tool_start':
        if (this.isStreaming) process.stdout.write('\n')
        this.isStreaming = false
        if (event.tool) {
          const detail = this.toolDetail(event.tool.name, event.tool.input as Record<string, unknown>)
          process.stdout.write(`  ${CYAN}[${event.tool.name}]${RESET} ${detail}\n`)
        }
        break

      case 'tool_result':
        if (event.isError && event.tool) {
          process.stdout.write(`  ${RED}[${event.tool.name} ERROR]${RESET} ${event.tool.result?.slice(0, 200)}\n`)
        }
        break

      case 'cost':
        // Cost is shown in the prompt, not inline
        break

      case 'error':
        if (this.isStreaming) process.stdout.write('\n')
        this.isStreaming = false
        process.stdout.write(`  ${RED}${event.error}${RESET}\n`)
        break

      case 'done':
        if (this.isStreaming) process.stdout.write('\n')
        this.isStreaming = false
        break
    }
  }

  private toolDetail(name: string, input?: Record<string, unknown>): string {
    if (!input) return ''
    switch (name) {
      case 'Read': return DIM + (input.file_path as string || '') + RESET
      case 'Write': return DIM + (input.file_path as string || '') + RESET
      case 'Edit': return DIM + (input.file_path as string || '') + RESET
      case 'Bash': {
        const cmd = (input.command as string || '').slice(0, 80)
        return DIM + cmd + (cmd.length >= 80 ? '...' : '') + RESET
      }
      case 'Glob': return DIM + (input.pattern as string || '') + RESET
      case 'Grep': return DIM + (input.pattern as string || '') + RESET
      default: return ''
    }
  }

  renderStatus(info: {
    project?: string
    branch?: string
    contextPercent: number
    costUsd: number
    model: string
  }): string {
    const parts: string[] = []
    if (info.project) parts.push(info.project)
    if (info.branch) parts.push(`:${info.branch}`)
    parts.push(` ${info.contextPercent}%`)
    if (info.costUsd > 0) parts.push(` $${info.costUsd.toFixed(2)}`)

    const modelShort = this.shortModelName(info.model)
    return `${parts.join('')} ${modelShort}${BOLD}›${RESET} `
  }

  private shortModelName(model: string): string {
    if (model.includes('opus')) return 'opus'
    if (model.includes('sonnet')) return 'sonnet'
    if (model.includes('haiku')) return 'haiku'
    if (model.startsWith('o3')) return 'o3'
    if (model.startsWith('o4')) return 'o4-mini'
    if (model.startsWith('gpt-4')) return 'gpt-4.1'
    if (model.includes('gemini') && model.includes('pro')) return 'gemini-pro'
    if (model.includes('gemini') && model.includes('flash')) return 'gemini-flash'
    return model.slice(0, 12)
  }

  renderWelcome(version: string, auth: { anthropic: boolean; openai: boolean; google: boolean }): void {
    console.log()
    console.log(`${BOLD}◆ squeezr-code v${version}${RESET}`)
    console.log(`  Auth:    anthropic ${auth.anthropic ? GREEN + '✓' + RESET : RED + '✗' + RESET}  openai ${auth.openai ? GREEN + '✓' + RESET : RED + '✗' + RESET}  google ${auth.google ? GREEN + '✓' + RESET : RED + '✗' + RESET}`)
    console.log()
  }
}
