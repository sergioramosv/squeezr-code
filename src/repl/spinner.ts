/**
 * Pequeño spinner de terminal para rellenar el hueco silencioso entre
 * "la API aceptó la request" y "llega el primer token".
 *
 * No añade dependencias. Usa un timer y los códigos ANSI clásicos:
 *   \r         ← volver al inicio de la línea
 *   \x1b[K     ← borrar de cursor al final de línea
 *   \x1b[?25l  ← ocultar cursor
 *   \x1b[?25h  ← mostrar cursor
 */
import { writeOutput, isEnabled as screenEnabled } from './screen.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

/** Wrapper: si screen está activo, write va al scroll region. */
function w(text: string): void {
  if (screenEnabled()) writeOutput(text)
  else process.stdout.write(text)
}

export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null
  private frameIdx = 0
  private text = ''
  private startedAt = 0

  start(text: string): void {
    if (this.interval) {
      this.text = text
      return
    }
    this.text = text
    this.frameIdx = 0
    this.startedAt = Date.now()
    w('\x1b[?25l')
    this.render()
    this.interval = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % FRAMES.length
      this.render()
    }, 80)
  }

  private render(): void {
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1)
    // Tras 3s, sugerimos el atajo para cancelar — útil cuando algo se cuelga.
    const elapsedNum = parseFloat(elapsed)
    const cancelHint = elapsedNum > 3
      ? `  \x1b[2m· esc to cancel\x1b[0m`
      : ''
    w(`\r\x1b[K${DIM}${FRAMES[this.frameIdx]} ${this.text}  (${elapsed}s)${RESET}${cancelHint}`)
  }

  stop(): void {
    if (!this.interval) return
    clearInterval(this.interval)
    this.interval = null
    w('\r\x1b[K\x1b[?25h')
  }

  get isRunning(): boolean {
    return this.interval !== null
  }
}
