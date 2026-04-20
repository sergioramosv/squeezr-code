import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Comandos custom del usuario, estilo "skills" de Claude Code.
 *
 * Ubicación:
 *   - ~/.squeezr-code/commands/<name>.md     (user-level, todos los proyectos)
 *   - <cwd>/.squeezr/commands/<name>.md       (project-level, opcional)
 *
 * Estructura del .md:
 *   ```md
 *   ---
 *   description: Brief description shown in /help
 *   ---
 *   El cuerpo del .md es el prompt que se envía al modelo cuando el usuario
 *   ejecuta `/<name>`. Puede usar `$ARGS` para inyectar lo que el usuario
 *   escriba tras el comando: `/review src/foo.ts` → `$ARGS = "src/foo.ts"`.
 *   ```
 *
 * Sin frontmatter el primer párrafo se usa como description.
 */

export interface CustomCommand {
  name: string
  description: string
  prompt: string
  source: string  // path al fichero
}

/**
 * Instala las skills predefinidas del paquete en ~/.squeezr-code/commands/
 * si no existen ya. Se llama al primer arranque.
 */
export function installBuiltinSkills(): void {
  const dest = path.join(os.homedir(), '.squeezr-code', 'commands')
  fs.mkdirSync(dest, { recursive: true })

  // Buscar skills/ relativo al directorio del paquete instalado
  const candidates = [
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'skills'),
    path.join(process.cwd(), 'skills'),
  ]
  for (const skillsDir of candidates) {
    if (!fs.existsSync(skillsDir)) continue
    try {
      for (const f of fs.readdirSync(skillsDir)) {
        if (!f.endsWith('.md')) continue
        const destFile = path.join(dest, f)
        // Solo instalar si no existe (no sobreescribir personalizaciones del usuario)
        if (!fs.existsSync(destFile)) {
          fs.copyFileSync(path.join(skillsDir, f), destFile)
        }
      }
    } catch { /* best-effort */ }
    break
  }
}

export function loadCustomCommands(cwd: string): CustomCommand[] {
  const out: CustomCommand[] = []
  const seen = new Set<string>()

  const dirs = [
    path.join(os.homedir(), '.squeezr-code', 'commands'),
    path.join(cwd, '.squeezr', 'commands'),
  ]
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue
        const name = f.slice(0, -3)
        if (seen.has(name)) continue  // user-level gana sobre project en colisión
        try {
          const text = fs.readFileSync(path.join(dir, f), 'utf-8')
          const cmd = parseCommand(name, text, path.join(dir, f))
          if (cmd) {
            out.push(cmd)
            seen.add(name)
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return out
}

function parseCommand(name: string, text: string, source: string): CustomCommand | null {
  // Frontmatter ---\nfield: value\n---
  let body = text
  let description = ''
  const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text)
  if (fmMatch) {
    body = text.slice(fmMatch[0].length)
    const fm = fmMatch[1]
    const descMatch = /description:\s*(.+)/.exec(fm)
    if (descMatch) description = descMatch[1].trim()
  }
  if (!description) {
    // Toma la primera línea no vacía como description
    const firstLine = body.split('\n').find(l => l.trim().length > 0)
    description = firstLine ? firstLine.trim().slice(0, 80) : `Custom command from ${path.basename(source)}`
  }
  return { name, description, prompt: body.trim(), source }
}

/**
 * Expande un comando custom: sustituye `$ARGS` por lo que el usuario escribió
 * tras `/<cmd>`. Si no hay $ARGS, devuelve el cuerpo tal cual + args al final.
 */
export function expandCustomCommand(cmd: CustomCommand, args: string): string {
  if (cmd.prompt.includes('$ARGS')) {
    return cmd.prompt.replace(/\$ARGS/g, args)
  }
  return args ? `${cmd.prompt}\n\n${args}` : cmd.prompt
}
