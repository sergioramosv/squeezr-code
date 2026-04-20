/**
 * Modos de operación del agente (inspirado en Claude Code).
 *
 * - `default`      — pregunta antes de tools peligrosas (Bash, Write, Edit, NotebookEdit).
 * - `accept-edits` — auto-aprueba edits de ficheros (Write/Edit/NotebookEdit) pero sigue
 *                    preguntando para Bash. Útil cuando ya confías en el plan de cambios.
 * - `plan`         — solo-lectura. El modelo NO puede usar Write/Edit/Bash/NotebookEdit.
 *                    Ideal para investigar y proponer antes de ejecutar.
 * - `bypass`       — alias "yolo" — aprueba TODAS las tools sin preguntar. Peligroso.
 *
 * El usuario cicla entre modos con Shift+Tab. El modo actual aparece bajo el prompt.
 */

export type Mode = 'default' | 'accept-edits' | 'plan' | 'bypass'

export const MODE_ORDER: Mode[] = ['default', 'accept-edits', 'plan', 'bypass']

const COLORS: Record<Mode, string> = {
  'default':      '\x1b[36m',  // cyan
  'accept-edits': '\x1b[33m',  // yellow
  'plan':         '\x1b[35m',  // magenta
  'bypass':       '\x1b[31m',  // red (peligroso)
}

const LABELS: Record<Mode, string> = {
  'default':      'default',
  'accept-edits': 'accept-edits',
  'plan':         'plan mode',
  'bypass':       'bypass (yolo)',
}

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

export function modeColor(m: Mode): string { return COLORS[m] }
export function modeLabel(m: Mode): string { return LABELS[m] }

/** Cicla al siguiente modo en MODE_ORDER. */
export function cycleMode(current: Mode): Mode {
  const idx = MODE_ORDER.indexOf(current)
  return MODE_ORDER[(idx + 1) % MODE_ORDER.length]
}

/** Línea que aparece bajo el prompt con el modo actual + hint. */
export function renderModeLine(m: Mode, hints?: { thinkingExpanded?: boolean; tasksCollapsed?: boolean }): string {
  // Hints del estado actual de los toggles Ctrl+O y Ctrl+T — cambian el verbo
  // según lo que HARÍA al pulsar (no lo que está ya), estilo Claude Code:
  //   "Ctrl+O thinking"  → cuando colapsado, pulsar lo expande (y viceversa).
  //   "Ctrl+T tasks"     → igual.
  const showThinking = hints?.thinkingExpanded === true
  const showTasks = hints?.tasksCollapsed === false
  const thinkingVerb = showThinking ? 'collapse' : 'expand'
  const tasksVerb = showTasks ? 'collapse' : 'expand'
  const right = `${DIM}Ctrl+O ${thinkingVerb} thinking${RESET}${DIM} · Ctrl+T ${tasksVerb} tasks${RESET}`
  return `${DIM}  ↳ ${RESET}${COLORS[m]}${LABELS[m]}${RESET} ${DIM}· shift+tab${RESET}   ${right}`
}

/** Tools que modifican el filesystem o ejecutan comandos. */
const MODIFYING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Bash'])
export function isModifyingTool(toolName: string): boolean {
  return MODIFYING_TOOLS.has(toolName)
}

const DANGEROUS_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit'])
export function isDangerous(toolName: string): boolean {
  return DANGEROUS_TOOLS.has(toolName)
}
