import { APIClient } from '../api/client.js'
import { AuthManager } from '../auth/manager.js'
import { Brain } from '../brain/brain.js'
import { handleAPIError, sleep } from '../api/retry.js'
import { resolveModelAlias } from '../api/models.js'
import { SQ_TOOLS } from '../tools/definitions.js'
import { executeTool, resolveToolPermission } from '../tools/executor.js'
import { buildSystemPrompt } from './system.js'
import type { McpManager } from '../mcp/manager.js'
import { HookRunner, loadHooks } from './hooks.js'
import type {
  AgentEvent,
  AgentLoopOpts,
  NormalizedMessage,
  ToolResult,
  Provider,
} from '../api/types.js'

import type { PermissionRules } from '../config.js'

/**
 * Tools que pueden ejecutarse en paralelo sin problemas:
 *   - Read-only puros (Read, Grep, Glob) → no hay race conditions
 *   - WebFetch / WebSearch → red, no toca disco compartido
 *   - Task (sub-agentes) → sesión aislada, perfecto para paralelizar
 *   - Monitor → proceso separado con salida propia
 *
 * Tools NO parallel-safe (actúan como barrera — se esperan pendientes antes):
 *   - Write, Edit, NotebookEdit → pueden tocar el mismo fichero
 *   - Bash (foreground) → puede pedir permiso interactivo
 *   - AskUserQuestion → solo un picker a la vez
 *   - ExitPlanMode → el user aprueba una sola vez
 */
const PARALLEL_SAFE_TOOLS = new Set([
  'Read', 'Grep', 'Glob',
  'WebFetch', 'WebSearch',
  'Task',
  'Monitor',
  'BashOutput', 'KillShell',
  'TaskList', 'TaskGet',
])

/**
 * Directiva de estilo que se inyecta en el system prompt según la config de
 * `/style`. Se añade al appendSystemPrompt del turno.
 */
const STYLE_DIRECTIVES: Record<'default' | 'concise' | 'explanatory', string> = {
  default: '',
  concise: `OUTPUT STYLE — CONCISE:
Respond with the minimum viable answer. No preamble, no "sure, let me...", no summaries of what you just did unless explicitly asked. Skip explanations unless the user asks "why" or "how". One sentence is often enough. When showing code, show only the changed lines with minimal context. Prefer showing diffs / commands / snippets over prose.`,
  explanatory: `OUTPUT STYLE — EXPLANATORY:
Walk through your reasoning step-by-step as you work. For non-trivial tasks, briefly explain what each change does and why. Teach the concepts behind decisions when appropriate. Use short code comments for context. Aim to help a junior developer understand the work — not just complete it.`,
}

/**
 * Traduce keywords del prompt a budget de extended thinking (tokens).
 * Matcheo case-insensitive, busca como palabra completa para no falsar con
 * sustrings (ej. "rethink" NO cuenta como "think").
 *
 *   ultrathink / think harder   → 32k
 *   think hard                  → 10k
 *   think                       → 4k
 *   (nada)                      → 0 (sin thinking)
 *
 * Este patrón lo usa Claude Code. Ahorra al usuario tener que tocar flags.
 */
function detectThinkingBudget(prompt: string): number {
  const p = prompt.toLowerCase()
  if (/\bultrathink\b/.test(p)) return 32_000
  if (/\bthink\s+harder\b/.test(p)) return 32_000
  if (/\bthink\s+hard\b/.test(p)) return 10_000
  if (/\bthink\b/.test(p)) return 4_000
  return 0
}

