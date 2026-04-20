import readline from 'node:readline'

/**
 * Picker de permisos estilo Claude Code. Cuando una tool peligrosa está a
 * punto de ejecutarse en modo `default`, se muestra este picker con opciones
 * más ricas que el `(y)es / (n)o / (a)lways` clásico:
 *
 *   ? Allow Edit to src/foo.ts?
 *     ❯ Yes
 *       Yes, and don't ask again for Edit in this session
 *       Yes, and don't ask again for Edit of src/** (this session)
 *       No, and tell the model what to do instead
 *
 * Devuelve un objeto con la decisión + opcionalmente instrucciones al modelo.
 */

const CSI   = '\x1b['
const RESET = '\x1b[0m'
const DIM   = '\x1b[2m'
const BOLD  = '\x1b[1m'
const CYAN  = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED   = '\x1b[31m'
const GRAY  = '\x1b[90m'

export type PermissionDecision =
  | { approved: true; remember: 'once' | 'tool-session' | 'pattern-session'; pattern?: string }
  | { approved: false; explanation: string }

interface Option {
  id: 'yes-once' | 'yes-tool' | 'yes-pattern' | 'no-explain'
  label: string
  hint?: string
}

export async function pickPermission(opts: {
  toolName: string
  detail: string
  preview: string
  patternSuggestion?: string | null
}): Promise<PermissionDecision> {
  if (!process.stdin.isTTY) {
    // Sin TTY (pipes, CI) → deny por defecto para no ejecutar sin autorización.
    return { approved: false, explanation: 'No TTY available (non-interactive mode), denying tool.' }
  }

  const options: Option[] = [
    { id: 'yes-once', label: 'Yes', hint: 'allow just this call' },
    { id: 'yes-tool', label: `Yes, and don't ask again for ${opts.toolName} this session`, hint: 'until sq closes' },
  ]
  if (opts.patternSuggestion) {
    options.push({
      id: 'yes-pattern',
      label: `Yes, and don't ask again for ${opts.toolName} matching ${opts.patternSuggestion}`,
      hint: 'pattern match only',
    })
  }
  options.push({ id: 'no-explain', label: 'No, and tell the model what to do instead', hint: 'denies + user message' })

  let idx = 0
  let linesWritten = 0

  // Pintar el preview del diff una vez (NO se redibuja en cada flecha)
  if (opts.preview) {
    process.stderr.write(`\n${opts.preview}\n`)
  }

  const result = await new Promise<'yes-once' | 'yes-tool' | 'yes-pattern' | 'no-explain' | null>((resolve) => {
    const wasRaw = process.stdin.isRaw
    const savedData = process.stdin.listeners('data').slice()
    const savedKeypress = process.stdin.listeners('keypress').slice()
    for (const l of savedData) process.stdin.removeListener('data', l as (...args: unknown[]) => void)
    for (const l of savedKeypress) process.stdin.removeListener('keypress', l as (...args: unknown[]) => void)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdout.write('\x1b[?25l')

    const draw = () => {
      if (linesWritten > 0) {
        process.stdout.write(`\r\x1b[${linesWritten}A\x1b[J`)
      }
      const lines: string[] = []
      const title = `${YELLOW}?${RESET} ${BOLD}Allow ${opts.toolName}?${RESET}  ${DIM}${opts.detail}${RESET}`
      lines.push('')
      lines.push(`  ${title}`)
      lines.push('')
      for (let i = 0; i < options.length; i++) {
        const o = options[i]
        const cursor = i === idx ? `${CYAN}❯${RESET}` : ' '
        const body = i === idx ? `${BOLD}${o.label}${RESET}` : o.label
        const hint = o.hint ? ` ${DIM}${o.hint}${RESET}` : ''
        lines.push(`  ${cursor}  ${body}${hint}`)
      }
      lines.push('')
      lines.push(`${DIM}  ↑↓ move · enter select · esc cancel${RESET}`)
      process.stdout.write(lines.join('\n') + '\n')
      linesWritten = lines.length
    }

    const cleanup = () => {
      process.stdin.off('data', onData)
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
      for (const l of savedData) process.stdin.on('data', l as (...args: unknown[]) => void)
      for (const l of savedKeypress) process.stdin.on('keypress', l as (...args: unknown[]) => void)
      process.stdout.write('\x1b[?25h')
    }

    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf-8')
      if (s === '\x03' || s === '\x1b' || s === 'q') {
        cleanup()
        process.stdout.write('\n')
        resolve(null)
        return
      }
      if (s === '\r' || s === '\n') {
        cleanup()
        process.stdout.write('\n')
        resolve(options[idx].id)
        return
      }
      if (s === '\x1b[A' || s === 'k') { idx = (idx - 1 + options.length) % options.length; draw(); return }
      if (s === '\x1b[B' || s === 'j') { idx = (idx + 1) % options.length; draw(); return }
      // Hotkeys: y=yes-once, a=yes-tool, p=yes-pattern, n=no
      if (s === 'y') { cleanup(); process.stdout.write('\n'); resolve('yes-once'); return }
      if (s === 'a') { cleanup(); process.stdout.write('\n'); resolve('yes-tool'); return }
      if (s === 'p' && opts.patternSuggestion) { cleanup(); process.stdout.write('\n'); resolve('yes-pattern'); return }
      if (s === 'n') { cleanup(); process.stdout.write('\n'); resolve('no-explain'); return }
    }

    process.stdin.on('data', onData)
    draw()
  })

  if (result === null) {
    return { approved: false, explanation: 'Cancelled by user (Esc).' }
  }

  if (result === 'no-explain') {
    // Prompt de texto libre para que el usuario le diga al modelo qué hacer.
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const explanation = await new Promise<string>((resolve) => {
      rl.question(`  ${RED}✗${RESET} ${DIM}Why not? What should the model do instead?${RESET}\n  > `, ans => {
        rl.close()
        resolve(ans.trim())
      })
    })
    return { approved: false, explanation: explanation || 'User declined.' }
  }

  if (result === 'yes-once') return { approved: true, remember: 'once' }
  if (result === 'yes-tool') return { approved: true, remember: 'tool-session' }
  if (result === 'yes-pattern') return { approved: true, remember: 'pattern-session', pattern: opts.patternSuggestion || undefined }
  return { approved: false, explanation: 'Unknown decision.' }
}
