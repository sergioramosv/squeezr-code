/**
 * Session-level permission allowlist. Cuando el usuario elige "Yes, and don't
 * ask again" en el picker de permisos, la regla se guarda aquí (en memoria).
 *
 * - `allowTool(name)`: auto-aprueba todas las invocaciones de ese tool en la sesión.
 * - `allowPattern(toolName, pattern)`: allow si el arg matchea el pattern (glob).
 *
 * Se resetea al cerrar sq. Las reglas PERMANENTES viven en `sq.toml`
 * `[permissions] allow/deny`.
 */

const sessionAllowedTools = new Set<string>()
const sessionAllowedPatterns = new Map<string, string[]>()  // toolName → patterns

export function allowToolForSession(toolName: string): void {
  sessionAllowedTools.add(toolName)
}

export function allowPatternForSession(toolName: string, pattern: string): void {
  const list = sessionAllowedPatterns.get(toolName) || []
  if (!list.includes(pattern)) list.push(pattern)
  sessionAllowedPatterns.set(toolName, list)
}

export function isAllowedBySession(toolName: string, input: Record<string, unknown>): boolean {
  if (sessionAllowedTools.has(toolName)) return true
  const patterns = sessionAllowedPatterns.get(toolName)
  if (!patterns || patterns.length === 0) return false
  const arg = extractArg(toolName, input)
  if (!arg) return false
  return patterns.some(p => globMatch(p, arg))
}

export function clearSessionPerms(): void {
  sessionAllowedTools.clear()
  sessionAllowedPatterns.clear()
}

/** Snapshot para debug/display. */
export function sessionPermsSnapshot(): { tools: string[]; patterns: Array<[string, string[]]> } {
  return {
    tools: Array.from(sessionAllowedTools),
    patterns: Array.from(sessionAllowedPatterns.entries()),
  }
}

function extractArg(toolName: string, input: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'Bash':  return (input.command as string) || null
    case 'Write':
    case 'Edit':
    case 'Read':  return (input.file_path as string) || null
    case 'NotebookEdit': return (input.notebook_path as string) || null
    case 'Glob':
    case 'Grep':  return (input.pattern as string) || null
    default:      return null
  }
}

function globMatch(pattern: string, value: string): boolean {
  const regex = '^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
  return new RegExp(regex).test(value)
}

/**
 * Sugiere un pattern "don't ask again" razonable basado en el arg:
 *   /abs/path/src/foo.ts → "/abs/path/src/**"  (dir parent)
 *   npm test              → "npm *"             (primer token)
 *   git status            → "git *"
 */
export function suggestPattern(toolName: string, input: Record<string, unknown>): string | null {
  const arg = extractArg(toolName, input)
  if (!arg) return null
  if (toolName === 'Bash') {
    // primer token del comando + *
    const firstToken = arg.trim().split(/\s+/)[0]
    if (firstToken) return `${firstToken} *`
    return null
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read' || toolName === 'NotebookEdit') {
    // directorio del fichero + /**
    const dirEnd = Math.max(arg.lastIndexOf('/'), arg.lastIndexOf('\\'))
    if (dirEnd > 0) return arg.slice(0, dirEnd) + '/**'
    return null
  }
  return null
}
