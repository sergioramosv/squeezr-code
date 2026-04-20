import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveModelAlias } from './model-picker.js'
import { getLoadedModels } from '../api/models.js'
import { getVersion } from '../version.js'
import type { BrainState } from '../brain/brain.js'
import type { Provider } from '../errors.js'
import type { NormalizedMessage } from '../api/types.js'

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

export interface CommandContext {
  brain: { getState: () => BrainState; reset: () => void }
  model: string
  setModel: (model: string) => void
  /** Coste acumulado por modelo en la sesión actual. */
  costByModel: () => Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; usd: number }>
  /** Historial completo de la sesión (para /export, /context). */
  history: () => NormalizedMessage[]
  /** System prompt construido para esta sesión (para /context). */
  systemPrompt: () => string
  /** Path del fichero de sesión persistido (para /export default). */
  sessionId: () => string
  /** Getter/setter de style — para `/style`. */
  outputStyle?: () => string
  setOutputStyle?: (s: 'default' | 'concise' | 'explanatory') => void
  /** Estado de thinking collapse + toggle. */
  thinkingCollapsed?: () => boolean
  setThinkingCollapsed?: (v: boolean) => void
}

export interface CommandResultLogin {
  output: string
  exit?: boolean
  action: 'login'
  loginProvider: Provider
}

export interface CommandResult {
  /** Texto a mostrar. Puede estar vacío si `action` lanza algo interactivo. */
  output: string
  exit?: boolean
  /** Acción especial que el REPL debe gestionar (por ejemplo abrir el model picker). */
  action?: 'pick-model' | 'login' | 'compact' | 'mcp' | 'resume' | 'review' | 'undo' | 'sessions' | 'paste' | 'fork' | 'repeat' | 'search' | 'template' | 'clean' | 'router' | 'committee' | 'snippet' | 'summary' | 'cancel' | 'library' | 'gh' | 'redact' | 'airplane' | 'sticky' | 'dispatch' | 'squad' | 'tasklist'
  /** Provider sobre el que arrancar el OAuth flow (cuando action === 'login'). */
  loginProvider?: Provider
  /** Rango de git para `/review [rango]` (p.ej. `HEAD~3`). */
  reviewRange?: string
  /** Args crudos para `/sessions [list|prune N|retain N|off]`. */
  sessionsArgs?: string
  /** Prompt opcional que acompaña la imagen de `/paste [texto]`. */
  pasteArgs?: string
  /** Query para `/search`. */
  searchQuery?: string
  /** Args crudos para `/template`. */
  templateArgs?: string
  /** Arg de `/router on|off|show`. */
  routerArg?: string
  /** Prompt completo para `/committee`. */
  committeePrompt?: string
  /** Args crudos para `/snippet save|insert|list|delete`. */
  snippetArgs?: string
  /** Args crudos para `/library [name]`. */
  libraryArgs?: string
  /** Args crudos para `/gh pr NUMBER`. */
  ghArgs?: string
  /** Arg para `/redact on|off|status`. */
  redactArg?: string
  /** Arg para `/airplane on|off|status`. */
  airplaneArg?: string
  /** Arg para `/sticky list|clear|add PATH|remove PATH`. */
  stickyArg?: string
  /** Body entero de `/dispatch` (multi-línea). */
  dispatchBody?: string
  /** Args crudos de `/squad NAME [task...]` o `/squad list`. */
  squadArgs?: string
  /** Arg de `/tasklist [clean]`. */
  tasklistArg?: string
}

type CommandHandler = (args: string, ctx: CommandContext) => CommandResult

