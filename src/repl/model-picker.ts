import type { AuthStatus } from '../auth/manager.js'
import { getLoadedModels, resolveFamilyShortcut, type ModelInfo } from '../api/models.js'

/**
 * Picker interactivo + helpers de resolución de alias.
 *
 * La lista de modelos YA NO es una constante: se carga dinámicamente contra
 * /v1/models de cada provider (ver src/api/models.ts).  El picker simplemente
 * dibuja lo que hay cargado en el registro.
 */

// ─── Resolución de alias ────────────────────────────────────────────
//
// El usuario puede escribir:
//   /model opus               → el último Opus disponible  (resolveFamilyShortcut)
//   /model opus-4.7           → exactamente ese alias
//   /model claude-opus-4-7    → el id completo
//   @sonnet explica esto      → mismo patrón
export function resolveModelAlias(input: string): string {
  const models = getLoadedModels()
  // id exacto
  const byId = models.find(m => m.id === input)
  if (byId) return byId.id
  // alias derivado (opus-4.7, sonnet-4.6, 5.4-mini, 5-codex, …)
  const byAlias = models.find(m => m.alias === input)
  if (byAlias) return byAlias.id
  // familia (opus → último opus)
  const family = resolveFamilyShortcut(input, models)
  if (family) return family
  // Fallback sin catálogo cargado: aliases que empiezan por dígito son Codex.
  //   "5.4-mini"  →  "gpt-5.4-mini"
  //   "5-codex"   →  "gpt-5-codex"
  if (/^\d/.test(input)) return `gpt-${input}`
  return input
}

/** Devuelve la lista de keys aceptadas por el completer (TAB). */
export function getAliasKeys(): string[] {
  const models = getLoadedModels()
  const set = new Set<string>()
  for (const m of models) {
    set.add(m.alias)
    set.add(m.id)
  }
  // Atajos de familia si hay Anthropic cargado.
  if (models.some(m => m.provider === 'anthropic')) {
    set.add('opus')
    set.add('sonnet')
    set.add('haiku')
  }
  // Atajos de familia Google.
  if (models.some(m => m.provider === 'google')) {
    set.add('pro')
    set.add('flash')
  }
  return Array.from(set).sort()
}

// ─── Picker ─────────────────────────────────────────────────────────
const CSI   = '\x1b['
const RESET = '\x1b[0m'
const DIM   = '\x1b[2m'
const BOLD  = '\x1b[1m'
const CYAN  = '\x1b[36m'
const GREEN = '\x1b[32m'
const GRAY  = '\x1b[90m'