export interface AgentConfig {
  defaultModel: string
  permissions: 'default' | 'accept-edits' | 'plan' | 'bypass' | 'auto' | 'yolo'
  /** Reglas granulares allow/deny del sq.toml. */
  rules?: PermissionRules
  transplant: {
    warnThreshold: number
    autoThreshold: number
  }
  /** Si generar recap LLM tras turnos largos. Default true. */
  recaps?: boolean
  /** Sandbox Docker para Bash tool. Default: deshabilitado. */
  sandbox?: { enabled: boolean; image: string }
  /**
   * System prompt extra que se appende al prompt base. Usado por sub-agentes
   * persistentes (`Task subagent_type=X`) para inyectar el system prompt del
   * agente definido en `~/.squeezr-code/agents/X.md`.
   */
  appendSystemPrompt?: string
  /**
   * Estilo de respuesta. Se traduce a una directiva extra en el system prompt.
   *   - default      → sin modificación
   *   - concise      → respuestas cortas, minimalistas, sin explicaciones
   *   - explanatory  → respuestas pedagógicas con razonamiento paso a paso
   */
  outputStyle?: 'default' | 'concise' | 'explanatory'
  /**
   * Si está, restringe las tools que este agente puede usar. Names sin
   * prefijo de MCP. Útil para agentes especializados (ej: revisor de seguridad
   * solo puede Read/Grep/Glob).
   */
  toolsAllowed?: string[]
}

/**
 * SqAgent — el agente interno de squeezr-code.
 *
 * Todas las requests del REPL pasan por aquí. El agente:
 *   - Gestiona auth de los 3 providers (auto-reimport al expirar).
 *   - Rutea al adapter correcto por modelo.
 *   - Corre el bucle agéntico (call → tools → repeat) con retry y recovery.
 *   - Trackea % de contexto vía Brain.
 *   - Mantiene historial multi-turn entre prompts.
 *   - Genera recaps LLM tras turnos largos.
 *   - Integra tools del MCP manager si está inyectado.
 *
 * (Antes se llamaba `SqProxy` porque el plan original era rutear a través
 * de squeezr-ai como proxy MITM. Ese camino se abandonó: sq habla directo a
 * las APIs con OAuth de suscripción. Renombrado en v0.12.4 para no confundir.)
 */
export interface ModelCostEntry {
  inputTokens: number
  outputTokens: number
  /** Tokens servidos desde cache — se cobran ~50% (OpenAI/Gemini) o ~10% (Anthropic) del input price. */
  cacheReadTokens: number
  usd: number
}

export class SqAgent {
  private apiClient: APIClient
  private auth: AuthManager
  private brain: Brain
  private config: AgentConfig
  private currentModel: string
  private currentProvider: Provider
  private totalCostUsd = 0
  /** Coste acumulado por modelo en la sesión actual (para /cost). */
  private costByModel = new Map<string, ModelCostEntry>()
  /** Historial multi-turn persistente entre prompts del REPL. */
  private conversationHistory: NormalizedMessage[] = []
  /** Último system prompt construido (para /context). */
  private lastSystemPrompt = ''
  /** Listener opcional para que el REPL persista la sesión tras cada turno. */
  private onTurnComplete: ((messages: NormalizedMessage[]) => void) | null = null

  /** Manager de MCP servers (opcional — se inyecta desde el REPL tras arrancarlos). */
  private mcp: McpManager | null = null
  /** Runner de hooks user-level (PreToolUse, PostToolUse, etc). */
  private hooks = new HookRunner(loadHooks())

  constructor(auth: AuthManager, config: AgentConfig) {
    this.auth = auth
    this.config = config
    // Resolve aliases ("sonnet", "opus-4.7", "5-codex") to full provider IDs
    // up front, so the literal alias never reaches the provider API (→ 404).
    const resolved = resolveModelAlias(config.defaultModel)
    this.currentModel = resolved
    this.currentProvider = this.resolveProvider(resolved)
    this.brain = new Brain(resolved)
    // No external proxy — direct to APIs
    this.apiClient = new APIClient(auth, null)
  }

  /** Flag que corta el loop cuando el usuario pulsa Esc/Ctrl+C durante el turno. */
  private aborted = false

  /** Inyecta el MCP manager para que el agente vea sus tools. */
  setMcpManager(mcp: McpManager): void {
    this.mcp = mcp
  }