const commands: Record<string, CommandHandler> = {
  help: () => ({
    output: `Available commands:
  /model              Open interactive model picker (↑↓ + enter)
  /model <alias>      Switch model directly (/model opus, /model pro...)
  /model list         List all models
  /status             Context %, 5h / 7d subscription usage, model, cost
  /cost               Cost breakdown by model for this session
  /cost explain       Explain why you spent what you spent (with cache savings)
  /cost preview [p]   Estimate cost for next turn across ALL models
  /compact            Summarize history to keep going without filling the window
  /mcp                MCP server picker (↑↓ + enter to connect/disconnect, r to restart)
  /clear              Clear current turn context (doesn't touch history or auth)
  /login [provider]   OAuth reauth (provider = anthropic|openai|google; empty = current model's)
  /checkpoint [name]  Save checkpoint (coming soon)
  /restore [id]       Restore checkpoint (coming soon)
  /resume             Picker of saved sessions — resume a previous conversation
  /review [range]     PR-style review of current diff (default: staged+unstaged)
  /undo               Revert the last Edit/Write in this session
  /sessions           List saved sessions (count + size)
  /sessions prune [N] Delete sessions older than N days (default 90) + stubs
  /sessions retain N  Configure auto-pruning at N days on startup (0 = off)
  /paste [text]       Read image from clipboard and send it (with optional prompt)
  Alt+V · F2 · Ctrl+V Shortcuts: same as /paste (inserts [Image #N], keep typing)
  /style [s]          default/concise/explanatory — change response tone
  /history [N]        Show the last N turns of the session (default 20)
  /fork               Clone current session into a new one (explore without breaking the original)
  /repeat             Resend your last message (retry after a failure without typing again)
  /search <text>      Search <text> across all saved sessions
  /template save NAME PROMPT   Save template with $1, $2… placeholders
  /template use NAME [args...] Reuse template filling in placeholders
  /context tree                Visual breakdown of context with ASCII tree
  /router [on|off|show]        Auto-routing: classify prompt → haiku/sonnet/opus alone
  /committee <prompt>          Ask 3 models in parallel and synthesize
  /clean                       Delete sq's temporary files (with confirmation)
  /snippet save NAME           Save the last assistant message as a reusable snippet
  /snippet insert NAME         Insert snippet as a new prompt
  /snippet list                List saved snippets
  /env                         Show env vars sq reads
  /perf                        Tool duration table for this session
  /summary                     Ask the model for a TL;DR of the current session
  /cancel                      Discard the next queued message
  /library [name]              Pre-built prompt library (review-pr, explain, tests…)
  /gh pr NUMBER                Fetch a PR diff via gh CLI and use it as context
  /redact [on|off|status]      Mask API keys / tokens in your prompts before sending
  /airplane [on|off|status]    Local-only mode: block API calls and WebFetch/Search
  @@path.ts                    Sticky mention: path auto-included in subsequent turns
  /sticky [list|clear]         View/clear active sticky mentions
  /dispatch                    Multi-agent ad-hoc (body with @model: prompt per line)
  /squad NAME [task]           Persistent squad (built-ins: opinions, pr-review, build-and-test)
  /squad list                  List available squads
  /tasklist                    Show ALL tasks for this session
  /tasklist clean              Clear all tasks
  Ctrl+O                       Toggle thinking visibility (expand/collapse)
  Ctrl+T                       Toggle task list (expand/collapse)
  /help               Show this help
  /exit               Exit sq

One-off override:  @alias prompt  (e.g. @opus explain this file, @pro summarize this)
Autocomplete:      TAB on /xxx    ·    History: ↑/↓ (persistent across sessions)`,
  }),

  exit: () => ({ output: 'Goodbye!', exit: true }),
  quit: () => ({ output: 'Goodbye!', exit: true }),

  model: (args, ctx) => {
    const name = args.trim()
    // /model sin argumento → abre picker interactivo (lo resuelve el REPL).
    if (!name) return { output: '', action: 'pick-model' }

    // /model list → imprime la lista de disponibles sin abrir el picker.
    if (name === 'list' || name === 'ls') {
      const models = getLoadedModels()
      if (models.length === 0) {
        return { output: 'Models not loaded yet (being fetched from /v1/models). Try again in a few seconds.' }
      }
      const lines = models.map(m => {
        const current = m.id === ctx.model ? '● ' : '  '
        const status = m.implemented ? '' : '  (not implemented)'
        return `  ${current}${m.alias.padEnd(14)} ${m.label.padEnd(22)} ${m.id}${status}`
      })
      return { output: `Available models:\n${lines.join('\n')}` }
    }

    const resolved = resolveModelAlias(name)
    ctx.setModel(resolved)
    return { output: `Model changed to: ${resolved}` }
  },

  status: (_args, ctx) => {
    const state = ctx.brain.getState()
    const totalTokens = state.totalInputTokens + state.totalOutputTokens
    const lines = [
      `  Model:      ${state.model}`,
      `  Context:    ${state.contextPercent}% (current turn, ~${totalTokens} accumulated tokens)`,
      `  Turns:      ${state.turnCount}`,
    ]
    const providerLabels = {
      anthropic: 'Claude',
      openai:    'ChatGPT / Codex',
      google:    'Gemini',
    } as const
    for (const provider of Object.keys(state.subscriptions) as Array<keyof typeof state.subscriptions>) {
      const sub = state.subscriptions[provider]
      if (!sub) continue
      // Cap to 100% — Anthropic returns values > 1.0 during burst allowance.
      const pct5h = Math.min(100, Math.round(sub.fiveHour * 100))
      const pct7d = Math.min(100, Math.round(sub.sevenDay * 100))
      const resetIn = formatResetIn(sub.fiveHourResetAt)
      const resetWeekIn = formatResetIn(sub.sevenDayResetAt)
      const label = providerLabels[provider]
      const plan = sub.plan ? ` [${sub.plan}]` : ''
      lines.push('')
      lines.push(`  ${label} subscription${plan} (${sub.status}):`)
      lines.push(`    5h window    ${pct5h}%   resets in ${resetIn}`)
      lines.push(`    Weekly       ${pct7d}%   resets in ${resetWeekIn}`)
      if (provider === 'anthropic') {
        const pct7dSonnet = Math.round(sub.sevenDaySonnet * 100)
        lines.push(`    Weekly Sonnet ${pct7dSonnet}%`)
      }
    }
    return { output: lines.join('\n') }
  },

  clear: (_args, ctx) => {
    ctx.brain.reset()
    return { output: '  \x1b[2mcontext cleared — turn 0\x1b[0m' }
  },

  compact: () => ({ output: '', action: 'compact' }),

  mcp: () => ({ output: '', action: 'mcp' }),

  context: (args, ctx) => {
    const state = ctx.brain.getState()
    const history = ctx.history()
    const sys = ctx.systemPrompt()
    const sysTokens = Math.ceil(sys.length / 4)
    let userTokens = 0, assistTokens = 0, toolTokens = 0
    let userCount = 0, assistCount = 0, toolCount = 0
    for (const m of history) {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      const t = Math.ceil(c.length / 4)
      if (m.role === 'user') { userTokens += t; userCount++ }
      else if (m.role === 'assistant') { assistTokens += t; assistCount++ }
      else if (m.role === 'tool') { toolTokens += t; toolCount++ }
    }
    const total = sysTokens + userTokens + assistTokens + toolTokens

    // `/context tree` — desglose visual con árbol ASCII.
    if (args.trim() === 'tree') {
      // Subseccionar el system prompt buscando marcadores.
      const memoryMatch = sys.match(/Project memory:\s*\n([\s\S]*?)(?:\n\n|$)/)
      const memoryLen = memoryMatch ? memoryMatch[1].length : 0
      const memoryTokens = Math.ceil(memoryLen / 4)
      const gitMatch = sys.match(/Git branch:\s*(\S+)/)
      const gitLine = gitMatch ? gitMatch[0] : ''
      const baseTokens = Math.max(0, sysTokens - memoryTokens - Math.ceil(gitLine.length / 4))
      // Estimación de tools defs — no las tenemos directo, asumimos ~3500 tok para los 22 built-in.
      const toolsTokens = 3500
      const contextLimit = 200_000
      const pct = Math.round((total / contextLimit) * 100)
      const bar = (n: number) => {
        const w = Math.round((n / total) * 40)
        return `\x1b[36m${'█'.repeat(w)}${'░'.repeat(Math.max(0, 40 - w))}\x1b[0m`
      }
      const lines = [
        `  \x1b[1mContext breakdown\x1b[0m  \x1b[2m${total.toLocaleString()} tok · ${pct}% of ${contextLimit.toLocaleString()}\x1b[0m`,
        '',
        `  \x1b[1mSystem prompt\x1b[0m  ${bar(sysTokens)}  ${sysTokens.toString().padStart(6)} tok`,
        `  ├─ Base instructions             ${baseTokens.toString().padStart(6)} tok`,
        `  ├─ Memory (SQUEEZR.md/CLAUDE.md) ${memoryTokens.toString().padStart(6)} tok`,
        `  └─ cwd + git                     ${Math.ceil(gitLine.length / 4).toString().padStart(6)} tok`,
        '',
        `  \x1b[1mTool definitions\x1b[0m  ${bar(toolsTokens)}  ~${toolsTokens.toString().padStart(5)} tok  \x1b[2m(cached)\x1b[0m`,
        '',
        `  \x1b[1mHistory\x1b[0m  ${bar(userTokens + assistTokens + toolTokens)}  ${(userTokens + assistTokens + toolTokens).toString().padStart(6)} tok`,
        `  ├─ User turns      ${userCount.toString().padStart(3)} msg   ${userTokens.toString().padStart(6)} tok`,
        `  ├─ Assistant turns ${assistCount.toString().padStart(3)} msg   ${assistTokens.toString().padStart(6)} tok`,
        `  └─ Tool results    ${toolCount.toString().padStart(3)} items ${toolTokens.toString().padStart(6)} tok`,
        '',
        `  \x1b[2mEvery turn, ALL of this goes to the model. Use /compact as you approach the limit.\x1b[0m`,
      ]
      return { output: lines.join('\n') }
    }
    const lines = [
      `  \x1b[1mContext window — ${total} estimated tokens\x1b[0m`,
      `    \x1b[2msystem prompt   :\x1b[0m  ${sysTokens.toString().padStart(6)} tok`,
      `    \x1b[2mhistory user    :\x1b[0m  ${userTokens.toString().padStart(6)} tok  (${userCount} msgs)`,
      `    \x1b[2mhistory assist  :\x1b[0m  ${assistTokens.toString().padStart(6)} tok  (${assistCount} msgs)`,
      `    \x1b[2mhistory tool    :\x1b[0m  ${toolTokens.toString().padStart(6)} tok  (${toolCount} results)`,
      `  ${'─'.repeat(50)}`,
      `    \x1b[1mTotal           :\x1b[0m  ${total.toString().padStart(6)} tok`,
      `    \x1b[2mWindow usage    :\x1b[0m  ${state.contextPercent}%`,
    ]
    return { output: lines.join('\n') }
  },

  export: (args, ctx) => {
    const arg = args.trim()
    const sid = ctx.sessionId()
    const defaultName = `sq-${sid.slice(0, 13)}.md`
    const outPath = arg
      ? (path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg))
      : path.join(process.cwd(), defaultName)
    const isJson = outPath.endsWith('.json')
    const history = ctx.history()
    let content: string
    if (isJson) {
      content = JSON.stringify({ sessionId: sid, model: ctx.model, messages: history }, null, 2)
    } else {
      const lines: string[] = [`# squeezr-code session ${sid.slice(0, 13)}`, ``, `**Model:** ${ctx.model}`, ``]
      for (const m of history) {
        const c = typeof m.content === 'string'
          ? m.content
          : (m.content as unknown as Array<Record<string, unknown>>)
              .map(b => b.type === 'text' ? (b.text as string) : `\`[${b.type}]\``)
              .join(' ')
        const heading = m.role === 'user' ? '## User' : m.role === 'assistant' ? '## Assistant' : '## Tool result'
        lines.push(heading, '', c, '')
      }
      content = lines.join('\n')
    }
    try {
      fs.writeFileSync(outPath, content)
      return { output: `  \x1b[32m✓\x1b[0m exported to \x1b[36m${outPath}\x1b[0m  (${history.length} messages)` }
    } catch (err) {
      return { output: `  \x1b[31m✖\x1b[0m could not write ${outPath}: ${err instanceof Error ? err.message : err}` }
    }
  },

  'release-notes': () => {
    const candidates = [
      path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', 'CHANGELOG.md'),
      path.join(process.cwd(), 'CHANGELOG.md'),
      path.join(os.homedir(), '..', 'CHANGELOG.md'),
    ]
    let changelogPath: string | null = null
    for (const c of candidates) {
      if (fs.existsSync(c)) { changelogPath = c; break }
    }
    if (!changelogPath) {
      return { output: `  \x1b[33m⚠\x1b[0m CHANGELOG.md not found.\n  squeezr-code v${getVersion()}` }
    }
    try {
      const text = fs.readFileSync(changelogPath, 'utf-8')
      // Extrae solo la sección de la versión actual.
      const ver = getVersion()
      const re = new RegExp(`^##\\s*\\[${ver.replace(/\\./g, '\\\\.')}\\][\\s\\S]*?(?=^##\\s*\\[)`, 'm')
      const match = re.exec(text)
      const section = match ? match[0].trim() : `# squeezr-code v${ver}\n(no entry found in CHANGELOG)`
      return { output: section.split('\n').map(l => '  ' + l).join('\n') }
    } catch {
      return { output: `  \x1b[31m✖\x1b[0m could not read ${changelogPath}` }
    }
  },

  feedback: () => ({
    output: `  For feedback / bugs / ideas:\n` +
            `    \x1b[36mhttps://github.com/sergioramosv/squeezr-code/issues\x1b[0m\n` +
            `  or email: \x1b[36msergioramosv@gmail.com\x1b[0m`,
  }),

  cost: (args, ctx) => {
    const sub = args.trim().split(/\s+/)[0] || ''
    const byModel = ctx.costByModel()

    // `/cost explain` — desglose didáctico.
    if (sub === 'explain') {
      if (byModel.size === 0) {
        return { output: '  \x1b[2mNo cost recorded yet in this session.\x1b[0m' }
      }
      const lines = [
        `  \x1b[1mWhy did you spend what you spent?\x1b[0m`,
        '',
      ]
      let totalFull = 0, totalCached = 0, totalSaved = 0
      for (const [model, c] of byModel) {
        // Ratio de cached price según provider.
        const cacheRatio = model.startsWith('claude-') ? 0.1
          : model.startsWith('gemini-') ? 0.25
          : 0.5
        const fullInputCost = c.usd  // lo que pagaste
        const wouldHaveCost = c.cacheReadTokens > 0
          ? c.usd + (c.cacheReadTokens / 1_000_000) * ((1 - cacheRatio) * getInputPricePer1M(model))
          : c.usd
        const saved = wouldHaveCost - fullInputCost
        totalFull += fullInputCost
        totalCached += c.cacheReadTokens
        totalSaved += saved
        lines.push(`  \x1b[36m${model}\x1b[0m`)
        lines.push(`    input: \x1b[1m${c.inputTokens.toLocaleString()}\x1b[0m tok (${c.cacheReadTokens.toLocaleString()} cached = ${Math.round(cacheRatio * 100)}% price)`)
        lines.push(`    output: \x1b[1m${c.outputTokens.toLocaleString()}\x1b[0m tok`)
        lines.push(`    cost: \x1b[1m$${fullInputCost.toFixed(4)}\x1b[0m  ${saved > 0 ? `\x1b[2m(saved $${saved.toFixed(4)} thanks to cache)\x1b[0m` : ''}`)
        lines.push('')
      }
      lines.push(`  \x1b[2m─ summary ─\x1b[0m`)
      lines.push(`  Total spent: \x1b[1m$${totalFull.toFixed(4)}\x1b[0m`)
      if (totalSaved > 0) {
        const savedPct = Math.round((totalSaved / (totalFull + totalSaved)) * 100)
        lines.push(`  \x1b[32m✓ saved $${totalSaved.toFixed(4)} (${savedPct}%)\x1b[0m thanks to prompt caching · ${totalCached.toLocaleString()} cached tok`)
      }
      lines.push(``)
      lines.push(`  \x1b[2mTip: system prompt + tool definitions are cached between turns.\x1b[0m`)
      lines.push(`  \x1b[2mThe longer the session, the more you save (until /compact resets).\x1b[0m`)
      return { output: lines.join('\n') }
    }

    // `/cost preview [prompt]` — estimación del próximo turn.
    if (sub === 'preview') {
      const promptText = args.trim().slice('preview'.length).trim()
      const sys = ctx.systemPrompt()
      const history = ctx.history()
      const sysTokens = Math.ceil(sys.length / 4)
      let histTokens = 0
      for (const m of history) {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        histTokens += Math.ceil(c.length / 4)
      }
      const promptTokens = Math.ceil((promptText || 'hello').length / 4)
      const totalIn = sysTokens + histTokens + promptTokens
      const estOut = 500  // estimación pesimista
      const models = ['claude-opus-4-6-20260301', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'gpt-5', 'gpt-5-codex', 'gemini-3.1-pro-high']
      const lines = [
        `  \x1b[1mNext turn preview\x1b[0m  \x1b[2m· ~${totalIn.toLocaleString()} tok in + ~${estOut} tok out estimated\x1b[0m`,
        '',
      ]
      for (const model of models) {
        const cacheRatio = model.startsWith('claude-') ? 0.1 : model.startsWith('gemini-') ? 0.25 : 0.5
        const inPrice = getInputPricePer1M(model)
        const outPrice = getOutputPricePer1M(model)
        // Asumimos que system+history (todo menos el nuevo prompt) ya está cacheado desde turnos previos.
        const cachedTokens = Math.max(0, totalIn - promptTokens)
        const fullTokens = promptTokens
        const inCost = (fullTokens / 1_000_000) * inPrice + (cachedTokens / 1_000_000) * inPrice * cacheRatio
        const outCost = (estOut / 1_000_000) * outPrice
        const total = inCost + outCost
        const short = shortModelLabel(model)
        const active = model === ctx.model ? '\x1b[32m❯ ' : '  '
        lines.push(`  ${active}${short.padEnd(18)}\x1b[0m $${total.toFixed(4)}  \x1b[2m(${inCost > outCost ? 'in-heavy' : 'out-heavy'})\x1b[0m`)
      }
      lines.push('')
      lines.push(`  \x1b[2mTip: @haiku prompt for a one-off override if something is simple.\x1b[0m`)
      return { output: lines.join('\n') }
    }

    // `/cost` — desglose clásico.
    if (byModel.size === 0) {
      return { output: '  \x1b[2mNo cost recorded yet in this session.\x1b[0m' }
    }
    const lines = ['  \x1b[1mCost of this session\x1b[0m  \x1b[2m(cached = tokens served from prompt cache)\x1b[0m']
    let totalUsd = 0, totalIn = 0, totalOut = 0, totalCache = 0
    for (const [model, c] of byModel) {
      totalUsd += c.usd
      totalIn += c.inputTokens
      totalOut += c.outputTokens
      totalCache += c.cacheReadTokens
      const cachePct = c.inputTokens > 0 ? Math.round((c.cacheReadTokens / c.inputTokens) * 100) : 0
      const cacheTag = c.cacheReadTokens > 0 ? `  \x1b[32m${cachePct}% cached\x1b[0m` : ''
      lines.push(
        `    ${model.padEnd(28)} ${String(c.inputTokens).padStart(8)} in ${String(c.outputTokens).padStart(8)} out   $${c.usd.toFixed(4)}${cacheTag}`,
      )
    }
    lines.push('    ' + '─'.repeat(60))
    const totalCachePct = totalIn > 0 ? Math.round((totalCache / totalIn) * 100) : 0
    const cacheSummary = totalCache > 0 ? `  \x1b[32m${totalCachePct}% cached\x1b[0m` : ''
    lines.push(`    ${'TOTAL'.padEnd(28)} ${String(totalIn).padStart(8)} in ${String(totalOut).padStart(8)} out   $${totalUsd.toFixed(4)}${cacheSummary}`)
    return { output: lines.join('\n') }
  },

  usage: () => {
    // Estadísticas agregadas de TODAS las sesiones guardadas.
    const sessionsDir = path.join(os.homedir(), '.squeezr-code', 'sessions')
    if (!fs.existsSync(sessionsDir)) {
      return { output: '  \x1b[2mNo saved sessions yet.\x1b[0m' }
    }
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'))
    if (files.length === 0) {
      return { output: '  \x1b[2mNo saved sessions yet.\x1b[0m' }
    }
    let totalMsgs = 0
    const byModel = new Map<string, number>()
    const byDay = new Map<string, number>()
    let oldest = Date.now(), newest = 0
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8')) as {
          model: string
          messages: NormalizedMessage[]
          createdAt: number
          updatedAt: number
        }
        totalMsgs += data.messages.length
        byModel.set(data.model, (byModel.get(data.model) || 0) + 1)
        const day = new Date(data.createdAt).toISOString().slice(0, 10)
        byDay.set(day, (byDay.get(day) || 0) + 1)
        if (data.createdAt < oldest) oldest = data.createdAt
        if (data.updatedAt > newest) newest = data.updatedAt
      } catch { /* skip */ }
    }
    const lines = ['  \x1b[1mUsage stats — all sessions\x1b[0m']
    lines.push(`    \x1b[2mSessions      :\x1b[0m  ${files.length}`)
    lines.push(`    \x1b[2mTotal messages:\x1b[0m  ${totalMsgs}`)
    lines.push(`    \x1b[2mSince         :\x1b[0m  ${new Date(oldest).toISOString().slice(0, 10)}`)
    lines.push('')
    lines.push('  \x1b[2mBy model:\x1b[0m')
    for (const [model, n] of Array.from(byModel.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      lines.push(`    \x1b[35m${model.padEnd(28)}\x1b[0m  ${n} sessions`)
    }
    lines.push('')
    lines.push('  \x1b[2mBy day (last 7):\x1b[0m')
    for (const [day, n] of Array.from(byDay.entries()).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7)) {
      lines.push(`    ${day}  ${'█'.repeat(Math.min(n, 30))} ${n}`)
    }
    return { output: lines.join('\n') }
  },

  login: (args, ctx) => {
    const requested = args.trim().toLowerCase()
    const valid: Provider[] = ['anthropic', 'openai', 'google']
    let provider: Provider
    if (!requested) {
      // Sin argumento → infiere del modelo actual.
      provider = inferProviderFromModel(ctx.model)
    } else if ((valid as string[]).includes(requested)) {
      provider = requested as Provider
    } else {
      return { output: `  \x1b[31m✖\x1b[0m invalid provider: ${requested}. Use: /login [anthropic|openai|google]` }
    }
    return { output: '', action: 'login', loginProvider: provider }
  },

  checkpoint: () => ({ output: 'Checkpoints coming in Phase 2' }),
  restore: () => ({ output: 'Restore coming in Phase 2' }),

  resume: () => ({ output: '', action: 'resume' }),
  review: (args) => ({ output: '', action: 'review', reviewRange: args.trim() || undefined }),
  undo: () => ({ output: '', action: 'undo' }),
  sessions: (args) => ({ output: '', action: 'sessions', sessionsArgs: args.trim() }),
  paste: (args) => ({ output: '', action: 'paste', pasteArgs: args.trim() }),
  fork: () => ({ output: '', action: 'fork' }),
  repeat: () => ({ output: '', action: 'repeat' }),
  search: (args) => ({ output: '', action: 'search', searchQuery: args.trim() }),
  template: (args) => ({ output: '', action: 'template', templateArgs: args.trim() }),
  clean: () => ({ output: '', action: 'clean' }),
  router: (args) => ({ output: '', action: 'router', routerArg: args.trim() }),
  committee: (args) => ({ output: '', action: 'committee', committeePrompt: args.trim() }),
  snippet: (args) => ({ output: '', action: 'snippet', snippetArgs: args.trim() }),
  env: () => ({ output: renderEnv(), exit: false }),
  perf: () => ({ output: renderPerf() }),
  summary: () => ({ output: '', action: 'summary' }),
  cancel: () => ({ output: '', action: 'cancel' }),
  library: (args) => ({ output: '', action: 'library', libraryArgs: args.trim() }),
  gh: (args) => ({ output: '', action: 'gh', ghArgs: args.trim() }),
  redact: (args) => ({ output: '', action: 'redact', redactArg: args.trim() }),
  airplane: (args) => ({ output: '', action: 'airplane', airplaneArg: args.trim() }),
  sticky: (args) => ({ output: '', action: 'sticky', stickyArg: args.trim() }),
  dispatch: (args) => ({ output: '', action: 'dispatch', dispatchBody: args }),
  squad: (args) => ({ output: '', action: 'squad', squadArgs: args.trim() }),
  tasklist: (args) => ({ output: '', action: 'tasklist', tasklistArg: args.trim() }),

  history: (args, ctx) => {
    const history = ctx.history()
    if (history.length === 0) {
      return { output: '  \x1b[2mEmpty session — no turns yet.\x1b[0m' }
    }
    const arg = args.trim()
    const limit = arg ? parseInt(arg, 10) : 20
    const userMsgs = history.filter(m => m.role === 'user')
    const assistantMsgs = history.filter(m => m.role === 'assistant')
    const lines: string[] = [
      `  \x1b[1mCurrent session\x1b[0m  \x1b[2m· ${userMsgs.length} user turns · ${assistantMsgs.length} responses\x1b[0m`,
      '',
    ]
    // Emparejamos user → assistant (puede haber tool_use en medio, los saltamos).
    let turnN = 0
    for (let i = 0; i < history.length; i++) {
      const m = history[i]
      if (m.role === 'user' && typeof m.content === 'string') {
        turnN++
        if (turnN > limit) {
          lines.push(`  \x1b[2m… (${userMsgs.length - limit} more turns)\x1b[0m`)
          break
        }
        const preview = m.content.length > 120 ? m.content.slice(0, 120) + '…' : m.content
        lines.push(`  \x1b[36m[${turnN}]\x1b[0m \x1b[2myou:\x1b[0m ${preview}`)
        // Encuentra la siguiente respuesta assistant con texto.
        for (let j = i + 1; j < history.length; j++) {
          const a = history[j]
          if (a.role !== 'assistant') continue
          const textBlock = Array.isArray(a.content)
            ? a.content.find(b => b.type === 'text')?.text
            : a.content
          if (typeof textBlock === 'string' && textBlock.trim()) {
            const short = textBlock.length > 120 ? textBlock.slice(0, 120) + '…' : textBlock
            lines.push(`      \x1b[2msq:\x1b[0m  ${short.replace(/\n/g, ' ').trim()}`)
            break
          }
        }
      }
    }
    return { output: lines.join('\n') }
  },

  style: (args, ctx) => {
    const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const arg = parts[0] || 'show'
    // /style thinking [expanded|collapsed]
    if (arg === 'thinking') {
      const val = parts[1] || 'show'
      if (val === 'show' || val === '') {
        return { output: `  thinking: \x1b[36m${ctx.thinkingCollapsed?.() ? 'collapsed' : 'expanded'}\x1b[0m\n  \x1b[2m/style thinking collapsed\x1b[0m — hide the reasoning (default)\n  \x1b[2m/style thinking expanded\x1b[0m — show all reasoning line by line` }
      }
      if (val !== 'expanded' && val !== 'collapsed') {
        return { output: `  \x1b[31m✖\x1b[0m usage: /style thinking expanded | collapsed` }
      }
      ctx.setThinkingCollapsed?.(val === 'collapsed')
      return { output: `  \x1b[32m✓\x1b[0m thinking → \x1b[36m${val}\x1b[0m` }
    }
    if (!arg || arg === 'show') {
      return { output: `  current style: \x1b[36m${ctx.outputStyle?.() || 'default'}\x1b[0m\n  thinking: \x1b[36m${ctx.thinkingCollapsed?.() ? 'collapsed' : 'expanded'}\x1b[0m\n  \x1b[2m/style default\x1b[0m — balanced (default)\n  \x1b[2m/style concise\x1b[0m — short responses, no preamble\n  \x1b[2m/style explanatory\x1b[0m — pedagogical, explains the why\n  \x1b[2m/style thinking expanded|collapsed\x1b[0m — reasoning visible or collapsed` }
    }
    if (!['default', 'concise', 'explanatory'].includes(arg)) {
      return { output: `  \x1b[31m✖\x1b[0m unknown style: ${arg}. Use: default | concise | explanatory | thinking` }
    }
    ctx.setOutputStyle?.(arg as 'default' | 'concise' | 'explanatory')
    return { output: `  \x1b[32m✓\x1b[0m style → \x1b[36m${arg}\x1b[0m` }
  },
}

