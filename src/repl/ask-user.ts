import readline from 'node:readline'

const RESET = '\x1b[0m'
const DIM   = '\x1b[2m'
const BOLD  = '\x1b[1m'
const CYAN  = '\x1b[36m'
const GREEN = '\x1b[32m'
const GRAY  = '\x1b[90m'

/**
 * Picker interactivo para `AskUserQuestion`. Devuelve un string con la
 * respuesta:
 *   - single select: el `label` elegido (o "" si Esc)
 *   - multi select: labels separados por `, `, o "" si ninguno
 *
 * Implementación: track manual del número de líneas escritas en el último
 * draw, y subir esas líneas antes del siguiente draw para sobrescribirlo.
 * Más robusto que `\x1b[s/\x1b[u` (save/restore cursor) que falla cuando hay
 * scroll o output ajeno entre draws (p. ej. el spinner).
 */
export async function askUserInteractive(
  rl: readline.Interface,
  question: string,
  options: Array<{ label: string; description?: string }>,
  multi: boolean,
): Promise<string> {
  if (!process.stdin.isTTY) {
    return options[0]?.label || ''
  }
  rl.pause()

  return new Promise<string>((resolve) => {
    let idx = 0
    const sel = new Set<number>()
    let linesWritten = 0  // cuántas líneas escribió el último draw

    const wasRaw = process.stdin.isRaw
    const savedKeypress = process.stdin.listeners('keypress').slice()
    const savedData     = process.stdin.listeners('data').slice()
    for (const l of savedKeypress) process.stdin.removeListener('keypress', l as (...args: unknown[]) => void)
    for (const l of savedData)     process.stdin.removeListener('data',     l as (...args: unknown[]) => void)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    // Oculta el cursor durante el picker (el spinner lo había escondido pero
    // si no había spinner activo, lo ocultamos aquí también).
    process.stdout.write('\x1b[?25l')

    const draw = () => {
      // Borra el draw anterior subiendo `linesWritten` líneas y limpiando.
      if (linesWritten > 0) {
        process.stdout.write(`\r\x1b[${linesWritten}A\x1b[J`)
      }
      const lines: string[] = []

      const help = multi
        ? `↑↓ move · space toggle · enter confirm · esc cancel`
        : `↑↓ move · enter select · esc cancel`
      lines.push(`${BOLD}  ${question}${RESET}`)
      lines.push(`  ${DIM}${help}${RESET}`)
      lines.push('')

      for (let i = 0; i < options.length; i++) {
        const o = options[i]
        const cursor = i === idx ? `${CYAN}❯${RESET}` : ' '
        const mark = multi
          ? (sel.has(i) ? `${GREEN}[x]${RESET}` : `${GRAY}[ ]${RESET}`)
          : (i === idx ? `${CYAN}●${RESET}` : `${GRAY}○${RESET}`)
        const labelStyled = i === idx ? `${BOLD}${o.label}${RESET}` : o.label
        lines.push(`  ${cursor}  ${mark}  ${labelStyled}`)
        if (o.description) {
          lines.push(`         ${DIM}${o.description}${RESET}`)
        }
      }

      // Footer
      lines.push('')
      const footer = multi
        ? `${DIM}  ${sel.size} selected${RESET}`
        : `${DIM}  select with enter${RESET}`
      lines.push(footer)

      process.stdout.write(lines.join('\n') + '\n')
      linesWritten = lines.length
    }

    const cleanup = () => {
      process.stdin.off('data', onData)
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
      for (const l of savedKeypress) process.stdin.on('keypress', l as (...args: unknown[]) => void)
      for (const l of savedData)     process.stdin.on('data',     l as (...args: unknown[]) => void)
      process.stdout.write('\x1b[?25h')  // muestra cursor
      rl.resume()
    }

    const finish = (val: string) => {
      cleanup()
      resolve(val)
    }

    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf-8')
      if (s === '\x03' || s === '\x1b' || s === 'q') { finish(''); return }
      if (s === '\r' || s === '\n') {
        if (multi) {
          const labels = Array.from(sel).sort((a, b) => a - b).map(i => options[i].label)
          finish(labels.join(', '))
        } else {
          finish(options[idx].label)
        }
        return
      }
      if (s === '\x1b[A' || s === 'k') { idx = (idx - 1 + options.length) % options.length; draw(); return }
      if (s === '\x1b[B' || s === 'j') { idx = (idx + 1) % options.length; draw(); return }
      if (multi && s === ' ') {
        if (sel.has(idx)) sel.delete(idx)
        else sel.add(idx)
        draw()
        return
      }
    }

    process.stdin.on('data', onData)
    draw()
  })
}
