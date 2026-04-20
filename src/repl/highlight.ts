import readline from 'node:readline'

/**
 * Comandos disponibles para mostrar como hints debajo del input cuando el
 * usuario escribe `/`. Se actualiza desde repl.ts via setCommandList.
 */
let availableCommands: string[] = []
export function setCommandList(cmds: string[]): void { availableCommands = cmds }

let availableAliases: string[] = []
export function setAliasList(aliases: string[]): void { availableAliases = aliases }

/**
 * Sintaxis highlight para slash commands y @aliases dentro del readline del REPL.
 *
 * Claude Code colorea `/comando` y `@modelo` en cyan/magenta mientras escribes
 * para que se distingan del texto normal. Aquí hacemos lo mismo intercectando
 * los métodos privados de readline:
 *
 *   - `_refreshLine()` — full refresh de la línea. Override para rintalar prompt
 *     + línea colorizada y reposicionar cursor a mano.
 *   - `_insertString(c)` — insert de char. Override para forzar siempre un
 *     refresh (por defecto, inserts al final de línea solo hacen write plano
 *     del char, sin recolorear).
 *
 * Si readline cambia su API interna en futuros Node, el highlight deja de
 * funcionar pero nada más se rompe: el REPL sigue operativo con línea plana.
 */

const CYAN = '\x1b[36m'
const MAGENTA = '\x1b[35m'
const RESET = '\x1b[0m'

/** Colorea `/cmd` en cyan y `@alias` en magenta. Resto pasa sin cambios. */
function colorize(line: string): string {
  if (line.length === 0) return line
  if (line[0] === '/') {
    const m = line.match(/^(\/\S*)(.*)$/)
    if (m) return `${CYAN}${m[1]}${RESET}${m[2]}`
  }
  if (line[0] === '@') {
    const m = line.match(/^(@\S*)(.*)$/)
    if (m) return `${MAGENTA}${m[1]}${RESET}${m[2]}`
  }
  return line
}

/**
 * Elimina secuencias ANSI para calcular ancho visible. Solo manejamos SGR
 * (códigos de color, que es lo que metemos nosotros).
 */
function visibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

export function installHighlight(rl: readline.Interface): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyRl = rl as any

  const origRefresh = anyRl._refreshLine?.bind(rl)
  const origInsert = anyRl._insertString?.bind(rl)
  if (!origRefresh || !origInsert) {
    // No compatible con esta versión de Node readline — no instalamos nada.
    return
  }

  anyRl._refreshLine = function (): void {
    // Para inserts/backspace/etc que no son `/` ni `@`, usamos el refresh
    // nativo (maneja bien multi-line prompt, scrolling, etc).
    const line = this.line as string
    if (!line.startsWith('/') && !line.startsWith('@')) {
      // Limpiar hint si lo había de antes
      if (lastHintLines > 0) {
        clearHintLines(this.output as NodeJS.WriteStream, lastHintLines, this.cursor as number, this._prompt as string)
        lastHintLines = 0
      }
      return origRefresh()
    }
    // Línea coloreable: refresh nativo pinta todo, luego sobrescribimos línea
    // con color y enseñamos hints debajo si aplica.
    origRefresh()
    repaintLineInColor(this)
    // Hint con comandos/aliases coincidentes debajo del input.
    showHints(this)
  }

  // Forzar refresh en cada insert (readline lo salta para inserts al final).
  anyRl._insertString = function (c: string): void {
    this.line = (this.line as string).slice(0, this.cursor) + c + (this.line as string).slice(this.cursor)
    this.cursor = (this.cursor as number) + c.length
    // Si va a colorear, usamos nuestro refresh; si no, basta con write plano
    // (lo que hace readline nativo cuando cursor está al final).
    const line = this.line as string
    if (line.startsWith('/') || line.startsWith('@')) {
      this._refreshLine()
    } else {
      // Insert al final sin color: mantenemos el write directo.
      if (this.cursor === this.line.length) {
        (this.output as NodeJS.WriteStream).write(c)
      } else {
        this._refreshLine()
      }
    }
  }
}

/**
 * Tras origRefresh ya pintó la línea en texto plano, sobrescribimos solo el
 * segmento de la línea (NO el prompt) con la versión coloreada.
 *
 * Funciona con multi-line prompts porque origRefresh dejó al cursor justo donde
 * readline cree que debe estar (columna = promptCol + cursor). Nosotros:
 *   1. Volvemos al inicio de la línea actual (`\r`)
 *   2. Avanzamos hasta donde termina el prompt (`\x1b[<n>C`)
 *   3. Limpiamos hasta fin de línea (`\x1b[K`)
 *   4. Reescribimos la línea coloreada
 *   5. Reposicionamos el cursor en promptCol + this.cursor
 */
