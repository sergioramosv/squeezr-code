import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse as parseTOML } from 'smol-toml'

/**
 * Reglas granulares de permisos por tool.
 *
 *   allow: lista de patrones que se aprueban sin preguntar. Aceptan glob simple
 *          (`*`) y prefijo de tool (`Bash:git *` solo autoriza comandos git).
 *   deny:  lista de patrones que se rechazan sin preguntar. Mismo formato.
 *
 * Orden de evaluación: deny > allow > pregunta (si el modo global es `default`).
 */
export interface PermissionRules {
  allow?: string[]
  deny?: string[]
}

export interface McpServerSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface SqConfig {
  agent: {
    default: string
    /**
     * Modo de operación:
     *   - default       → pregunta antes de Bash/Write/Edit/NotebookEdit
     *   - accept-edits  → auto-aprueba edits (pregunta Bash)
     *   - plan          → solo-lectura (bloquea modifying tools)
     *   - bypass        → aprueba todo
     *   - auto, yolo    → aliases de bypass (legacy)
     * Se cambia en runtime con Shift+Tab.
     */
    permissions: 'default' | 'accept-edits' | 'plan' | 'bypass' | 'auto' | 'yolo'
  }
  permissions: PermissionRules
  /**
   * MCP servers a arrancar al iniciar el REPL. Declarados como [mcp.<name>]
   * en sq.toml — cada entrada es un subproceso stdio con JSON-RPC.
   *
   * NOTA: por defecto sq SOLO usa los MCPs declarados aquí. Si tienes MCPs
   * en Claude Code o Claude Desktop y quieres que sq también los use, ejecuta
   * `sq mcp import` (interactivo) o pon `auto_import = true` en sq.toml para
   * que sq los lea automáticamente al arrancar.
   */
  mcp: Record<string, McpServerSpec>
  /**
   * Si `true`, sq importa al arrancar los MCPs declarados en `~/.claude.json`,
   * `claude_desktop_config.json` y `<cwd>/.mcp.json`. Default: `false`.
   * Override puntual con env: `SQ_MCP_AUTO_IMPORT=1 sq`.
   */
  mcp_auto_import: boolean
  transplant: {
    mode: 'auto' | 'manual' | 'hybrid'
    warn_threshold: number
    auto_threshold: number
    strategy: 'replay' | 'summary' | 'hybrid'
    max_replay_messages: number
  }
  /**
   * Reservado para integración futura con `squeezr-ai` (compresión del
   * contexto vía proxy MITM). Hoy sq habla DIRECTO a las APIs sin proxy
   * intermedio — esta sección está aquí solo como placeholder para v0.13+.
   */
  proxy: {
    enabled: boolean
    port: number
  }
  economist: {
    enabled: boolean
    daily_budget: number
    warn_at: number
  }
  router: {
    enabled: boolean
    rules: Record<string, string>
  }
  display: {
    show_cost: boolean
    show_context: boolean
    show_router: boolean
    recaps: boolean
    /** Theme: dark | light | solarized | nord. Default: dark. */
    theme: string
    /** Modo vim para el input (readline editor: 'vi'). Default: false. */
    vim: boolean
    /** Símbolo del prompt. Default: ❯. Alternativas: ▸ ➜ $ > λ */
    prompt_char: string
    /** Banner ASCII al arrancar. Default: 'big'. Alternativas: 'compact', 'slant'. */
    banner_style: 'big' | 'compact' | 'slant'
    /**
     * EXPERIMENTAL — pinea el input al bottom del terminal con scroll region
     * (DECSTBM). Output scrollea arriba, prompt pegado abajo (estilo Claude
     * Code). Default: false — el renderer actual escribe a stdout sin
     * controlar cursor position, así que con scroll region activo el output
     * escribe en lugares raros. Hacer que funcione bien requiere refactor
     * grande del renderer (writeWrapped, markdown, spinner) para llamar a
     * positionOutputCursor antes de cada write. Pendiente para v0.15+.
     * Activar solo si quieres probar con un output corto.
     */
    pin_input_bottom: boolean
  }
  /** Comandos shell que aparecen en el status bar (con cache). */
  statusline: {
    commands: string[]
    refresh_seconds: number
  }
  /** Bash sandboxing opcional vía Docker. */
  sandbox: {
    enabled: boolean
    image: string
  }
  /**
   * Política de retención de sesiones. Default: no se borra nada
   * (mismo comportamiento que Claude Code). Ajustable con `/sessions retain N`.
   */
  sessions: {
    /** Si > 0, al arrancar sq borra sesiones con updatedAt > N días. 0 = off. */
    auto_prune_days: number
  }
  /**
   * Audit logs: JSONL append-only en ~/.squeezr-code/audit.log con cada tool
   * ejecutada (tool, input, output hash + preview, timestamp, cwd, sessionId).
   * Default OFF. Opt-in para B2B / compliance / debugging.
   */
  audit: {
    enabled: boolean
  }
  /**
   * Seguridad: redacción de secrets y airplane mode.
   *   - redact_prompts: enmascara API keys / tokens en TU prompt antes de mandar.
   *   - redact_tool_outputs: enmascara secrets que aparezcan en Read/Bash output
   *     antes de meter al contexto (default true, opt-out).
   *   - airplane: si true, bloquea todas las llamadas a la API + WebFetch/Search.
   */
  security: {
    redact_prompts: boolean
    redact_tool_outputs: boolean
    airplane: boolean
  }
}

