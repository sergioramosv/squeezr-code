import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

/**
 * Hooks system: scripts del usuario que sq ejecuta en momentos específicos.
 *
 * Configuración en `~/.squeezr-code/settings.json` o `<cwd>/sq.toml`:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         { "matcher": "Bash", "command": "echo 'Bash about to run: ${input.command}'" }
 *       ],
 *       "PostToolUse": [
 *         { "matcher": "Edit", "command": "prettier --write ${input.file_path}" }
 *       ],
 *       "UserPromptSubmit": [
 *         { "command": "echo \"$(date) $1\" >> ~/.squeezr-code/prompts.log" }
 *       ],
 *       "Stop": [
 *         { "command": "notify-send 'sq turn done'" }
 *       ]
 *     }
 *   }
 *
 * El `matcher` es opcional (regex sobre el nombre del tool). Si no hay matcher,
 * el hook se ejecuta para todas las invocaciones.
 *
 * Variables disponibles:
 *   - $1                   primer arg (el prompt para UserPromptSubmit, etc)
 *   - ${input.<field>}     accede a campos del tool input (Bash command, Edit file_path, etc)
 *   - SQ_TOOL_NAME, SQ_CWD env vars
 *
 * Hooks se ejecutan async, no bloquean el agente. Failures son silenciosos
 * (a menos que DEBUG_HOOKS=1).
 */

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'Notification'

export interface HookSpec {
  matcher?: string
  command: string
}

export interface HooksConfig {
  PreToolUse?: HookSpec[]
  PostToolUse?: HookSpec[]
  UserPromptSubmit?: HookSpec[]
  Stop?: HookSpec[]
  Notification?: HookSpec[]
}

export class HookRunner {
  constructor(private hooks: HooksConfig) {}

  /** Ejecuta todos los hooks configurados para un evento. Fire-and-forget. */
  fire(event: HookEvent, opts: { toolName?: string; input?: Record<string, unknown>; arg?: string; cwd?: string }): void {
    const specs = this.hooks[event] || []
    for (const spec of specs) {
      if (spec.matcher && opts.toolName) {
        try {
          if (!new RegExp(spec.matcher).test(opts.toolName)) continue
        } catch { /* regex inválida → match todo */ }
      }
      this.run(spec, opts)
    }
  }

  private run(spec: HookSpec, opts: { toolName?: string; input?: Record<string, unknown>; arg?: string; cwd?: string }): void {
    let cmd = spec.command
    // Sustituye ${input.field} con valores del input.
    if (opts.input) {
      cmd = cmd.replace(/\$\{input\.(\w+)\}/g, (_m, field: string) => {
        const v = (opts.input as Record<string, unknown>)[field]
        return v === undefined ? '' : String(v)
      })
    }
    const env = {
      ...process.env,
      SQ_TOOL_NAME: opts.toolName || '',
      SQ_CWD: opts.cwd || process.cwd(),
    }
    const isWin = process.platform === 'win32'
    const args = isWin ? ['/c', cmd] : ['-c', cmd]
    const shell = isWin ? 'cmd.exe' : '/bin/bash'
    try {
      const proc = spawn(shell, args, {
        cwd: opts.cwd || process.cwd(),
        env,
        stdio: process.env.DEBUG_HOOKS ? 'inherit' : 'ignore',
        detached: true,
      })
      proc.unref()
      // Si pasamos $1, lo escribimos a stdin
      if (opts.arg && proc.stdin) {
        try { proc.stdin.write(opts.arg) } catch { /* ignore */ }
        try { proc.stdin.end() } catch { /* ignore */ }
      }
    } catch { /* hook silencioso */ }
  }
}

/** Carga hooks desde settings.json del user-level. */
export function loadHooks(): HooksConfig {
  const file = path.join(os.homedir(), '.squeezr-code', 'settings.json')
  if (!fs.existsSync(file)) return {}
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return (data.hooks || {}) as HooksConfig
  } catch {
    return {}
  }
}
