import type { PermissionRules } from '../config.js'

/**
 * Matcher para reglas granulares de permisos.
 *
 * Cada regla es un string:
 *   "Read"            → match cualquier invocación de Read
 *   "Bash"            → match cualquier Bash
 *   "Bash:git *"      → match Bash con command que empieza por "git "
 *   "Bash:rm -rf *"   → match Bash con command que empieza por "rm -rf "
 *   "Write:src/**"    → match Write con file_path que empieza por "src/"
 *   "Write"           → match cualquier Write
 *
 * Glob básico: `*` matchea cualquier string (incluso vacío), incluyendo `/`.
 * No es un glob completo pero cubre los casos útiles para reglas de permisos.
 */

export type MatchResult = 'allow' | 'deny' | 'ask'

export function evaluateRules(
  toolName: string,
  input: Record<string, unknown>,
  rules: PermissionRules,
): MatchResult {
  const deny = rules.deny || []
  const allow = rules.allow || []
  for (const pattern of deny) {
    if (matches(pattern, toolName, input)) return 'deny'
  }
  for (const pattern of allow) {
    if (matches(pattern, toolName, input)) return 'allow'
  }
  return 'ask'
}

function matches(pattern: string, toolName: string, input: Record<string, unknown>): boolean {
  // "Tool" o "Tool:<pattern>"
  const colonIdx = pattern.indexOf(':')
  const patTool = colonIdx < 0 ? pattern : pattern.slice(0, colonIdx)
  if (patTool !== toolName) return false
  if (colonIdx < 0) return true // "Tool" solo → match todo lo de ese tool

  const patArg = pattern.slice(colonIdx + 1)
  // Extrae el campo relevante según el tool.
  const value = extractArg(toolName, input)
  if (value === null) return false
  return globMatch(patArg, value)
}

function extractArg(toolName: string, input: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'Bash':  return (input.command as string) || null
    case 'Write':
    case 'Edit':
    case 'Read':  return (input.file_path as string) || null
    case 'Glob':
    case 'Grep':  return (input.pattern as string) || null
    default:      return null
  }
}

/** Glob básico: `*` → `.*` en regex, resto escapado. */
function globMatch(pattern: string, value: string): boolean {
  const regex = '^' + pattern.split('*').map(escapeRegex).join('.*') + '$'
  return new RegExp(regex).test(value)
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}