function repaintLineInColor(rl: { line: string; cursor: number; _prompt: string; output: NodeJS.WriteStream }): void {
  const prompt = rl._prompt
  const line = rl.line
  const lastNl = prompt.lastIndexOf('\n')
  const promptTail = lastNl >= 0 ? prompt.slice(lastNl + 1) : prompt
  const promptCol = visibleWidth(promptTail)
  const out = rl.output

  out.write('\r')
  if (promptCol > 0) out.write(`\x1b[${promptCol}C`)
  out.write('\x1b[K')
  out.write(colorize(line))

  // Reposiciona cursor. `\r` + avance hasta la columna final.
  const targetCol = promptCol + rl.cursor
  out.write('\r')
  if (targetCol > 0) out.write(`\x1b[${targetCol}C`)
}

/**
 * Cuántas líneas de hint se imprimieron en la última pintada — necesarias
 * para borrarlas en el siguiente refresh sin dejar restos.
 */
let lastHintLines = 0
const DIM_ANSI = '\x1b[2m'
const CYAN_ANSI = '\x1b[36m'
const MAGENTA_ANSI = '\x1b[35m'
const RESET_ANSI = '\x1b[0m'

function showHints(rl: { line: string; cursor: number; _prompt: string; output: NodeJS.WriteStream }): void {
  const line = rl.line
  let hits: string[] = []
  if (line.startsWith('/')) {
    hits = availableCommands
      .filter(c => c.startsWith(line))
      .slice(0, 6)
  } else if (line.startsWith('@')) {
    const prefix = line.slice(1).split(' ')[0]
    hits = availableAliases
      .filter(a => a.startsWith(prefix))
      .map(a => `@${a}`)
      .slice(0, 6)
  }

  // Limpia hints anteriores antes de pintar nuevos
  const out = rl.output
  if (lastHintLines > 0) {
    clearHintLines(out, lastHintLines, rl.cursor, rl._prompt)
    lastHintLines = 0
  }

  if (hits.length === 0 || (line.startsWith('/') && line.length === 1)) {
    // Si el usuario solo ha escrito '/' enseñamos TODOS los comandos cortos.
    if (line === '/') hits = availableCommands.slice(0, 8)
    else return
  }

  // Enseñamos los hits en una línea, separados por espacios.
  const colored = hits.map(h => {
    if (h.startsWith('/')) return `${CYAN_ANSI}${h}${RESET_ANSI}`
    if (h.startsWith('@')) return `${MAGENTA_ANSI}${h}${RESET_ANSI}`
    return h
  }).join(`${DIM_ANSI} · ${RESET_ANSI}`)

  // Bajamos a una línea nueva, escribimos hint, volvemos al cursor original.
  out.write(`\n${DIM_ANSI}  ${RESET_ANSI}${colored}`)
  lastHintLines = 1
  // Volver arriba a la línea del input y a la columna correcta.
  out.write('\x1b[A')
  const lastNl2 = rl._prompt.lastIndexOf('\n')
  const promptTail2 = lastNl2 >= 0 ? rl._prompt.slice(lastNl2 + 1) : rl._prompt
  const promptCol2 = visibleWidth(promptTail2)
  const targetCol = promptCol2 + rl.cursor
  out.write('\r')
  if (targetCol > 0) out.write(`\x1b[${targetCol}C`)
}

function clearHintLines(out: NodeJS.WriteStream, n: number, cursor: number, prompt: string): void {
  // Bajamos n líneas, limpiamos cada una, subimos.
  for (let i = 0; i < n; i++) {
    out.write('\x1b[B\r\x1b[K')
  }
  for (let i = 0; i < n; i++) {
    out.write('\x1b[A')
  }
  // Posicionar cursor donde estaba (en la línea del input, columna correcta).
  const lastNl = prompt.lastIndexOf('\n')
  const promptTail = lastNl >= 0 ? prompt.slice(lastNl + 1) : prompt
  const promptCol = visibleWidth(promptTail)
  out.write('\r')
  const targetCol = promptCol + cursor
  if (targetCol > 0) out.write(`\x1b[${targetCol}C`)
}
