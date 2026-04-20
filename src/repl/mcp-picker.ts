import type { McpManager } from '../mcp/manager.js'

/**
 * Picker interactivo para gestionar MCP servers (`/mcp` desde el REPL).
 *
 *   ↑↓        navegar
 *   enter     toggle (connect ↔ disconnect)
 *   r         restart (stop + start del seleccionado)
 *   esc/q     salir
 *
 * Mismo patrón de raw-mode-y-arrancar-listeners-de-readline que el model-picker
 * para evitar el bug de doble echo / interferencia con readline.
 */

const CSI   = '\x1b['
const RESET = '\x1b[0m'
const DIM   = '\x1b[2m'
const BOLD  = '\x1b[1m'
const CYAN  = '\x1b[36m'
const GREEN = '\x1b[32m'
const RED   = '\x1b[31m'
const YELLOW = '\x1b[33m'
const GRAY  = '\x1b[90m'

export async function pickMcp(mcp: McpManager): Promise<void> {
  if (!process.stdin.isTTY) return

  // Snapshot inicial — refrescamos en cada redibujo, así si algo cambia se ve.
  let items = mcp.list()
  if (items.length === 0) {
    process.stdout.write(`${GRAY}  No MCP servers declared. Add them in sq.toml [mcp.<name>].${RESET}\n`)
    return
  }

  let idx = 0
  let busy: string | null = null

  return new Promise<void>((resolve) => {
    const wasRaw = process.stdin.isRaw
    const savedKeypress = process.stdin.listeners('keypress').slice()
    const savedData     = process.stdin.listeners('data').slice()
    for (const l of savedKeypress) process.stdin.removeListener('keypress', l as (...args: unknown[]) => void)
    for (const l of savedData)     process.stdin.removeListener('data',     l as (...args: unknown[]) => void)

    process.stdin.setRawMode(true)
    process.stdin.resume()

    // Tracker manual de líneas (más robusto que save/restore cursor).
    let linesWritten = 0

    const draw = () => {
      items = mcp.list()
      if (linesWritten > 0) {
        process.stdout.write(`\r\x1b[${linesWritten}A\x1b[J`)
      }
      const lines: string[] = []
      lines.push(`${BOLD}  MCP servers${RESET}  ${DIM}↑↓ move · enter connect/disconnect · r restart · esc exit${RESET}`)
      lines.push('')

      for (let i = 0; i < items.length; i++) {
        const m = items[i]
        const cursor = i === idx ? `${CYAN}❯${RESET}` : ' '
        const dot =
          m.status === 'connected'   ? `${GREEN}●${RESET}` :
          m.status === 'connecting'  ? `${YELLOW}⋯${RESET}` :
          m.status === 'error'       ? `${RED}✗${RESET}`  :
                                       `${GRAY}○${RESET}`
        const name = m.name.padEnd(18)
        const status =
          m.status === 'connected'   ? `${GREEN}connected${RESET}  ${DIM}${m.toolCount} tools${RESET}` :
          m.status === 'connecting'  ? `${YELLOW}connecting…${RESET}` :
          m.status === 'error'       ? `${RED}error${RESET}      ${DIM}${(m.lastError || '').slice(0, 40)}${RESET}` :
                                       `${GRAY}disconnected${RESET}`
        const cmd = `${DIM}${m.command} ${m.args.join(' ').slice(0, 40)}${m.args.join(' ').length > 40 ? '…' : ''}${RESET}`
        const isBusy = busy === m.name
        const tag = isBusy ? `  ${YELLOW}…${RESET}` : ''
        lines.push(`  ${cursor}  ${dot}  ${name} ${status}${tag}`)
        lines.push(`     ${cmd}`)
        lines.push('')
      }

      lines.push(`${DIM}  ${items.filter(i => i.status === 'connected').length} of ${items.length} connected${RESET}`)

      process.stdout.write(lines.join('\n') + '\n')
      linesWritten = lines.length
    }

    const cleanup = () => {
      process.stdin.off('data', onData)
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
      for (const l of savedKeypress) process.stdin.on('keypress', l as (...args: unknown[]) => void)
      for (const l of savedData)     process.stdin.on('data',     l as (...args: unknown[]) => void)
    }

    const finish = () => {
      cleanup()
      process.stdout.write('\n')
      resolve()
    }

    const moveBy = (delta: number) => {
      idx = (idx + delta + items.length) % items.length
      draw()
    }

    const toggle = async () => {
      const m = items[idx]
      if (!m) return
      busy = m.name
      draw()
      try {
        if (m.status === 'connected') {
          mcp.disconnect(m.name)
        } else {
          await mcp.connect(m.name)
        }
      } finally {
        busy = null
        draw()
      }
    }

    const restart = async () => {
      const m = items[idx]
      if (!m) return
      busy = m.name
      draw()
      try {
        await mcp.restart(m.name)
      } finally {
        busy = null
        draw()
      }
    }

    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf-8')
      if (s === '\x03' || s === '\x1b' || s === 'q') { finish(); return }
      if (s === '\r' || s === '\n') { void toggle(); return }
      if (s === '\x1b[A' || s === 'k') { moveBy(-1); return }
      if (s === '\x1b[B' || s === 'j') { moveBy(+1); return }
      if (s === 'r') { void restart(); return }
    }

    process.stdin.on('data', onData)
    draw()
  })
}