/** Render de `/env` — env vars que sq usa. */
function renderEnv(): string {
  const vars = [
    'SQ_MODEL', 'SQ_PERMISSIONS', 'SQ_PROXY_PORT', 'SQ_MCP_AUTO_IMPORT',
    'SQ_DEBUG', 'SQ_VERBOSE', 'HOME', 'USERPROFILE',
  ]
  const lines = ['  \x1b[1mEnv vars sq reads\x1b[0m']
  for (const v of vars) {
    const val = process.env[v]
    const shown = val ? `\x1b[32m${val.length > 60 ? val.slice(0, 60) + '…' : val}\x1b[0m` : `\x1b[2m(unset)\x1b[0m`
    lines.push(`    ${v.padEnd(22)} ${shown}`)
  }
  lines.push('')
  lines.push(`  \x1b[2mNode:\x1b[0m ${process.version}  \x1b[2mplatform:\x1b[0m ${process.platform}  \x1b[2march:\x1b[0m ${process.arch}`)
  lines.push(`  \x1b[2mcwd:\x1b[0m ${process.cwd()}`)
  return lines.join('\n')
}

/** Render de `/perf` — tabla de duraciones por tool en la sesión actual. */
function renderPerf(): string {
  // Lazy load para evitar circular import
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getToolStats } = require('../tools/perf.js') as typeof import('../tools/perf.js')
  const stats = getToolStats()
  if (stats.length === 0) return '  \x1b[2mNo tools have been executed yet in this session.\x1b[0m'
  const lines = [
    `  \x1b[1mTool performance\x1b[0m  \x1b[2m(sorted by total time)\x1b[0m`,
    `  ${'tool'.padEnd(18)} ${'calls'.padStart(6)} ${'total'.padStart(9)} ${'avg'.padStart(8)} ${'max'.padStart(8)} ${'err'.padStart(4)}`,
    `  ${'─'.repeat(58)}`,
  ]
  for (const s of stats) {
    const avg = Math.round(s.totalMs / s.calls)
    const errTag = s.errors > 0 ? `\x1b[31m${s.errors}\x1b[0m` : `${s.errors}`
    lines.push(`  \x1b[36m${s.name.padEnd(18)}\x1b[0m ${String(s.calls).padStart(6)} ${(s.totalMs + 'ms').padStart(9)} ${(avg + 'ms').padStart(8)} ${(s.maxMs + 'ms').padStart(8)} ${errTag.padStart(4)}`)
  }
  return lines.join('\n')
}

