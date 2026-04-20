/**
 * Screen manager para pin_input_bottom.
 *
 * Usa ALTERNATE SCREEN BUFFER (\x1b[?1049h) para aislarnos del terminal
 * principal: sq tiene su propia "pantalla" limpia, y al salir el terminal
 * vuelve a como estaba. Igual que hacen tmux, vim, less, htop.
 *
 * Layout:
 *
 *   row 1                ┐
 *   row 2                │  <- scroll region: output
 *   ...                  │     del agente. \n aquí scrollea SOLO esta zona.
 *   row H-4              ┘
 *   row H-3              -> status line  (proyecto · % · modelo)
 *   row H-2              -> mode line    (↳ accept-edits · shift+tab)
 *   row H-1              -> prompt       (❯ lo que escribes)
 *   row H                -> buffer vacío (absorbe \n de Enter sin romper layout)
 *
 * La clave de que funcione: TODAS las writes a output deben pasar por
 * `writeOutput()`, que posiciona el cursor dentro del scroll region antes de
 * escribir. Writes fuera de este wrapper podrían escribir donde no deben.
 *
 * Status/mode se redibujan con `drawInputArea()` después de cada evento del
 * renderer (o cuando cambia el estado). Usan absolute positioning con DECSC/
 * DECRC para no mover el cursor fuera de sitio.
 */

// 5 filas fijas abajo: topSep + status + mode + botSep + prompt
// (con el buffer-row absorbido por el prompt, sin línea extra)
const INPUT_ROWS = 5

let enabled = false
let termRows = 0
let termCols = 0
let resizeHandler: (() => void) | null = null

const RESET = '\x1b[0m'

/**
 * Enter alternate screen + set scroll region. Devuelve función de cleanup.
 * No-op si no hay TTY.
 */
export function enableScreen(onResize?: () => void): () => void {
  if (!process.stdout.isTTY) return () => { /* noop */ }

  termRows = process.stdout.rows || 24
  termCols = process.stdout.columns || 80
  const bottom = scrollBottom()

  // Orden:
  //   - NO entramos en alt screen (\x1b[?1049h) porque eso desactiva el
  //     scrollback del terminal y el usuario no puede hacer scroll up para
  //     ver output pasado.
  //   - Sí definimos scroll region (DECSTBM) para que el output scrollee
  //     solo en las filas de arriba mientras status/mode/prompt quedan fijos.
  process.stdout.write(
    `\x1b[1;${bottom}r`  // DECSTBM scroll region
  )
  // Posición inicial del cursor: donde estaba antes (no reposicionamos para
  // no saltar). El primer render (banner) escribirá donde el shell dejó
  // el cursor, típicamente justo debajo del prompt del shell.
  enabled = true

  resizeHandler = () => {
    termRows = process.stdout.rows || 24
    termCols = process.stdout.columns || 80
    process.stdout.write(`\x1b[1;${scrollBottom()}r`)
    if (onResize) onResize()
  }
  process.stdout.on('resize', resizeHandler)

  return cleanup
}

export function cleanup(): void {
  if (!enabled) return
  enabled = false
  if (resizeHandler) {
    process.stdout.off('resize', resizeHandler)
    resizeHandler = null
  }
  // Reset scroll region y aseguramos cursor visible. Cursor va a la última
  // fila para que el shell prompt que viene aparezca abajo, no mezclado con
  // el output de sq.
  process.stdout.write(
    '\x1b[r'                            // reset scroll region
    + '\x1b[?25h'                       // cursor visible
    + `\x1b[${termRows};1H\n`           // cursor a última fila + newline
  )
}

export function isEnabled(): boolean { return enabled }
export function rows(): number { return termRows }
export function cols(): number { return termCols }

export function scrollBottom(): number { return Math.max(1, termRows - INPUT_ROWS) }
// Layout del área pinned (5 filas):
//   topSepRow  (termRows - 4)  ← separador ─────
//   statusRow  (termRows - 3)  ← Ramos · 4% 5h · …
//   modeRow    (termRows - 2)  ← ↳ accept-edits · shift+tab
//   botSepRow  (termRows - 1)  ← separador ─────
//   promptRow  (termRows)      ← ❯ input
export function topSepRow(): number { return Math.max(1, termRows - 4) }
export function statusRow(): number { return Math.max(1, termRows - 3) }
export function modeRow(): number { return Math.max(1, termRows - 2) }
export function botSepRow(): number { return Math.max(1, termRows - 1) }
export function promptRow(): number { return Math.max(1, termRows) }

