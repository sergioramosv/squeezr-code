import { diffForWrite, diffForEdit } from './diff.js'
import { pickPermission } from '../repl/permission-picker.js'
import {
  allowToolForSession,
  allowPatternForSession,
  isAllowedBySession,
  suggestPattern,
} from './session-perms.js'

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bdrop\s+table\b/i,
  /\bdrop\s+database\b/i,
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bcurl\b.*\|\s*sh\b/,
]

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(p => p.test(command))
}

/**
 * Respuesta del permission flow:
 *   - approved=true: ejecuta la tool
 *   - approved=false: cancela, opcionalmente con explanation que se devuelve
 *     al modelo como tool_result para que aprenda qué hacer después.
 */
export interface PermissionResult {
  approved: boolean
  explanation?: string
}

export async function askPermission(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
  // Si la sesión ya tiene un allow para este tool/pattern, auto-apruebamos.
  if (isAllowedBySession(toolName, input)) {
    return { approved: true }
  }

  let detail = ''
  let preview = ''

  if (toolName === 'Bash') {
    detail = input.command as string
    const dangerous = isDangerousCommand(detail)
    if (!dangerous) return { approved: true }  // auto-approve safe bash commands
  } else if (toolName === 'Write') {
    detail = input.file_path as string
    try {
      preview = diffForWrite(detail, (input.content as string) || '')
    } catch { /* si el diff falla, seguimos sin él */ }
  } else if (toolName === 'Edit') {
    detail = input.file_path as string
    try {
      preview = diffForEdit(
        detail,
        (input.old_string as string) || '',
        (input.new_string as string) || '',
      )
    } catch { /* si el diff falla, seguimos sin él */ }
  } else if (toolName === 'NotebookEdit') {
    detail = (input.notebook_path as string) || ''
  }

  const patternSuggestion = suggestPattern(toolName, input)

  const decision = await pickPermission({
    toolName,
    detail,
    preview,
    patternSuggestion,
  })

  if (!decision.approved) {
    return { approved: false, explanation: decision.explanation }
  }

  // Guarda la regla "don't ask again" en session allowlist según tipo.
  if (decision.remember === 'tool-session') {
    allowToolForSession(toolName)
  } else if (decision.remember === 'pattern-session' && decision.pattern) {
    allowPatternForSession(toolName, decision.pattern)
  }

  return { approved: true }
}
