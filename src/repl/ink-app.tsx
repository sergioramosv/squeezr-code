/**
 * ink-app.tsx — Phase 2: full Ink-based REPL with pinned input at the bottom.
 *
 * Layout (always stable, never disrupted by agent output):
 *
 *   ┌────────────────────────────────────────────┐
 *   │  output lines (last N that fit)            │  scrollable area
 *   ├────────────────────────────────────────────┤
 *   │ project · ░░░░░░░░░░ 0% 5h · $0.01 · model│  status bar
 *   │   ↳ accept-edits · shift+tab               │  mode line
 *   ├────────────────────────────────────────────┤
 *   │ ❯ user input here                          │  input — ALWAYS VISIBLE
 *   └────────────────────────────────────────────┘
 *
 * Features:
 *  - Streaming: for await (const event of agent.send()) → OutputLine updates
 *  - Line budget scroll: render only last N lines that fit terminal height
 *  - Queue while processing: pending prompts accumulate, run after turn ends
 *  - History ↑↓: up/down arrow navigates past inputs
 *  - Ctrl+C abort: calls agent.abortCurrent() mid-turn
 *  - Shift+Tab mode cycle: cycles through default/accept-edits/plan/bypass
 *  - Slash commands: /cmd → handleCommand(), no agent call
 *  - Tool rendering with icons, diff lines for Edit/Write, task snapshots
 */

import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Static, Text, useInput, useStdout } from 'ink'
import type { SqAgent } from '../agent/agent.js'
import type { SqConfig } from '../config.js'
import { cycleMode, type Mode } from './mode.js'
import { handleCommand, type CommandContext } from './commands.js'
import { taskSnapshot } from '../tools/tasks.js'
import { isAllowedBySession, allowToolForSession, allowPatternForSession, suggestPattern } from '../tools/session-perms.js'
import { classifyPromptForRouter } from './repl.js'
import { resolveModelAlias, getAliasKeys } from './model-picker.js'
import { type CustomCommand, expandCustomCommand } from './custom-commands.js'

