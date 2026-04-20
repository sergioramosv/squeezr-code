import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AuthManager, type AuthStatus } from '../auth/manager.js'
import type { Provider } from '../errors.js'

/**
 * First-run wizard. Se ejecuta la primera vez que `sq` arranca (cuando
 * `~/.squeezr-code/config.toml` no existe). Lleva al usuario por:
 *
 *   1. Detección de providers autenticados (y opción de login si falta)
 *   2. Elección del modelo default
 *   3. Elección del modo de permisos (default / accept-edits / plan / bypass)
 *
 * Guarda el resultado en `~/.squeezr-code/config.toml` para que no vuelva
 * a aparecer en siguientes arranques.
 */

const CSI = '\x1b['
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const MAGENTA = '\x1b[35m'
const RED = '\x1b[31m'
const GRAY = '\x1b[90m'

const CONFIG_PATH = path.join(os.homedir(), '.squeezr-code', 'config.toml')

export function isFirstRun(): boolean {
  return !fs.existsSync(CONFIG_PATH)
}

export async function runOnboarding(auth: AuthManager): Promise<void> {
  printWelcome()

  const authStatus = await auth.init()
  const hasAny = authStatus.anthropic || authStatus.openai || authStatus.google

  if (!hasAny) {
    process.stdout.write(`\n  ${YELLOW}⚠${RESET} ${BOLD}No provider is authenticated.${RESET}\n\n`)
    process.stdout.write(`  ${DIM}You have three options:${RESET}\n`)
    process.stdout.write(`    ${CYAN}1.${RESET} ${BOLD}sq login anthropic${RESET}  ${DIM}(Claude Pro/Max)${RESET}\n`)
    process.stdout.write(`    ${CYAN}2.${RESET} ${BOLD}sq login openai${RESET}     ${DIM}(ChatGPT Plus/Pro)${RESET}\n`)
    process.stdout.write(`    ${CYAN}3.${RESET} ${BOLD}sq login google${RESET}     ${DIM}(Gemini Pro/Ultra)${RESET}\n\n`)
    process.stdout.write(`  ${DIM}Run one of the commands, then launch${RESET} ${BOLD}sq${RESET}${DIM} again.${RESET}\n\n`)
    process.exit(1)
  }

  const authed: Provider[] = []
  if (authStatus.anthropic) authed.push('anthropic')
  if (authStatus.openai) authed.push('openai')
  if (authStatus.google) authed.push('google')

  process.stdout.write(`\n  ${GREEN}✓${RESET} ${BOLD}Providers detected:${RESET} ${authed.join(', ')}\n\n`)

  const defaultModel = await pickModel(authed)
  const mode = await pickMode()

  await saveConfig({ model: defaultModel, mode })

  process.stdout.write(`\n  ${GREEN}✓${RESET} Configuration saved to ${CYAN}${CONFIG_PATH}${RESET}\n`)
  process.stdout.write(`  ${DIM}Edit that file later if you want to change more options.${RESET}\n\n`)
  process.stdout.write(`  ${BOLD}All set.${RESET} ${DIM}Starting REPL...${RESET}\n\n`)
}

function printWelcome(): void {
  const B1 = '\x1b[38;5;22m'  // verde oscuro
  const B3 = '\x1b[38;5;34m'  // verde medio
  const B5 = '\x1b[38;5;46m'  // verde brillante
  process.stdout.write('\n')
  process.stdout.write(`${B1}  ╭────────────────────────────────────────────╮${RESET}\n`)
  process.stdout.write(`${B3}  │${RESET} ${BOLD}Welcome to${RESET} ${B5}squeezr-code${RESET}${B3}                   │${RESET}\n`)
  process.stdout.write(`${B3}  │${RESET} ${DIM}Let's set it up in 30 seconds.             ${RESET}${B3}│${RESET}\n`)
  process.stdout.write(`${B1}  ╰────────────────────────────────────────────╯${RESET}\n`)
}