  /**
   * Aborta el turno en curso. Cierra el adapter (cancela stream/WebSocket)
   * y marca el flag para que el loop del send() termine en la siguiente
   * iteración. Llamado desde el REPL cuando el usuario pulsa Esc o Ctrl+C
   * mientras sq está procesando.
   */
  abortCurrent(): void {
    this.aborted = true
    try {
      const adapter = this.apiClient.getAdapter(this.currentProvider)
      adapter.close()
    } catch { /* ignore */ }
  }

  /**
   * Send a user prompt through the full agentic loop.
   * Yields AgentEvents for the REPL to render.
   */
  async *send(
    prompt: string,
    opts?: {
      model?: string
      cwd?: string
      askPermission?: (name: string, input: Record<string, unknown>) => Promise<{ approved: boolean; explanation?: string }>
      /** Imágenes adjuntas al mensaje del usuario (clipboard paste o @foto.png). */
      attachments?: Array<{ base64: string; mediaType: string }>
    },
  ): AsyncGenerator<AgentEvent> {
    // Per-turn override (`@opus hola`) may arrive as an alias — resolve here
    // so downstream provider adapters always see a full model ID.
    const model = opts?.model ? resolveModelAlias(opts.model) : this.currentModel
    const provider = this.resolveProvider(model)
    const cwd = opts?.cwd || process.cwd()
    // Reset del abort flag al empezar el turno.
    this.aborted = false

    const adapter = this.apiClient.getAdapter(provider)
    // Style directive se añade al appendSystemPrompt para que vaya al sistema.
    const styleDirective = STYLE_DIRECTIVES[this.config.outputStyle || 'default'] || ''
    const combinedAppend = [styleDirective, this.config.appendSystemPrompt].filter(Boolean).join('\n\n')
    const systemPrompt = buildSystemPrompt({
      provider,
      model,
      cwd,
      permissions: this.config.permissions,
      appendSystemPrompt: combinedAppend || undefined,
    })
    this.lastSystemPrompt = systemPrompt

    // Para decidir si generar recap al final del turno.
    const turnStartedAt = Date.now()
    let turnToolCount = 0

    // Hook UserPromptSubmit — fire-and-forget al recibir el prompt del usuario.
    this.hooks.fire('UserPromptSubmit', { arg: prompt, cwd })

    // Multi-turn: arrancamos con el historial acumulado de turnos previos +
    // el nuevo prompt del usuario. Sin esto, el modelo no recuerda qué le
    // dijiste en el turno anterior.
    const messages: NormalizedMessage[] = [...this.conversationHistory]
    // Multimodal: si hay imágenes adjuntas, el user message va como array de
    // content blocks [image..., text]. Si no, string plano para no añadir
    // overhead a los turnos normales.
    if (opts?.attachments && opts.attachments.length > 0) {
      const blocks: import('../api/types.js').ContentBlock[] = opts.attachments.map(a => ({
        type: 'image' as const,
        imageBase64: a.base64,
        imageMediaType: a.mediaType,
      }))
      if (prompt) blocks.push({ type: 'text', text: prompt })
      messages.push({ role: 'user', content: blocks })
    } else {
      messages.push({ role: 'user', content: prompt })
    }

    let consecutiveErrors = 0

    while (true) {
      yield { type: 'api_call_start', timestamp: Date.now(), model }

      // Si el usuario abortó entre iteraciones del loop, salimos limpio.
      if (this.aborted) {
        yield { type: 'error', timestamp: Date.now(), error: 'Cancelled by user (Esc)' }
        yield { type: 'done', timestamp: Date.now() }
        return
      }

      // Merge tools built-in + MCP. Si config.toolsAllowed está, filtra solo
      // a ese subset (las MCP tools pasan tal cual — restringir por agente se
      // haría con `mcp_server__tool` en toolsAllowed).
      let baseTools = SQ_TOOLS
      if (this.config.toolsAllowed && this.config.toolsAllowed.length > 0) {
        const allowed = new Set(this.config.toolsAllowed)
        baseTools = SQ_TOOLS.filter(t => allowed.has(t.name))
      }
      const allTools = this.mcp
        ? [...baseTools, ...this.mcp.getAllTools()]
        : baseTools

      // Send request with retry
      try {
        // Extended thinking: si el usuario incluyó "think"/"think hard"/etc
        // en el prompt, traduce a budget de tokens. Solo aplica a Anthropic.
        const thinkingBudget = provider === 'anthropic' ? detectThinkingBudget(prompt) : 0
        await adapter.sendRequest({
          system: systemPrompt,
          messages,
          tools: allTools,
          model,
          stream: true,
          thinkingBudget,
        })
        consecutiveErrors = 0
      } catch (err) {
        consecutiveErrors++
        const recovery = handleAPIError(err, consecutiveErrors)
        yield { type: 'error', timestamp: Date.now(), error: recovery.message }
        if (recovery.action === 'retry') {
          await sleep(recovery.delayMs)
          continue
        }
        yield { type: 'done', timestamp: Date.now() }
        return
      }

      // Process stream
      let hasToolUse = false
      const toolResults: ToolResult[] = []
      const assistantContentBlocks: unknown[] = []
      let turnInputTokens = 0
      let turnOutputTokens = 0
      let turnCacheRead = 0

      // Paralelización de tools: si la tool es PARALLEL_SAFE, la ejecutamos
      // sin await y guardamos la promesa. Las tools sequential-only (Edit,
      // Write, Bash interactiva) actúan como barrera — antes de ejecutarlas,
      // esperamos todas las pendientes + las ejecutamos aisladas.
      //
      // Beneficio: 5 Task() / 5 WebFetch() / 5 Read() en la misma respuesta
      // del modelo ahora corren en paralelo en lugar de uno tras otro.
      type PendingTool = {
        id: string
        name: string
        input: Record<string, unknown>
        promise: Promise<{ result: string; isError: boolean }>
      }
      const pending: PendingTool[] = []

      const flushPending = async function* (self: SqAgent) {
        for (const p of pending) {
          const { result, isError } = await p.promise
          toolResults.push({ id: p.id, result, isError })
          self.hooks.fire('PostToolUse', { toolName: p.name, input: p.input, cwd })
          yield {
            type: 'tool_result' as const,
            timestamp: Date.now(),
            tool: { name: p.name, result },
            ...(isError ? { isError: true } : {}),
          }
        }
        pending.length = 0
      }

      const runToolAsync = async (
        name: string,
        input: Record<string, unknown>,
        /** true when the caller has already resolved the permission — skips
         *  the picker inside executeTool so it doesn't appear twice. */
        preApproved = false,
      ): Promise<{ result: string; isError: boolean }> => {
        try {
          const isMcp = this.mcp?.isMcpTool(name) || false
          const result = isMcp
            ? await this.mcp!.callTool(name, input)
            : await executeTool(name, input, {
              cwd,
              permissions: this.config.permissions,
              rules: this.config.rules,
              sandbox: this.config.sandbox,
              askPermission: opts?.askPermission,
              preApproved,
            })
          return { result, isError: false }
        } catch (toolErr) {
          const errorMsg = `Tool '${name}' failed: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`
          return { result: errorMsg, isError: true }
        }
      }

      try {
        for await (const chunk of adapter.receiveStream()) {
          // Corte instantáneo: si el usuario pulsó Ctrl+C, cualquier chunk
          // que llegue después (incluyendo los que ya estaban en buffer) se
          // descarta sin renderizar. Sale del loop → post-stream abort yield.
          if (this.aborted) break

          if (chunk.type === 'thinking') {
            yield { type: 'thinking', timestamp: Date.now(), text: chunk.text }
          }

          if (chunk.type === 'text') {
            assistantContentBlocks.push({ type: 'text', text: chunk.text })
            yield { type: 'text', timestamp: Date.now(), text: chunk.text }
          }

          if (chunk.type === 'tool_use') {
            hasToolUse = true
            turnToolCount++
            const toolInput = chunk.input || {}

            assistantContentBlocks.push({
              type: 'tool_use',
              id: chunk.id,
              name: chunk.name,
              input: toolInput,
            })

            this.hooks.fire('PreToolUse', { toolName: chunk.name!, input: toolInput, cwd })

            const isParallelSafe = PARALLEL_SAFE_TOOLS.has(chunk.name!)

            if (isParallelSafe) {
              // Parallel-safe tools never prompt — emit tool_start, fire-and-forget.
              yield {
                type: 'tool_start',
                timestamp: Date.now(),
                tool: { name: chunk.name!, input: toolInput },
              }
              pending.push({
                id: chunk.id!,
                name: chunk.name!,
                input: toolInput,
                promise: runToolAsync(chunk.name!, toolInput),
              })
            } else {
              // Barrera: espera todo lo pendiente antes de ejecutar sequential.
              yield* flushPending(this)

              // Resolve the permission BEFORE announcing the tool in the
              // scrollback. Otherwise the user sees "▸ Edit foo.ts" pop
              // up, the permission picker appears, and it looks as though
              // the edit already happened even though nothing has run yet.
              const isMcp = this.mcp?.isMcpTool(chunk.name!) || false
              let permission: { allowed: true } | { allowed: false; message: string } = { allowed: true }
              if (!isMcp) {
                permission = await resolveToolPermission(chunk.name!, toolInput, {
                  cwd,
                  permissions: this.config.permissions,
                  rules: this.config.rules,
                  sandbox: this.config.sandbox,
                  askPermission: opts?.askPermission,
                })
              }

              if (!permission.allowed) {
                // User denied (or a rule blocked it). Report the denial
                // without ever emitting tool_start — the user knows what
                // they just denied.
                toolResults.push({ id: chunk.id!, result: permission.message, isError: true })
                this.hooks.fire('PostToolUse', { toolName: chunk.name!, input: toolInput, cwd })
                yield {
                  type: 'tool_result',
                  timestamp: Date.now(),
                  tool: { name: chunk.name!, result: permission.message },
                  isError: true,
                }
                continue
              }

              // Permission granted → announce the tool and run it with
              // preApproved=true so executeTool doesn't prompt a second time.
              yield {
                type: 'tool_start',
                timestamp: Date.now(),
                tool: { name: chunk.name!, input: toolInput },
              }
              const { result, isError } = await runToolAsync(chunk.name!, toolInput, true)
              toolResults.push({ id: chunk.id!, result, isError })
              this.hooks.fire('PostToolUse', { toolName: chunk.name!, input: toolInput, cwd })
              yield {
                type: 'tool_result',
                timestamp: Date.now(),
                tool: { name: chunk.name!, result },
                ...(isError ? { isError: true } : {}),
              }
            }
          }

          if (chunk.type === 'usage' && chunk.usage) {
            turnInputTokens += chunk.usage.inputTokens
            turnOutputTokens += chunk.usage.outputTokens
            turnCacheRead += chunk.usage.cacheRead || 0
          }

          if (chunk.type === 'subscription' && chunk.subscription) {
            this.brain.setSubscription(chunk.subscription)
            yield {
              type: 'subscription',
              timestamp: Date.now(),
              subscription: chunk.subscription,
            }
          }
        }
        // Si el stream terminó por un adapter.close() (ej. Ctrl+C), la
        // iteración sale silenciosa sin throw → emite evento de abort AQUÍ,
        // antes de flushear pending tools (que ya no nos interesan porque
        // el user abortó todo).
        if (this.aborted) {
          yield { type: 'error', timestamp: Date.now(), error: 'Interrupted by user' }
          yield { type: 'done', timestamp: Date.now() }
          return
        }
        // Sin abort: drena tools parallel-safe pendientes.
        yield* flushPending(this)
      } catch (streamErr) {
        // Si fue por abort del usuario, salimos limpio sin error.
        if (this.aborted) {
          yield { type: 'error', timestamp: Date.now(), error: 'Interrupted by user' }
          yield { type: 'done', timestamp: Date.now() }
          return
        }
        consecutiveErrors++
        const recovery = handleAPIError(streamErr, consecutiveErrors)
        yield { type: 'error', timestamp: Date.now(), error: recovery.message }
        if (recovery.action === 'retry') {
          await sleep(recovery.delayMs)
          continue
        }
        yield { type: 'done', timestamp: Date.now() }
        return
      }

      // Update brain
      if (turnInputTokens || turnOutputTokens) {
        this.brain.addUsage(turnInputTokens, turnOutputTokens)
        const turnCost = this.estimateCost(model, turnInputTokens, turnOutputTokens, turnCacheRead)
        this.totalCostUsd += turnCost
        // Acumula por modelo para /cost.
        const prev = this.costByModel.get(model) || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, usd: 0 }
        this.costByModel.set(model, {
          inputTokens: prev.inputTokens + turnInputTokens,
          outputTokens: prev.outputTokens + turnOutputTokens,
          cacheReadTokens: prev.cacheReadTokens + turnCacheRead,
          usd: prev.usd + turnCost,
        })
        yield {
          type: 'cost',
          timestamp: Date.now(),
          usage: { inputTokens: turnInputTokens, outputTokens: turnOutputTokens, cacheRead: turnCacheRead },
          cost: { usd: this.totalCostUsd, model },
        }
      }

      // No tool use → done. Persistimos el turno completo en historial.
      if (!hasToolUse) {
        if (assistantContentBlocks.length > 0) {
          messages.push({ role: 'assistant', content: assistantContentBlocks as any })
        }
        this.conversationHistory = messages
        if (this.onTurnComplete) {
          try { this.onTurnComplete(this.conversationHistory) } catch { /* persist es best-effort */ }
        }
        // Context warnings
        const state = this.brain.getState()
        if (state.contextPercent >= this.config.transplant.warnThreshold) {
          yield {
            type: 'transplant',
            timestamp: Date.now(),
            contextPercent: state.contextPercent,
            text: `Context at ${state.contextPercent}%`,
          }
        }
        // Recap LLM-generado tras turnos largos. Umbral: > 60s con ≥2 tools,
        // o > 2min sin importar las tools. Con recaps=false en config se salta.
        const elapsedSec = (Date.now() - turnStartedAt) / 1000
        const recapsEnabled = this.config.recaps !== false
        const complex = elapsedSec > 300 && turnToolCount >= 3
        const veryLong = elapsedSec > 600
        if (recapsEnabled && (complex || veryLong)) {
          let recapText = ''
          try {
            for await (const piece of this.streamRecap(model, provider)) {
              recapText += piece
            }
          } catch { /* best-effort — si falla el recap, seguimos sin él */ }
          if (recapText.trim().length > 0) {
            yield {
              type: 'recap',
              timestamp: Date.now(),
              text: recapText.trim(),
              elapsedSec,
            }
          }
        }
        // Hook Stop — fire-and-forget al terminar el turno (sin tool_use).
        this.hooks.fire('Stop', { cwd })
        yield { type: 'done', timestamp: Date.now() }
        return
      }

      // Add assistant + tool results, continue loop.
      // Tool results se truncan a 20KB antes de guardarse en el historial:
      // se re-envían en cada turno siguiente y resultados grandes (Read de
      // ficheros enteros, bash output largo) inflan el contexto innecesariamente.
      const MAX_TOOL_RESULT_HISTORY = 5_000
      messages.push({ role: 'assistant', content: assistantContentBlocks as any })
      for (const tr of toolResults) {
        const result = tr.result.length > MAX_TOOL_RESULT_HISTORY
          ? tr.result.slice(0, MAX_TOOL_RESULT_HISTORY) + '\n... [truncated for context efficiency]'
          : tr.result
        messages.push({ role: 'tool', content: result, toolUseId: tr.id })
      }
    }
  }

  /**
   * Genera un recap del turno actual. Usa el mismo modelo y el historial
   * actualizado (post-turn) para pedir una frase corta de resumen.
   *
   * El recap NO se persiste en conversationHistory: es un ping transient.
   */
  private async *streamRecap(model: string, provider: Provider): AsyncIterable<string> {
    const adapter = this.apiClient.getAdapter(provider)
    const recapPrompt = `En 1-2 frases cortas (máx 200 chars), resume qué acabas de hacer en este turno y qué viene después. Formato estilo log entry: "<verbo en gerundio> <qué>. Next: <siguiente paso>." No narres, no uses segunda persona, no incluyas saludos. Solo la frase.`
    await adapter.sendRequest({
      system: 'Eres un asistente que condensa un turno de conversación en una línea de log. Devuelve SOLO la frase, nada más.',
      messages: [
        ...this.conversationHistory,
        { role: 'user', content: recapPrompt },
      ],
      tools: [],
      model,
      stream: true,
    })
    for await (const chunk of adapter.receiveStream()) {
      if (chunk.type === 'text' && chunk.text) {
        yield chunk.text
      }
    }
  }

  // --- Public getters for the REPL ---

  getBrainState() { return this.brain.getState() }
  getTotalCost() { return this.totalCostUsd }
  getCurrentModel() { return this.currentModel }
  getCurrentProvider() { return this.currentProvider }

  /** Cambia el modo de permisos en runtime (Shift+Tab del REPL). */
  setPermissionMode(mode: AgentConfig['permissions']): void {
    this.config.permissions = mode
  }
  setOutputStyle(style: AgentConfig['outputStyle']): void {
    this.config.outputStyle = style
  }
  getOutputStyle(): AgentConfig['outputStyle'] {
    return this.config.outputStyle || 'default'
  }
  getPermissionMode(): AgentConfig['permissions'] {
    return this.config.permissions
  }

  /** Borra contadores del Brain + historial multi-turn (lo que hace /clear). */
  resetBrain(): void {
    this.brain.reset()
    this.conversationHistory = []
    if (this.onTurnComplete) this.onTurnComplete([])
  }

  /** Snapshot del coste por modelo para `/cost`. */
  getCostByModel(): Map<string, ModelCostEntry> {
    return new Map(this.costByModel)
  }

  /** Historial completo (para persistencia de sesión). */
  getConversationHistory(): NormalizedMessage[] {
    return [...this.conversationHistory]
  }

  /** Último system prompt construido (para /context). */
  getLastSystemPrompt(): string {
    return this.lastSystemPrompt
  }

  /** Rehidrata historial desde una sesión persistida (sq resume).
   *  Trunca tool results a 5KB para sanear sesiones antiguas sin límite. */
  setConversationHistory(messages: NormalizedMessage[]): void {
    const MAX = 5_000
    this.conversationHistory = messages.map(m => {
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > MAX) {
        return { ...m, content: m.content.slice(0, MAX) + '\n... [truncated on resume]' }
      }
      return m
    })
  }

  /**
   * Tamaño estimado del historial en caracteres.
   * Útil para decidir si compactar antes del primer turno.
   */
  historyChars(): number {
    return JSON.stringify(this.conversationHistory).length
  }

  /** Hook que el REPL usa para persistir tras cada turno completo. */
  onPersist(cb: (messages: NormalizedMessage[]) => void): void {
    this.onTurnComplete = cb
  }

  /**
   * Comprime el historial: pide al modelo actual un resumen conciso de la
   * conversación y reemplaza el historial por un único par user+assistant con
   * el resumen. Úsalo cuando contexto > 70% para seguir sin perder hilo.
   *
   * Devuelve el texto del resumen para que el REPL lo muestre.
   */
  async *compact(): AsyncGenerator<AgentEvent, string> {
    if (this.conversationHistory.length === 0) {
      return 'No hay historial que comprimir.'
    }

    const provider = this.currentProvider
    const adapter = this.apiClient.getAdapter(provider)

    const compactPrompt = `Resume la conversación anterior en un formato estructurado y denso, preservando:
- Los objetivos del usuario y decisiones tomadas.
- Archivos que se leyeron o modificaron, con path completo.
- Comandos ejecutados y su resultado relevante.
- Errores encontrados y cómo se resolvieron.
- Estado actual del trabajo (qué está hecho, qué queda).

Escribe el resumen como si fuera un briefing para retomar el trabajo en una nueva sesión. No uses lenguaje conversacional. Lista punto por punto.`

    const messages: NormalizedMessage[] = [
      ...this.conversationHistory,
      { role: 'user', content: compactPrompt },
    ]

    yield { type: 'api_call_start', timestamp: Date.now(), model: this.currentModel }

    try {
      await adapter.sendRequest({
        system: 'Eres un asistente que condensa conversaciones largas en briefings estructurados.',
        messages,
        tools: [],
        model: this.currentModel,
        stream: true,
      })
    } catch (err) {
      yield { type: 'error', timestamp: Date.now(), error: err instanceof Error ? err.message : String(err) }
      yield { type: 'done', timestamp: Date.now() }
      return ''
    }

    let summary = ''
    for await (const chunk of adapter.receiveStream()) {
      if (chunk.type === 'text' && chunk.text) {
        summary += chunk.text
        yield { type: 'text', timestamp: Date.now(), text: chunk.text }
      }
      if (chunk.type === 'thinking' && chunk.text) {
        yield { type: 'thinking', timestamp: Date.now(), text: chunk.text }
      }
    }

    yield { type: 'done', timestamp: Date.now() }

    // Reemplaza el historial por un único par user+assistant con el resumen.
    // El user prompt explica qué contiene el resumen para que el modelo no se
    // sorprenda en el siguiente turno.
    this.conversationHistory = [
      {
        role: 'user',
        content: 'Este es un resumen estructurado de nuestra conversación anterior. Úsalo como contexto para los próximos turnos:',
      },
      {
        role: 'assistant',
        content: summary,
      },
    ]
    this.brain.reset()
    if (this.onTurnComplete) this.onTurnComplete(this.conversationHistory)
    return summary
  }

  setModel(model: string): void {
    // Accept aliases from slash commands, the model picker, persisted sessions,
    // etc. All internal bookkeeping uses the full ID so API requests never
    // 404 because of a bare "sonnet".
    const resolved = resolveModelAlias(model)
    this.currentModel = resolved
    this.currentProvider = this.resolveProvider(resolved)
    this.brain.setModel(resolved)
  }

  // --- Internal ---

  private resolveProvider(model: string): Provider {
    if (model.startsWith('claude-') || model.includes('haiku') || model.includes('sonnet') || model.includes('opus')) {
      return 'anthropic'
    }
    // Codex / OpenAI: gpt-5.4, gpt-5-codex, o3, o4-mini, o aliases sin prefijo (5.4-mini, 5-codex...)
    if (model.startsWith('gpt-') || model.startsWith('o3') || model.startsWith('o4') || /^\d/.test(model)) {
      return 'openai'
    }
    if (model.startsWith('gemini-')) {
      return 'google'
    }
    return 'anthropic'
  }

  private estimateCost(model: string, inputTokens: number, outputTokens: number, cacheRead = 0): number {
    // Pricing per 1M tokens
    const pricing: Record<string, { input: number; output: number }> = {
      'claude-opus-4-20250514': { input: 15.00, output: 75.00 },
      'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
      'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
      'o3': { input: 2.00, output: 8.00 },
      'o4-mini': { input: 0.55, output: 2.20 },
      'gpt-4.1': { input: 2.00, output: 8.00 },
      'gemini-2.5-pro': { input: 1.25, output: 10.00 },
      'gemini-2.5-flash': { input: 0.15, output: 0.60 },
    }
    const p = pricing[model] || { input: 3.00, output: 15.00 }
    // Cache reads se cobran al ratio del provider:
    //   Anthropic  → 10% del input price
    //   OpenAI     → 50% del input price
    //   Google     → 25% del input price (variable; usamos 25% como aproximación)
    const cacheRatio = model.startsWith('claude-') ? 0.1
      : model.startsWith('gemini-') ? 0.25
      : 0.5
    const fullInput = Math.max(0, inputTokens - cacheRead)
    const inputCost = (fullInput / 1_000_000) * p.input + (cacheRead / 1_000_000) * p.input * cacheRatio
    return inputCost + (outputTokens / 1_000_000) * p.output
  }

  shutdown(): void {
    this.apiClient.closeAll()
  }
}