/** Modelos curados para el picker de /model */
const CURATED_MODELS = [
  // Claude — solo el más reciente de cada familia
  { alias: 'opus',    label: 'Claude Opus 4.7      — máxima calidad' },
  { alias: 'sonnet',  label: 'Claude Sonnet 4.6    — equilibrio coste/calidad' },
  { alias: 'haiku',   label: 'Claude Haiku 4.5     — rápido y barato' },
  // OpenAI
  { alias: 'gpt-5.4',      label: 'GPT-5.4            — flagship OpenAI' },
  { alias: 'gpt-5.4-mini', label: 'GPT-5.4 mini       — rápido y barato' },
  { alias: 'gpt-5.3-codex',label: 'Codex 5.3          — especializado en código' },
  // Google
  { alias: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro    — contexto 1M' },
  { alias: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash  — rápido' },
]

/** Comandos disponibles en el Ink REPL (con output o acción implementada) */
const SLASH_COMMANDS = [
  // Con output directo — siempre funcionan
  '/help', '/status', '/cost', '/context', '/export', '/usage',
  '/history', '/env', '/perf', '/feedback', '/release-notes',
  // Con acción implementada en el Ink REPL
  '/model', '/compact', '/clear', '/login',
  '/repeat', '/cancel', '/tasklist', '/router',
  // Salida
  '/exit', '/quit',
]

/** Petición de permiso pendiente — mientras existe, bloquea el input normal. */
interface PermissionRequest {
  toolName: string
  detail: string          // ruta o comando abreviado
  patternSuggestion: string | null
  resolve: (result: { approved: boolean; explanation?: string }) => void
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type OutputLineKind =
  | 'user_header'
  | 'user_body'
  | 'agent_header'
  | 'agent_body'
  | 'tool_start'
  | 'diff_remove'
  | 'diff_add'
  | 'task_item'
  | 'turn_end'
  | 'error'
  | 'info'
  | 'thinking'

export interface OutputLine {
  id: number
  kind: OutputLineKind
  text: string
}

export interface AppProps {
  agent: SqAgent
  config: SqConfig
  cwd: string
  projectName: string
  resumedInfo?: { sessionId: string; turns: number }
  version: string
  authStatus: { anthropic: boolean; openai: boolean; google: boolean }
  customCommands?: CustomCommand[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let lineIdCounter = 0
function nextId(): number {
  return ++lineIdCounter
}

function makeLine(kind: OutputLineKind, text: string): OutputLine {
  return { id: nextId(), kind, text }
}

/**
 * Word-wrap a string to `maxWidth` chars, cutting on spaces when possible.
 * Returns an array of strings each fitting within maxWidth.
 * Used so every visual line has its own │ prefix in OutputLineView.
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || text.length <= maxWidth) return [text]
  const result: string[] = []
  let remaining = text
  while (remaining.length > maxWidth) {
    let cut = remaining.lastIndexOf(' ', maxWidth)
    if (cut <= 0) cut = maxWidth
    result.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut).replace(/^ /, '')
  }
  result.push(remaining)
  return result
}

/**
 * Splits text by newlines and word-wraps each paragraph, returning
 * an array of OutputLines of the given kind.
 */
function makeBodyLines(kind: OutputLineKind, text: string): OutputLine[] {
  const cols = process.stdout.columns || 80
  const maxWidth = Math.max(20, cols - 3) // 3 = '│ ' prefix + 1 margin
  return text.split('\n').flatMap(para => wrapText(para, maxWidth).map(l => makeLine(kind, l)))
}

function toolIcon(name: string): string {
  switch (name) {
    case 'Read':            return '▸'
    case 'Write':           return '✎'
    case 'Edit':            return '±'
    case 'Bash':            return '$'
    case 'BashOutput':      return '↻'
    case 'KillShell':       return '✗'
    case 'Glob':            return '*'
    case 'Grep':            return '⌕'
    case 'WebFetch':        return '⤓'
    case 'WebSearch':       return '⊕'
    case 'TaskCreate':      return '+'
    case 'TaskList':        return '≡'
    case 'TaskGet':         return '?'
    case 'TaskUpdate':      return '⟳'
    case 'NotebookEdit':    return '▤'
    case 'AskUserQuestion': return '?'
    case 'Task':            return '⤳'
    default:                return '◆'
  }
}

function toolDetail(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const inp = input as Record<string, unknown>
  if (name === 'Read' || name === 'Write' || name === 'Glob' || name === 'Grep') {
    const p = inp.file_path || inp.path || inp.pattern || ''
    return typeof p === 'string' ? shortenPath(p) : ''
  }
  if (name === 'Edit') {
    return typeof inp.file_path === 'string' ? shortenPath(inp.file_path) : ''
  }
  if (name === 'Bash') {
    const cmd = typeof inp.command === 'string' ? inp.command : ''
    return cmd.slice(0, 60) + (cmd.length > 60 ? '…' : '')
  }
  if (name === 'WebFetch' || name === 'WebSearch') {
    const u = inp.url || inp.query || ''
    return typeof u === 'string' ? u.slice(0, 60) : ''
  }
  if (name === 'TaskCreate' || name === 'TaskUpdate') {
    return typeof inp.subject === 'string' ? inp.subject.slice(0, 50) : ''
  }
  return ''
}

function shortenPath(p: string): string {
  // Keep last 2 path segments for readability
  const parts = p.replace(/\\/g, '/').split('/')
  return parts.slice(-2).join('/')
}

function buildDiffLines(name: string, input: unknown): OutputLine[] {
  if (!input || typeof input !== 'object') return []
  const inp = input as Record<string, unknown>
  const lines: OutputLine[] = []

  if (name === 'Edit') {
    const oldStr = typeof inp.old_string === 'string' ? inp.old_string : ''
    const newStr = typeof inp.new_string === 'string' ? inp.new_string : ''
    const oldLines = oldStr.split('\n').slice(0, 20)
    const newLines = newStr.split('\n').slice(0, 20)
    for (const l of oldLines) {
      lines.push(makeLine('diff_remove', `- ${l}`))
    }
    for (const l of newLines) {
      lines.push(makeLine('diff_add', `+ ${l}`))
    }
  } else if (name === 'Write') {
    const content = typeof inp.content === 'string' ? inp.content : ''
    const contentLines = content.split('\n').slice(0, 40)
    for (const l of contentLines) {
      lines.push(makeLine('diff_add', `+ ${l}`))
    }
  }

  // Clamp total diff lines to 40
  return lines.slice(0, 40)
}

function buildTaskLines(): OutputLine[] {
  const tasks = taskSnapshot()
  if (tasks.length === 0) return []
  return tasks.map(t => {
    const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '⋯' : '○'
    return makeLine('task_item', `  ${icon} #${t.id}  ${t.subject}`)
  })
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

const MODE_COLORS: Record<Mode, string> = {
  default:        '#5f9ea0',  // cadet blue — neutro
  'accept-edits': '#c8a050',  // naranja apagado
  plan:           '#7a9ec2',  // azul acero
  bypass:         '#c05050',  // rojo apagado
}

// ─── Line renderer component ─────────────────────────────────────────────────

function OutputLineView({ line }: { line: OutputLine }): React.ReactElement {
  switch (line.kind) {
    case 'user_header':
      return (
        <Box backgroundColor="#303030">
          <Text dimColor>│ </Text>
          <Text dimColor>you</Text>
        </Box>
      )
    case 'user_body':
      return (
        <Box backgroundColor="#303030">
          <Text dimColor>│ </Text>
          <Text color="white">{line.text}</Text>
        </Box>
      )
    case 'agent_header':
      return (
        <Box>
          <Text dimColor>│ </Text>
          <Text color="#6aaa6a">Squeezr</Text>
        </Box>
      )
    case 'agent_body':
      return (
        <Box>
          <Text dimColor>│ </Text>
          <Text>{line.text}</Text>
        </Box>
      )
    case 'thinking':
      return (
        <Box>
          <Text dimColor>│ </Text>
          <Text dimColor color="#7a9ec2">{line.text}</Text>
        </Box>
      )
    case 'tool_start':
      return (
        <Box>
          <Text color="#7a9ec2">{line.text}</Text>
        </Box>
      )
    case 'diff_remove':
      return (
        <Box>
          <Text backgroundColor="#5c0000" color="white">{line.text}</Text>
        </Box>
      )
    case 'diff_add':
      return (
        <Box>
          <Text backgroundColor="#1a4a1a" color="white">{line.text}</Text>
        </Box>
      )
    case 'task_item':
      return (
        <Box>
          <Text dimColor color="#7a9ec2">{line.text}</Text>
        </Box>
      )
    case 'turn_end':
      return <Text dimColor>╰──</Text>
    case 'error':
      return (
        <Box>
          <Text color="red">✖ </Text>
          <Text color="red">{line.text}</Text>
        </Box>
      )
    case 'info':
      return (
        <Box>
          <Text dimColor>· </Text>
          <Text dimColor>{line.text}</Text>
        </Box>
      )
  }
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export function App({ agent, config, cwd, projectName, resumedInfo, version, authStatus, customCommands = [] }: AppProps): React.ReactElement {
  const { stdout } = useStdout()
  const cols = stdout.columns || 80
  const rows = stdout.rows || 24

  // ── State ───────────────────────────────────────────────────────────────────
  const [lines, setLines] = useState<OutputLine[]>([])
  // Token buffer currently being streamed — lives OUTSIDE the Static block so
  // the rest of the scrollback isn't repainted on every keystroke. When a `\n`
  // is flushed, the completed text is pushed into `lines` (Static) and this
  // clears.
  const [liveText, setLiveText] = useState('')
  const [input, setInput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [pendingQueue, setPendingQueue] = useState<string[]>([])
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [mode, setMode] = useState<Mode>('default')
  const [cost, setCost] = useState(0)
  const [ctxPct, setCtxPct] = useState(0)
  const [model, setModel] = useState(agent.getCurrentModel())
  // Picker interactivo de modelo (/model)
  const [modelPicker, setModelPicker] = useState<{ options: { alias: string; label: string }[]; idx: number } | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  // Scroll manual: Ctrl+U/D desplazan el output. 0 = al fondo (live).
  const [scrollOffset, setScrollOffset] = useState(0)
  const outputHeightRef = useRef(20)
  // Ctrl+T: colapsa/expande task panel. Ctrl+O: colapsa/expande thinking blocks
  const [tasklistCollapsed, setTasklistCollapsed] = useState(false)
  const [thinkingCollapsed, setThinkingCollapsed] = useState(true)
  // Panel de tareas — estado separado, actualizado solo por eventos TaskCreate/TaskUpdate
  const [taskPanelItems, setTaskPanelItems] = useState<ReturnType<typeof taskSnapshot>>([])
  // Ref para debounce del panel (evita setState en cascada si hay varios tasks seguidos)
  const taskPanelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Autocompletado: sugerencias para / y @
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggestionIdx, setSuggestionIdx] = useState(0)

  // Permission picker nativo de Ink
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null)
  const permissionRequestRef = useRef<PermissionRequest | null>(null)

  const askPermissionInk = useCallback(async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ approved: boolean; explanation?: string }> => {
    if (isAllowedBySession(toolName, input)) return { approved: true }
    const detail = (input.file_path as string | undefined)
      || (input.notebook_path as string | undefined)
      || (typeof input.command === 'string' ? (input.command as string).slice(0, 80) : '')
      || toolName
    const patternSuggestion = suggestPattern(toolName, input)
    return new Promise(resolve => {
      const req: PermissionRequest = { toolName, detail, patternSuggestion, resolve }
      permissionRequestRef.current = req
      setPermissionRequest(req)
    })
  }, [])
  // Ref para ctxPct accesible dentro del callback async de processTurn
  const ctxPctRef = useRef(0)
  // Esc: primer Esc muestra hint "Esc again to clear", segundo Esc borra el input
  const [escPending, setEscPending] = useState(false)
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Saved input when navigating history
  const savedInputRef = useRef('')
  // Ref for queue processing to avoid stale closures
  const pendingQueueRef = useRef<string[]>([])
  const isProcessingRef = useRef(false)

  // Keep refs in sync
  useEffect(() => {
    pendingQueueRef.current = pendingQueue
  }, [pendingQueue])
  useEffect(() => {
    isProcessingRef.current = isProcessing
  }, [isProcessing])

  // On mount: banner de bienvenida + info de sesión resumida
  useEffect(() => {
    const dot = (ok: boolean) => ok ? '●' : '○'
    const auth = `anthropic ${dot(authStatus.anthropic)}  openai ${dot(authStatus.openai)}  google ${dot(authStatus.google)}`
    const welcome: OutputLine[] = [
      makeLine('info', ''),
      makeLine('info', '  ███████╗ ██████╗ ██╗   ██╗███████╗███████╗███████╗██████╗'),
      makeLine('info', '  ██╔════╝██╔═══██╗██║   ██║██╔════╝██╔════╝╚══███╔╝██╔══██╗'),
      makeLine('info', '  ███████╗██║   ██║██║   ██║█████╗  █████╗    ███╔╝ ██████╔╝'),
      makeLine('info', '  ╚════██║██║▄▄ ██║██║   ██║██╔══╝  ██╔══╝   ███╔╝  ██╔══██╗'),
      makeLine('info', '  ███████║╚██████╔╝╚██████╔╝███████╗███████╗███████╗██║  ██║'),
      makeLine('info', '  ╚══════╝ ╚══▀▀═╝  ╚═════╝ ╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝'),
      makeLine('info', ''),
      makeLine('info', `  squeezr-code v${version}  ·  The intelligent CLI that never loses context`),
      makeLine('info', `  auth   ${auth}`),
      makeLine('info', `  cwd    ${cwd}`),
      makeLine('info', '  tip    /help · @model para override · Shift+Tab cicla modo'),
      makeLine('info', ''),
    ]
    if (resumedInfo) {
      welcome.push(makeLine('info', `  resumed session ${resumedInfo.sessionId.slice(0, 13)} (${resumedInfo.turns} turns)`))
      welcome.push(makeLine('info', ''))
    }
    setLines(welcome)
  }, [])

  // Recalcular sugerencias cuando el input cambia (backspace, Ctrl+W, history nav)
  useEffect(() => {
    if (input.startsWith('/')) {
      const allCmds = [...SLASH_COMMANDS, ...customCommands.map(c => `/${c.name}`)]
      const hits = allCmds.filter(c => c.startsWith(input))
      setSuggestions(hits.slice(0, 6))
      setSuggestionIdx(0)
    } else {
      const atMatch = /@([^\s]*)$/.exec(input)
      if (atMatch) {
        const hits = getAliasKeys().filter(a => a.startsWith(atMatch[1]))
        setSuggestions(hits.slice(0, 6))
        setSuggestionIdx(0)
      } else {
        setSuggestions([])
      }
    }
  }, [input])

  // ── Process a turn ──────────────────────────────────────────────────────────
  const processTurn = useCallback(async (text: string) => {
    setIsProcessing(true)
    isProcessingRef.current = true

    // User message block
    const userLines: OutputLine[] = [
      makeLine('user_header', ''),
      ...makeBodyLines('user_body', text),
    ]
    setScrollOffset(0)  // volver al live mode al enviar un mensaje
    setLines(prev => [...prev, ...userLines])

    // History update
    setHistory(prev => [...prev, text])
    setHistIdx(-1)
    savedInputRef.current = ''

    // Extraer @alias al inicio del prompt — igual que el REPL clásico.
    // "@5.4-mini hola" → modelo=5.4-mini, prompt="hola"
    let promptToSend = text
    let routerModel: string | undefined
    const atOverride = text.match(/^@(\S+)\s+(.+)$/s)
    if (atOverride) {
      const alias = atOverride[1]
      const resolved = resolveModelAlias(alias)
      if (resolved) {
        routerModel = resolved
        promptToSend = atOverride[2]
        setLines(prev => [...prev, makeLine('info', `  ▸ @override: ${alias}`)])
      }
    }

    // Auto-router: si NO hay override explícito y el router está ON
    if (!routerModel && config.router?.enabled) {
      const picked = classifyPromptForRouter(promptToSend, authStatus)
      if (picked) {
        routerModel = resolveModelAlias(picked)
        setLines(prev => [...prev, makeLine('info', `  ▸ router: ${picked} (heuristic)`)])
      }
    }

    let hasAgentHeader = false
    let currentTextBuffer = ''

    function flushText() {
      if (!currentTextBuffer) {
        setLiveText('')
        return
      }
      const textLines = makeBodyLines('agent_body', currentTextBuffer)
      setLines(prev => [...prev, ...textLines])
      currentTextBuffer = ''
      setLiveText('')
    }

    try {
      for await (const event of agent.send(promptToSend, { cwd, model: routerModel, askPermission: askPermissionInk })) {
        if (event.type === 'text' && event.text) {
          if (!hasAgentHeader) {
            setLines(prev => [...prev, makeLine('agent_header', '')])
            hasAgentHeader = true
          }
          currentTextBuffer += event.text
          // Flush on newlines to keep streaming feel
          if (currentTextBuffer.includes('\n')) {
            const parts = currentTextBuffer.split('\n')
            const incomplete = parts.pop()!
            const complete = parts.flatMap(l => makeBodyLines('agent_body', l))
            setLines(prev => [...prev, ...complete])
            currentTextBuffer = incomplete
            setLiveText(incomplete)
          } else {
            // No newline yet — surface the partial buffer in the live area so
            // the user sees tokens as they stream, without repainting Static.
            setLiveText(currentTextBuffer)
          }
        } else if (event.type === 'thinking' && event.text) {
          if (!hasAgentHeader) {
            setLines(prev => [...prev, makeLine('agent_header', '')])
            hasAgentHeader = true
          }
          flushText()
          const thinkLines = event.text.split('\n').slice(0, 10).map(l =>
            makeLine('thinking', `  ${l}`)
          )
          setLines(prev => [...prev, ...thinkLines])
        } else if (event.type === 'tool_start' && event.tool) {
          flushText()
          const icon = toolIcon(event.tool.name)
          const detail = toolDetail(event.tool.name, event.tool.input)
          const line = `├─ ${icon} ${event.tool.name}${detail ? '  ' + detail : ''}`
          setLines(prev => [...prev, makeLine('tool_start', line)])

          // Diff lines for Edit/Write
          if (event.tool.name === 'Edit' || event.tool.name === 'Write') {
            const diffLines = buildDiffLines(event.tool.name, event.tool.input)
            if (diffLines.length > 0) {
              setLines(prev => [...prev, ...diffLines])
            }
          }

          // Task panel: actualizar snapshot tras TaskCreate/TaskUpdate (debounced 100ms)
          if (event.tool.name === 'TaskCreate' || event.tool.name === 'TaskUpdate') {
            if (taskPanelTimerRef.current) clearTimeout(taskPanelTimerRef.current)
            taskPanelTimerRef.current = setTimeout(() => setTaskPanelItems(taskSnapshot()), 100)
          }
        } else if (event.type === 'cost' && event.cost) {
          setCost(prev => prev + event.cost!.usd)
          setModel(event.cost.model)
        } else if (event.type === 'subscription' && event.subscription) {
          // Cap at 100 — Anthropic returns > 1.0 during burst allowance, which
          // would render as "102%" and confuse the user.
          const pct = Math.min(100, Math.round(event.subscription.fiveHour * 100))
          ctxPctRef.current = pct
          setCtxPct(pct)
        } else if (event.type === 'error' && event.error) {
          flushText()
          setLines(prev => [...prev, makeLine('error', event.error!)])
        } else if (event.type === 'done') {
          break
        }
      }
    } catch (err) {
      flushText()
      const msg = err instanceof Error ? err.message : String(err)
      setLines(prev => [...prev, makeLine('error', msg)])
    } finally {
      // Flush any remaining text
      if (currentTextBuffer) {
        const remaining = makeBodyLines('agent_body', currentTextBuffer)
        setLines(prev => [...prev, ...remaining])
      }
      // Turn end marker
      setLines(prev => [...prev, makeLine('turn_end', '')])

      // Auto-compact: si el contexto superó el umbral, comprimir historial
      const autoThreshold = config.transplant?.auto_threshold ?? 95
      const currentCtx = ctxPctRef.current
      if (currentCtx >= autoThreshold && agent.getConversationHistory().length > 4) {
        setLines(prev => [...prev, makeLine('info', `  ▸ context at ${currentCtx}% — compacting automatically…`)])
        try {
          for await (const ev of agent.compact()) {
            if (ev.type === 'text' && ev.text) { /* silencioso */ }
          }
          setLines(prev => [...prev, makeLine('info', '  ✓ context compacted')])
        } catch (compactErr) {
          setLines(prev => [...prev, makeLine('info', `  ✖ compact failed: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`)])
        }
      }

      setIsProcessing(false)
      isProcessingRef.current = false

      // Process next in queue
      const nextQueue = pendingQueueRef.current
      if (nextQueue.length > 0) {
        const [next, ...rest] = nextQueue
        setPendingQueue(rest)
        pendingQueueRef.current = rest
        // Small delay to let React settle
        setTimeout(() => void processTurn(next), 0)
      }
    }
  }, [agent, cwd])

  // ── Input handling ──────────────────────────────────────────────────────────
  useInput((char, key) => {
    // ── Help overlay ──────────────────────────────────────────────────────────
    if (showHelp) {
      if (key.escape || key.return || char === 'q') {
        setShowHelp(false)
        return
      }
      return  // bloquea todas las teclas mientras el help está abierto
    }

    // ── Model picker ──────────────────────────────────────────────────────────
    if (modelPicker) {
      if (key.upArrow) {
        setModelPicker(p => p ? { ...p, idx: Math.max(0, p.idx - 1) } : null)
        return
      }
      if (key.downArrow) {
        setModelPicker(p => p ? { ...p, idx: Math.min(p.options.length - 1, p.idx + 1) } : null)
        return
      }
      if (key.return) {
        const selected = modelPicker.options[modelPicker.idx]
        const resolved = resolveModelAlias(selected.alias)
        if (resolved) {
          setModel(resolved)
          agent.setModel(resolved)
        }
        setLines(prev => [...prev, makeLine('info', `  ✓ modelo → ${selected.alias}`)])
        setModelPicker(null)
        return
      }
      if (key.escape) {
        setModelPicker(null)
        return
      }
      return  // bloquea otras teclas mientras el picker está abierto
    }

    // Tab: si hay sugerencias, completar la seleccionada
    if (key.tab && !key.shift && suggestions.length > 0) {
      const selected = suggestions[suggestionIdx]
      // Para slash commands: sustituir input completo
      if (selected.startsWith('/')) {
        setInput(selected + ' ')
        setSuggestions([])
      } else {
        // Para @alias: sustituir desde el último @
        const atIdx = input.lastIndexOf('@')
        const newInput = atIdx >= 0 ? input.slice(0, atIdx + 1) + selected + ' ' : selected + ' '
        setInput(newInput)
        setSuggestions([])
      }
      return
    }
    // Esc: si hay sugerencias abiertas, cerrarlas primero
    if (key.escape) {
      if (suggestions.length > 0) {
        setSuggestions([])
        return
      }
      if (escPending) {
        // Segundo Esc → borrar input
        if (escTimerRef.current) clearTimeout(escTimerRef.current)
        setEscPending(false)
        setInput('')
        savedInputRef.current = ''
      } else if (input.length > 0) {
        // Primer Esc → mostrar hint y armar timer
        setEscPending(true)
        if (escTimerRef.current) clearTimeout(escTimerRef.current)
        escTimerRef.current = setTimeout(() => setEscPending(false), 1500)
      }
      return
    }
    // Cualquier otra tecla cancela el hint de Esc
    if (escPending) {
      if (escTimerRef.current) clearTimeout(escTimerRef.current)
      setEscPending(false)
    }

    // Ctrl+C: abort or exit
    if (key.ctrl && char === 'c') {
      if (isProcessing) {
        agent.abortCurrent()
        setLines(prev => [...prev, makeLine('info', 'Aborting…')])
      } else {
        process.exit(0)
      }
      return
    }

    // Scroll is now handled by the terminal's native scrollback (since the
    // message history lives inside <Static> — see render block). Mouse wheel
    // and Shift+PgUp/Dn work out of the box. Ctrl+U/D and PgUp/PgDn are
    // consumed here to prevent them from being typed into the input buffer,
    // but do nothing else.
    if ((key.ctrl && char === 'u') || key.pageUp) return
    if ((key.ctrl && char === 'd') || key.pageDown) return

    // ── Permission picker ──────────────────────────────────────────────────────
    if (permissionRequest) {
      const req = permissionRequest
      const resolve = (result: { approved: boolean; explanation?: string }) => {
        permissionRequestRef.current = null
        setPermissionRequest(null)
        req.resolve(result)
      }
      if (char === 'y' || key.return) {
        allowToolForSession(req.toolName)
        resolve({ approved: true })
        return
      }
      if (char === '1') { resolve({ approved: true }); return }
      if (char === '2') {
        allowToolForSession(req.toolName)
        resolve({ approved: true })
        return
      }
      if (char === '3' && req.patternSuggestion) {
        allowPatternForSession(req.toolName, req.patternSuggestion)
        resolve({ approved: true })
        return
      }
      if (char === 'n' || char === '4') {
        resolve({ approved: false, explanation: 'denied by user' })
        return
      }
      return  // bloquea cualquier otra tecla mientras está el picker
    }

    // Ctrl+T: toggle task list
    if (key.ctrl && char === 't') {
      setTasklistCollapsed(v => !v)
      return
    }
    // Ctrl+O: toggle thinking blocks
    if (key.ctrl && char === 'o') {
      setThinkingCollapsed(v => !v)
      return
    }

    // Shift+Tab: cycle mode
    if (key.shift && key.tab) {
      const next = cycleMode(mode)
      setMode(next)
      setLines(prev => [...prev, makeLine('info', `mode → ${next}`)])
      return
    }

    // Enter: enviar
    if (key.return) {
      const trimmed = input.trim()
      setSuggestions([])
      if (!trimmed) return
      handleSubmitText(trimmed)
      setInput('')
      return
    }

    // Up/Down: navegar sugerencias si están abiertas, si no navegar historial
    if (key.upArrow) {
      if (suggestions.length > 0) {
        setSuggestionIdx(i => Math.max(0, i - 1))
        return
      }
      if (permissionRequest || escPending) return
      const h = history
      if (h.length === 0) return
      const newIdx = histIdx < 0 ? h.length - 1 : Math.max(0, histIdx - 1)
      if (histIdx < 0) savedInputRef.current = input
      setHistIdx(newIdx)
      setInput(h[newIdx])
      return
    }

    if (key.downArrow) {
      if (suggestions.length > 0) {
        setSuggestionIdx(i => Math.min(suggestions.length - 1, i + 1))
        return
      }
      if (permissionRequest || escPending) return
      if (histIdx < 0) return
      const h = history
      if (histIdx >= h.length - 1) {
        setHistIdx(-1)
        setInput(savedInputRef.current)
      } else {
        const newIdx = histIdx + 1
        setHistIdx(newIdx)
        setInput(h[newIdx])
      }
      return
    }

    // Ctrl+A: ir al inicio (borra todo — sin cursor posicional, lo más útil)
    if (key.ctrl && char === 'a') { setInput(''); setSuggestions([]); return }
    // Ctrl+W: borrar última palabra
    if (key.ctrl && char === 'w') {
      setInput(s => {
        const trimmed = s.trimEnd()
        const lastSpace = trimmed.lastIndexOf(' ')
        return lastSpace >= 0 ? trimmed.slice(0, lastSpace + 1) : ''
      })
      setSuggestions([])
      return
    }

    // Backspace
    if (key.backspace || key.delete) {
      setInput(s => s.slice(0, -1))
      setSuggestions(prev => {
        // Recalcular sugerencias con el nuevo valor (un char menos)
        return prev  // se recalcula en el useEffect de abajo
      })
      return
    }

    // Caracteres normales — ignorar si ctrl/meta están activos
    if (char && !key.ctrl && !key.meta && char >= ' ') {
      const newVal = input + char
      setInput(newVal)
      // Actualizar sugerencias
      if (newVal.startsWith('/')) {
        const hits = SLASH_COMMANDS.filter(c => c.startsWith(newVal))
        setSuggestions(hits.slice(0, 6))
        setSuggestionIdx(0)
      } else {
        const atMatch = /@([^\s]*)$/.exec(newVal)
        if (atMatch) {
          const hits = getAliasKeys().filter(a => a.startsWith(atMatch[1]))
          setSuggestions(hits.slice(0, 6))
          setSuggestionIdx(0)
        } else {
          setSuggestions([])
        }
      }
    }
  })

  // Submit handler — called by TextInput's onSubmit
  const handleSubmitText = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return

    setHistIdx(-1)
    savedInputRef.current = ''

    if (isProcessingRef.current) {
      // Queue it
      const newQueue = [...pendingQueueRef.current, trimmed]
      setPendingQueue(newQueue)
      pendingQueueRef.current = newQueue
      setLines(prev => [...prev, makeLine('info', `queued (${newQueue.length} pending)`)])
      return
    }

    // Slash command
    if (trimmed.startsWith('/')) {
      // /help — abre overlay sin tocar el output
      if (trimmed === '/help' || trimmed === '/help ') {
        setShowHelp(true)
        return
      }

      // /skills — listar skills disponibles
      if (trimmed === '/skills' || trimmed === '/skills list') {
        if (customCommands.length === 0) {
          setLines(prev => [...prev, makeLine('info', '  No hay skills instaladas en ~/.squeezr-code/commands/')])
        } else {
          const skillLines = [
            makeLine('info', ''),
            makeLine('info', `  Skills disponibles (${customCommands.length}):`),
            ...customCommands.map(c => makeLine('info', `    /${c.name.padEnd(16)} ${c.description}`)),
            makeLine('info', ''),
            makeLine('info', '  Uso: /<skill> [argumentos]   •   Añade .md en ~/.squeezr-code/commands/'),
            makeLine('info', ''),
          ]
          setLines(prev => [...prev, ...skillLines])
        }
        return
      }

      // Custom command (skill) — /<name> [args]
      if (customCommands.length > 0) {
        const m = trimmed.match(/^\/(\S+)\s*(.*)$/s)
        if (m) {
          const skill = customCommands.find(c => c.name === m[1])
          if (skill) {
            const expanded = expandCustomCommand(skill, m[2])
            setLines(prev => [...prev, makeLine('info', `  ▸ skill: /${skill.name}`)])
            void processTurn(expanded)
            return
          }
        }
      }

      const ctx: CommandContext = {
        brain: {
          getState: () => ({ contextPercent: ctxPct, model, turnCount: 0 } as any),
          reset: () => {},
        },
        model,
        setModel: (m: string) => { setModel(m); agent.setModel(m) },
        costByModel: () => agent.getCostByModel() as Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; usd: number }>,
        history: () => agent.getConversationHistory(),
        systemPrompt: () => agent.getLastSystemPrompt() ?? '',
        sessionId: () => '',
      }
      const result = handleCommand(trimmed, ctx)
      if (result) {
        if (result.output) {
          const outLines = result.output.split('\n').map(l => makeLine('info', l))
          setLines(prev => [...prev, ...outLines])
        }
        // Acciones interactivas
        if (result.action === 'pick-model') {
          setModelPicker({ options: CURATED_MODELS, idx: 0 })

        } else if (result.action === 'compact') {
          setLines(prev => [...prev, makeLine('info', '  ▸ compactando historial…')])
          void (async () => {
            try {
              for await (const _ev of agent.compact()) { /* silent */ }
              setLines(prev => [...prev, makeLine('info', '  ✓ historial compactado')])
            } catch (e) {
              setLines(prev => [...prev, makeLine('error', `compact failed: ${e instanceof Error ? e.message : String(e)}`)])
            }
          })()

        } else if (result.action === 'login') {
          const provider = (result as { loginProvider?: string }).loginProvider || 'anthropic'
          setLines(prev => [...prev, makeLine('info', `  Abre otra terminal y ejecuta: sq login ${provider}`)])

        } else if (result.action === 'repeat') {
          // Reenviar el último mensaje del usuario
          const hist = agent.getConversationHistory()
          const lastUser = [...hist].reverse().find(m => m.role === 'user')
          if (lastUser && typeof lastUser.content === 'string') {
            void processTurn(lastUser.content)
          } else {
            setLines(prev => [...prev, makeLine('info', '  No hay mensaje previo para repetir.')])
          }

        } else if (result.action === 'cancel') {
          setPendingQueue([])
          pendingQueueRef.current = []
          setLines(prev => [...prev, makeLine('info', '  Cola vaciada.')])

        } else if (result.action === 'tasklist') {
          const tasks = taskSnapshot()
          const arg = (result as { tasklistArg?: string }).tasklistArg || ''
          if (arg === 'clean') {
            setTaskPanelItems([])
            setLines(prev => [...prev, makeLine('info', '  Tasks limpiadas del panel.')])
          } else {
            if (tasks.length === 0) {
              setLines(prev => [...prev, makeLine('info', '  No hay tareas en esta sesión.')])
            } else {
              const taskLines = tasks.map(t => {
                const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '⋯' : '○'
                return makeLine('info', `  ${icon} #${t.id}  ${t.subject}  [${t.status}]`)
              })
              setLines(prev => [...prev, ...taskLines])
            }
          }

        } else if (result.action === 'router') {
          const arg = (result as { routerArg?: string }).routerArg || 'show'
          if (arg === 'on') {
            setLines(prev => [...prev, makeLine('info', '  Router ON — usa /router off para desactivar. (persiste en sq.toml)')])
          } else if (arg === 'off') {
            setLines(prev => [...prev, makeLine('info', '  Router OFF.')])
          } else {
            const state = config.router?.enabled ? 'ON' : 'OFF'
            setLines(prev => [...prev, makeLine('info', `  Router: ${state}. /router on | off`)])
          }

        } else if (result.action === 'undo') {
          setLines(prev => [...prev, makeLine('info', '  /undo no disponible en el Ink REPL. Usa sq --classic para acceder a undo.')])

        } else if (result.action === 'sessions') {
          setLines(prev => [...prev, makeLine('info', '  /sessions no disponible en el Ink REPL. Usa sq sessions en una terminal.')])

        } else if (result.action && !['mcp','resume','review','paste','fork','search','template','clean','committee','snippet','summary','library','gh','redact','airplane','sticky','dispatch','squad'].includes(result.action)) {
          // Acción desconocida — avisar
          setLines(prev => [...prev, makeLine('info', `  Acción '${result.action}' no disponible en este modo.`)])
        } else if (result.action) {
          setLines(prev => [...prev, makeLine('info', `  /${result.action} no está disponible en el Ink REPL. Usa sq --classic.`)])
        }

        if (result.exit) process.exit(0)
      }
      return
    }

    void processTurn(trimmed)
  }, [agent, ctxPct, model, processTurn])

  // ── Status bar ──────────────────────────────────────────────────────────────
  const barWidth = 10
  const filled = Math.round((ctxPct / 100) * barWidth)
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)
  const barColor = ctxPct >= 100 ? '#c05050' : ctxPct >= 70 ? '#c8a050' : '#5f9ea0'
  const modelLabel = shortModelLabel(model)

  // ── Line budget scroll ───────────────────────────────────────────────────────
  // 5 filas fijas: sep + status + mode + sep + input
  // + panel de tareas si visible + permission picker si activo
  const taskPanelHeight = (!tasklistCollapsed && taskPanelItems.length > 0)
    ? Math.min(taskPanelItems.length, 7) + 1  // +1 para la cabecera
    : 0
  const permPickerHeight = permissionRequest ? 7 : 0
  const outputHeight = Math.max(4, rows - 5 - taskPanelHeight - permPickerHeight)
  outputHeightRef.current = outputHeight
  // Filtrado: agrupa thinking en resumen si collapsed; excluye task_item del output (van al panel)
  const filteredLines: OutputLine[] = []
  let thinkBuf: OutputLine[] = []
  for (const l of lines) {
    if (l.kind === 'task_item') continue  // solo en el panel, nunca en el output
    if (l.kind === 'thinking') {
      thinkBuf.push(l)
      continue
    }
    if (thinkBuf.length > 0) {
      if (thinkingCollapsed) {
        filteredLines.push(makeLine('info', `  ▸ thinking (${thinkBuf.length} lines) · Ctrl+O to expand`))
      } else {
        filteredLines.push(...thinkBuf)
      }
      thinkBuf = []
    }
    filteredLines.push(l)
  }
  if (thinkBuf.length > 0) {
    if (thinkingCollapsed) {
      filteredLines.push(makeLine('info', `  ▸ thinking (${thinkBuf.length} lines) · Ctrl+O to expand`))
    } else {
      filteredLines.push(...thinkBuf)
    }
  }
  // NOTE: Previous versions did in-app pagination (sliceStart/sliceEnd with
  // Ctrl+U/D) because Ink was repainting the whole output on every render,
  // which broke terminal scrollback and therefore mouse-wheel scrolling.
  // That's now replaced by <Static>: each completed line is emitted to
  // stdout exactly once and never repainted, so the terminal's own
  // scrollback retains it and the mouse wheel works. `scrollOffset` and the
  // Ctrl+U/D handlers are left as no-ops and will be removed once users
  // adopt the new scroll model.
  const staticLines = filteredLines
  // Silence unused-var warnings from the now-decommissioned scroll math.
  void scrollOffset
  const isLiveMode = true

  const sep = '─'.repeat(cols)

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      {/* Completed scrollback — emitted once to stdout, never repainted.
          This is what lets the terminal's native scroll (mouse wheel,
          Shift+PgUp/Dn) work on past messages. */}
      <Static items={staticLines}>
        {(line: OutputLine) => <OutputLineView key={line.id} line={line} />}
      </Static>

      {/* Live area — tokens being streamed + spinner. Repaints normally. */}
      <Box flexDirection="column">
        {/* Streaming buffer: tokens received since the last newline, so the
            user sees them flowing without waiting for a \n to flush. */}
        {liveText && (
          <Box>
            <Text dimColor>│ </Text>
            <Text>{liveText}</Text>
          </Box>
        )}
        {isProcessing && !liveText && (
          <Box>
            <Text dimColor>│ </Text>
            <Text dimColor color="#c8a050">…</Text>
          </Box>
        )}
      </Box>

      {/* Task panel — panel fijo entre output y status, solo cuando hay tareas */}
      {!tasklistCollapsed && taskPanelItems.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>{'─'.repeat(cols)}</Text>
          <Text dimColor>  Tasks ({taskPanelItems.length})</Text>
          {taskPanelItems.slice(0, 7).map(t => {
            const icon = t.status === 'completed' ? '✓'
                       : t.status === 'in_progress' ? '⋯' : '○'
            const col = t.status === 'completed' ? '#6aaa6a'
                      : t.status === 'in_progress' ? '#c8a050' : undefined
            const struck = t.status === 'completed'
            return (
              <Box key={t.id}>
                <Text color={col}>  {icon} </Text>
                <Text dimColor>#{t.id} </Text>
                <Text dimColor={struck}>{t.subject}</Text>
              </Box>
            )
          })}
          {taskPanelItems.length > 7 && (
            <Text dimColor>  … {taskPanelItems.length - 7} more</Text>
          )}
        </Box>
      )}

      {/* Permission picker — aparece encima del status cuando hay petición pendiente */}
      {permissionRequest && (
        <Box flexDirection="column" borderStyle="single" borderColor="#c8a050" paddingX={1}>
          <Text color="#c8a050" bold>  Allow {permissionRequest.toolName}?  </Text>
          <Text dimColor>  {permissionRequest.detail}</Text>
          <Text> </Text>
          <Text dimColor>  1 / Y  Allow once</Text>
          <Text dimColor>  2      Allow {permissionRequest.toolName} for this session</Text>
          {permissionRequest.patternSuggestion && (
            <Text dimColor>  3      Allow pattern {permissionRequest.patternSuggestion}</Text>
          )}
          <Text dimColor>  N / 4  Deny</Text>
        </Box>
      )}

      {/* Help overlay — flota encima del status sin tocar el output */}
      {showHelp && (
        <Box flexDirection="column" borderStyle="single" borderColor="#5f9ea0" paddingX={1}>
          <Text color="#6aaa6a" bold>  Squeezr — referencia rápida   </Text><Text dimColor>Esc / Enter para cerrar</Text>
          <Text dimColor>  ─────────────────────────────────────────────────────</Text>
          <Text dimColor>  Modelos      </Text><Text>/model           </Text><Text dimColor>picker ↑↓ Enter</Text>
          <Text dimColor>               </Text><Text>@alias texto     </Text><Text dimColor>override puntual (@opus, @sonnet…)</Text>
          <Text dimColor>  ─────────────────────────────────────────────────────</Text>
          <Text dimColor>  Sesión       </Text><Text>/status  /cost   </Text><Text dimColor>tokens y coste</Text>
          <Text dimColor>               </Text><Text>/context         </Text><Text dimColor>desglose del contexto en tokens</Text>
          <Text dimColor>               </Text><Text>/compact         </Text><Text dimColor>comprimir historial</Text>
          <Text dimColor>               </Text><Text>/clear           </Text><Text dimColor>limpiar contexto del turno</Text>
          <Text dimColor>               </Text><Text>/history [N]     </Text><Text dimColor>últimos N turnos</Text>
          <Text dimColor>               </Text><Text>/repeat  /cancel </Text><Text dimColor>reenviar / vaciar cola</Text>
          <Text dimColor>  ─────────────────────────────────────────────────────</Text>
          <Text dimColor>  Tareas       </Text><Text>/tasklist        </Text><Text dimColor>ver tareas  ·  Ctrl+T panel</Text>
          <Text dimColor>  Thinking     </Text><Text>Ctrl+O           </Text><Text dimColor>expandir/colapsar razonamiento</Text>
          <Text dimColor>  Router       </Text><Text>/router on|off   </Text><Text dimColor>auto-elegir modelo</Text>
          <Text dimColor>  ─────────────────────────────────────────────────────</Text>
          <Text dimColor>  Misc         </Text><Text>/export  /usage  /env  /release-notes  /exit</Text>
          <Text dimColor>  Login        </Text><Text>/login anthropic  /login openai  /login google</Text>
          <Text dimColor>  Scroll       rueda del ratón · Shift+PgUp/Dn (nativo del terminal)</Text>
          <Text dimColor>  Input        Esc×2 limpiar · Shift+Tab ciclar modo</Text>
          <Text dimColor>  Avanzados    sq --classic  (mcp, sessions, fork, undo…)</Text>
        </Box>
      )}

      {/* Model picker — aparece encima del status cuando /model está abierto */}
      {modelPicker && (
        <Box flexDirection="column" paddingLeft={2}>
          <Text dimColor>  Selecciona modelo ↑↓ · Enter confirma · Esc cancela</Text>
          {modelPicker.options.map((o, i) => (
            <Box key={o.alias}>
              {i === modelPicker.idx
                ? <Text color="#6aaa6a">❯ {o.alias.padEnd(18)} <Text dimColor>{o.label}</Text></Text>
                : <Text dimColor>  {o.alias.padEnd(18)} {o.label}</Text>
              }
            </Box>
          ))}
        </Box>
      )}

      {/* Top separator above the status bar. With <Static> handling the
          scrollback, we're always "live" — no paginator state to surface. */}
      <Text dimColor>{sep}</Text>

      {/* Status bar */}
      <Box>
        <Text color="#6aaa6a">{projectName}</Text>
        <Text dimColor> · </Text>
        <Text color={barColor}>{bar}</Text>
        <Text> {ctxPct}%</Text>
        <Text dimColor> 5h · </Text>
        <Text dimColor>${cost.toFixed(2)}</Text>
        <Text dimColor> · </Text>
        <Text color="#c8a050">{modelLabel}</Text>
      </Box>

      {/* Mode line */}
      <Box>
        <Text dimColor>  ↳ </Text>
        <Text color={MODE_COLORS[mode]}>{mode}</Text>
        <Text dimColor> · shift+tab</Text>
        <Text dimColor>  Ctrl+O {thinkingCollapsed ? 'expand' : 'collapse'} thinking</Text>
        <Text dimColor>  Ctrl+T {tasklistCollapsed ? 'expand' : 'collapse'} tasks</Text>
        {pendingQueue.length > 0 && (
          <Text dimColor color="#c8a050"> · {pendingQueue.length} queued</Text>
        )}
      </Box>

      {/* Bottom separator */}
      <Text dimColor>{sep}</Text>

      {/* Input — always visible, input manual para evitar conflictos con useInput */}
      <Box>
        <Text color={isProcessing ? '#c8a050' : '#6aaa6a'}>❯ </Text>
        <Text>{input}</Text>
        {!escPending && <Text color="#6aaa6a">▌</Text>}
        {escPending && <Text dimColor>  Esc again to clear</Text>}
      </Box>

      {/* Sugerencias de autocompletado — solo visibles cuando hay suggestions */}
      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {suggestions.map((s, i) => (
            <Box key={s}>
              <Text color={i === suggestionIdx ? '#6aaa6a' : undefined} dimColor={i !== suggestionIdx}>
                {i === suggestionIdx ? '❯ ' : '  '}{s}
              </Text>
            </Box>
          ))}
          <Text dimColor>  Tab seleccionar · Esc cerrar</Text>
        </Box>
      )}
    </Box>
  )
}
