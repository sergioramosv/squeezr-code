/**
 * Mini-renderer de markdown para terminal. Convierte una línea de markdown en
 * un string con ANSI codes que se ve bonito en el REPL.
 *
 * Soporta:
 *   - # / ## / ### headings
 *   - **bold** y *italic*
 *   - `inline code`
 *   - ```code blocks``` (multi-línea, lo gestiona el llamador)
 *   - - / * lists
 *   - > blockquotes
 *   - --- horizontal rule
 *   - [text](url) links
 *
 * No soporta: tablas, imágenes, footnotes, HTML embebido. Para esos, el texto
 * crudo se ve con el caracter literal.
 */

const RESET   = '\x1b[0m'
const BOLD    = '\x1b[1m'
const DIM     = '\x1b[2m'
const ITAL    = '\x1b[3m'
const UNDER   = '\x1b[4m'
const RED     = '\x1b[31m'
const GREEN   = '\x1b[32m'
const YELLOW  = '\x1b[33m'
const CYAN    = '\x1b[36m'
const MAGENTA = '\x1b[35m'

// Verdes del banner para headings (gradiente)
const H1_COLOR = '\x1b[38;5;46m'  // verde brillante
const H2_COLOR = '\x1b[38;5;40m'  // verde
const H3_COLOR = '\x1b[38;5;34m'  // verde medio

import { gradient, link } from './ansi.js'

/** Renderiza una línea (sin `\n`) con markdown aplicado. */
export function renderMdLine(line: string): string {
  // Headings
  let m = /^(#{1,6})\s+(.*)$/.exec(line)
  if (m) {
    const level = m[1].length
    const text = m[2]
    // H1 con gradient (mismo del banner). H2/H3 con color sólido.
    if (level === 1) return BOLD + gradient(text)
    if (level === 2) return `${BOLD}${H2_COLOR}${text}${RESET}`
    if (level === 3) return `${BOLD}${H3_COLOR}${text}${RESET}`
    return `${BOLD}${text}${RESET}`
  }

  // Horizontal rule
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    return `${DIM}${'─'.repeat(50)}${RESET}`
  }

  // Blockquote
  m = /^(>+)\s?(.*)$/.exec(line)
  if (m) {
    const depth = m[1].length
    const inner = renderInline(m[2])
    return `${DIM}${'┃ '.repeat(depth)}${RESET}${ITAL}${DIM}${inner}${RESET}`
  }

  // List item: -, *, +, or numbered
  m = /^(\s*)([-*+])\s+(.*)$/.exec(line)
  if (m) {
    const indent = m[1]
    const inner = renderInline(m[3])
    return `${indent}${CYAN}•${RESET} ${inner}`
  }
  m = /^(\s*)(\d+)\.\s+(.*)$/.exec(line)
  if (m) {
    const indent = m[1]
    const num = m[2]
    const inner = renderInline(m[3])
    return `${indent}${DIM}${num}.${RESET} ${inner}`
  }

  // Plain line con inline formatting
  return renderInline(line)
}

/**
 * Aplica formateado inline a una línea: bold, italic, code, links.
 * Orden importa: code primero (puede contener `*` o `_`), luego links, luego
 * bold/italic.
 */
function renderInline(text: string): string {
  // Code spans `code` — placeholder para que el resto no toque su contenido
  const codeSpans: string[] = []
  text = text.replace(/`([^`]+)`/g, (_, c: string) => {
    codeSpans.push(c)
    return `\u0000CODE${codeSpans.length - 1}\u0000`
  })

  // Links [text](url) — usamos OSC 8 para que sean clickeables. Terminales que
  // no lo soporten muestran el texto subrayado igual.
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t: string, u: string) => {
    return `${UNDER}${CYAN}${link(u, t)}${RESET}`
  })

  // Bold **text** y __text__
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, c: string) => `${BOLD}${c}${RESET}`)
  text = text.replace(/__([^_\n]+)__/g, (_m, c: string) => `${BOLD}${c}${RESET}`)

  // Italic *text* y _text_  (cuidado con no pisar negritas — ya consumidas arriba)
  text = text.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, (_m, c: string) => `${ITAL}${c}${RESET}`)
  text = text.replace(/(?<![_\w])_([^_\n]+)_(?!_)/g, (_m, c: string) => `${ITAL}${c}${RESET}`)

  // Restituye code spans con estilo
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => {
    const c = codeSpans[parseInt(idx, 10)]
    return `${MAGENTA}\`${c}\`${RESET}`
  })

  return text
}

/**
 * Para bloques de código multilinea: línea cruda en cyan dim. El llamador
 * se encarga de detectar los marcadores ``` y togglear el estado.
 */
export function renderCodeLine(line: string): string {
  return `${DIM}${CYAN}${line}${RESET}`
}

