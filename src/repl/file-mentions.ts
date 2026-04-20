import fs from 'node:fs'
import path from 'node:path'

/**
 * Expande `@path/to/file.txt` en el prompt del usuario al contenido del
 * fichero como bloque de código. Igual que Claude Code y Gemini CLI.
 *
 * Sintaxis soportada:
 *   - `@README.md`               → relativo al cwd
 *   - `@src/foo.ts`              → relativo al cwd con subpath
 *   - `@/abs/path/file.json`     → absoluto
 *   - `@~/notes.md`              → expand `~` a home
 *
 * El `@modelo prompt` (override de modelo) se distingue porque NO contiene
 * `/`, `.` ni `~` ni `:` después del `@`. Si el token tras `@` parece un id
 * de modelo (alfanumérico+`-`+`.`+digit), no se interpreta como fichero.
 */

const MAX_FILE_BYTES = 200_000  // 200KB por fichero, evita explotar contexto

export interface ExpansionResult {
  prompt: string
  filesIncluded: string[]
  filesNotFound: string[]
}

export function expandFileMentions(rawPrompt: string, cwd: string): ExpansionResult {
  const filesIncluded: string[] = []
  const filesNotFound: string[] = []

  // Match `@<path>` donde el path tiene al menos un `/`, `.`, `~` o `\` —
  // así no chocamos con `@modelo`.
  const re = /@([~/\\][^\s]+|[^\s]*[/\\.][^\s]+)/g
  const expanded = rawPrompt.replace(re, (match, p1: string) => {
    const cleaned = p1.replace(/[,;:.!?)]+$/, '')  // quita puntuación final
    const resolvedPath = resolvePath(cleaned, cwd)
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      filesNotFound.push(cleaned)
      return match  // deja el `@xxx` literal
    }
    try {
      const stat = fs.statSync(resolvedPath)
      if (stat.isDirectory()) {
        // Lista los ficheros del dir como tree.
        const entries = fs.readdirSync(resolvedPath).slice(0, 50)
        filesIncluded.push(cleaned + '/')
        return `\n\n--- Contents of ${cleaned}/ ---\n${entries.map(e => '  ' + e).join('\n')}\n--- end ${cleaned}/ ---\n\n`
      }
      if (stat.size > MAX_FILE_BYTES) {
        filesNotFound.push(`${cleaned} (>${Math.round(MAX_FILE_BYTES/1024)}KB)`)
        return match
      }
      const content = fs.readFileSync(resolvedPath, 'utf-8')
      filesIncluded.push(cleaned)
      const ext = path.extname(resolvedPath).slice(1) || ''
      return `\n\n--- ${cleaned} ---\n\`\`\`${ext}\n${content}\n\`\`\`\n--- end ${cleaned} ---\n\n`
    } catch {
      filesNotFound.push(cleaned)
      return match
    }
  })

  return { prompt: expanded, filesIncluded, filesNotFound }
}

function resolvePath(p: string, cwd: string): string | null {
  if (p.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    return path.join(home, p.slice(1))
  }
  if (path.isAbsolute(p)) return p
  return path.join(cwd, p)
}
