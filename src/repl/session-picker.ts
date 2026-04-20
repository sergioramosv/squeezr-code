import path from 'node:path'
import os from 'node:os'
import { Session } from '../state/session.js'

/**
 * Picker interactivo de sesiones (↑↓ + enter). Lista las sesiones del disco
 * ordenadas por updatedAt desc y devuelve el id de la elegida, o null si se
 * cancela.
 *
 * Mismo patrón que model-picker: salva/restaura los listeners de stdin para
 * no pelearse con readline mientras estamos en raw mode.
 */

const RESET = '\x1b[0m'
const DIM   = '\x1b[2m'
const BOLD  = '\x1b[1m'
const CYAN  = '\x1b[36m'
const GRAY  = '\x1b[90m'
const GREEN = '\x1b[32m'
const MAGENTA = '\x1b[35m'

function formatAgo(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${Math.round(sec / 3600)}h`
  return `${Math.round(sec / 86400)}d`
}

function shortCwd(cwd: string): string {
  const home = os.homedir()
  if (cwd.startsWith(home)) return '~' + cwd.slice(home.length).replace(/\\/g, '/')
  return cwd.replace(/\\/g, '/')
}

export async function pickSession(): Promise<string | null> {
  if (!process.stdin.isTTY) return null

  const sessions = Session.list()
  if (sessions.length === 0) {
    process.stdout.write(`${GRAY}  No saved sessions yet.${RESET}\n`)
    return null
  }

  let idx = 0

  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw
    const savedKeypress = process.stdin.listeners('keypress').slice()
    const savedData     = process.stdin.listeners('data').slice()
    for (const l of savedKeypress) process.stdin.removeListener('keypress', l as (...args: unknown[]) => void)
    for (const l of savedData)     process.stdin.removeListener('data',     l as (...args: unknown[]) => void)

    process.stdin.setRawMode(true)
    process.stdin.resume()

    let linesWritten = 0

    const draw = () => {
      if (linesWritten > 0) {
        process.stdout.write(`\r\x1b[${linesWritten}A\x1b[J`)
      }
      const lines: string[] = []
      lines.push(`${BOLD}  Choose session${RESET}  ${DIM}↑↓ move · enter resume · esc cancel${RESET}`)
      lines.push('')

      // Límite visible para no llenar la pantalla.
      const VISIBLE = Math.min(sessions.length, 15)
      const offset = Math.max(0, Math.min(sessions.length - VISIBLE, idx - Math.floor(VISIBLE / 2)))
      for (let i = offset; i < offset + VISIBLE; i++) {
        const s = sessions[i]
        const active = i === idx
        const cursor = active ? `${CYAN}❯${RESET}` : ' '
        const when = formatAgo(s.updatedAt).padStart(4)
        const model = s.model.split('-').slice(-2).join('-')
        const turns = `${s.turnCount} msg`.padStart(6)
        const body = `${DIM}${when}${RESET}  ${MAGENTA}${model.padEnd(16)}${RESET} ${DIM}${turns}${RESET}  ${shortCwd(s.cwd)}`
        const line = active ? `${BOLD}${body}${RESET}` : body
        lines.push(`  ${cursor}  ${line}`)
      }
      if (sessions.length > VISIBLE) {
        lines.push(`${DIM}  (${sessions.length - VISIBLE} more — scroll with ↑↓)${RESET}`)
      }
      lines.push('')
      lines.push(`${DIM}  id: ${GREEN}${sessions[idx].id}${RESET}`)

      process.stdout.write(lines.join('\n') + '\n')
      linesWritten = lines.length
    }

    const cleanup = () => {
      process.stdin.off('data', onData)
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
      for (const l of savedKeypress) process.stdin.on('keypress', l as (...args: unknown[]) => void)
      for (const l of savedData)     process.stdin.on('data',     l as (...args: unknown[]) => void)
    }

    const move = (delta: number) => {
      idx = (idx + delta + sessions.length) % sessions.length
    }

    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf-8')
      if (s === '\x03') { cleanup(); process.stdout.write('\n'); resolve(null); return }
      if (s === '\r' || s === '\n') {
        cleanup()
        process.stdout.write('\n')
        resolve(sessions[idx].id)
        return
      }
      if (s === '\x1b') { cleanup(); process.stdout.write('\n'); resolve(null); return }
      if (s === '\x1b[A' || s === 'k') { move(-1); draw(); return }
      if (s === '\x1b[B' || s === 'j') { move(+1); draw(); return }
    }

    process.stdin.on('data', onData)
    draw()
  })
}