/** Pricing per 1M tokens — keep en sync con agent.ts. */
function getInputPricePer1M(model: string): number {
  if (model.includes('opus')) return 15
  if (model.includes('sonnet')) return 3
  if (model.includes('haiku')) return 0.8
  if (model.includes('gpt-5-codex')) return 5
  if (model.includes('gpt-5')) return 5
  if (model.includes('o4-mini')) return 0.55
  if (model.includes('o3')) return 2
  if (model.includes('gpt-4')) return 2
  if (model.includes('gemini') && model.includes('pro')) return 1.25
  if (model.includes('gemini') && model.includes('flash')) return 0.15
  return 3
}
function getOutputPricePer1M(model: string): number {
  if (model.includes('opus')) return 75
  if (model.includes('sonnet')) return 15
  if (model.includes('haiku')) return 4
  if (model.includes('gpt-5-codex')) return 15
  if (model.includes('gpt-5')) return 15
  if (model.includes('o4-mini')) return 2.2
  if (model.includes('o3')) return 8
  if (model.includes('gpt-4')) return 8
  if (model.includes('gemini') && model.includes('pro')) return 10
  if (model.includes('gemini') && model.includes('flash')) return 0.6
  return 15
}
function shortModelLabel(model: string): string {
  const m = /claude-(opus|sonnet|haiku)-(\d+)-(\d+)/.exec(model)
  if (m) return `${m[1]} ${m[2]}.${m[3]}`
  if (model.startsWith('gpt-5-codex')) return 'gpt-5-codex'
  if (model.startsWith('gpt-5')) return 'gpt-5'
  const g = /gemini-(\d+(?:\.\d+)?)-(pro|flash)/.exec(model)
  if (g) return `gemini ${g[1]} ${g[2]}`
  return model.slice(0, 16)
}

function inferProviderFromModel(model: string): Provider {
  if (model.startsWith('claude-') || /haiku|sonnet|opus/.test(model)) return 'anthropic'
  if (model.startsWith('gemini-')) return 'google'
  return 'openai'
}

export function handleCommand(input: string, ctx: CommandContext): CommandResult | null {
  if (!input.startsWith('/')) return null
  const [cmd, ...rest] = input.slice(1).split(' ')
  const handler = commands[cmd]
  if (!handler) return { output: `Unknown command: /${cmd}. Type /help for available commands.` }
  return handler(rest.join(' '), ctx)
}