/** Marcador de inicio/fin de bloque de código (separador visual). */
export function renderCodeFence(lang: string, opening: boolean): string {
  if (opening) {
    const tag = lang ? ` ${lang} ` : ' code '
    return `${DIM}┌─${tag}${'─'.repeat(Math.max(0, 40 - tag.length))}${RESET}`
  }
  return `${DIM}└${'─'.repeat(42)}${RESET}`
}

/** Cuenta caracteres visibles (sin ANSI). Útil para wrap manual. */
export function visibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

// ─── Table rendering ──────────────────────────────────────────────
//
// Markdown tables llegan línea a línea, pero necesitamos TODOS los rows
// para calcular el ancho de cada columna antes de pintar (alineación).
// Solución: buffer + flush. El renderer acumula mientras las líneas
// sigan siendo de tabla (`| ... | ... |`), y al ver una línea que NO es
// tabla, hace flush con formato bonito.

export interface TableState {
  rows: string[][]     // cada row = array de celdas
  hasHeader: boolean   // true si ya vimos la línea separadora ---
  aligns: Array<'left' | 'center' | 'right' | null>
}

/** Detecta si una línea parece una row de tabla markdown. */
export function isTableLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length >= 3
}

/** Detecta la línea separadora de tabla: `| --- | :---: | ---: |`. */
export function isTableSeparator(line: string): boolean {
  const cells = parseCells(line)
  return cells.length > 0 && cells.every(c => /^:?-{3,}:?$/.test(c.trim()))
}

/** Parse `| a | b | c |` → ['a', 'b', 'c']. */
function parseCells(line: string): string[] {
  const trimmed = line.trim()
  // Quita `|` inicial y final.
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const core = inner.endsWith('|') ? inner.slice(0, -1) : inner
  return core.split('|').map(c => c.trim())
}

/** Crea un TableState vacío. */
export function emptyTable(): TableState {
  return { rows: [], hasHeader: false, aligns: [] }
}

/** Añade una línea al TableState. Devuelve true si consumió la línea. */
export function addTableRow(state: TableState, line: string): boolean {
  if (isTableSeparator(line)) {
    // La línea separadora define header + alineaciones.
    const cells = parseCells(line)
    state.aligns = cells.map(c => {
      const t = c.trim()
      const left = t.startsWith(':')
      const right = t.endsWith(':')
      if (left && right) return 'center'
      if (right) return 'right'
      if (left) return 'left'
      return null
    })
    state.hasHeader = state.rows.length > 0
    return true
  }
  if (!isTableLine(line)) return false
  state.rows.push(parseCells(line))
  return true
}

/**
 * Renderiza el TableState como string ANSI bonito:
 *   ┌──────┬──────┐
 *   │ col  │ val  │
 *   ├──────┼──────┤
 *   │ foo  │ bar  │
 *   └──────┴──────┘
 */
export function renderTable(state: TableState): string {
  if (state.rows.length === 0) return ''
  const cols = Math.max(...state.rows.map(r => r.length))
  // Ancho por columna = máx visible width de cualquier celda.
  const widths: number[] = new Array(cols).fill(0)
  for (const row of state.rows) {
    for (let c = 0; c < cols; c++) {
      const text = row[c] || ''
      const w = visibleWidth(renderInline(text))
      if (w > widths[c]) widths[c] = w
    }
  }

  const padCell = (text: string, width: number, align: 'left' | 'center' | 'right' | null): string => {
    const rendered = renderInline(text)
    const pad = Math.max(0, width - visibleWidth(rendered))
    if (align === 'right') return ' '.repeat(pad) + rendered
    if (align === 'center') {
      const l = Math.floor(pad / 2)
      return ' '.repeat(l) + rendered + ' '.repeat(pad - l)
    }
    return rendered + ' '.repeat(pad)
  }

  const lines: string[] = []
  const top = `${DIM}┌${widths.map(w => '─'.repeat(w + 2)).join('┬')}┐${RESET}`
  const sep = `${DIM}├${widths.map(w => '─'.repeat(w + 2)).join('┼')}┤${RESET}`
  const bot = `${DIM}└${widths.map(w => '─'.repeat(w + 2)).join('┴')}┘${RESET}`
  lines.push(top)
  for (let r = 0; r < state.rows.length; r++) {
    const row = state.rows[r]
    const cells = widths.map((w, c) => {
      const align = state.aligns[c] || 'left'
      // Primera row con estilo header si hay separador.
      const text = row[c] || ''
      const padded = padCell(text, w, align)
      if (state.hasHeader && r === 0) return `${BOLD}${padded}${RESET}`
      return padded
    })
    lines.push(`${DIM}│${RESET} ${cells.join(` ${DIM}│${RESET} `)} ${DIM}│${RESET}`)
    // Separador tras header.
    if (state.hasHeader && r === 0) lines.push(sep)
  }
  lines.push(bot)
  return lines.join('\n')
}