export async function pickModel(current: string, auth: AuthStatus): Promise<string | null> {
  if (!process.stdin.isTTY) return null

  const loaded = getLoadedModels()
  if (loaded.length === 0) {
    process.stdout.write(`${GRAY}  Model list not loaded yet. Try again in a moment.${RESET}\n`)
    return null
  }

  const items = loaded.map(m => ({
    ...m,
    available: m.implemented && Boolean(auth[m.provider]),
  }))

  let idx = items.findIndex(m => m.id === current && m.available)
  if (idx < 0) idx = items.findIndex(m => m.available)
  if (idx < 0) {
    process.stdout.write(`${GRAY}  No models available (no provider authenticated).${RESET}\n`)
    return null
  }

  return new Promise((resolve) => {
    // Evitamos compartir canal con readline.
    //
    // `readline` también está escuchando `'keypress'` y `'data'` en `process.stdin`,
    // así que si usáramos `emitKeypressEvents` o `on('keypress')` aquí, cada flecha
    // ↑↓ que pulsas en el picker TAMBIÉN la procesaría readline internamente (para
    // su historia y edición de línea), y el Enter final podría emitir un 'line'
    // stale con algo del histórico → reabre el picker con default y revierte tu
    // selección antes de que envíes el siguiente prompt.
    //
    // Así que: quitamos temporalmente los listeners de readline de stdin, ponemos
    // el nuestro leyendo bytes crudos en raw mode, y al salir los restauramos
    // intactos. Readline ni se entera de que existió un picker.
    const wasRaw = process.stdin.isRaw
    const savedKeypress = process.stdin.listeners('keypress').slice()
    const savedData     = process.stdin.listeners('data').slice()
    for (const l of savedKeypress) process.stdin.removeListener('keypress', l as (...args: unknown[]) => void)
    for (const l of savedData)     process.stdin.removeListener('data',     l as (...args: unknown[]) => void)

    process.stdin.setRawMode(true)
    process.stdin.resume()

    // Tracker manual de líneas escritas en el último draw.
    // Más robusto que `\x1b[s`/`\x1b[u` (save/restore cursor), que falla en
    // algunos terminales o cuando hay scroll/output entre frames.
    let linesWritten = 0

    const draw = () => {
      // Borra el draw anterior subiendo linesWritten líneas y limpiando.
      if (linesWritten > 0) {
        process.stdout.write(`\r\x1b[${linesWritten}A\x1b[J`)
      }
      const lines: string[] = []
      lines.push(`${BOLD}  Choose model${RESET}  ${DIM}↑↓ move · enter select · esc cancel${RESET}`)
      lines.push('')

      let lastProvider = ''
      for (let i = 0; i < items.length; i++) {
        const m = items[i]
        const providerChanged = m.provider !== lastProvider
        lastProvider = m.provider

        const cursor      = i === idx ? `${CYAN}❯${RESET}` : ' '
        const currentMark = m.id === current ? `${GREEN}●${RESET}` : ' '
        const alias       = m.alias.padEnd(14)
        const label       = m.label.padEnd(22)
        const providerTag = providerChanged
          ? `${DIM}[${m.provider}]${RESET}`
          : `${DIM}${'         '}${RESET}`
        const tail = m.available ? providerTag : `${DIM}[no auth / not implemented]${RESET}`
        const body = `${alias} ${label} ${tail}`
        const line = m.available
          ? (i === idx ? `${BOLD}${body}${RESET}` : body)
          : `${DIM}${body}${RESET}`

        lines.push(`  ${cursor} ${currentMark}  ${line}`)
      }
      lines.push('')
      lines.push(`${DIM}  current: ${current}${RESET}`)

      process.stdout.write(lines.join('\n') + '\n')
      linesWritten = lines.length
    }

    const cleanup = () => {
      process.stdin.off('data', onData)
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
      // Restaura los listeners originales de readline (y de quien sea).
      for (const l of savedKeypress) process.stdin.on('keypress', l as (...args: unknown[]) => void)
      for (const l of savedData)     process.stdin.on('data',     l as (...args: unknown[]) => void)
    }

    const moveBy = (delta: number) => {
      let next = idx
      for (let step = 0; step < items.length; step++) {
        next = (next + delta + items.length) % items.length
        if (items[next].available) { idx = next; return }
      }
    }

    // Parser de bytes crudos. Soporta secuencias ANSI de flechas, Enter, Esc, Ctrl-C.
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf-8')
      // Ctrl-C
      if (s === '\x03') { cleanup(); process.stdout.write('\n'); resolve(null); return }
      // Enter (CR o LF)
      if (s === '\r' || s === '\n') {
        cleanup()
        process.stdout.write('\n')
        resolve(items[idx].id)
        return
      }
      // Esc (solo, sin secuencia siguiente)
      if (s === '\x1b') {
        cleanup(); process.stdout.write('\n'); resolve(null); return
      }
      // Flechas: \x1b[A (up), \x1b[B (down)
      if (s === '\x1b[A') { moveBy(-1); draw(); return }
      if (s === '\x1b[B') { moveBy(+1); draw(); return }
      // Atajos vim-style
      if (s === 'k') { moveBy(-1); draw(); return }
      if (s === 'j') { moveBy(+1); draw(); return }
      // cualquier otro byte — lo ignoramos
    }

    process.stdin.on('data', onData)
    draw()
  })
}