const DEFAULTS: SqConfig = {
  agent: {
    default: 'sonnet',
    permissions: 'default',
  },
  permissions: {
    allow: [],
    deny: [],
  },
  mcp: {},
  mcp_auto_import: false,
  transplant: {
    mode: 'hybrid',
    warn_threshold: 80,
    auto_threshold: 75,
    strategy: 'replay',
    max_replay_messages: 30,
  },
  proxy: {
    enabled: true,
    port: 8080,
  },
  economist: {
    enabled: true,
    daily_budget: 0,
    warn_at: 0,
  },
  router: {
    enabled: false,
    rules: {},
  },
  display: {
    show_cost: true,
    show_context: true,
    show_router: true,
    recaps: false,
    theme: 'dark',
    vim: false,
    // Pin bottom = OFF por default. La implementación con scroll region
    // (DECSTBM) requiere que TODOS los writes del renderer pasen por
    // screen.writeOutput, pero varios escapan (banner, erase del prompt
    // multi-línea, readline echo) y corrompen el layout. Rewrite con ink
    // pendiente — task #94. Quien quiera probarlo, flip en config.toml.
    pin_input_bottom: false,
    prompt_char: '❯',
    banner_style: 'big',
  },
  statusline: {
    commands: [],
    refresh_seconds: 30,
  },
  sandbox: {
    enabled: false,
    image: 'node:20-alpine',
  },
  sessions: {
    auto_prune_days: 0,  // 0 = no prune (guarda todas indefinidamente)
  },
  audit: {
    enabled: false,  // default OFF
  },
  security: {
    redact_prompts: false,       // opt-in por configurabilidad
    redact_tool_outputs: true,   // default ON — poco coste, mucha seguridad
    airplane: false,             // default OFF
  },
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result = { ...base }
  for (const key of Object.keys(override)) {
    const val = override[key]
    if (val && typeof val === 'object' && !Array.isArray(val) && typeof (base as Record<string, unknown>)[key] === 'object') {
      (result as Record<string, unknown>)[key] = deepMerge(
        (base as Record<string, unknown>)[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      )
    } else {
      (result as Record<string, unknown>)[key] = val
    }
  }
  return result
}

function tryLoadTOML(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf-8')
    return parseTOML(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

export function loadConfig(cwd?: string): SqConfig {
  let config = { ...DEFAULTS } as Record<string, unknown>

  // 1. Global config: ~/.squeezr-code/config.toml
  const globalPath = path.join(os.homedir(), '.squeezr-code', 'config.toml')
  const globalConf = tryLoadTOML(globalPath)
  if (globalConf) config = deepMerge(config, globalConf)

  // 2. Local config: <project>/sq.toml
  const localPath = path.join(cwd || process.cwd(), 'sq.toml')
  const localConf = tryLoadTOML(localPath)
  if (localConf) config = deepMerge(config, localConf)

  const result = config as unknown as SqConfig

  // 3. Env overrides
  if (process.env.SQ_MODEL) result.agent.default = process.env.SQ_MODEL
  if (process.env.SQ_PROXY_PORT) result.proxy.port = parseInt(process.env.SQ_PROXY_PORT, 10)
  if (process.env.SQ_PERMISSIONS) result.agent.permissions = process.env.SQ_PERMISSIONS as SqConfig['agent']['permissions']
  if (process.env.SQ_MCP_AUTO_IMPORT) result.mcp_auto_import = process.env.SQ_MCP_AUTO_IMPORT !== '0' && process.env.SQ_MCP_AUTO_IMPORT.toLowerCase() !== 'false'

  // sq.toml usa `mcp_auto_import` flat o `[mcp_import] enabled = true` — soportamos ambos.
  // El parser de TOML mete `[mcp_import]` como objeto; flateamos el campo si existe.
  const raw = result as unknown as Record<string, unknown>
  const mcpImport = raw.mcp_import as { enabled?: boolean } | undefined
  if (mcpImport?.enabled !== undefined) result.mcp_auto_import = mcpImport.enabled

  return result
}