async function pickModel(authed: Provider[]): Promise<string> {
  const options: Array<{ id: string; label: string; desc: string }> = []
  if (authed.includes('anthropic')) {
    options.push({ id: 'sonnet', label: 'sonnet', desc: 'Claude Sonnet — price/quality balance (recommended)' })
    options.push({ id: 'opus', label: 'opus', desc: 'Claude Opus — maximum quality for complex tasks' })
    options.push({ id: 'haiku', label: 'haiku', desc: 'Claude Haiku — fast and cheap' })
  }
  if (authed.includes('openai')) {
    options.push({ id: '5.4-mini', label: '5.4-mini', desc: 'ChatGPT 5.4 mini — fast' })
    options.push({ id: '5.4', label: '5.4', desc: 'ChatGPT 5.4 — good quality' })
    options.push({ id: '5.3-codex', label: '5.3-codex', desc: 'Codex 5.3 — specialized for code' })
  }
  if (authed.includes('google')) {
    options.push({ id: 'pro', label: 'pro', desc: 'Gemini 3.1 Pro — huge context (1M)' })
    options.push({ id: 'flash', label: 'flash', desc: 'Gemini 3 Flash — fast and cheap' })
  }

  return picker('Which model do you use by default?', options)
}

async function pickMode(): Promise<string> {
  const options = [
    { id: 'default', label: 'default', desc: 'ask before Bash/Write/Edit (safer)' },
    { id: 'accept-edits', label: 'accept-edits', desc: 'auto-approve edits, ask for Bash' },
    { id: 'plan', label: 'plan', desc: 'read-only — the agent investigates but changes nothing' },
    { id: 'bypass', label: 'bypass', desc: 'approve everything without asking (dangerous)' },
  ]
  return picker('Default permission mode? (can be changed with Shift+Tab)', options)
}

function picker(question: string, options: Array<{ id: string; label: string; desc: string }>): Promise<string> {
  return new Promise((resolve) => {
    let idx = 0
    let linesWritten = 0
    const wasRaw = process.stdin.isRaw
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdout.write('\x1b[?25l')

    const draw = () => {
      if (linesWritten > 0) process.stdout.write(`\r${CSI}${linesWritten}A${CSI}J`)
      const lines: string[] = []
      lines.push(`  ${BOLD}${question}${RESET}`)
      lines.push(`  ${DIM}↑↓ mover · enter seleccionar${RESET}`)
      lines.push('')
      for (let i = 0; i < options.length; i++) {
        const o = options[i]
        const cursor = i === idx ? `${CYAN}❯${RESET}` : ' '
        const label = i === idx ? `${BOLD}${o.label}${RESET}` : o.label
        lines.push(`  ${cursor}  ${label.padEnd(30)} ${DIM}${o.desc}${RESET}`)
      }
      process.stdout.write(lines.join('\n') + '\n')
      linesWritten = lines.length
    }

    const cleanup = () => {
      process.stdin.off('data', onData)
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
      process.stdout.write('\x1b[?25h')
    }

    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf-8')
      if (s === '\x03') { cleanup(); process.exit(0); return }
      if (s === '\r' || s === '\n') {
        cleanup()
        process.stdout.write(`\n  ${GREEN}✓${RESET} ${options[idx].label}\n`)
        resolve(options[idx].id)
        return
      }
      if (s === '\x1b[A' || s === 'k') { idx = (idx - 1 + options.length) % options.length; draw(); return }
      if (s === '\x1b[B' || s === 'j') { idx = (idx + 1) % options.length; draw(); return }
    }

    process.stdin.on('data', onData)
    draw()
  })
}

async function saveConfig(opts: { model: string; mode: string }): Promise<void> {
  const dir = path.dirname(CONFIG_PATH)
  fs.mkdirSync(dir, { recursive: true })
  const toml = `# squeezr-code — configuración user-level
# Generado por el wizard el ${new Date().toISOString().slice(0, 10)}.
# Edita este fichero para ajustar más opciones, o usa Shift+Tab en sq
# para cambiar el modo en runtime.

[agent]
default = "${opts.model}"
permissions = "${opts.mode}"

[display]
theme = "dark"
recaps = true

# [mcp.example]
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
`
  fs.writeFileSync(CONFIG_PATH, toml)
}
