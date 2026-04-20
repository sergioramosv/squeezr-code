import fs from 'node:fs'
import path from 'node:path'
import { discoverMcpServers } from './discover.js'

const CSI   = '\x1b['
const RESET = '\x1b[0m'
const DIM   = '\x1b[2m'
const BOLD  = '\x1b[1m'
const CYAN  = '\x1b[36m'
const GREEN = '\x1b[32m'
const RED   = '\x1b[31m'
const GRAY  = '\x1b[90m'

/**
 * `sq mcp import [--all]` — importa MCPs declarados en config de Claude Code,
 * Claude Desktop o `.mcp.json` del proyecto al `sq.toml` local.
 *
 * Sin `--all`: picker interactivo multi-select.
 *   ↑↓ navegar, espacio toggle, a marcar todos, n ninguno, enter confirmar, esc cancelar.
 *
 * Con `--all`: importa todos sin preguntar.
 *
 * El sq.toml se actualiza añadiendo bloques `[mcp.<name>]` al final, sin
 * tocar el resto del fichero (no se reformatea, no se pierden comentarios).
 */
export async function runMcpImport(opts: { all?: boolean; cwd?: string }): Promise<void> {
  const cwd = opts.cwd || process.cwd()
  const tomlPath = path.join(cwd, 'sq.toml')

  const discovered = discoverMcpServers(cwd)
  if (discovered.length === 0) {
    process.stdout.write(`\n  ${DIM}No se han encontrado MCPs en Claude Code, Claude Desktop ni .mcp.json del proyecto.${RESET}\n\n`)
    return
  }

  // Filtra los que ya estén en sq.toml para no duplicar.
  const existing = readExistingMcpNames(tomlPath)
  const candidates = discovered.filter(d => !existing.has(d.name))
  if (candidates.length === 0) {
    process.stdout.write(`\n  ${GREEN}✓${RESET} Todos los MCPs descubiertos ya están en ${tomlPath}.\n\n`)
    return
  }

  let selected: Set<string>
  if (opts.all) {
    selected = new Set(candidates.map(c => c.name))
  } else {
    const picked = await pickMulti(candidates)
    if (picked === null) {
      process.stdout.write(`  ${DIM}cancelado${RESET}\n`)
      return
    }
    selected = picked
  }

  if (selected.size === 0) {
    process.stdout.write(`  ${DIM}no has seleccionado ninguno${RESET}\n`)
    return
  }

  const toAppend = candidates.filter(c => selected.has(c.name))
  appendToToml(tomlPath, toAppend)

  process.stdout.write(`\n  ${GREEN}✓${RESET} ${selected.size} MCP${selected.size === 1 ? '' : 's'} importado${selected.size === 1 ? '' : 's'} a ${CYAN}${tomlPath}${RESET}\n`)
  for (const c of toAppend) {
    process.stdout.write(`     ${DIM}${c.name}  →  ${c.source}${RESET}\n`)
  }
  process.stdout.write(`\n  ${DIM}Reabre sq para que los cargue. Verifica con${RESET} ${CYAN}/mcp${RESET}\n\n`)
}

interface DiscoveredItem {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  source: string
}

function pickMulti(items: DiscoveredItem[]): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(null)
      return
    }

    let idx = 0
    const sel = new Set<string>()

    const wasRaw = process.stdin.isRaw
    process.stdin.setRawMode(true)
    process.stdin.resume()
    let firstDraw = true

    const draw = () => {
      if (firstDraw) {
        process.stdout.write(`\r${CSI}K\n${CSI}s`)
        firstDraw = false
      } else {
        process.stdout.write(`${CSI}u${CSI}J`)
      }
      process.stdout.write(`${BOLD}  Importar MCPs a sq.toml${RESET}  ${DIM}↑↓ mover · espacio toggle · a todos · n ninguno · enter confirmar · esc cancelar${RESET}\n\n`)
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        const cursor = i === idx ? `${CYAN}❯${RESET}` : ' '
        const check  = sel.has(it.name) ? `${GREEN}[x]${RESET}` : `${GRAY}[ ]${RESET}`
        const name = it.name.padEnd(22)
        const source = `${DIM}${it.source}${RESET}`
        const cmd = `${DIM}${it.command} ${(it.args || []).join(' ').slice(0, 40)}${RESET}`
        const body = `${check}  ${name} ${source}\n         ${cmd}`
        const line = i === idx ? `${BOLD}${body}${RESET}` : body
        process.stdout.write(`  ${cursor}  ${line}\n\n`)
      }
      process.stdout.write(`${DIM}  ${sel.size} de ${items.length} seleccionados${RESET}\n`)
    }

    const cleanup = () => {
      process.stdin.off('data', onData)
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
      process.stdin.pause()
    }

    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf-8')
      if (s === '\x03') { cleanup(); process.stdout.write('\n'); resolve(null); return }
      if (s === '\x1b') { cleanup(); process.stdout.write('\n'); resolve(null); return }
      if (s === '\r' || s === '\n') { cleanup(); process.stdout.write('\n'); resolve(sel); return }
      if (s === '\x1b[A' || s === 'k') { idx = (idx - 1 + items.length) % items.length; draw(); return }
      if (s === '\x1b[B' || s === 'j') { idx = (idx + 1) % items.length; draw(); return }
      if (s === ' ') {
        const it = items[idx]
        if (sel.has(it.name)) sel.delete(it.name)
        else sel.add(it.name)
        draw()
        return
      }
      if (s === 'a') { for (const it of items) sel.add(it.name); draw(); return }
      if (s === 'n') { sel.clear(); draw(); return }
    }

    process.stdin.on('data', onData)
    draw()
  })
}

function readExistingMcpNames(tomlPath: string): Set<string> {
  if (!fs.existsSync(tomlPath)) return new Set()
  try {
    const text = fs.readFileSync(tomlPath, 'utf-8')
    const names = new Set<string>()
    for (const m of text.matchAll(/^\s*\[mcp\.([^\]]+)\]/gm)) {
      names.add(m[1].trim())
    }
    return names
  } catch {
    return new Set()
  }
}

function appendToToml(tomlPath: string, items: DiscoveredItem[]): void {
  const exists = fs.existsSync(tomlPath)
  let text = exists ? fs.readFileSync(tomlPath, 'utf-8') : ''
  // Asegura un trailing newline antes de añadir.
  if (text.length > 0 && !text.endsWith('\n')) text += '\n'
  if (text.length > 0) text += '\n'
  text += `# Importado con \`sq mcp import\` el ${new Date().toISOString().slice(0, 10)}\n`
  for (const it of items) {
    text += `\n[mcp.${tomlKeyEscape(it.name)}]\n`
    text += `command = ${jsonString(it.command)}\n`
    if (it.args && it.args.length > 0) {
      text += `args = [${it.args.map(jsonString).join(', ')}]\n`
    }
    if (it.env && Object.keys(it.env).length > 0) {
      text += `env = { ${Object.entries(it.env).map(([k, v]) => `${tomlKeyEscape(k)} = ${jsonString(v)}`).join(', ')} }\n`
    }
  }
  fs.writeFileSync(tomlPath, text)
}

function tomlKeyEscape(key: string): string {
  // Si el key tiene chars problemáticos, lo metemos entre comillas.
  return /^[a-zA-Z0-9_-]+$/.test(key) ? key : jsonString(key)
}

function jsonString(s: string): string {
  // TOML basic strings = JSON strings (escape \, ", controles).
  return JSON.stringify(s)
}
