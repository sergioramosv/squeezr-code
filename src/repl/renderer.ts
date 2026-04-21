import type { AgentEvent, SubscriptionUsage } from '../api/types.js'
import { Spinner } from './spinner.js'
import { getGitInfo } from './git-info.js'
import {
  renderMdLine, renderCodeLine, renderCodeFence, visibleWidth,
  isTableLine, addTableRow, renderTable, emptyTable, type TableState,
} from './markdown.js'
import { link, BEEP, osNotify } from './ansi.js'
import { renderModeLine, type Mode } from './mode.js'
import { taskSnapshot } from '../tools/tasks.js'
import { writeOutput, isEnabled as screenEnabled } from './screen.js'

/**
 * Wrapper single point de output del renderer. Si pin_input_bottom está
 * activo, la screen coordina cursor + scroll region. Si no, escribe directo.
 * Todas las writes del renderer DEBEN pasar por esta función.
 */
function w(text: string): void {
  if (screenEnabled()) writeOutput(text)
  else process.stdout.write(text)
}

// ─── ANSI ───────────────────────────────────────────────────────────
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const ITAL = '\x1b[3m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const BLUE = '\x1b[34m'
const MAGENTA = '\x1b[35m'
const WHITE = '\x1b[37m'
const GRAY = '\x1b[90m'

// Gradiente verde para el banner (oscuro → brillante)
const B1 = '\x1b[38;5;22m'   // verde oscuro
const B2 = '\x1b[38;5;28m'
const B3 = '\x1b[38;5;34m'
const B4 = '\x1b[38;5;40m'
const B5 = '\x1b[38;5;46m'   // verde brillante / lima

// ─── Helpers ────────────────────────────────────────────────────────
/** Mismo criterio que APIClient.providerForModel — duplicado aquí para evitar
 *  importar client.ts desde el renderer. */
function providerOfModel(model: string): 'anthropic' | 'openai' | 'google' {
  if (model.startsWith('claude-') || /haiku|sonnet|opus/.test(model)) return 'anthropic'
  if (model.startsWith('gpt-') || model.startsWith('o3') || model.startsWith('o4') || /^\d/.test(model)) return 'openai'
  if (model.startsWith('gemini-')) return 'google'
  return 'anthropic'
}

/** Pick the 5h utilisation that matches the *active* model, not the global
 *  aggregate. Anthropic emits a per-family header alongside the global
 *  one; Claude Code's status bar uses the family-specific one, so to keep
 *  the two CLIs in sync we do the same. Falls back to the aggregate if
 *  the family-specific header is missing (0). */
export function effectiveFiveHour(sub: import('../api/types.js').SubscriptionUsage, model: string): number {
  if (/sonnet/.test(model) && sub.fiveHourSonnet > 0) return sub.fiveHourSonnet
  if (/opus/.test(model)   && sub.fiveHourOpus   > 0) return sub.fiveHourOpus
  if (/haiku/.test(model)  && sub.fiveHourHaiku  > 0) return sub.fiveHourHaiku
  return sub.fiveHour
}

function colorPct(pct: number): string {
  if (pct >= 90) return RED
  if (pct >= 70) return YELLOW
  if (pct >= 40) return CYAN
  return DIM
}

function formatResetIn(resetAtMs: number): string {
  if (!resetAtMs) return '—'
  const ms = resetAtMs - Date.now()
  if (ms <= 0) return 'already passed'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours > 24) {
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h`
  }
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

/** Formatea duración en segundos a "Xs", "Xm Ys", "Xh Ym". */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return `${m}m ${s}s`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

/** Barra horizontal de progreso de ancho fijo — 10 casillas. */
function bar(pct: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  const empty = width - filled
  const col = colorPct(pct)
  return `${col}${'█'.repeat(filled)}${RESET}${DIM}${'░'.repeat(empty)}${RESET}`
}

/**
 * Spinner messages contextuales por tool. Lo que ve el usuario cuando una
 * tool está corriendo, en lugar del genérico "ejecutando X".
 */
const TOOL_STAGE: Record<string, string> = {
  Read: 'reading',
  Write: 'writing',
  Edit: 'editing',
  Bash: 'running',
  BashOutput: 'reading output',
  Glob: 'searching files',
  Grep: 'searching text',
  WebFetch: 'downloading',
  WebSearch: 'web searching',
  TaskCreate: 'planning',
  TaskList: 'querying tasks',
  TaskUpdate: 'updating task',
  NotebookEdit: 'editing notebook',
  AskUserQuestion: 'awaiting response',
  Task: 'delegating to sub-agent',
}

// ─── Renderer ───────────────────────────────────────────────────────
export class Renderer {
  private isStreaming = false
  private isThinking = false
  /** Si true, acumula thinking text en un buffer en vez de imprimirlo línea a línea. */
  private thinkingCollapsed = true
  private promptChar = '❯'
  setPromptChar(ch: string): void { this.promptChar = ch || '❯' }
  private thinkingBuffer = ''

  /** Toggle desde el REPL (via /style thinking expanded|collapsed). */
  setThinkingCollapsed(on: boolean): void {
    this.thinkingCollapsed = on
  }
  /** Visibilidad de la task list (Ctrl+T toggle). */
  private tasklistCollapsed = false
  setTasklistCollapsed(on: boolean): void {
    this.tasklistCollapsed = on
  }
  getTasklistCollapsed(): boolean { return this.tasklistCollapsed }
  private hasToolBlock = false
  private spinner = new Spinner()
  /** Columna actual dentro del bloque de texto (para wrap manual con `│`). */
  private col = 0
  /** Buffer de texto pendiente de procesar como markdown (hasta el próximo \n). */
  private mdBuffer = ''
  /** Estado: dentro de un bloque ```code```. Atraviesa varias líneas. */
  private inCodeBlock = false

  // ─── Tracking de turno (para el summary tras ╰──) ───
  private turnStartedAt = 0
  private turnTools: string[] = []
  private turnTokensIn = 0
  private turnTokensOut = 0
  private turnFilesModified = new Set<string>()
  private turnFilesCreated = new Set<string>()
  /** Último input de tool_start — lo usamos en tool_result para mostrar el diff. */
  private lastToolInput: Record<string, unknown> = {}
  private lastToolName = ''

  /** Garantiza que el spinner esté parado antes de escribir cualquier otra cosa. */
  private stopSpinner(): void {
    if (this.spinner.isRunning) this.spinner.stop()
  }

  /**
   * Versión pública: para que pickers externos (AskUserQuestion, /mcp) puedan
   * silenciar el spinner antes de tomar el control de la pantalla. Sin esto,
   * el timer del spinner sigue escribiendo en raw mode y rompe el rendering
   * del picker.
   */
  stopSpinnerExternal(): void {
    this.stopSpinner()
  }

  /**
   * Escribe texto dentro del bloque con `│` a la izquierda, haciendo wrap
   * manual en el ancho del terminal. Width medido sin ANSI codes para que
   * `\x1b[1mfoo\x1b[0m` cuente como 3 cols (no 11).
   */
  private writeWrapped(text: string): void {
    const cols = process.stdout.columns || 80
    const maxCol = Math.max(20, cols - 1)
    const pieces = text.split(/(\n|\s+)/)
    for (const piece of pieces) {
      if (!piece) continue
      if (piece === '\n') {
        w(`\n${GRAY}│${RESET} `)
        this.col = 2
        continue
      }
      if (/^\s+$/.test(piece)) {
        if (this.col + 1 > maxCol) {
          w(`\n${GRAY}│${RESET} `)
          this.col = 2
        } else {
          w(piece)
          this.col += piece.length
        }
        continue
      }
      const pieceWidth = visibleWidth(piece)
      // Palabra no cabe: salto de línea con barrita antes.
      if (this.col + pieceWidth > maxCol && this.col > 2) {
        w(`\n${GRAY}│${RESET} `)
        this.col = 2
      }
      // Palabra extra-larga sin ANSI: troceamos a pelo. Con ANSI no, riesgo
      // de partir un escape sequence.
      const hasAnsi = /\x1b\[/.test(piece)
      if (pieceWidth > maxCol - 2 && !hasAnsi) {
        let remaining = piece
        while (remaining.length > 0) {
          const space = maxCol - this.col
          const slice = remaining.slice(0, space)
          w(slice)
          this.col += slice.length
          remaining = remaining.slice(space)
          if (remaining.length > 0) {
            w(`\n${GRAY}│${RESET} `)
            this.col = 2
          }
        }
      } else {
        w(piece)
        this.col += pieceWidth
      }
    }
  }

  /**
   * Drena el buffer de markdown: procesa todas las líneas completas (con \n)
   * aplicando estilos. Si `flushPartial=true`, también renderiza la última
   * línea sin \n (al cerrar el turno con 'done').
   */
  private flushMdLines(flushPartial: boolean): void {
    while (true) {
      const nlIdx = this.mdBuffer.indexOf('\n')
      if (nlIdx < 0) break
      const line = this.mdBuffer.slice(0, nlIdx)
      this.mdBuffer = this.mdBuffer.slice(nlIdx + 1)
      this.writeMdLine(line)
      // Salto a nueva línea con la barrita y reset de col.
      w(`\n${GRAY}│${RESET} `)
      this.col = 2
    }
    if (flushPartial && this.mdBuffer.length > 0) {
      this.writeMdLine(this.mdBuffer)
      this.mdBuffer = ''
    }
  }

  /**
   * Streaming híbrido: escribe chunks plain al instante, y cuando llega \n
   * borra la línea actual y re-renderiza con markdown aplicado.
   *
   *   stream(chunk) → [plain chars] ... \n → [erase + md(line)] \n [next]
   *
   * Mantiene `mdBuffer` como la línea en curso (sin \n). Al ver \n:
   *   1. `\r\x1b[K` limpia la línea visible
   *   2. Escribe `│ ` prefijo
   *   3. writeWrapped(renderMdLine(buffer)) → línea con estilos
   *   4. \n + barrita para siguiente línea
   *   5. Resetea buffer
   */
  private streamText(chunk: string): void {
    const termCols = process.stdout.columns || 80
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]
      if (ch === '\n') {
        const line = this.mdBuffer
        const wrapped = this.col >= termCols  // plain text excedió el ancho → ya hizo wrap, no podemos borrarlo limpio
        this.mdBuffer = ''
        if (!wrapped && line.length > 0) {
          // Line cabe en una fila → erase + re-render con markdown aplicado
          w('\r\x1b[K')
          w(`${GRAY}│${RESET} `)
          this.col = 2
          this.writeMdLine(line)
        }
        // Salto + barrita para la siguiente línea
        w(`\n${GRAY}│${RESET} `)
        this.col = 2
      } else {
        this.mdBuffer += ch
        w(ch)
        this.col += 1
      }
    }
  }

  // Tabla en curso: buffer de rows hasta que veamos una línea no-tabla,
  // entonces flush con renderTable() alineado.
  private tableState: TableState | null = null

  private flushTableIfAny(): void {
    if (this.tableState && this.tableState.rows.length > 0) {
      const rendered = renderTable(this.tableState)
      // Rendered puede ser multi-línea — escribimos cada línea con barra izquierda.
      for (const line of rendered.split('\n')) {
        this.writeWrapped(line)
        w(`\n${GRAY}│${RESET} `)
        this.col = 2
      }
    }
    this.tableState = null
  }

  /** Renderiza UNA línea (sin \n) con markdown aplicado, respetando code blocks. */
  private writeMdLine(line: string): void {
    // Detecta marcadores de code block: ```lang o ``` solo
    const fenceMatch = /^```(\w*)\s*$/.exec(line.trim())
    if (fenceMatch) {
      this.flushTableIfAny()
      const opening = !this.inCodeBlock
      this.inCodeBlock = opening
      this.writeWrapped(renderCodeFence(fenceMatch[1], opening))
      return
    }
    if (this.inCodeBlock) {
      // Líneas dentro de bloque: rendered as code, sin formato inline.
      this.writeWrapped(renderCodeLine(line))
      return
    }
    // Detecta tabla: acumula rows mientras sean tabla, flush al romperse.
    if (isTableLine(line)) {
      if (!this.tableState) this.tableState = emptyTable()
      addTableRow(this.tableState, line)
      return
    }
    // No es tabla — si teníamos una buffered, flush ahora.
    this.flushTableIfAny()
    // Línea de markdown normal.
    this.writeWrapped(renderMdLine(line))
  }

  renderEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'api_call_start':
        this.stopSpinner()
        this.isStreaming = false
        this.isThinking = false
        this.thinkingBuffer = ''
        this.hasToolBlock = false
        this.mdBuffer = ''
        this.inCodeBlock = false
        this.col = 0
        // Reset tracking solo si es el primer api_call del turno (no en
        // tool-loop iterations dentro del mismo turno).
        if (this.turnStartedAt === 0) {
          this.turnStartedAt = Date.now()
          this.turnTools = []
          this.turnTokensIn = 0
          this.turnTokensOut = 0
          this.turnFilesModified.clear()
          this.turnFilesCreated.clear()
        }
        // Header de turno.
        w(`\n${GRAY}│${RESET} ${DIM}Squeezr${RESET}\n`)
        this.spinner.start('thinking')
        break

      case 'thinking':
        // Razonamiento interno: en gris + itálica bajo la barrita, prefijado
        // con un marcador ✻ para distinguirlo del output real.
        //
        // Si `thinkingCollapsed = true`, acumulamos el texto sin pintar y al
        // pasar a `text` mostramos solo "✻ (N líneas colapsadas)" como línea
        // plegada. Esto reduce ruido en turnos con mucho razonamiento.
        this.stopSpinner()
        if (event.text) {
          if (this.thinkingCollapsed) {
            this.thinkingBuffer += event.text
          } else {
            if (!this.isThinking) {
              w(`${GRAY}│ ${DIM}${ITAL}✻ ${RESET}${DIM}${ITAL}`)
              this.isThinking = true
            }
            w(event.text.replace(/\n/g, `${RESET}\n${GRAY}│ ${DIM}${ITAL}  `))
          }
        }
        break

      case 'text':
        // Flush thinking colapsado antes del primer texto.
        if (this.thinkingCollapsed && this.thinkingBuffer) {
          const lines = this.thinkingBuffer.trim().split('\n').length
          const chars = this.thinkingBuffer.length
          w(`${GRAY}│ ${DIM}${ITAL}✻ reasoning collapsed · ${lines} lines / ${chars} chars (/style thinking expanded to view)${RESET}\n`)
          this.thinkingBuffer = ''
        }
        if (this.isThinking) {
          w(`${RESET}\n`)
          this.isThinking = false
        }
        this.stopSpinner()
        if (event.text) {
          if (!this.isStreaming) {
            // Primera emisión: barra izquierda + reset de col.
            w(`${GRAY}│${RESET} `)
            this.col = 2
          }
          // Streaming híbrido con markdown on-newline:
          //   - Chunks sin \n → se muestran plain inmediato (fluidez)
          //   - Cuando llega \n, la línea completa se acumula y se re-renderiza
          //     con markdown aplicado (bold, headings, code spans, etc)
          //   - Usamos `\r\x1b[K` + re-write para pisar la versión plain.
          this.streamText(event.text)
          this.isStreaming = true
        }
        break

      case 'tool_start':
        if (this.isThinking) { w(`${RESET}\n`); this.isThinking = false }
        this.stopSpinner()
        if (this.isStreaming) w('\n')
        this.isStreaming = false
        this.mdBuffer = ''
        if (event.tool) {
          const toolInput = event.tool.input as Record<string, unknown> || {}
          this.lastToolInput = toolInput
          this.lastToolName = event.tool.name
          const icon = toolIcon(event.tool.name)
          const detail = this.toolDetail(event.tool.name, toolInput)
          w(`${GRAY}├─${RESET} ${CYAN}${icon} ${event.tool.name}${RESET} ${detail}\n`)
          this.hasToolBlock = true
          // Track para el summary
          this.turnTools.push(event.tool.name)
          this.trackFileFromTool(event.tool.name, toolInput)
          // Para Edit/Write: mostrar el diff inmediatamente (antes del spinner)
          if (event.tool.name === 'Edit' || event.tool.name === 'Write') {
            this.renderDiff(event.tool.name, toolInput)
          }
          // Spinner contextual: "leyendo" / "buscando" / "ejecutando" / etc
          const stage = TOOL_STAGE[event.tool.name] || `running ${event.tool.name}`
          this.spinner.start(stage)
        }
        break

      case 'tool_result':
        this.stopSpinner()
        if (event.isError && event.tool) {
          const msg = (event.tool.result || '').slice(0, 200).replace(/\n/g, ' ')
          w(`${GRAY}│${RESET}  ${RED}✗ ${msg}${RESET}\n`)
        }
        // Task list live: mostrar el checklist actualizado tras cada TaskCreate/TaskUpdate.
        if (event.tool && (event.tool.name === 'TaskCreate' || event.tool.name === 'TaskUpdate')) {
          this.printTaskListIfActive()
        }
        this.spinner.start('thinking')
        break

      case 'cost':
        // Se refleja en el status bar vía renderStatus, pero también
        // acumulamos para el turn summary.
        if (event.usage) {
          this.turnTokensIn += event.usage.inputTokens
          this.turnTokensOut += event.usage.outputTokens
        }
        break

      case 'recap':
        // "✻ Churned for Xs / ※ recap: ..."  tras turnos largos (>60s + 2 tools)
        if (event.text && typeof event.elapsedSec === 'number') {
          w('\n')
          w(`${CYAN}✻${RESET} ${DIM}Churned for ${formatDuration(event.elapsedSec)}${RESET}\n`)
          w('\n')
          w(`${DIM}※ recap: ${event.text.trim()}${RESET}\n`)
          w(`${DIM}  (disable recaps in sq.toml: [display] recaps = false)${RESET}\n`)
        }
        break
      case 'subscription':
        // Se refleja en el prompt vía renderStatus, no inline.
        break

      case 'error':
        this.stopSpinner()
        if (this.isThinking) { w(`${RESET}\n`); this.isThinking = false }
        if (this.isStreaming) w('\n')
        this.isStreaming = false
        // Detecta abort por usuario → estilo gris como el bloque de user msg.
        // Cualquier otro error → rojo.
        if (/cancelado|cancelled|interrupted|abort/i.test(event.error || '')) {
          const BG = '\x1b[48;5;236m'
          const YELLOW2 = '\x1b[33m'
          const CLR_EOL = '\x1b[K'
          w(`${BG}${YELLOW2}⏸${RESET}${BG} ${DIM}interrupted by user${RESET}${BG}${CLR_EOL}${RESET}\n`)
        } else {
          w(`${GRAY}│${RESET} ${RED}✗ ${event.error}${RESET}\n`)
        }
        break

      case 'done':
        if (this.isThinking) { w(`${RESET}\n`); this.isThinking = false }
        this.stopSpinner()
        // La última línea parcial ya se mostró via streamText (plain). No la
        // re-renderizamos con markdown porque `\r\x1b[K` solo limpia la fila
        // actual, no las filas previas si el texto hizo wrap — resultado:
        // duplicación visible. Lose markdown en la línea final (trade-off).
        // Flush tabla pendiente antes del cierre del turno.
        this.flushTableIfAny()
        if (this.isStreaming) w('\n')
        this.isStreaming = false
        this.inCodeBlock = false
        this.mdBuffer = ''
        w(`${GRAY}╰${'─'.repeat(2)}${RESET}\n`)
        // Si el modelo trabajó con TaskCreate/Update, enseña el checklist actual.
        this.printTaskListIfActive()
        // Turn summary: tools, tokens, tiempo, ficheros modificados.
        this.printTurnSummary()
        // Notificación nativa si el turno tardó > 30s.
        const elapsedSec = (Date.now() - this.turnStartedAt) / 1000
        if (elapsedSec > 30) {
          w(BEEP)
          osNotify('squeezr-code', `Turn completed in ${elapsedSec.toFixed(1)}s`)
        }
        this.turnStartedAt = 0
        break
    }
  }

  private toolDetail(name: string, input?: Record<string, unknown>): string {
    if (!input) return ''
    switch (name) {
      case 'Read':
      case 'Write':
      case 'Edit': {
        const fp = input.file_path as string || ''
        // Hyperlink OSC 8 — clicable en terminales modernos. El path relativo
        // queda más compacto y el href absoluto.
        return DIM + (fp ? link('file://' + fp.replace(/\\/g, '/'), fp) : '') + RESET
      }
      case 'Bash': {
        const cmd = (input.command as string || '').replace(/\n/g, ' ').slice(0, 80)
        return DIM + cmd + (cmd.length >= 80 ? '…' : '') + RESET
      }
      case 'Glob':
      case 'Grep':
        return DIM + (input.pattern as string || '') + RESET
      case 'WebFetch': {
        const url = input.url as string || ''
        return DIM + (url ? link(url, url) : '') + RESET
      }
      case 'WebSearch':
        return DIM + (input.query as string || '') + RESET
      case 'Task':
        return DIM + (input.description as string || '') + RESET
      default: return ''
    }
  }

  /** Track Write/Edit/Bash creations + modifications para el summary. */
  private trackFileFromTool(name: string, input: Record<string, unknown>): void {
    if (name === 'Write') {
      const fp = input.file_path as string
      if (fp) this.turnFilesCreated.add(fp)
    } else if (name === 'Edit') {
      const fp = input.file_path as string
      if (fp) this.turnFilesModified.add(fp)
    } else if (name === 'NotebookEdit') {
      const fp = input.notebook_path as string
      if (fp) this.turnFilesModified.add(fp)
    }
  }

  /**
   * Si en el turno el modelo usó TaskCreate/TaskUpdate, mostramos el checklist
   * actualizado. Se llama tanto live (tras cada TaskCreate/Update) como al final
   * del turno en `done`.
   */
  private printTaskListIfActive(): void {
    const touched = this.turnTools.some(t => t.startsWith('Task') && t !== 'Task')
    if (!touched) return
    const tasks = taskSnapshot()
    if (tasks.length === 0) return
    const done = tasks.filter(t => t.status === 'completed').length
    const active = tasks.filter(t => t.status === 'in_progress').length
    const pending = tasks.filter(t => t.status === 'pending').length
    if (this.tasklistCollapsed) {
      w(`${DIM}  Tasks (${tasks.length}): ${GREEN}${done} done${RESET}${DIM}, ${YELLOW}${active} active${RESET}${DIM}, ${pending} pending · Ctrl+T expand${RESET}\n`)
      return
    }
    w(`${DIM}  Tasks (${tasks.length}) · Ctrl+T collapse${RESET}\n`)
    for (const t of tasks) {
      const icon = t.status === 'completed' ? `${GREEN}✓${RESET}`
                 : t.status === 'in_progress' ? `${YELLOW}⋯${RESET}`
                 : `${GRAY}○${RESET}`
      const subj = t.status === 'completed' ? `${DIM}\x1b[9m${t.subject}\x1b[29m${RESET}` : t.subject
      w(`  ${icon} ${DIM}#${t.id}${RESET} ${subj}\n`)
    }
  }

  /**
   * Renderiza un diff al estilo Claude Code: líneas eliminadas en rojo (-)
   * y añadidas en verde (+). Se muestra inmediatamente tras `├─ Edit/Write`.
   * Limitado a MAX_DIFF_LINES líneas totales para no inundar el terminal.
   */
  private renderDiff(toolName: string, input: Record<string, unknown>): void {
    const MAX_DIFF_LINES = 40
    const RED_BG    = '\x1b[48;5;52m'   // fondo rojo oscuro
    const GREEN_BG  = '\x1b[48;5;22m'   // fondo verde oscuro
    const WHITE     = '\x1b[97m'         // texto blanco brillante (legible sobre fondos oscuros)
    const CLR_EOL   = '\x1b[K'

    if (toolName === 'Edit') {
      const oldStr = (input.old_string as string | undefined) || ''
      const newStr = (input.new_string as string | undefined) || ''
      const oldLines = oldStr === '' ? [] : oldStr.split('\n')
      const newLines = newStr === '' ? [] : newStr.split('\n')
      const total = oldLines.length + newLines.length

      if (total === 0) return

      const truncated = total > MAX_DIFF_LINES
      const maxOld = truncated ? Math.floor(MAX_DIFF_LINES / 2) : oldLines.length
      const maxNew = truncated ? Math.floor(MAX_DIFF_LINES / 2) : newLines.length

      for (const line of oldLines.slice(0, maxOld)) {
        w(`${GRAY}│${RESET}${RED_BG}${WHITE}- ${line}${CLR_EOL}${RESET}\n`)
      }
      for (const line of newLines.slice(0, maxNew)) {
        w(`${GRAY}│${RESET}${GREEN_BG}${WHITE}+ ${line}${CLR_EOL}${RESET}\n`)
      }
      if (truncated) {
        w(`${GRAY}│${RESET} ${DIM}… (diff truncado a ${MAX_DIFF_LINES} líneas)${RESET}\n`)
      }
    } else if (toolName === 'Write') {
      const content = (input.content as string | undefined) || ''
      const lines = content.split('\n')
      const shown = lines.slice(0, MAX_DIFF_LINES)
      for (const line of shown) {
        w(`${GRAY}│${RESET}${GREEN_BG}${WHITE}+ ${line}${CLR_EOL}${RESET}\n`)
      }
      if (lines.length > MAX_DIFF_LINES) {
        w(`${GRAY}│${RESET} ${DIM}… (${lines.length - MAX_DIFF_LINES} líneas más)${RESET}\n`)
      }
    }
  }

  /** Resumen tras `╰──` con: tools usadas, tokens, tiempo, ficheros tocados. */
  private printTurnSummary(): void {
    const elapsedSec = ((Date.now() - this.turnStartedAt) / 1000).toFixed(1)
    const totalTokens = this.turnTokensIn + this.turnTokensOut
    const tokStr = totalTokens >= 1000
      ? `${(totalTokens / 1000).toFixed(1)}k tok`
      : `${totalTokens} tok`
    const parts: string[] = []
    if (this.turnTools.length > 0) {
      const counts = new Map<string, number>()
      for (const t of this.turnTools) counts.set(t, (counts.get(t) || 0) + 1)
      const top = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([n, c]) => c > 1 ? `${n}×${c}` : n)
        .join(' ')
      parts.push(`${this.turnTools.length} tools (${top})`)
    }
    if (totalTokens > 0) parts.push(tokStr)
    parts.push(`${elapsedSec}s`)
    if (this.turnFilesCreated.size > 0) {
      parts.push(`${GREEN}+${RESET}${this.turnFilesCreated.size}`)
    }
    if (this.turnFilesModified.size > 0) {
      parts.push(`${YELLOW}~${RESET}${this.turnFilesModified.size}`)
    }
    w(`${DIM}  ${parts.join(' · ')}${RESET}\n`)
  }

  /**
   * Devuelve SOLO la línea de status (sin saltos de línea, sin prompt).
   * Útil para absolute positioning cuando el input está pinned.
   */
  renderStatusLine(info: {
    project?: string
    branch?: string
    cwd?: string
    contextPercent: number
    costUsd: number
    model: string
    subscriptions?: { anthropic: SubscriptionUsage | null; openai: SubscriptionUsage | null; google: SubscriptionUsage | null } | null
  }): string {
    const parts: string[] = []
    if (info.project) {
      const git = info.cwd ? getGitInfo(info.cwd) : null
      if (git?.branch) {
        const dirty = git.dirty ? '*' : ''
        parts.push(`${GREEN}${info.project}${RESET}${DIM}/${git.branch}${dirty}${RESET}`)
      } else {
        parts.push(`${GREEN}${info.project}${RESET}`)
      }
    }
    if (info.branch) parts.push(`${DIM}${info.branch}${RESET}`)
    const currentProvider = providerOfModel(info.model)
    const sub = info.subscriptions?.[currentProvider] || null
    if (sub) {
      // Si el uso es > 0 pero redondea a 0, muestra 1 decimal para no mentir
      // ("acabo de empezar pero ya salgo como 0% agotado").
      // Anthropic puede devolver >1.0 en la ventana de 5h cuando te pasas del
      // soft-limit (burst allowance) — cap a 100% y anéxalo con `!` para que el
      // usuario vea que está al tope en vez del confuso "102%".
      const rawPct = effectiveFiveHour(sub, info.model) * 100
      const over = rawPct > 100
      const clamped = Math.min(rawPct, 100)
      const pct = Math.round(clamped)
      const display = rawPct > 0 && pct === 0 ? rawPct.toFixed(1) : String(pct)
      const overMark = over ? '!' : ''
      parts.push(`${bar(pct)} ${colorPct(pct)}${display}%${overMark}${RESET} ${DIM}5h${RESET}`)
    } else {
      parts.push(`${DIM}ctx ${info.contextPercent}%${RESET}`)
    }
    if (info.costUsd > 0) parts.push(`${DIM}$${info.costUsd.toFixed(2)}${RESET}`)
    parts.push(`${MAGENTA}${this.shortModelName(info.model)}${RESET}`)
    return parts.join(`${DIM} · ${RESET}`)
  }

  renderStatus(info: {
    project?: string
    branch?: string
    cwd?: string
    contextPercent: number
    costUsd: number
    model: string
    /** Modo actual del agente (default / accept-edits / plan / bypass). */
    mode?: Mode
    /** Snapshot de suscripción por provider. Se muestra el del modelo actual. */
    subscriptions?: { anthropic: SubscriptionUsage | null; openai: SubscriptionUsage | null; google: SubscriptionUsage | null } | null
  }): string {
    const parts: string[] = []

    // git-aware: si hay cwd y es repo → "project/branch*", si no → "project".
    if (info.project) {
      const git = info.cwd ? getGitInfo(info.cwd) : null
      if (git?.branch) {
        const dirty = git.dirty ? '*' : ''
        parts.push(`${GREEN}${info.project}${RESET}${DIM}/${git.branch}${dirty}${RESET}`)
      } else {
        parts.push(`${GREEN}${info.project}${RESET}`)
      }
    }
    if (info.branch) parts.push(`${DIM}${info.branch}${RESET}`)

    // Elige el subscription del provider al que pertenece el modelo actual.
    const currentProvider = providerOfModel(info.model)
    const sub = info.subscriptions?.[currentProvider] || null

    if (sub) {
      const rawPct = effectiveFiveHour(sub, info.model) * 100
      const over = rawPct > 100
      const clamped = Math.min(rawPct, 100)
      const pct = Math.round(clamped)
      const display = rawPct > 0 && pct === 0 ? rawPct.toFixed(1) : String(pct)
      const overMark = over ? '!' : ''
      parts.push(`${bar(pct)} ${colorPct(pct)}${display}%${overMark}${RESET} ${DIM}5h${RESET}`)
    } else {
      const pct = info.contextPercent
      parts.push(`${DIM}ctx ${pct}%${RESET}`)
    }

    if (info.costUsd > 0) parts.push(`${DIM}$${info.costUsd.toFixed(2)}${RESET}`)
    parts.push(`${MAGENTA}${this.shortModelName(info.model)}${RESET}`)

    // Línea de modo bajo el prompt (si está definido). Añade hints de
    // Ctrl+O / Ctrl+T con el verbo correcto según el estado actual.
    const modeLine = info.mode
      ? `\n${renderModeLine(info.mode, {
          thinkingExpanded: !this.thinkingCollapsed,
          tasksCollapsed: this.tasklistCollapsed,
        })}`
      : ''
    // Separador edge-to-edge arriba del status y abajo del mode, aislando el
    // área del prompt del output. Usa terminal width o fallback a 80.
    const cols = Math.max(40, process.stdout.columns || 80)
    const sep = `${DIM}${'─'.repeat(cols)}${RESET}`
    return `\n${sep}\n${parts.join(`${DIM} · ${RESET}`)}${modeLine}\n${sep}\n${B3}${this.promptChar}${RESET} `
  }

  private shortModelName(model: string): string {
    // Anthropic: claude-<family>-<major>-<minor>-<fecha>  →  "<family> <major>.<minor>"
    //   claude-opus-4-6-20260301    → opus 4.6
    //   claude-sonnet-4-5-20250929  → sonnet 4.5
    //   claude-haiku-4-5-*          → haiku 4.5
    const anthropic = /claude-(opus|sonnet|haiku)-(\d+)-(\d+)/.exec(model)
    if (anthropic) return `${anthropic[1]} ${anthropic[2]}.${anthropic[3]}`
    // Alias plain sin versión.
    if (/^(opus|sonnet|haiku)$/i.test(model)) return model.toLowerCase()

    // OpenAI
    if (model.startsWith('gpt-5-codex')) return 'gpt-5-codex'
    if (model.startsWith('gpt-5')) return 'gpt-5'
    if (model.startsWith('gpt-4.1')) return 'gpt-4.1'
    if (model.startsWith('gpt-4')) return 'gpt-4'
    if (model.startsWith('o4-mini')) return 'o4-mini'
    if (model.startsWith('o4')) return 'o4'
    if (model.startsWith('o3-mini')) return 'o3-mini'
    if (model.startsWith('o3')) return 'o3'

    // Google: gemini-3.1-pro-high  →  gemini 3.1 pro
    const gemini = /gemini-(\d+(?:\.\d+)?)-(pro|flash)/.exec(model)
    if (gemini) return `gemini ${gemini[1]} ${gemini[2]}`
    if (model.startsWith('gemini-')) return model.slice(0, 16)

    return model.slice(0, 16)
  }

  renderWelcome(version: string, auth: { anthropic: boolean; openai: boolean; google: boolean }, cwd?: string): void {
    // Versión compacta (4 líneas) — el banner gigante queda para renderWelcomeFull.
    // Con pin_input_bottom, el banner gigante ocuparía demasiadas filas del
    // scroll region dejando poca zona para output.
    const tag = `${BOLD}squeezr-code${RESET} ${DIM}v${version}${RESET}`
    const providers = [
      `anthropic ${auth.anthropic ? GREEN + '●' + RESET : RED + '○' + RESET}`,
      `openai ${auth.openai ? GREEN + '●' + RESET : RED + '○' + RESET}`,
      `google ${auth.google ? GREEN + '●' + RESET : RED + '○' + RESET}`,
    ].join(`  ${GRAY}·${RESET}  `)
    const git = cwd ? getGitInfo(cwd) : null
    const cwdShort = cwd ? cwd.replace(process.env.HOME || '', '~').replace(/\\/g, '/') : ''
    const branch = git?.branch ? `  ${DIM}⎇${RESET} ${git.branch}${git.dirty ? DIM + '*' + RESET : ''}` : ''

    w(`${BOLD}${B5}▌${RESET} ${tag}  ${DIM}·${RESET}  ${DIM}The intelligent CLI that never loses context${RESET}\n`)
    w(`${BOLD}${B5}▌${RESET} ${DIM}auth${RESET}  ${providers}\n`)
    if (cwd) w(`${BOLD}${B5}▌${RESET} ${DIM}cwd${RESET}   ${DIM}▸${RESET} ${cwdShort}${branch}\n`)
    w(`${BOLD}${B5}▌${RESET} ${DIM}tip${RESET}   ${DIM}type${RESET} ${CYAN}/help${RESET} ${DIM}· @model prompt · Shift+Tab cycles mode${RESET}\n`)
    w(`\n`)
  }

  /**
   * Banner grande con ASCII art. Disponible si el usuario lo quiere via
   * flag o comando (/banner). Usado por defecto solo cuando pin_input_bottom
   * está deshabilitado, ya que ocupa ~13 filas del scroll region.
   */
  renderWelcomeFull(version: string, auth: { anthropic: boolean; openai: boolean; google: boolean }, cwd?: string, style: 'big' | 'compact' | 'slant' = 'big'): void {
    const cols = Math.max(60, Math.min(process.stdout.columns || 80, 100))

    const BANNERS: Record<'big' | 'compact' | 'slant', string[]> = {
      big: [
        `${B1}███████╗${B2} ██████╗ ${B3}██╗   ██╗${B3}███████╗${B4}███████╗${B4}███████╗${B5}██████╗ ${RESET}`,
        `${B1}██╔════╝${B2}██╔═══██╗${B3}██║   ██║${B3}██╔════╝${B4}██╔════╝${B4}╚══███╔╝${B5}██╔══██╗${RESET}`,
        `${B1}███████╗${B2}██║   ██║${B3}██║   ██║${B3}█████╗  ${B4}█████╗    ${B4}███╔╝ ${B5}██████╔╝${RESET}`,
        `${B1}╚════██║${B2}██║▄▄ ██║${B3}██║   ██║${B3}██╔══╝  ${B4}██╔══╝   ${B4}███╔╝  ${B5}██╔══██╗${RESET}`,
        `${B1}███████║${B2}╚██████╔╝${B3}╚██████╔╝${B3}███████╗${B4}███████╗${B4}███████╗${B5}██║  ██║${RESET}`,
        `${B1}╚══════╝${B2} ╚══▀▀═╝ ${B3} ╚═════╝ ${B3}╚══════╝${B4}╚══════╝${B4}╚══════╝${B5}╚═╝  ╚═╝${RESET}`,
        `${DIM}                     ·  C O D E  ·${RESET}`,
      ],
      compact: [
        `${B3}▀█▀ ${B4}█▀▀${B5} █${RESET}  ${BOLD}SQUEEZR${RESET} ${DIM}·${RESET} ${B4}CODE${RESET}`,
      ],
      slant: [
        `${B1}   _____${B2}____${B3}_   ${B4}_________${B5}______ __${RESET}`,
        `${B1}  / ___/${B2}__ \\${B3} | | ${B4}/ / ____/${B4} ____/${B5} //__${RESET}`,
        `${B1}  \\__ \\${B2}/ / /${B3} | |/ ${B4}/ __/ ${B4}/____ \\${B5} /_/ ${RESET}`,
        `${B1} ___/ /${B2} /_/ /${B3} |  ${B4}/ /___ ${B4} ____/${B5} / __${RESET}`,
        `${B1}/____/${B2}\\___\\${B3}_\\|__/${B4}_____/${B4}/_____/${B5} /_/${RESET}`,
        `${DIM}          ·  C O D E  ·${RESET}`,
      ],
    }
    const banner = BANNERS[style] || BANNERS.big

    const top = `${GRAY}╭${'─'.repeat(cols - 2)}╮${RESET}`
    const bottom = `${GRAY}╰${'─'.repeat(cols - 2)}╯${RESET}`
    const sep = `${GRAY}├${'─'.repeat(cols - 2)}┤${RESET}`

    console.log()
    console.log(top)
    for (const line of banner) {
      console.log(`${GRAY}│${RESET} ${line}`)
    }
    console.log(sep)

    const tag = `${BOLD}squeezr-code${RESET} ${DIM}v${version}${RESET}`
    const subtitle = `${DIM}The intelligent CLI that never loses context${RESET}`
    console.log(`${GRAY}│${RESET} ${tag}  ${GRAY}·${RESET}  ${subtitle}`)

    const providers = [
      `anthropic ${auth.anthropic ? GREEN + '●' + RESET : RED + '○' + RESET}`,
      `openai ${auth.openai ? GREEN + '●' + RESET : RED + '○' + RESET}`,
      `google ${auth.google ? GREEN + '●' + RESET : RED + '○' + RESET}`,
    ].join(`  ${GRAY}·${RESET}  `)
    console.log(`${GRAY}│${RESET} ${DIM}auth${RESET}  ${providers}`)

    if (cwd) {
      const git = getGitInfo(cwd)
      const folderLine = git?.branch
        ? `${DIM}cwd${RESET}   ${DIM}▸${RESET} ${cwd}  ${DIM}⎇${RESET} ${git.branch}${git.dirty ? DIM + '*' + RESET : ''}`
        : `${DIM}cwd${RESET}   ${DIM}▸${RESET} ${cwd}`
      console.log(`${GRAY}│${RESET} ${folderLine}`)
    }

    console.log(`${GRAY}│${RESET} ${DIM}tip${RESET}   ${DIM}type${RESET} ${CYAN}/help${RESET} ${DIM}to see commands · @model prompt to override${RESET}`)
    console.log(bottom)
    console.log()
  }
}

function toolIcon(name: string): string {
  switch (name) {
    case 'Read':            return '▸'
    case 'Write':           return '✎'
    case 'Edit':            return '±'
    case 'Bash':            return '$'
    case 'BashOutput':      return '↻'
    case 'KillShell':       return '✗'
    case 'Glob':            return '*'
    case 'Grep':            return '⌕'
    case 'WebFetch':        return '⤓'
    case 'WebSearch':       return '⌕'
    case 'TaskCreate':      return '+'
    case 'TaskList':        return '≡'
    case 'TaskGet':         return '?'
    case 'TaskUpdate':      return '⟳'
    case 'NotebookEdit':    return '▤'
    case 'AskUserQuestion': return '?'
    case 'Task':            return '⤳'
    default:                return '◆'
  }
}