/**
 * Escribe output dentro del scroll region. Posiciona el cursor correctamente
 * antes de escribir para que `\n` scrollee solo dentro del region, sin tocar
 * las filas fijas de abajo.
 *
 * Este wrapper ES el punto de entrada único para todo output del renderer.
 * Si alguien escribe directo con `process.stdout.write` fuera de esto, el
 * layout puede romperse.
 */
/**
 * Memoria de dónde quedó el cursor en el scroll region tras el último output.
 * Necesaria porque readline puede mover el cursor al prompt row entre
 * writeOutput calls (para echo de teclas del usuario).
 */
let lastCursorRow = 1
let lastCursorCol = 1

export function writeOutput(text: string): void {
  if (!enabled) {
    process.stdout.write(text)
    return
  }
  // CRÍTICO: readline pone el terminal en raw mode donde `\n` SOLO baja una
  // fila y NO hace carriage return (no vuelve a col 1). Si escribimos texto
  // con `\n│ ` (patrón habitual del renderer), el `│` aparecería desplazado
  // a la columna donde estábamos antes del `\n`. Normalizamos `\n` → `\r\n`
  // para forzar el CR aunque raw mode esté activo.
  const normalized = text.replace(/\r?\n/g, '\r\n')

  // Guarda cursor actual (probablemente en el prompt row si readline está
  // echoando teclas) y lo restaura al final.
  const save = '\x1b7'
  const restore = '\x1b8'
  // Posiciona en la fila/col del scroll region donde quedó el último output.
  const gotoOutput = `\x1b[${lastCursorRow};${lastCursorCol}H`

  process.stdout.write(save + gotoOutput + normalized)

  // Actualiza lastCursorRow/Col según el texto emitido.
  // Nota: tras un `\r\n`, cursor queda en col 1 de la siguiente fila.
  const lines = normalized.split('\r\n')
  if (lines.length > 1) {
    lastCursorRow = Math.min(scrollBottom(), lastCursorRow + lines.length - 1)
    lastCursorCol = visibleLen(lines[lines.length - 1]) + 1
  } else {
    lastCursorCol += visibleLen(lines[0])
  }

  process.stdout.write(restore)
}

/**
 * Elimina ANSI codes y devuelve el ancho visible del texto. Usado para
 * estimar dónde queda el cursor tras writeOutput.
 */
function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

/**
 * Dibuja las 4 líneas pinned (topSep + status + mode + botSep) en filas
 * absolutas. El prompt (row H) lo gestiona readline; solo aseguramos que
 * esté vacío. Guarda/restaura cursor con DECSC/DECRC para no romper el flow.
 */
export function drawInputArea(statusLine: string, modeLine: string): void {
  if (!enabled) return
  const DIM = '\x1b[2m'
  const sep = `${DIM}${'─'.repeat(termCols)}${RESET}`
  process.stdout.write(
    '\x1b7'                                                   // save cursor
    + `\x1b[${topSepRow()};1H\x1b[K${sep}`                     // top separator
    + `\x1b[${statusRow()};1H\x1b[K${statusLine}${RESET}`      // status
    + `\x1b[${modeRow()};1H\x1b[K${modeLine}${RESET}`          // mode
    + `\x1b[${botSepRow()};1H\x1b[K${sep}`                     // bottom separator
    + '\x1b8'                                                  // restore cursor
  )
}

/**
 * Posiciona el cursor en la fila del prompt, preparado para que readline
 * escriba ahí. Llamar antes de `rl.prompt()`.
 */
export function positionPromptCursor(): void {
  if (!enabled) return
  process.stdout.write(`\x1b[${promptRow()};1H\x1b[K`)
}

/** Resetea la memoria de cursor al arrancar (tras setup). */
export function resetOutputCursor(): void {
  lastCursorRow = 1
  lastCursorCol = 1
}

export { INPUT_ROWS }
