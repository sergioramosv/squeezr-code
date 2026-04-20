import readline from 'node:readline'
import path from 'node:path'
import { SqAgent } from '../agent/agent.js'
import { AuthManager } from '../auth/manager.js'
import { Renderer } from './renderer.js'
import { handleCommand } from './commands.js'
import { askPermission } from '../tools/permissions.js'
import { getVersion } from '../version.js'
import { loadHistory, appendHistory } from './history.js'
import { installHighlight, setCommandList, setAliasList } from './highlight.js'
import { pickModel, resolveModelAlias, getAliasKeys } from './model-picker.js'
import { pickSession } from './session-picker.js'
import { readClipboardImage, readClipboardImageAsync } from './clipboard-image.js'
import { printImagePaste } from './inline-image.js'
import { loadSquads, parseDispatchBody, runSquad } from './squads.js'
import { popAndRestore as popUndo } from '../tools/undo.js'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { loadModels } from '../api/models.js'
import { formatError } from './error-format.js'
import { AuthError } from '../errors.js'
import { Session, pruneSessions } from '../state/session.js'
import type { NormalizedMessage } from '../api/types.js'
import { checkForUpdate } from '../state/update-check.js'
import { setAuditEnabled } from '../state/audit.js'
import { redactSecrets, formatRedactSummary } from '../state/redact.js'
import { setScanToolOutputs } from '../tools/executor.js'
import { setCronFireHandler, startCronTicker, stopCronTicker } from '../tools/cron.js'
import { setWorktreeCwdChanger } from '../tools/worktree.js'
import { McpManager } from '../mcp/manager.js'
import { discoverMcpServers } from '../mcp/discover.js'
import { pickMcp } from './mcp-picker.js'
import { setSubAgentRunner, setUserQuestioner, setPlanApprover } from '../tools/executor.js'
import { expandFileMentions } from './file-mentions.js'
import { loadCustomCommands, expandCustomCommand, installBuiltinSkills } from './custom-commands.js'
import { setTheme } from './themes.js'
import { evaluateStatusline } from './statusline.js'
import { cycleMode, renderModeLine, type Mode } from './mode.js'
import {
  enableScreen,
  cleanup as cleanupScreen,
  isEnabled as screenEnabled,
  drawInputArea,
  positionPromptCursor,
} from './screen.js'
import { modeColor, modeLabel } from './mode.js'
import { askUserInteractive } from './ask-user.js'
import { killAllBackground } from '../tools/background.js'
import type { SqConfig } from '../config.js'

/** Pregunta y/N en stdin sin tocar el readline activo (que está en pause). */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(question)
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf-8').trim().toLowerCase()
      process.stdin.removeListener('data', onData)
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
      resolve(s === '' || s === 'y' || s === 'yes' || s === 's' || s === 'si')
    }
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.resume()
    process.stdin.once('data', onData)
  })
}

/** Comandos reconocidos para autocompletar con TAB. */
const COMMANDS = [
  '/help', '/model', '/status', '/cost', '/usage', '/context', '/export',
  '/compact', '/mcp', '/clear', '/login', '/release-notes', '/feedback',
  '/checkpoint', '/restore', '/resume', '/review', '/undo', '/sessions', '/paste', '/style', '/history',
  '/fork', '/repeat', '/search', '/template',
  '/clean', '/router', '/committee',
  '/snippet', '/env', '/perf', '/summary', '/cancel', '/library', '/gh',
  '/redact', '/airplane', '/sticky', '/dispatch', '/squad', '/tasklist',
  '/exit', '/quit',
]

/** Captura git diff del cwd. `range` opcional (ej. `HEAD~3`, `main..HEAD`). */
function getGitDiff(cwd: string, range?: string): string {
  try {
    if (range) {
      return execSync(`git diff ${range}`, { cwd, encoding: 'utf-8', maxBuffer: 10_000_000 })
    }
    // Sin rango: staged + unstaged.
    const staged = execSync('git diff --cached', { cwd, encoding: 'utf-8', maxBuffer: 10_000_000 })
    const unstaged = execSync('git diff', { cwd, encoding: 'utf-8', maxBuffer: 10_000_000 })
    return [staged && `--- staged ---\n${staged}`, unstaged && `--- unstaged ---\n${unstaged}`]
      .filter(Boolean).join('\n\n')
  } catch {
    return ''
  }
}

/** Construye el prompt que se le mandará al modelo con el diff como contexto. */
function buildReviewPrompt(diff: string, range?: string): string {
  const scope = range ? `\`${range}\`` : 'the local changes (staged + unstaged)'
  // Truncamos a ~100k chars para no reventar el contexto en diffs enormes.
  const truncated = diff.length > 100_000 ? diff.slice(0, 100_000) + '\n\n[... diff truncated to 100k chars ...]' : diff
  return `Review ${scope} as if it were a PR. Output format:

## Summary
1-3 bullets describing what the change does.

## Possible bugs
List each real issue with \`file:line\` + explanation. If there are none, say "none".

## Suggestions
Readability improvements, uncovered edge cases, naming, reasonable refactors.

## Tests
What should be tested that is not covered.

Diff:

\`\`\`diff
${truncated}
\`\`\``
}

/**
 * Auto-router: clasifica un prompt y devuelve un alias de modelo óptimo.
 * Heurística simple pero efectiva — keywords + longitud + context.
 *
 *   Keywords complejos (architect, debug, refactor...) → opus
 *   think-hard / ultrathink                            → opus
 *   Short + simple question                            → haiku
 *   Resto                                              → sonnet (balance)
 */
export function classifyPromptForRouter(prompt: string, authStatus: { anthropic: boolean; openai: boolean; google: boolean }): string | null {
  const p = prompt.toLowerCase()
  // Si no hay anthropic auth, skip — el router apunta a la familia Claude.
  if (!authStatus.anthropic) return null
  // Señales de "hard":
  if (/\b(architect|arquitect|design pattern|refactor|security audit|auditor|complex|algorithm|algoritmo|debug.*bug|fix.*(race|deadlock|memory leak)|implement.*(system|architecture)|performance tuning|concurrency)\b/.test(p)) return 'opus'
  if (/\b(think hard|think harder|ultrathink)\b/.test(p)) return 'opus'
  // Señales de "easy":
  if (p.length < 60 && /^(what|when|where|who|why|how|is|can|does|define|explain\s+briefly|translate|spell|how do you say|qu[eé]|c[oó]mo|por qu[eé])\b/.test(p)) return 'haiku'
  if (p.length < 40) return 'haiku'
  // Por defecto, sonnet.
  return 'sonnet'
}

/**
 * Handler para `/router on|off|show`. Persiste `[router] enabled = true/false`
 * en ~/.squeezr-code/config.toml, aplica en runtime.
 */
function handleRouterCmd(arg: string, config: SqConfig): void {
  const a = arg.toLowerCase().trim()
  if (a === 'show' || a === '' || a === 'status') {
    const state = config.router?.enabled ? '\x1b[32mON\x1b[0m' : '\x1b[2mOFF\x1b[0m'
    console.log(`  router: ${state}`)
    if (config.router?.enabled) {
      console.log(`  \x1b[2mShort/simple prompts → haiku · complex keywords → opus · rest → sonnet\x1b[0m`)
    }
    console.log(`  \x1b[2mUsage:\x1b[0m /router on · /router off`)
    return
  }
  if (a !== 'on' && a !== 'off') {
    console.log(`  \x1b[31m✖\x1b[0m usage: /router on | off | show`)
    return
  }
  const newVal = a === 'on'
  config.router = config.router || { enabled: false, rules: {} }
  config.router.enabled = newVal

  // Persiste a ~/.squeezr-code/config.toml sección [router].
  const configPath = path.join(os.homedir(), '.squeezr-code', 'config.toml')
  let content = ''
  try { content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '' } catch { /* new */ }
  const section = `[router]\nenabled = ${newVal}\n`
  if (/^\[router\]/m.test(content)) {
    content = content.replace(/\[router\][^\[]*/m, section)
  } else {
    content = content.trimEnd() + (content ? '\n\n' : '') + section
  }
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, content)
    console.log(`  \x1b[32m✓\x1b[0m router → ${newVal ? 'ON' : 'OFF'} ${newVal ? '\x1b[2m(persisted in config.toml)\x1b[0m' : ''}`)
  } catch (err) {
    console.log(`  \x1b[33m⚠\x1b[0m applied in runtime but could not write config: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Handler para `/clean`. Borra caches + worktrees + stubs de sesiones con
 * confirmación por categoría.
 */
async function handleCleanCmd(cwd: string): Promise<void> {
  const candidates: Array<{ label: string; action: () => number | Promise<number> }> = [
    {
      label: 'models-cache.json (will re-download on its own)',
      action: () => {
        const p = path.join(os.homedir(), '.squeezr-code', 'models-cache.json')
        if (fs.existsSync(p)) { fs.unlinkSync(p); return 1 }
        return 0
      },
    },
    {
      label: 'update-check.json (will re-check in 24h)',
      action: () => {
        const p = path.join(os.homedir(), '.squeezr-code', 'update-check.json')
        if (fs.existsSync(p)) { fs.unlinkSync(p); return 1 }
        return 0
      },
    },
    {
      label: `.claude/worktrees in the repo (${path.join(cwd, '.claude', 'worktrees')})`,
      action: () => {
        const dir = path.join(cwd, '.claude', 'worktrees')
        if (!fs.existsSync(dir)) return 0
        fs.rmSync(dir, { recursive: true, force: true })
        return 1
      },
    },
    {
      label: 'stub sessions (no user message)',
      action: () => {
        const dir = path.join(os.homedir(), '.squeezr-code', 'sessions')
        if (!fs.existsSync(dir)) return 0
        let n = 0
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue
          const fp = path.join(dir, f)
          try {
            const d = JSON.parse(fs.readFileSync(fp, 'utf-8')) as { messages: Array<{ role: string }> }
            const user = d.messages.filter(m => m.role === 'user').length
            if (user === 0) { fs.unlinkSync(fp); n++ }
          } catch { /* ignore */ }
        }
        return n
      },
    },
  ]

  console.log(`  \x1b[1m/clean\x1b[0m  \x1b[2m— select what to delete:\x1b[0m`)
  for (let i = 0; i < candidates.length; i++) {
    console.log(`  \x1b[36m[${i + 1}]\x1b[0m ${candidates[i].label}`)
  }
  console.log(`  \x1b[2mType space-separated numbers (e.g. "1 2 4") or "all" · Enter to cancel.\x1b[0m`)

  // Leer una línea de stdin directamente (rl está pausado).
  process.stdout.write('  \x1b[2m> \x1b[0m')
  const line = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.removeListener('data', onData)
      resolve(chunk.toString('utf-8').trim())
    }
    process.stdin.once('data', onData)
  })

  if (!line) { console.log('  \x1b[2mcancelled\x1b[0m'); return }
  const picks = line === 'all'
    ? candidates.map((_, i) => i)
    : line.split(/\s+/).map(n => parseInt(n, 10) - 1).filter(n => n >= 0 && n < candidates.length)

  let total = 0
  for (const i of picks) {
    try {
      const n = await candidates[i].action()
      total += n
      console.log(`  \x1b[32m✓\x1b[0m ${candidates[i].label.split(' (')[0]} → ${n} removed`)
    } catch (err) {
      console.log(`  \x1b[31m✖\x1b[0m ${candidates[i].label.split(' (')[0]}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(`  \x1b[1m${total}\x1b[0m items deleted.`)
}

/**
 * Committee mode: corre el mismo prompt en 3 modelos distintos (Anthropic,
 * OpenAI, Google) en paralelo vía Promise.allSettled, imprime sus respuestas
 * lado a lado, y opcionalmente sintetiza con un 4º call.
 */
async function runCommittee(
  userPrompt: string,
  authStatus: { anthropic: boolean; openai: boolean; google: boolean },
  config: SqConfig,
  cwd: string,
): Promise<void> {
  const members: Array<{ model: string; label: string }> = []
  if (authStatus.anthropic) members.push({ model: 'opus', label: 'Claude Opus' })
  if (authStatus.openai) members.push({ model: 'gpt-5', label: 'GPT-5' })
  if (authStatus.google) members.push({ model: 'gemini-3.1-pro-high', label: 'Gemini Pro' })
  if (members.length < 2) {
    console.log(`  \x1b[31m✖\x1b[0m committee needs at least 2 authenticated providers (you have ${members.length})`)
    return
  }
  console.log(`\n  \x1b[1m🏛  Committee mode\x1b[0m  \x1b[2m— ${members.length} models in parallel: ${members.map(m => m.label).join(' · ')}\x1b[0m\n`)

  const start = Date.now()
  const results = await Promise.allSettled(members.map(async (m) => {
    const text = await runSubAgent(await import('../auth/manager.js').then(x => new x.AuthManager()), config, cwd, `committee-${m.model}`, userPrompt, undefined, m.model)
    return { ...m, text }
  }))

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { label, text } = r.value
      console.log(`  \x1b[1m▸ ${label}\x1b[0m`)
      const preview = text.length > 2000 ? text.slice(0, 2000) + '\n\n  [... truncated ...]' : text
      console.log(`  \x1b[2m${preview.replace(/\n/g, '\n  ')}\x1b[0m\n`)
    } else {
      console.log(`  \x1b[31m✖\x1b[0m ${r.reason}\n`)
    }
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`  \x1b[2m═ ${elapsed}s ═\x1b[0m`)
  console.log(`  \x1b[2mReview the responses and pick the best — or ask for a synthesis like "combine the best of each".\x1b[0m`)
}

/**
 * Ejecuta /dispatch — lanza cada @modelo:prompt como sub-agente en paralelo,
 * muestra resultados con header por agente, timing individual y total.
 */
async function runDispatch(
  agents: Array<{ model: string; prompt: string }>,
  auth: AuthManager,
  config: SqConfig,
  cwd: string,
): Promise<void> {
  const BOLD = '\x1b[1m'
  const DIM = '\x1b[2m'
  const MAGENTA = '\x1b[35m'
  const GRAY = '\x1b[90m'
  const GREEN = '\x1b[32m'
  const RED = '\x1b[31m'
  const RESET = '\x1b[0m'

  console.log(`\n  ${BOLD}🚀 dispatch${RESET}  ${DIM}${agents.length} agents in parallel${RESET}`)
  for (const a of agents) {
    console.log(`    ${MAGENTA}${a.model.padEnd(12)}${RESET} ${DIM}${a.prompt.slice(0, 70)}${a.prompt.length > 70 ? '…' : ''}${RESET}`)
  }
  console.log('')

  const start = Date.now()
  const settled = await Promise.allSettled(agents.map(async (a, i) => {
    const agentStart = Date.now()
    const text = await runSubAgent(auth, config, cwd, `dispatch-${i}`, a.prompt, undefined, a.model)
    return { ...a, text, elapsedMs: Date.now() - agentStart, idx: i }
  }))

  for (const r of settled) {
    if (r.status === 'fulfilled') {
      const { model, text, elapsedMs, idx } = r.value
      console.log(`  ${GRAY}╭─${RESET} ${BOLD}[${idx + 1}]${RESET} ${MAGENTA}${model}${RESET}  ${DIM}${(elapsedMs / 1000).toFixed(1)}s${RESET}`)
      const preview = text.length > 2000 ? text.slice(0, 2000) + '\n\n[... truncated ...]' : text
      for (const line of preview.split('\n')) console.log(`  ${GRAY}│${RESET} ${line}`)
      console.log(`  ${GRAY}╰─${RESET}\n`)
    } else {
      console.log(`  ${RED}✖${RESET} ${r.reason}\n`)
    }
  }
  console.log(`  ${GREEN}✓${RESET} dispatch finished in ${DIM}${((Date.now() - start) / 1000).toFixed(1)}s${RESET}`)
}

/**
 * Ejecuta un squad (parallel o sequential) — igual que dispatch pero con
 * template aplicado (task + result_N).
 */
async function runSquadInREPL(
  squad: import('./squads.js').Squad,
  task: string,
  auth: AuthManager,
  config: SqConfig,
  cwd: string,
): Promise<void> {
  const BOLD = '\x1b[1m'
  const DIM = '\x1b[2m'
  const MAGENTA = '\x1b[35m'
  const GRAY = '\x1b[90m'
  const GREEN = '\x1b[32m'
  const RED = '\x1b[31m'
  const RESET = '\x1b[0m'
  const modeTag = squad.mode === 'parallel' ? '🚀 parallel' : '🔗 sequential'

  console.log(`\n  ${BOLD}${modeTag}${RESET}  ${DIM}${squad.agents.length} agents${RESET}`)
  console.log(`  ${DIM}task:${RESET} ${task.slice(0, 100)}${task.length > 100 ? '…' : ''}\n`)

  const start = Date.now()
  const results = await runSquad(squad, task, async (model, prompt, role) => {
    return runSubAgent(auth, config, cwd, `squad-${role}`, prompt, undefined, model)
  })

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const icon = r.error ? RED + '✖' : GREEN + '✓'
    console.log(`  ${GRAY}╭─${RESET} ${icon}${RESET} ${BOLD}${r.role}${RESET}  ${MAGENTA}${r.model}${RESET}  ${DIM}${(r.elapsedMs / 1000).toFixed(1)}s${RESET}`)
    const preview = r.result.length > 2000 ? r.result.slice(0, 2000) + '\n\n[... truncated ...]' : r.result
    for (const line of preview.split('\n')) console.log(`  ${GRAY}│${RESET} ${line}`)
    console.log(`  ${GRAY}╰─${RESET}\n`)
  }
  console.log(`  ${GREEN}✓${RESET} squad finished in ${DIM}${((Date.now() - start) / 1000).toFixed(1)}s${RESET}`)
}

/**
 * Escribe `[security]` en ~/.squeezr-code/config.toml preservando el resto.
 */
function writeSecurityConfig(sec: { redact_prompts: boolean; redact_tool_outputs: boolean; airplane: boolean }): void {
  const configPath = path.join(os.homedir(), '.squeezr-code', 'config.toml')
  let content = ''
  try { content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '' } catch { /* new */ }
  const section = `[security]\nredact_prompts = ${sec.redact_prompts}\nredact_tool_outputs = ${sec.redact_tool_outputs}\nairplane = ${sec.airplane}\n`
  if (/^\[security\]/m.test(content)) {
    content = content.replace(/\[security\][^\[]*/m, section)
  } else {
    content = content.trimEnd() + (content ? '\n\n' : '') + section
  }
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, content)
  } catch { /* best-effort */ }
}

/**
 * Prompt library — plantillas útiles hard-coded. `/library <name>` inyecta el
 * prompt como si el user lo tecleara. `/library` sin args lista los disponibles.
 */
const PROMPT_LIBRARY: Record<string, { desc: string; prompt: string }> = {
  'review-pr': {
    desc: 'Pull request-style review of the current diff',
    prompt: 'Do a review of the current git diff in this project as if it were a PR. Format: ## Summary (2-3 bullets), ## Possible bugs (with file:line), ## Suggestions, ## Missing tests.',
  },
  'explain': {
    desc: 'Explain a file or function step by step',
    prompt: 'Read the file I just mentioned and explain it to a junior dev: what it does at a high level, architecture, critical parts, patterns used. Use specific comments (file:line).',
  },
  'tests': {
    desc: 'Generate tests for the last mentioned file',
    prompt: 'Generate unit tests for the last function/file we reviewed. Cover: happy path, edge cases (null, empty, bounds), expected errors. Use the framework already configured in the project.',
  },
  'optimize': {
    desc: 'Look for optimization opportunities',
    prompt: 'Analyze the current code looking for optimization opportunities: algorithmic complexity, unnecessary I/O, memory leaks, N+1 queries. Propose 3-5 concrete changes ordered by impact.',
  },
  'docs': {
    desc: 'Generate JSDoc/TSDoc documentation',
    prompt: 'Add JSDoc/TSDoc to the public functions of the current file. Format: short description, @param with types, @returns, @throws. Only exported functions.',
  },
  'refactor': {
    desc: 'Step-by-step refactor with justification',
    prompt: 'Refactor the current file applying: consistent naming, helper extraction, reduction of cyclomatic complexity. Propose EACH change before applying it explaining why.',
  },
  'commit': {
    desc: 'Suggest commit message for the current diff',
    prompt: 'Read the staged + unstaged git diff and propose a commit message (<72 chars title, optional body). Conventional commits style if the repo uses it.',
  },
  'debug': {
    desc: 'Systematic debug of a bug',
    prompt: "I'm going to tell you about a bug. Follow this flow: 1) repeat your understanding, 2) propose hypotheses ordered by probability, 3) for each hypothesis tell me what to verify, 4) after my checks, refine. think hard.",
  },
}

function handleLibraryCmd(name: string, rl: readline.Interface): void {
  if (!name) {
    const GRAY = '\x1b[90m'
    const CYAN = '\x1b[36m'
    const RESET = '\x1b[0m'
    console.log(`  \x1b[1mPrompt library\x1b[0m  ${GRAY}— /library NAME to use${RESET}`)
    for (const [key, { desc }] of Object.entries(PROMPT_LIBRARY)) {
      console.log(`    ${CYAN}${key.padEnd(12)}${RESET} ${desc}`)
    }
    return
  }
  const entry = PROMPT_LIBRARY[name]
  if (!entry) {
    console.log(`  \x1b[31m✖\x1b[0m library "${name}" does not exist. Use /library to see the list.`)
    return
  }
  console.log(`  \x1b[2m▸ library:\x1b[0m \x1b[36m${name}\x1b[0m`)
  setImmediate(() => rl.emit('line', entry.prompt))
}

/**
 * Snippets: fragmentos reusables guardados en ~/.squeezr-code/snippets.json.
 * save guarda el último text del assistant; insert lo devuelve como prompt.
 */
function handleSnippetCmd(args: string, history: NormalizedMessage[]): { message?: string; insert?: string } {
  const snipFile = path.join(os.homedir(), '.squeezr-code', 'snippets.json')
  const load = (): Record<string, string> => {
    try { return JSON.parse(fs.readFileSync(snipFile, 'utf-8')) as Record<string, string> } catch { return {} }
  }
  const save = (s: Record<string, string>): void => {
    try {
      fs.mkdirSync(path.dirname(snipFile), { recursive: true })
      fs.writeFileSync(snipFile, JSON.stringify(s, null, 2))
    } catch { /* ignore */ }
  }
  const parts = args.split(/\s+/).filter(Boolean)
  const sub = parts[0] || 'list'
  const snippets = load()

  if (sub === 'list' || !sub) {
    const keys = Object.keys(snippets)
    if (keys.length === 0) return { message: `  \x1b[2mno snippets saved\x1b[0m` }
    const lines = [`  \x1b[1m${keys.length}\x1b[0m snippets:`]
    for (const k of keys) {
      const v = snippets[k]
      lines.push(`    \x1b[36m${k.padEnd(14)}\x1b[0m \x1b[2m${v.length} chars\x1b[0m`)
    }
    return { message: lines.join('\n') }
  }

  if (sub === 'save') {
    const name = parts[1]
    if (!name) return { message: `  \x1b[31m✖\x1b[0m usage: /snippet save NAME` }
    // Usa el último assistant text.
    const lastAssist = [...history].reverse().find(m =>
      m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'text'),
    )
    if (!lastAssist) return { message: `  \x1b[31m✖\x1b[0m no assistant message yet` }
    const textBlock = Array.isArray(lastAssist.content)
      ? lastAssist.content.find(b => b.type === 'text')?.text
      : lastAssist.content as string
    if (!textBlock) return { message: `  \x1b[31m✖\x1b[0m last assistant had no text` }
    snippets[name] = textBlock
    save(snippets)
    return { message: `  \x1b[32m✓\x1b[0m snippet \x1b[36m${name}\x1b[0m saved (${textBlock.length} chars)` }
  }

  if (sub === 'insert') {
    const name = parts[1]
    if (!name || !(name in snippets)) return { message: `  \x1b[31m✖\x1b[0m snippet not found: ${name}` }
    return { insert: snippets[name] }
  }

  if (sub === 'delete' || sub === 'rm') {
    const name = parts[1]
    if (!name || !(name in snippets)) return { message: `  \x1b[31m✖\x1b[0m snippet not found: ${name}` }
    delete snippets[name]
    save(snippets)
    return { message: `  \x1b[32m✓\x1b[0m snippet \x1b[36m${name}\x1b[0m deleted` }
  }

  return { message: `  \x1b[31m✖\x1b[0m subcommand: list | save NAME | insert NAME | delete NAME` }
}

/**
 * /gh pr NUMBER — ejecuta `gh pr view NUMBER --json ...` + `gh pr diff NUMBER`
 * y devuelve un prompt con toda esa info como contexto.
 */
async function handleGhCmd(args: string, cwd: string): Promise<{ message?: string; prompt?: string }> {
  const parts = args.split(/\s+/).filter(Boolean)
  if (parts[0] !== 'pr' || !parts[1]) {
    return { message: `  \x1b[31m✖\x1b[0m usage: /gh pr NUMBER [--repo owner/name]  (without --repo infers from the git remote of cwd)` }
  }
  const prNum = parts[1]
  if (!/^\d+$/.test(prNum)) {
    return { message: `  \x1b[31m✖\x1b[0m NUMBER must be a number: ${prNum}` }
  }
  // Soporta --repo owner/name para atacar un repo distinto al del cwd.
  let repoFlag = ''
  const repoIdx = parts.indexOf('--repo')
  if (repoIdx >= 0 && parts[repoIdx + 1]) {
    const r = parts[repoIdx + 1]
    if (!/^[\w.-]+\/[\w.-]+$/.test(r)) {
      return { message: `  \x1b[31m✖\x1b[0m --repo debe ser owner/name, got: ${r}` }
    }
    repoFlag = ` --repo ${r}`
  }
  try {
    execSync('gh --version', { stdio: 'ignore' })
  } catch {
    return { message: `  \x1b[31m✖\x1b[0m gh CLI is not installed. https://cli.github.com` }
  }
  let meta = '', diff = ''
  try {
    meta = execSync(`gh pr view ${prNum}${repoFlag} --json number,title,author,state,body,url,baseRefName,headRefName,headRepository`, {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 5_000_000,
    })
    diff = execSync(`gh pr diff ${prNum}${repoFlag}`, {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10_000_000,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/no.+default.+remote|could not determine|no git remotes/i.test(msg)) {
      return { message: `  \x1b[31m✖\x1b[0m sq does not know which GitHub repo to use. Options:\n    · run sq from a directory that is a repo with a GitHub remote\n    · or pass --repo: /gh pr ${prNum} --repo owner/name` }
    }
    return { message: `  \x1b[31m✖\x1b[0m gh pr ${prNum} failed: ${msg.slice(0, 300)}` }
  }
  const truncatedDiff = diff.length > 80_000 ? diff.slice(0, 80_000) + '\n\n[... diff truncated to 80k chars ...]' : diff
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(meta) } catch { /* keep empty */ }
  const prompt = `I'm going to review PR #${prNum} (${parsed.title || '—'}) by ${(parsed.author as { login?: string })?.login || '?'}.

Meta:
- State: ${parsed.state}
- Branch: ${parsed.headRefName} → ${parsed.baseRefName}
- URL: ${parsed.url}

Description:
${parsed.body || '(no description)'}

Diff:
\`\`\`diff
${truncatedDiff}
\`\`\`

Do a structured review: summary, potential bugs with file:line, improvement suggestions, missing tests.`
  return { prompt }
}

/** ms → "3h" / "12d". Formato compacto para la UI. */
function formatAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/**
 * Handler para `/template [save NAME PROMPT | use NAME args...]`. Persiste
 * en ~/.squeezr-code/templates.json. Soporta placeholders $1, $2... que se
 * reemplazan por los args del `use`.
 */
function handleTemplateCmd(args: string): { prompt?: string; message?: string } {
  const templatesFile = path.join(os.homedir(), '.squeezr-code', 'templates.json')
  const load = (): Record<string, string> => {
    try { return JSON.parse(fs.readFileSync(templatesFile, 'utf-8')) as Record<string, string> } catch { return {} }
  }
  const save = (t: Record<string, string>): void => {
    try {
      fs.mkdirSync(path.dirname(templatesFile), { recursive: true })
      fs.writeFileSync(templatesFile, JSON.stringify(t, null, 2))
    } catch { /* ignore */ }
  }

  const parts = args.split(/\s+/).filter(Boolean)
  const sub = parts[0] || 'list'
  const templates = load()

  if (sub === 'list' || !sub) {
    const keys = Object.keys(templates)
    if (keys.length === 0) {
      return { message: `  \x1b[2mno templates. Create one:\x1b[0m /template save NAME "prompt with $1, $2…"` }
    }
    const lines = [`  \x1b[1m${keys.length}\x1b[0m templates:`]
    for (const k of keys) {
      const v = templates[k]
      lines.push(`    \x1b[36m${k.padEnd(14)}\x1b[0m ${v.length > 80 ? v.slice(0, 80) + '…' : v}`)
    }
    return { message: lines.join('\n') }
  }

  if (sub === 'save') {
    const name = parts[1]
    const promptText = parts.slice(2).join(' ')
    if (!name || !promptText) {
      return { message: `  \x1b[31m✖\x1b[0m usage: /template save NAME "prompt"` }
    }
    templates[name] = promptText
    save(templates)
    return { message: `  \x1b[32m✓\x1b[0m template \x1b[36m${name}\x1b[0m saved` }
  }

  if (sub === 'delete' || sub === 'rm') {
    const name = parts[1]
    if (!name || !(name in templates)) {
      return { message: `  \x1b[31m✖\x1b[0m template not found: ${name}` }
    }
    delete templates[name]
    save(templates)
    return { message: `  \x1b[32m✓\x1b[0m template \x1b[36m${name}\x1b[0m deleted` }
  }

  if (sub === 'use') {
    const name = parts[1]
    if (!name || !(name in templates)) {
      return { message: `  \x1b[31m✖\x1b[0m template not found: ${name}. List with /template list` }
    }
    const userArgs = parts.slice(2)
    let prompt = templates[name]
    for (let i = 0; i < userArgs.length; i++) {
      prompt = prompt.replaceAll(`$${i + 1}`, userArgs[i])
    }
    return { prompt }
  }

  return { message: `  \x1b[31m✖\x1b[0m unknown subcommand: ${sub}. Use: list | save NAME "prompt" | use NAME args... | delete NAME` }
}

/**
 * Handler para `/sessions [list|prune [N]|retain N]`. Síncrono — no usa rl.pause
 * porque no hace I/O interactivo, solo print/fs.
 */
function handleSessionsCmd(args: string, config: SqConfig): void {
  const parts = args.split(/\s+/).filter(Boolean)
  const sub = parts[0] || 'list'
  const sessionsDir = path.join(os.homedir(), '.squeezr-code', 'sessions')

  if (sub === 'list' || sub === '') {
    if (!fs.existsSync(sessionsDir)) {
      console.log(`  \x1b[2mno sessions yet\x1b[0m`)
      return
    }
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'))
    let total = 0, stubs = 0, oldest = Date.now(), newest = 0
    for (const f of files) {
      const fp = path.join(sessionsDir, f)
      total += fs.statSync(fp).size
      try {
        const d = JSON.parse(fs.readFileSync(fp, 'utf-8'))
        if (d.messages.filter((m: { role: string }) => m.role === 'user').length === 0) stubs++
        if (d.updatedAt < oldest) oldest = d.updatedAt
        if (d.updatedAt > newest) newest = d.updatedAt
      } catch { stubs++ }
    }
    const retain = config.sessions?.auto_prune_days || 0
    const days = (ts: number) => Math.round((Date.now() - ts) / 86_400_000)
    console.log(`  \x1b[1m${files.length}\x1b[0m sessions · \x1b[2m${(total / 1024).toFixed(1)} KB\x1b[0m`)
    if (files.length > 0) {
      console.log(`  \x1b[2mmost recent: ${days(newest)}d ago · oldest: ${days(oldest)}d ago · stubs: ${stubs}\x1b[0m`)
    }
    console.log(`  \x1b[2mretain: ${retain > 0 ? retain + ' days (auto-prune on startup)' : 'OFF (keeps all indefinitely)'}\x1b[0m`)
    console.log(`  \x1b[2m/sessions prune [N]   delete > N days + stubs (default 90)\x1b[0m`)
    console.log(`  \x1b[2m/sessions retain N    auto-delete > N days on startup (0 = off)\x1b[0m`)
    return
  }

  if (sub === 'prune') {
    const days = parts[1] ? parseInt(parts[1], 10) : 90
    if (Number.isNaN(days) || days < 0) {
      console.log(`  \x1b[31m✖\x1b[0m usage: /sessions prune [N]  (N = days, default 90)`)
      return
    }
    const deleted = pruneSessions({ maxAgeDays: days, maxKeep: 999999 })
    console.log(`  \x1b[32m✓\x1b[0m deleted ${deleted} sessions${deleted > 0 ? ` (stubs + > ${days} days)` : ''}`)
    return
  }

  if (sub === 'retain') {
    const raw = parts[1]
    const n = raw === 'off' ? 0 : parseInt(raw, 10)
    if (raw === undefined || (raw !== 'off' && (Number.isNaN(n) || n < 0))) {
      console.log(`  \x1b[31m✖\x1b[0m usage: /sessions retain N  (N = days, or 'off')`)
      return
    }
    writeSessionsRetainToConfig(n)
    if (n === 0) {
      console.log(`  \x1b[32m✓\x1b[0m auto-prune disabled — all sessions are kept`)
    } else {
      console.log(`  \x1b[32m✓\x1b[0m auto-prune at ${n} days — will apply on sq startup`)
    }
    // Actualiza la config en runtime también, así el cambio aplica sin reiniciar.
    config.sessions = config.sessions || { auto_prune_days: 0 }
    config.sessions.auto_prune_days = n
    return
  }

  console.log(`  \x1b[31m✖\x1b[0m unknown subcommand: ${sub}. Use: list | prune [N] | retain N`)
}

/**
 * Escribe `[sessions] auto_prune_days = N` en ~/.squeezr-code/config.toml,
 * preservando el resto del fichero. Si no existe, lo crea. Si la sección ya
 * está, reemplaza la línea. Best-effort: errores se loguean pero no revientan.
 */
function writeSessionsRetainToConfig(days: number): void {
  const configPath = path.join(os.homedir(), '.squeezr-code', 'config.toml')
  let content = ''
  try {
    if (fs.existsSync(configPath)) {
      content = fs.readFileSync(configPath, 'utf-8')
    }
  } catch { /* nuevo fichero */ }

  const section = `[sessions]\nauto_prune_days = ${days}\n`

  if (/^\[sessions\]/m.test(content)) {
    // Reemplaza la sección entera hasta la siguiente sección o EOF.
    content = content.replace(/\[sessions\][^\[]*/m, section)
  } else {
    content = content.trimEnd() + (content ? '\n\n' : '') + section
  }

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, content)
  } catch (err) {
    console.log(`  \x1b[31m✖\x1b[0m could not write to ${configPath}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Autocompletado: TAB completa comandos (`/he` → `/help`) y sub-valores de `/model`.
 * Para resto de texto (prompts libres), no sugiere nada.
 */
function completer(line: string): [string[], string] {
  // /model <alias>
  if (line.startsWith('/model ')) {
    const prefix = line.slice('/model '.length)
    const aliases = getAliasKeys()
    const hits = aliases.filter(a => a.startsWith(prefix)).map(a => `/model ${a}`)
    return [hits.length > 0 ? hits : aliases.map(a => `/model ${a}`), line]
  }
  // /comando
  if (line.startsWith('/')) {
    const hits = COMMANDS.filter(c => c.startsWith(line))
    return [hits.length > 0 ? hits : COMMANDS, line]
  }
  // @... al final de la línea — file path o model alias.
  const atMatch = /@([^\s]*)$/.exec(line)
  if (atMatch) {
    const token = atMatch[1]
    // File-path: si el token tiene /, \, . o ~, completamos con rutas del fs.
    if (/[/\\.~]/.test(token)) {
      const hits = completeFilePath(token, process.cwd()).map(p => line.slice(0, atMatch.index) + '@' + p)
      return [hits, line]
    }
    // Model alias
    const aliases = getAliasKeys()
    const hits = aliases.filter(a => a.startsWith(token)).map(a => line.slice(0, atMatch.index) + '@' + a + ' ')
    return [hits, line]
  }
  return [[], line]
}

/** Completa `@path/to/f` listando el directorio `path/to/` filtrado por prefix `f`. */
function completeFilePath(token: string, cwd: string): string[] {
  try {
    let absBase: string
    if (token.startsWith('~/') || token.startsWith('~\\')) {
      absBase = path.join(os.homedir(), token.slice(2))
    } else if (path.isAbsolute(token)) {
      absBase = token
    } else {
      absBase = path.join(cwd, token)
    }
    const endsInSep = /[\\/]$/.test(token)
    const dir = endsInSep ? absBase : path.dirname(absBase)
    const prefix = endsInSep ? '' : path.basename(absBase)
    if (!fs.existsSync(dir)) return []
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.name.startsWith(prefix) && !e.name.startsWith('.'))
      .slice(0, 25)
      .map(e => {
        const base = endsInSep ? token + e.name : token.slice(0, token.length - prefix.length) + e.name
        return e.isDirectory() ? base + '/' : base + ' '
      })
    return entries
  } catch {
    return []
  }
}

export async function startREPL(config: SqConfig, opts: { resumeSession?: Session } = {}): Promise<void> {
  let cwd = process.cwd()
  const projectName = path.basename(cwd)
  const renderer = new Renderer()
  // Aplica customizaciones de display desde sq.toml / config.toml.
  if (config.display?.prompt_char) renderer.setPromptChar(config.display.prompt_char)

  // Init auth
  const auth = new AuthManager()
  const authStatus = await auth.init()

  // Auto-refresh proactivo: cada 60s, refresca tokens que expiran en < 2 min.
  // Evita que el primer prompt falle porque acaba de caducar el access_token
  // mientras tenías el REPL abierto idle.
  const refreshInterval = setInterval(() => {
    void auth.refreshIfNeeded(2 * 60_000)
  }, 60_000)
  refreshInterval.unref()

  // Init the internal agent (the brain of sq — runs the agentic loop)
  const agent = new SqAgent(auth, {
    defaultModel: config.agent.default,
    permissions: config.agent.permissions,
    rules: config.permissions,
    recaps: config.display.recaps,
    sandbox: config.sandbox,
    transplant: {
      warnThreshold: config.transplant.warn_threshold,
      autoThreshold: config.transplant.auto_threshold,
    },
  })

  // MCP servers: por defecto solo `sq.toml`. Si `mcp_auto_import = true` en
  // sq.toml (o env SQ_MCP_AUTO_IMPORT=1), también lee Claude Code / Claude
  // Desktop / .mcp.json del proyecto. Esto es OPT-IN para que sq sea su propio
  // mundo y no herede MCPs sin que el usuario lo pida explícitamente.
  // Para importar manualmente: `sq mcp import` (interactivo).
  const mcp = new McpManager()
  const fromConfig = Object.entries(config.mcp || {}).map(([name, spec]) => ({
    name, command: spec.command, args: spec.args, env: spec.env,
  }))
  const configNames = new Set(fromConfig.map(s => s.name))
  const discovered = config.mcp_auto_import
    ? discoverMcpServers(cwd).filter(s => !configNames.has(s.name))
    : []
  const mcpSpecs = [...fromConfig, ...discovered]
  if (mcpSpecs.length > 0) {
    // No await: los servers se conectan en background. El REPL arranca ya y
    // los MCPs aparecen como connecting → connected/error en /mcp a medida que
    // responden al handshake (timeout 8s por server).
    mcp.start(mcpSpecs)
  }
  agent.setMcpManager(mcp)

  // Screen layout PRIMERO — antes de cualquier output. Esto entra en alt
  // screen buffer, setea scroll region [1, H-4], y deja cursor en row 1
  // listo para que renderWelcome + output llenen la región de arriba abajo.
  const pinEnabled = config.display.pin_input_bottom === true
  const scrollCleanup = pinEnabled
    ? enableScreen(() => { drawPinnedLines(); positionPromptCursor() })
    : () => { /* disabled */ }

  // Welcome: banner grande siempre.
  renderer.renderWelcomeFull(getVersion(), authStatus, cwd, config.display?.banner_style)

  // Info de MCP servers activos
  const mcpActive = mcp.getActiveServers()
  if (mcpActive.length > 0) {
    console.log(`  \x1b[2mMCP:\x1b[0m ${mcpActive.map(n => `\x1b[36m${n}\x1b[0m`).join(', ')}\n`)
  }

  // Update check: fire-and-forget, 2s timeout, 24h cache. No bloquea arranque.
  void checkForUpdate().then(latest => {
    if (latest) {
      console.log(`  \x1b[33m↑\x1b[0m new version \x1b[1m${latest}\x1b[0m available · \x1b[2mnpm i -g squeezr-code@latest\x1b[0m\n`)
    }
  }).catch(() => { /* silencioso */ })

  // Auto-prune SOLO si el usuario lo pidió explícitamente con
  // `/sessions retain N` (persistido en ~/.squeezr-code/config.toml como
  // `[sessions] auto_prune_days = N`). Default: no se borra NADA.
  if (config.sessions?.auto_prune_days && config.sessions.auto_prune_days > 0) {
    try { pruneSessions({ maxAgeDays: config.sessions.auto_prune_days, maxKeep: 999999 }) } catch { /* best-effort */ }
  }

  // Sesión: resume si nos pasaron una, o crea nueva.
  let session = opts.resumeSession || Session.create({ cwd, model: agent.getCurrentModel() })

  // Audit logs opt-in. Si el usuario puso `[audit] enabled = true` en
  // ~/.squeezr-code/config.toml, logueamos cada tool ejecutada.
  if (config.audit?.enabled) {
    setAuditEnabled(true, session.getId())
    console.log(`  \x1b[2maudit log:\x1b[0m ~/.squeezr-code/audit.log\n`)
  }

  // Security: scan de tool outputs. Default ON — poco coste, mucha seguridad.
  setScanToolOutputs(config.security?.redact_tool_outputs !== false)
  if (config.security?.airplane) {
    console.log(`  \x1b[33m✈  airplane mode ACTIVE\x1b[0m — no API calls will be made. \x1b[2m/airplane off to disable.\x1b[0m\n`)
  }
  if (opts.resumeSession) {
    agent.setConversationHistory(opts.resumeSession.getMessages())
    agent.setModel(opts.resumeSession.getModel())
    const turns = opts.resumeSession.getMessages().filter(m => m.role === 'user').length
    console.log(`  \x1b[2mresumed session\x1b[0m \x1b[36m${opts.resumeSession.getId().slice(0, 13)}\x1b[0m \x1b[2m(${turns} turns)\x1b[0m\n`)

    // Auto-compact si el historial cargado es grande (> 100KB de caracteres).
    // Evita que un "hola" consuma 100k+ tokens por re-enviar historial antiguo.
    const RESUME_COMPACT_THRESHOLD = 100_000
    if (agent.historyChars() > RESUME_COMPACT_THRESHOLD) {
      process.stdout.write(`  \x1b[33m▸\x1b[0m session history is large (${Math.round(agent.historyChars() / 1000)}KB) — compacting before start…\n`)
      try {
        for await (const ev of agent.compact()) {
          if (ev.type === 'text' && ev.text) process.stdout.write('')
        }
        session.updateMessages(agent.getConversationHistory())
        process.stdout.write(`  \x1b[32m✓\x1b[0m compacted — history is now ${Math.round(agent.historyChars() / 1000)}KB\n\n`)
      } catch (e) {
        process.stdout.write(`  \x1b[31m✖\x1b[0m compact failed: ${e instanceof Error ? e.message : String(e)}\n\n`)
      }
    }
  }
  agent.onPersist((messages) => {
    session.updateMessages(messages)
  })

  // Runners para los tools que necesitan hablar con el REPL o spawnear
  // sub-agentes. Se registran globalmente en el executor.
  setSubAgentRunner(async (description, subPrompt, subagentType, modelOverride) => {
    // Sub-agente: comparte auth + cwd pero es una sesión aislada. Si viene:
    //   - subagent_type → carga ~/.squeezr-code/agents/<name>.md (sys prompt + model + tools)
    //   - model → override explícito del modelo (ganaría sobre subagent_type)
    // El modelo puede llamar `Task(model="haiku", ...)` + `Task(model="opus", ...)` a la vez
    // y cada sub-agente correrá con su provider distinto, en paralelo.
    return runSubAgent(auth, config, cwd, description, subPrompt, subagentType, modelOverride)
  })
  setUserQuestioner(async (question, options, multi) => {
    // CRÍTICO: parar el spinner antes de abrir el picker. Si no, su timer
    // sigue escribiendo \r\x1b[K{spinner} cada 80ms, machaca el picker y
    // rompe el cursor save/restore.
    renderer.stopSpinnerExternal()
    return askUserInteractive(rl, question, options, multi)
  })
  // Cron fire handler: cuando un job programado con CronCreate se dispara,
  // inyecta el prompt en rl como si el user lo hubiera tecleado. Solo si el
  // REPL está idle — si hay turno en curso, lo encolamos.
  setCronFireHandler((prompt) => {
    console.log(`\n  \x1b[33m⏰\x1b[0m cron fired → ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`)
    setImmediate(() => rl.emit('line', prompt))
  })
  startCronTicker()

  // EnterWorktree / ExitWorktree cambian el cwd que recibe el agente en el
  // siguiente turno. El tool guarda el estado; nosotros solo reasignamos.
  setWorktreeCwdChanger((newCwd) => {
    cwd = newCwd
    try { process.chdir(newCwd) } catch { /* si falla, al menos nuestro cwd local está actualizado */ }
  })

  setPlanApprover(async (plan) => {
    renderer.stopSpinnerExternal()
    // Muestra el plan en un bloque visible y pregunta y/n.
    const DIM = '\x1b[2m'
    const GRAY = '\x1b[90m'
    const GREEN = '\x1b[32m'
    const BOLD = '\x1b[1m'
    const RESET = '\x1b[0m'
    console.log(`\n${GRAY}╭─${RESET} ${BOLD}Proposed plan${RESET}`)
    for (const line of plan.split('\n')) console.log(`${GRAY}│${RESET} ${line}`)
    console.log(`${GRAY}╰─${RESET}`)
    const yes = await promptYesNo(`\n  ${GREEN}Approve plan and switch to accept-edits?${RESET} ${DIM}[Y/n]${RESET} `)
    if (yes) {
      currentMode = 'accept-edits'
      agent.setPermissionMode('accept-edits')
      console.log(`  ${GREEN}✓${RESET} mode changed to ${DIM}accept-edits${RESET}`)
    } else {
      console.log(`  ${DIM}still in plan mode — refine the plan or request more investigation${RESET}`)
    }
    return yes
  })

  // Carga la lista real de modelos (caché 1h en ~/.squeezr-code/models-cache.json).
  // Bloqueamos antes del primer prompt para evitar que el usuario escriba `@5.4-mini`
  // antes de que se conozcan los aliases → la petición iría al provider equivocado.
  const loadPromise = loadModels(auth, authStatus).catch(() => [])
  const loadTimer = setTimeout(() => {
    process.stdout.write('\x1b[2m  loading models…\x1b[0m\r')
  }, 300)
  await loadPromise
  clearTimeout(loadTimer)
  process.stdout.write('\r\x1b[K')

  // Resuelve el default del config (puede ser alias tipo "sonnet" o ID completo)
  // al ID real según lo que devolvió /v1/models. Sin esto, con sq.toml apuntando
  // a "sonnet" acabaríamos pegándole a api.anthropic.com con modelo "sonnet" y 404.
  const resolvedDefault = resolveModelAlias(config.agent.default)
  if (resolvedDefault !== agent.getCurrentModel()) {
    agent.setModel(resolvedDefault)
  }

  // Check if we have auth for the default provider
  const defaultProvider = agent.getCurrentProvider()
  if (!authStatus[defaultProvider]) {
    const available = auth.authenticated()
    if (available.length === 0) {
      console.error('\x1b[31mNo providers authenticated. Run: sq login\x1b[0m')
      process.exit(1)
    }
    const modelMap: Record<string, string> = {
      anthropic: 'claude-sonnet-4-20250514',
      openai: 'o3',
      google: 'gemini-2.5-pro',
    }
    agent.setModel(modelMap[available[0]] || config.agent.default)
    console.log(`  \x1b[33mDefault provider not available. Using ${available[0]} (${agent.getCurrentModel()})\x1b[0m\n`)
  }

  // Aplica theme antes de crear el REPL.
  setTheme(config.display.theme || 'dark')

  // Modo actual (se cicla con Shift+Tab). Normalizamos legacy (auto/yolo → bypass).
  let currentMode: Mode = (config.agent.permissions === 'auto' || config.agent.permissions === 'yolo')
    ? 'bypass'
    : (config.agent.permissions as Mode)

  // REPL con completer + historial persistente.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer,
    historySize: 500,
    prompt: renderer.renderStatus({
      project: projectName,
      cwd,
      contextPercent: 0,
      costUsd: 0,
      model: agent.getCurrentModel(),
      mode: currentMode,
      subscriptions: null,
    }),
  })

  // Pre-carga el historial en el readline (newest first como espera readline).
  const past = loadHistory()
  for (const entry of [...past].reverse()) {
    ;(rl as unknown as { history: string[] }).history.push(entry)
  }

  // Attachments pendientes indexadas por número. Cada Ctrl+V incrementa el
  // contador e inserta `[Image #N]` como texto literal en el prompt; al enviar,
  // extraemos los `[Image #N]` del texto y adjuntamos las imágenes asociadas
  // (el modelo ve ambos → puede referenciar "corrige el error en [Image #1]").
  // El contador es global de sesión (no se resetea por turno) para que el user
  // pueda referenciar imágenes de turnos anteriores si el modelo lo soporta.
  const imagesByIndex = new Map<number, { base64: string; mediaType: string }>()
  let imageCounter = 0
  // Sticky mentions: paths con `@@path.ts` que se re-inyectan automáticamente
  // en cada turno hasta que se limpian con /sticky clear.
  const stickyMentions: string[] = []
  let isProcessingRef = { v: false }  // ref para que el closure de keypress vea cambios

  // ─── Bracketed paste mode para Ctrl+V → imagen ──────────────────
  //
  // Windows Terminal / iTerm2 / modernos → interceptan Ctrl+V al nivel del
  // terminal y NO envían el keystroke raw al proceso. Sí nos envían el
  // protocolo "bracketed paste": cuando activamos `\x1b[?2004h`, el terminal
  // envuelve el paste entre `\x1b[200~` y `\x1b[201~`. Para clipboard de
  // solo-imagen, Windows Terminal sigue enviando esos marcadores con contenido
  // vacío entre ellos → nosotros los detectamos y ESE es el evento "el user
  // hizo Ctrl+V".
  //
  // Cuando detectamos paste-start, pedimos al SO el clipboard image (async,
  // no bloquea). Si hay imagen, insertamos `[Image #N]`. Si solo texto, no
  // hacemos nada — readline ya está insertando el texto por su cuenta.
  //
  // Es el mismo patrón que Claude Code / Gemini CLI (confirmado via PR
  // #13997 de google-gemini/gemini-cli).
  process.stdout.write('\x1b[?2004h')  // enable bracketed paste
  const disableBracketedPaste = () => { try { process.stdout.write('\x1b[?2004l') } catch { /* ignore */ } }
  process.on('exit', disableBracketedPaste)

  const onStdinData = (chunk: Buffer | string) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    if (!s.includes('\x1b[200~')) return   // no es paste
    if (isProcessingRef.v) return          // turno en curso, no tocamos input
    // Dispara chequeo async — readline seguirá procesando el texto que venga
    // entre los marcadores por su cuenta.
    void readClipboardImageAsync().then(img => {
      if (!img) return  // paste era texto plano, readline ya lo insertó
      imageCounter += 1
      const idx = imageCounter
      imagesByIndex.set(idx, img)
      const token = `[Image #${idx}]`

      const rlInternal = rl as unknown as { line: string; cursor: number; _refreshLine?: () => void }
      const before = rlInternal.line.slice(0, rlInternal.cursor)
      const after = rlInternal.line.slice(rlInternal.cursor)
      rlInternal.line = before + token + after
      rlInternal.cursor = before.length + token.length
      if (typeof rlInternal._refreshLine === 'function') rlInternal._refreshLine()

      const sizeKB = Math.round(img.base64.length * 3 / 4 / 1024)
      process.stdout.write('\n')
      printImagePaste(token, img.base64, img.mediaType, sizeKB)
      rl.prompt(true)
    }).catch(() => { /* silencio */ })
  }
  process.stdin.on('data', onStdinData)
  rl.on('close', () => {
    process.stdin.off('data', onStdinData)
    disableBracketedPaste()
  })

  // ─── Image paste keypress intercept (fallback para Alt+V, F2) ───
  // Windows Terminal / iTerm2 / GNOME Terminal interceptan Ctrl+V para pegar
  // el TEXTO del clipboard — cuando el clipboard solo tiene imagen, pegan
  // cadena vacía y el keypress Ctrl+V real NUNCA llega a Node. No podemos
  // anular eso desde el proceso hijo.
  //
  // Por eso bindeamos varias teclas que el terminal SÍ deja pasar:
  //   - Alt+V    → \x1bv — no bindeada por defecto en Windows Terminal
  //   - F2       → escape seq \x1bOQ, siempre pasa
  //   - Ctrl+V   → por si el terminal no la intercepta (algunos Linux)
  //
  // Cualquiera de las 3 dispara el mismo flow: lee clipboard, inserta
  // `[Image #N]` en el input. El usuario sigue tecleando su prompt.
  readline.emitKeypressEvents(process.stdin)
  // Global keybindings — toggles de Ctrl+O (thinking) y Ctrl+T (tasks).
  // Los cablemos ANTES del listener de /paste para que no colisionen.
  let thinkingExpanded = false
  let tasklistCollapsed = false
  process.stdin.on('keypress', (_str: string, key: { ctrl?: boolean; name?: string } | undefined) => {
    if (!key || !key.ctrl) return
    if (key.name === 'o') {
      thinkingExpanded = !thinkingExpanded
      renderer.setThinkingCollapsed(!thinkingExpanded)
      // En pin mode refrescamos la línea del mode para actualizar el hint
      // "Ctrl+O expand thinking" ↔ "Ctrl+O collapse thinking" al instante.
      // En inline mode, esperamos al siguiente turno (evita escribir a stdout
      // mid-streaming, que corrompe el render).
      if (pinEnabled) drawPinnedLines()
      return
    }
    if (key.name === 't') {
      tasklistCollapsed = !tasklistCollapsed
      renderer.setTasklistCollapsed(tasklistCollapsed)
      if (pinEnabled) drawPinnedLines()
      return
    }
  })

  process.stdin.on('keypress', (_str: string, key: { ctrl?: boolean; meta?: boolean; name?: string } | undefined) => {
    if (!key) return
    // Ctrl+V no lo capturamos aquí: si el terminal lo deja pasar, el
    // bracketed paste handler (stdin 'data') ya disparará el flow y evitamos
    // doble inserción. Solo Alt+V y F2 llegan garantizados por keypress.
    const isPasteKey =
      (key.meta && key.name === 'v') ||       // Alt+V
      (key.name === 'f2')                      // F2
    if (!isPasteKey) return
    if (isProcessingRef.v) return  // no interrumpe un turno en curso
    const img = readClipboardImage()
    if (!img) return  // sin imagen → Ctrl+V default (normalmente nada)

    // Asigna número, guarda la imagen en el map, e inserta `[Image #N]` en la
    // posición del cursor dentro del input. NO envía — el usuario sigue
    // tecleando su prompt y le da Enter cuando quiera.
    imageCounter += 1
    const idx = imageCounter
    imagesByIndex.set(idx, img)
    const token = `[Image #${idx}]`

    const rlInternal = rl as unknown as { line: string; cursor: number; _refreshLine: () => void }
    // Borra el \x16 (Ctrl+V) que readline pudo insertar.
    rlInternal.line = rlInternal.line.replace(/\x16/g, '')
    // Inserta el token en la posición del cursor.
    const before = rlInternal.line.slice(0, rlInternal.cursor)
    const after = rlInternal.line.slice(rlInternal.cursor)
    rlInternal.line = before + token + after
    rlInternal.cursor = before.length + token.length
    if (typeof rlInternal._refreshLine === 'function') rlInternal._refreshLine()
  })

  // Custom slash commands (skills) — drop-in .md en ~/.squeezr-code/commands/
  installBuiltinSkills()  // instala las skills predefinidas si no existen
  const customCommands = loadCustomCommands(cwd)
  if (customCommands.length > 0) {
    console.log(`  \x1b[2mCustom commands:\x1b[0m ${customCommands.map(c => `\x1b[36m/${c.name}\x1b[0m`).join(', ')}\n`)
  }

  // Sintaxis highlight para /comando y @alias mientras escribes + hints abajo.
  setCommandList([...COMMANDS, ...customCommands.map(c => `/${c.name}`)])
  setAliasList(getAliasKeys())
  installHighlight(rl)

  // Esc: limpiar línea cuando estás escribiendo (igual que claude code).
  // Shift+Tab: cicla entre modos (default → accept-edits → plan → bypass).
  process.stdin.on('keypress', (_str, key) => {
    if (!key) return

    // Shift+Tab → cicla modo (sin/con turno en curso; operativo siempre).
    if (key.name === 'tab' && key.shift) {
      currentMode = cycleMode(currentMode)
      agent.setPermissionMode(currentMode)
      updatePrompt()
      rl.prompt(true)  // redibuja el prompt con el nuevo modo
      return
    }

    // Esc → si hay turno en marcha, aborta. Si no, limpia línea.
    if (key.name !== 'escape') return
    if (key.shift || key.ctrl || key.meta) return
    if (isProcessing) {
      agent.abortCurrent()
      return
    }
    const rlAny = rl as unknown as { line: string; cursor: number; _refreshLine: () => void }
    if (rlAny.line && rlAny.line.length > 0) {
      rlAny.line = ''
      rlAny.cursor = 0
      rlAny._refreshLine()
    }
  })

  /**
   * Dibuja las 2 líneas fijas (status, mode) en su posición absoluta.
   * Usado por pin_input_bottom para que el status se quede pegado abajo
   * y el output scrollee por arriba.
   */
  const drawPinnedLines = () => {
    if (!screenEnabled()) return
    const state = agent.getBrainState()
    const statusLine = '  ' + renderer.renderStatusLine({
      project: projectName,
      cwd,
      contextPercent: state.contextPercent,
      costUsd: agent.getTotalCost(),
      model: agent.getCurrentModel(),
      subscriptions: state.subscriptions,
    })
    const DIM = '\x1b[2m'
    const RESET = '\x1b[0m'
    const modeLine = renderModeLine(currentMode, {
      thinkingExpanded: thinkingExpanded,
      tasksCollapsed: tasklistCollapsed,
    })
    drawInputArea(statusLine, modeLine)
  }

  const updatePrompt = () => {
    if (pinEnabled) {
      // Con pin: el prompt de readline es solo "❯ ", el status/mode viven aparte.
      rl.setPrompt('\x1b[38;5;34m❯\x1b[0m ')
      drawPinnedLines()
      return
    }
    // Sin pin: prompt multi-línea tradicional (status inline).
    const state = agent.getBrainState()
    rl.setPrompt(renderer.renderStatus({
      project: projectName,
      cwd,
      contextPercent: state.contextPercent,
      costUsd: agent.getTotalCost(),
      model: agent.getCurrentModel(),
      mode: currentMode,
      subscriptions: state.subscriptions,
    }))
  }

  rl.prompt()

  // Acumulador para multi-line via backslash continuation: si una línea
  // termina con `\`, no se submite — se queda esperando más líneas.
  let multilineBuffer = ''

  // Queueing: mientras sq procesa un turno, los Enter que el usuario pulse
  // NO bloquean — el nuevo prompt se encola y se procesa al terminar el
  // actual. Permite "send, send, send" rápidos sin esperar cada respuesta.
  let isProcessing = false
  const pendingQueue: string[] = []
  // pendingAttachments declarada arriba, cerca del keypress interceptor.

  rl.on('line', async (line) => {
    // Continuación con `\` al final: acumula y pide otra línea.
    // El usuario ve un prompt secundario `... ` para indicar continuación.
    if (line.endsWith('\\')) {
      multilineBuffer += line.slice(0, -1) + '\n'
      rl.setPrompt(`${'\x1b[2m'}... ${'\x1b[0m'}`)
      rl.prompt()
      return
    }
    // Si había buffer acumulado, esta es la última línea del bloque.
    const fullInput = multilineBuffer + line
    multilineBuffer = ''
    const input = fullInput.trim()
    if (!input) {
      updatePrompt()
      rl.prompt()
      return
    }

    // Persistimos el input en historial antes de procesar.
    appendHistory(input)

    // ─── Queue ───
    // Si ya hay un turno en marcha, encolamos el input y volvemos. El loop
    // procesará la cola cuando acabe el turno actual.
    if (isProcessing) {
      pendingQueue.push(input)
      console.log(`  \x1b[2m· queued (${pendingQueue.length} pending — waiting for current turn)\x1b[0m`)
      return
    }
    // NOTA: isProcessing=true se setea más abajo, justo antes de `agent.send()`.
    // Los slash commands NO deben marcar processing porque son síncronos (o
    // abren pickers que ya pausan rl por su cuenta) — si los marcásemos,
    // bloquearíamos el siguiente mensaje en la cola por error.

    // Muestra el mensaje del user en el output area, como un chat.
    // PRIMERO borra el prompt multi-línea que readline dejó en pantalla
    // (renderStatus emite 4 filas: blank, status, mode, ❯input → tras Enter
    // el cursor está 4 filas bajo el inicio del prompt). Si no borrásemos,
    // el usuario vería su mensaje dos veces: una en `❯ hola` y otra en
    // `│ you / │ hola`. Skip cuando venía de continuación `\` (ese prompt
    // `... ` es 1 fila, no 4) o cuando pin está activo.
    const GRAY = '\x1b[90m'
    const DIM = '\x1b[2m'
    const RESET = '\x1b[0m'
    const BG = '\x1b[48;5;236m'   // fondo gris oscuro (estilo Claude Code)
    const CLR_EOL = '\x1b[K'       // rellena con el bg actual hasta fin de fila
    const wasContinuation = fullInput.includes('\n')
    if (!pinEnabled && !wasContinuation) {
      // 6 filas del prompt multi-linea (renderStatus):
      //   blank, separator, status, mode, separator, ❯+input
      process.stdout.write('\x1b[6A\r\x1b[J')
    }
    // Wrap el mensaje completo al ancho del terminal, pintando cada línea con
    // fondo gris de borde a borde. El prefijo visible "│ " ocupa 2 columnas,
    // así que cada línea de contenido puede usar (cols - 2) caracteres.
    const cols = process.stdout.columns || 80
    const contentWidth = Math.max(cols - 2, 20)
    const wrapLines = (text: string): string[] => {
      const result: string[] = []
      for (const paragraph of text.split('\n')) {
        if (paragraph.length === 0) { result.push(''); continue }
        let remaining = paragraph
        while (remaining.length > contentWidth) {
          // Intentar cortar en el último espacio dentro del ancho
          let cut = remaining.lastIndexOf(' ', contentWidth)
          if (cut <= 0) cut = contentWidth
          result.push(remaining.slice(0, cut))
          remaining = remaining.slice(cut).replace(/^ /, '')
        }
        result.push(remaining)
      }
      return result
    }
    // Cada fila: bg gris + contenido + erase-to-EOL (pinta resto de la fila
    // del mismo bg) + reset. Resultado: tira gris de borde a borde.
    console.log(`${BG}${GRAY}│${RESET}${BG} ${DIM}you${RESET}${BG}${CLR_EOL}${RESET}`)
    for (const line of wrapLines(input)) {
      console.log(`${BG}${GRAY}│${RESET}${BG} ${line}${CLR_EOL}${RESET}`)
    }

    // ─── Custom slash commands (skills) ───
    // Si el input empieza con /xxx y `xxx` matchea un custom command de
    // ~/.squeezr-code/commands/<name>.md, expandimos al prompt del .md y
    // continuamos abajo como si el usuario hubiese escrito ese prompt.
    let effectiveInput = input
    if (effectiveInput.startsWith('/') && customCommands.length > 0) {
      const m = effectiveInput.match(/^\/(\S+)\s*(.*)$/s)
      if (m) {
        const customMatch = customCommands.find(c => c.name === m[1])
        if (customMatch) {
          effectiveInput = expandCustomCommand(customMatch, m[2])
          console.log(`  \x1b[2m▸ custom command:\x1b[0m \x1b[36m/${customMatch.name}\x1b[0m`)
        }
      }
    }

    // ─── Slash commands (built-in) ───
    // Si el custom command lo expandió, NO es un slash interno; salta.
    const cmdResult = effectiveInput === input
      ? handleCommand(input, {
      brain: {
        getState: () => agent.getBrainState(),
        reset: () => agent.resetBrain(),
      },
      model: agent.getCurrentModel(),
      setModel: (m: string) => { agent.setModel(m); session.updateModel(m) },
      costByModel: () => agent.getCostByModel(),
      history: () => agent.getConversationHistory(),
      systemPrompt: () => agent.getLastSystemPrompt(),
      sessionId: () => session.getId(),
      outputStyle: () => agent.getOutputStyle() || 'default',
      setOutputStyle: (s) => agent.setOutputStyle(s),
      thinkingCollapsed: () => true,  // default
      setThinkingCollapsed: (v) => renderer.setThinkingCollapsed(v),
    })
      : null

    if (cmdResult) {
      if (cmdResult.output) console.log(cmdResult.output)

      // Acción especial: abrir el picker interactivo.
      if (cmdResult.action === 'pick-model') {
        rl.pause()
        const picked = await pickModel(agent.getCurrentModel(), authStatus)
        if (picked && picked !== agent.getCurrentModel()) {
          agent.setModel(picked)
          session.updateModel(picked)
          console.log(`  \x1b[2mmodel →\x1b[0m \x1b[35m${picked}\x1b[0m`)
        } else if (!picked) {
          console.log('  \x1b[2mcancelled\x1b[0m')
        }
        rl.resume()
      }

      // Acción especial: picker de MCP servers.
      if (cmdResult.action === 'mcp') {
        rl.pause()
        await pickMcp(mcp)
        rl.resume()
      }

      // Acción especial: compact — resumir el historial.
      if (cmdResult.action === 'compact') {
        rl.pause()
        try {
          const events = agent.compact()
          for await (const event of events) {
            renderer.renderEvent(event)
          }
          console.log(`\n  \x1b[32m✓\x1b[0m historial comprimido`)
        } catch (err) {
          console.error(`\n  ${formatError(err)}`)
        }
        rl.resume()
      }

      // Acción especial: resume — picker de sesiones.
      if (cmdResult.action === 'resume') {
        rl.pause()
        const pickedId = await pickSession()
        if (pickedId) {
          const loaded = Session.load(pickedId)
          if (loaded) {
            agent.setConversationHistory(loaded.getMessages())
            if (loaded.getModel() !== agent.getCurrentModel()) {
              agent.setModel(loaded.getModel())
            }
            session = loaded
            console.log(`  \x1b[32m✓\x1b[0m resumed session \x1b[2m${pickedId}\x1b[0m — ${loaded.getMessages().length} messages`)
          } else {
            console.log(`  \x1b[31m✖\x1b[0m could not load the session`)
          }
        } else {
          console.log('  \x1b[2mcancelled\x1b[0m')
        }
        rl.resume()
      }

      // Acción especial: gestión de sesiones (list / prune / retain).
      if (cmdResult.action === 'sessions') {
        handleSessionsCmd(cmdResult.sessionsArgs || '', config)
      }

      // Acción especial: undo — revertir último Edit/Write.
      if (cmdResult.action === 'undo') {
        const restored = popUndo()
        if (restored) {
          console.log(`  \x1b[32m✓\x1b[0m restored \x1b[2m${restored}\x1b[0m`)
        } else {
          console.log(`  \x1b[2mno changes to undo in this session\x1b[0m`)
        }
      }

      // Acción especial: review — inyecta un git diff como si el usuario
      // mandase el prompt "review this diff: ...". Reusa el flow normal
      // emitiendo otra 'line' al readline.
      if (cmdResult.action === 'review') {
        const range = cmdResult.reviewRange
        const diff = getGitDiff(cwd, range)
        if (!diff.trim()) {
          console.log(`  \x1b[2mno changes${range ? ` in ${range}` : ' (staged or unstaged)'}\x1b[0m`)
        } else {
          const reviewPrompt = buildReviewPrompt(diff, range)
          setImmediate(() => rl.emit('line', reviewPrompt))
          return
        }
      }

      // Acción especial: /fork — clona la sesión actual en una nueva.
      if (cmdResult.action === 'fork') {
        const forked = Session.create({ cwd, model: agent.getCurrentModel() })
        forked.updateMessages(agent.getConversationHistory())
        const BG = '\x1b[48;5;236m'
        const RESET = '\x1b[0m'
        console.log(`  \x1b[32m✓\x1b[0m session forked → \x1b[36m${forked.getId()}\x1b[0m`)
        console.log(`  \x1b[2m${forked.getMessages().length} messages cloned. Still in the original session (${session.getId().slice(0, 13)}).${RESET}${BG}\x1b[0m`)
        console.log(`  \x1b[2musage: \`sq resume ${forked.getId()}\` to continue in the fork\x1b[0m`)
      }

      // Acción especial: /repeat — reenvía el último user prompt.
      if (cmdResult.action === 'repeat') {
        const hist = agent.getConversationHistory()
        const lastUser = [...hist].reverse().find(m => m.role === 'user' && typeof m.content === 'string')
        if (!lastUser) {
          console.log(`  \x1b[2mno previous message to repeat\x1b[0m`)
        } else {
          const text = lastUser.content as string
          console.log(`  \x1b[2mrepeating:\x1b[0m ${text.length > 100 ? text.slice(0, 100) + '…' : text}`)
          setImmediate(() => rl.emit('line', text))
          return
        }
      }

      // Acción especial: /search <texto> en TODAS las sesiones guardadas.
      if (cmdResult.action === 'search') {
        const q = cmdResult.searchQuery || ''
        if (!q) {
          console.log(`  \x1b[31m✖\x1b[0m usage: /search <text or regex>`)
        } else {
          let re: RegExp
          try { re = new RegExp(q, 'i') } catch { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
          const sessions = Session.list()
          const hits: Array<{ id: string; turn: number; preview: string; when: number }> = []
          for (const s of sessions) {
            const loaded = Session.load(s.id)
            if (!loaded) continue
            let turn = 0
            for (const m of loaded.getMessages()) {
              if (m.role === 'user') turn++
              const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
              if (re.test(text)) {
                const idx = text.search(re)
                const start = Math.max(0, idx - 30)
                const end = Math.min(text.length, idx + 80)
                hits.push({ id: s.id, turn, preview: text.slice(start, end).replace(/\s+/g, ' '), when: s.updatedAt })
                break  // un hit por sesión basta
              }
            }
          }
          if (hits.length === 0) {
            console.log(`  \x1b[2mno sessions found with "${q}"\x1b[0m`)
          } else {
            console.log(`  \x1b[1m${hits.length}\x1b[0m sessions contain \x1b[36m${q}\x1b[0m:`)
            for (const h of hits.slice(0, 20)) {
              const ago = formatAgo(h.when)
              console.log(`  \x1b[2m${ago.padStart(4)}\x1b[0m  \x1b[36m${h.id.slice(0, 13)}\x1b[0m  \x1b[2mturn ${h.turn}:\x1b[0m ${h.preview}`)
            }
            if (hits.length > 20) console.log(`  \x1b[2m(${hits.length - 20} more)\x1b[0m`)
          }
        }
      }

      // Acción especial: /template — guarda/usa templates de prompts.
      if (cmdResult.action === 'template') {
        const out = handleTemplateCmd(cmdResult.templateArgs || '')
        if (out.prompt) {
          // uso de template → se reinyecta como línea
          console.log(`  \x1b[2mtemplate:\x1b[0m ${out.prompt.length > 100 ? out.prompt.slice(0, 100) + '…' : out.prompt}`)
          setImmediate(() => rl.emit('line', out.prompt!))
          return
        } else if (out.message) {
          console.log(out.message)
        }
      }

      // Acción especial: /paste — grab imagen del portapapeles + prompt opcional.
      // Acción especial: /tasklist [clean] — muestra o limpia tasks de la sesión.
      if (cmdResult.action === 'tasklist') {
        const { taskSnapshot, clearAllTasks } = await import('../tools/tasks.js')
        const arg = ((cmdResult as { tasklistArg?: string }).tasklistArg || '').trim()
        if (arg === 'clean' || arg === 'clear') {
          clearAllTasks()
          console.log(`  \x1b[32m✓\x1b[0m all tasks cleared`)
        } else {
          const tasks = taskSnapshot()
          if (tasks.length === 0) {
            console.log(`  \x1b[2mno tasks in this session. The agent creates them when it splits multi-step work with TaskCreate.\x1b[0m`)
          } else {
            const done = tasks.filter(t => t.status === 'completed').length
            const active = tasks.filter(t => t.status === 'in_progress').length
            const pending = tasks.filter(t => t.status === 'pending').length
            console.log(`  \x1b[1m📋 ${tasks.length} tasks\x1b[0m  \x1b[2m— \x1b[32m${done} done\x1b[0m\x1b[2m, \x1b[33m${active} active\x1b[0m\x1b[2m, ${pending} pending\x1b[0m`)
            for (const t of tasks) {
              const icon = t.status === 'completed' ? '\x1b[32m✓\x1b[0m'
                         : t.status === 'in_progress' ? '\x1b[33m⋯\x1b[0m'
                         : '\x1b[90m○\x1b[0m'
              const subj = t.status === 'completed' ? `\x1b[2m\x1b[9m${t.subject}\x1b[29m\x1b[0m` : t.subject
              console.log(`    ${icon} \x1b[2m#${t.id}\x1b[0m ${subj}`)
            }
            console.log(`  \x1b[2m/tasklist clean to clear · Ctrl+T toggle inline visibility after each turn\x1b[0m`)
          }
        }
      }

      // Acción especial: /dispatch — multi-agent ad-hoc.
      if (cmdResult.action === 'dispatch') {
        const body = (cmdResult as { dispatchBody?: string }).dispatchBody || ''
        const agents = parseDispatchBody(body)
        if (agents.length === 0) {
          console.log(`  \x1b[31m✖\x1b[0m /dispatch needs at least one \x1b[36m@model: prompt\x1b[0m line`)
          console.log(`  \x1b[2mExample:\x1b[0m`)
          console.log(`  \x1b[2m  /dispatch \\\x1b[0m`)
          console.log(`  \x1b[2m    @opus: implement X \\\x1b[0m`)
          console.log(`  \x1b[2m    @codex: review Y\x1b[0m`)
        } else {
          rl.pause()
          await runDispatch(agents, auth, config, cwd)
          rl.resume()
        }
      }

      // Acción especial: /squad NAME [task] | list.
      if (cmdResult.action === 'squad') {
        const args = (cmdResult as { squadArgs?: string }).squadArgs || ''
        const squads = loadSquads()
        const parts = args.split(/\s+/)
        const name = parts[0] || 'list'
        if (name === 'list' || !name) {
          console.log(`  \x1b[1mAvailable squads\x1b[0m  \x1b[2m(~/.squeezr-code/squads.json)\x1b[0m`)
          for (const [key, squad] of Object.entries(squads)) {
            const models = squad.agents.map(a => `\x1b[35m${a.model}\x1b[0m/\x1b[2m${a.role}\x1b[0m`).join(' · ')
            console.log(`    \x1b[36m${key.padEnd(18)}\x1b[0m \x1b[2m[${squad.mode}]\x1b[0m ${models}`)
          }
          console.log(`  \x1b[2mUsage: /squad NAME your task here\x1b[0m`)
        } else {
          const squad = squads[name]
          if (!squad) {
            console.log(`  \x1b[31m✖\x1b[0m squad "${name}" does not exist. /squad list to see available.`)
          } else {
            const task = parts.slice(1).join(' ').trim()
            if (!task) {
              console.log(`  \x1b[31m✖\x1b[0m /squad ${name} needs a task`)
            } else {
              rl.pause()
              await runSquadInREPL(squad, task, auth, config, cwd)
              rl.resume()
            }
          }
        }
      }

      // Acción especial: /sticky list|clear|add|remove.
      if (cmdResult.action === 'sticky') {
        const a = ((cmdResult as { stickyArg?: string }).stickyArg || 'list').trim()
        const parts = a.split(/\s+/)
        const sub = parts[0] || 'list'
        if (sub === 'list' || sub === '') {
          if (stickyMentions.length === 0) {
            console.log(`  \x1b[2mno active sticky mentions. Use \`@@path\` in a prompt to add.\x1b[0m`)
          } else {
            console.log(`  \x1b[1m📌 ${stickyMentions.length}\x1b[0m sticky mentions:`)
            for (const p of stickyMentions) console.log(`    \x1b[36m@${p}\x1b[0m`)
            console.log(`  \x1b[2mre-included every turn. /sticky clear to clear.\x1b[0m`)
          }
        } else if (sub === 'clear') {
          stickyMentions.length = 0
          console.log(`  \x1b[32m✓\x1b[0m sticky mentions cleared`)
        } else if (sub === 'remove' && parts[1]) {
          const p = parts[1]
          const i = stickyMentions.indexOf(p)
          if (i >= 0) { stickyMentions.splice(i, 1); console.log(`  \x1b[32m✓\x1b[0m @${p} removed`) }
          else console.log(`  \x1b[31m✖\x1b[0m ${p} was not sticky`)
        } else if (sub === 'add' && parts[1]) {
          const p = parts[1]
          if (!stickyMentions.includes(p)) stickyMentions.push(p)
          console.log(`  \x1b[32m✓\x1b[0m @${p} added to sticky`)
        } else {
          console.log(`  \x1b[31m✖\x1b[0m usage: /sticky [list|clear|add PATH|remove PATH]`)
        }
      }

      // Acción especial: /redact on|off|status.
      if (cmdResult.action === 'redact') {
        const a = ((cmdResult as { redactArg?: string }).redactArg || 'status').toLowerCase()
        if (a === 'status' || a === '') {
          const st = config.security?.redact_prompts ? '\x1b[32mON\x1b[0m' : '\x1b[2mOFF\x1b[0m'
          console.log(`  redact-prompts: ${st}  \x1b[2m(masks API keys/tokens in YOUR prompt before sending)\x1b[0m`)
          const st2 = config.security?.redact_tool_outputs !== false ? '\x1b[32mON\x1b[0m' : '\x1b[2mOFF\x1b[0m'
          console.log(`  redact-outputs: ${st2}  \x1b[2m(masks secrets in Read/Bash output before passing to model)\x1b[0m`)
        } else if (a === 'on' || a === 'off') {
          const on = a === 'on'
          config.security = config.security || { redact_prompts: false, redact_tool_outputs: true, airplane: false }
          config.security.redact_prompts = on
          writeSecurityConfig(config.security)
          console.log(`  \x1b[32m✓\x1b[0m redact-prompts → ${on ? 'ON' : 'OFF'} \x1b[2m(persisted)\x1b[0m`)
        } else {
          console.log(`  \x1b[31m✖\x1b[0m usage: /redact on | off | status`)
        }
      }

      // Acción especial: /airplane on|off|status.
      if (cmdResult.action === 'airplane') {
        const a = ((cmdResult as { airplaneArg?: string }).airplaneArg || 'status').toLowerCase()
        if (a === 'status' || a === '') {
          const st = config.security?.airplane ? '\x1b[33m✈  ON\x1b[0m' : '\x1b[2mOFF\x1b[0m'
          console.log(`  airplane mode: ${st}`)
          if (config.security?.airplane) console.log(`  \x1b[2mAPI calls + WebFetch/Search blocked. Only local tools work.\x1b[0m`)
        } else if (a === 'on' || a === 'off') {
          const on = a === 'on'
          config.security = config.security || { redact_prompts: false, redact_tool_outputs: true, airplane: false }
          config.security.airplane = on
          writeSecurityConfig(config.security)
          console.log(`  \x1b[32m✓\x1b[0m airplane → ${on ? 'ON ✈' : 'OFF'} \x1b[2m(persisted)\x1b[0m`)
        } else {
          console.log(`  \x1b[31m✖\x1b[0m usage: /airplane on | off | status`)
        }
      }

      // Acción especial: /cancel — descarta el próximo mensaje de la queue.
      if (cmdResult.action === 'cancel') {
        if (pendingQueue.length === 0) {
          console.log(`  \x1b[2mno messages in the queue\x1b[0m`)
        } else {
          const removed = pendingQueue.pop()
          console.log(`  \x1b[32m✓\x1b[0m cancelled: "${removed?.slice(0, 60)}${removed && removed.length > 60 ? '…' : ''}"  \x1b[2m(${pendingQueue.length} remaining)\x1b[0m`)
        }
      }

      // Acción especial: /summary — TL;DR de la sesión via modelo.
      if (cmdResult.action === 'summary') {
        const hist = agent.getConversationHistory()
        if (hist.length === 0) {
          console.log(`  \x1b[2mno history to summarize\x1b[0m`)
        } else {
          const summaryPrompt = `Summarize in 5-8 bullets what we have done in this conversation so far: decisions made, code written, bugs fixed, open issues. Be concise and specific (mention real files/functions). Do not include code — just short prose.`
          setImmediate(() => rl.emit('line', summaryPrompt))
          return
        }
      }

      // Acción especial: /library [name] — prompts pre-hechos.
      if (cmdResult.action === 'library') {
        const name = (cmdResult as { libraryArgs?: string }).libraryArgs || ''
        handleLibraryCmd(name, rl)
        if (name && PROMPT_LIBRARY[name]) return  // /library <name> → re-emitió una línea
      }

      // Acción especial: /snippet — guardar/insertar bloques reusables.
      if (cmdResult.action === 'snippet') {
        const args = (cmdResult as { snippetArgs?: string }).snippetArgs || ''
        const result = handleSnippetCmd(args, agent.getConversationHistory())
        if (result.insert) {
          setImmediate(() => rl.emit('line', result.insert!))
          return
        }
        if (result.message) console.log(result.message)
      }

      // Acción especial: /gh pr NUMBER — trae el diff del PR via gh CLI.
      if (cmdResult.action === 'gh') {
        const ghArg = (cmdResult as { ghArgs?: string }).ghArgs || ''
        const result = await handleGhCmd(ghArg, cwd)
        if (result.prompt) {
          console.log(`  \x1b[32m✓\x1b[0m PR context injected`)
          setImmediate(() => rl.emit('line', result.prompt!))
          return
        }
        if (result.message) console.log(result.message)
      }

      // Acción especial: /clean — borrar ficheros temporales.
      if (cmdResult.action === 'clean') {
        await handleCleanCmd(cwd)
      }

      // Acción especial: /router on|off|show — auto-routing de modelos.
      if (cmdResult.action === 'router') {
        handleRouterCmd((cmdResult as { routerArg?: string }).routerArg || 'show', config)
      }

      // Acción especial: /committee <prompt> — 3 modelos en paralelo.
      if (cmdResult.action === 'committee') {
        const cmtPrompt = (cmdResult as { committeePrompt?: string }).committeePrompt || ''
        if (!cmtPrompt) {
          console.log(`  \x1b[31m✖\x1b[0m usage: /committee <prompt>`)
        } else {
          rl.pause()
          await runCommittee(cmtPrompt, authStatus, config, cwd)
          rl.resume()
        }
      }

      if (cmdResult.action === 'paste') {
        const img = readClipboardImage()
        if (!img) {
          console.log(`  \x1b[31m✖\x1b[0m no image found on clipboard`)
        } else {
          imageCounter += 1
          const idx = imageCounter
          imagesByIndex.set(idx, img)
          const sizeKB = Math.round(img.base64.length * 3 / 4 / 1024)
          printImagePaste(`[Image #${idx}]`, img.base64, img.mediaType, sizeKB)
          // Si el user pasó prompt, se usa tal cual; si no, prepend el token
          // para que la referencia exista en el texto que ve el modelo.
          const userPrompt = cmdResult.pasteArgs || 'describe this image'
          const promptText = userPrompt.includes(`[Image #${idx}]`) ? userPrompt : `[Image #${idx}] ${userPrompt}`
          setImmediate(() => rl.emit('line', promptText))
          return
        }
      }

      // Acción especial: arrancar OAuth flow (abre navegador).
      if (cmdResult.action === 'login' && cmdResult.loginProvider) {
        rl.pause()
        try {
          await auth.login(cmdResult.loginProvider)
          authStatus[cmdResult.loginProvider] = true
          console.log(`  \x1b[32m✓\x1b[0m ${cmdResult.loginProvider} authenticated`)
        } catch (err) {
          console.error(`  \x1b[31m✖\x1b[0m login ${cmdResult.loginProvider} failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        // CRÍTICO: drenar stdin antes de resumir readline. Si no, el code que
        // el usuario acaba de pegar para el OAuth se cuela en readline cuando
        // resumimos y se manda como prompt al siguiente modelo, que responde
        // "esto parece un token, ¿qué querías?". Pasa porque el paste viene en
        // varios chunks y el último puede llegar después de que el flow OAuth
        // terminó pero antes de que readline retome el control.
        ;(rl as unknown as { line: string; cursor: number }).line = ''
        ;(rl as unknown as { line: string; cursor: number }).cursor = 0
        // Drena el buffer interno de stdin hasta vaciarlo
        let drained: unknown
        do { drained = process.stdin.read() } while (drained !== null)
        rl.resume()
      }

      if (cmdResult.exit) {
        rl.close()
        agent.shutdown()
        process.exit(0)
      }
      updatePrompt()
      rl.prompt()
      return
    }

    // ─── Model override con @alias ───
    // Usa effectiveInput (puede venir expandido por custom command) en vez de input.
    let prompt = effectiveInput
    let overrideModel: string | undefined
    const atMatch = effectiveInput.match(/^@(\S+)\s+(.+)$/s)
    if (atMatch) {
      const token = atMatch[1]
      // Prioridad: ¿es un alias conocido? (sonnet, 5.3-codex, pro-3.1-high, etc)
      const known = new Set(getAliasKeys())
      const isAlias = known.has(token) || /^\d/.test(token)
      // ¿parece path? (/, \, ~ al inicio, o empieza con ./ o ../)
      const looksLikePath = /[/\\]/.test(token) || token.startsWith('~') || token.startsWith('./') || token.startsWith('../')
      if (isAlias && !looksLikePath) {
        overrideModel = resolveModelAlias(token)
        prompt = atMatch[2]
      }
      // Si no es ni alias ni parece path, lo dejamos como está y @file mentions
      // decide si lo expande o lo deja literal.
    }

    // ─── Auto-router ───
    // Si /router está ON y el user NO hizo @override explícito, clasificamos
    // el prompt por heurística y escogemos haiku/sonnet/opus automáticamente.
    if (!overrideModel && config.router?.enabled) {
      const picked = classifyPromptForRouter(prompt, authStatus)
      if (picked) {
        overrideModel = resolveModelAlias(picked)
        console.log(`  \x1b[2m▸ router: ${picked} (heuristic)\x1b[0m`)
      }
    }

    // ─── Airplane mode guard ───
    // Si está activo, no hay llamada a la API. Explicamos al user y no
    // procesamos el prompt.
    if (config.security?.airplane) {
      console.log(`\n  \x1b[33m✈  airplane mode:\x1b[0m the prompt was NOT sent to the model. Disable airplane with \x1b[36m/airplane off\x1b[0m to continue.\n`)
      updatePrompt()
      rl.prompt()
      return
    }

    // ─── Redact prompts si está ON ───
    if (config.security?.redact_prompts) {
      const r = redactSecrets(prompt)
      if (r.count > 0) {
        prompt = r.cleaned
        console.log(`  \x1b[32m🔒\x1b[0m ${r.count} secret(s) masked before sending: \x1b[2m${formatRedactSummary(r.byType)}\x1b[0m`)
      }
    }

    // ─── Sticky mentions (@@path) ───
    // Al procesar el prompt del user, extraemos `@@path` y los guardamos en
    // stickyMentions. En los siguientes turnos, estos paths se re-prepend al
    // prompt automáticamente (se "pegan"). /sticky clear para borrar.
    const stickyMatches = [...prompt.matchAll(/@@(\S+)/g)]
    for (const m of stickyMatches) {
      const p = m[1]
      if (!stickyMentions.includes(p)) stickyMentions.push(p)
    }
    // Sustituimos `@@path` → `@path` para que expandFileMentions lo procese.
    prompt = prompt.replace(/@@(\S+)/g, '@$1')
    // Re-inyecta mentions stickies al inicio del prompt (como referencias
    // adicionales) si no están ya mencionados.
    if (stickyMentions.length > 0) {
      const notInPrompt = stickyMentions.filter(p => !prompt.includes(`@${p}`))
      if (notInPrompt.length > 0) {
        prompt = notInPrompt.map(p => `@${p}`).join(' ') + '\n' + prompt
      }
    }

    // ─── @file mentions ───
    // Expande @path/foo.ts → contenido del fichero como bloque inline.
    const expanded = expandFileMentions(prompt, cwd)
    prompt = expanded.prompt
    if (expanded.filesIncluded.length > 0) {
      console.log(`  \x1b[2m▸ included:\x1b[0m ${expanded.filesIncluded.map(f => `\x1b[36m${f}\x1b[0m`).join(', ')}`)
    }
    if (expanded.filesNotFound.length > 0) {
      console.log(`  \x1b[33m⚠\x1b[0m not found: ${expanded.filesNotFound.join(', ')}`)
    }
    if (stickyMentions.length > 0 && stickyMatches.length > 0) {
      console.log(`  \x1b[2m📌 sticky:\x1b[0m ${stickyMentions.map(p => `\x1b[36m${p}\x1b[0m`).join(', ')}  \x1b[2m(re-included every turn · /sticky clear)\x1b[0m`)
    }

    // ─── Envío al agente ───
    // NO pausamos readline: rl.pause() deja el byte 0x03 (Ctrl+C) en buffer
    // sin procesar → el usuario no puede abortar el turno. Prioridad: Ctrl+C
    // funciona SIEMPRE. Trade-off: si el user teclea durante el streaming,
    // readline redibuja el prompt mid-output (conocido, aceptable).
    isProcessing = true
    isProcessingRef.v = true
    try {
      // Extrae `[Image #N]` del prompt y adjunta las imágenes guardadas.
      // El texto del prompt mantiene los marcadores literalmente — el modelo
      // los ve y puede referenciarse a cada imagen por número.
      const attachments: Array<{ base64: string; mediaType: string }> = []
      const imageRefs = [...prompt.matchAll(/\[Image #(\d+)\]/g)]
      for (const match of imageRefs) {
        const n = parseInt(match[1], 10)
        const img = imagesByIndex.get(n)
        if (img) {
          attachments.push(img)
          imagesByIndex.delete(n)  // consumida para no re-mandar en otro turno
        }
      }

      const events = agent.send(prompt, {
        model: overrideModel,
        cwd,
        askPermission: config.agent.permissions === 'yolo' ? undefined : askPermission,
        attachments: attachments.length > 0 ? attachments : undefined,
      })

      for await (const event of events) {
        renderer.renderEvent(event)
        // Con input pinned: redibuja status/mode tras cada evento para
        // mantenerlos visibles aunque el output haya hecho scroll.
        if (pinEnabled) drawPinnedLines()
      }
    } catch (err) {
      console.error(`\n  ${formatError(err)}`)
      // Si es AuthError, ofrece reauth inline.
      if (err instanceof AuthError) {
        const yes = await promptYesNo(`  reauth with /login ${err.provider} now? [Y/n] `)
        if (yes) {
          try {
            await auth.login(err.provider)
            authStatus[err.provider] = true
            console.log(`  \x1b[32m✓\x1b[0m ${err.provider} authenticated — retry your prompt`)
          } catch (loginErr) {
            console.error(`  \x1b[31m✖\x1b[0m login failed: ${loginErr instanceof Error ? loginErr.message : String(loginErr)}`)
          }
        }
      }
    } finally {
      isProcessing = false
      isProcessingRef.v = false
    }

    // Auto-compact: si el contexto superó el umbral (default 95%), comprime
    // el historial automáticamente sin bloquear al usuario. Aviso visible
    // para que sepa qué pasó.
    const ctxPct = agent.getBrainState().contextPercent
    if (ctxPct >= config.transplant.auto_threshold && agent.getConversationHistory().length > 4) {
      console.log(`\n  \x1b[33m▸\x1b[0m context at ${ctxPct}% — compacting automatically…\x1b[0m`)
      try {
        for await (const event of agent.compact()) {
          renderer.renderEvent(event)
        }
        console.log(`  \x1b[32m✓\x1b[0m history compacted`)
      } catch (err) {
        console.error(`  \x1b[31m✖\x1b[0m auto-compact failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (!pinEnabled) console.log()
    updatePrompt()
    if (pinEnabled) positionPromptCursor()
    rl.prompt()

    // Si hay cola, procesa la siguiente. Usamos setImmediate para no
    // bloquear el event loop y permitir que el prompt se dibuje primero.
    if (pendingQueue.length > 0) {
      const next = pendingQueue.shift()!
      setImmediate(() => {
        rl.emit('line', next)
      })
    }
  })

  // Doble Ctrl+C para salir. Primer Ctrl+C con input vacío arma un timer de
  // 2s y avisa; si llega otro antes de expirar, cierra. Si el input NO estaba
  // vacío, el primer Ctrl+C solo limpia la línea. Cualquier otra tecla desarma.
  let exitArmed = false
  let exitTimer: NodeJS.Timeout | null = null
  const armExit = () => {
    exitArmed = true
    if (exitTimer) clearTimeout(exitTimer)
    exitTimer = setTimeout(() => {
      exitArmed = false
      exitTimer = null
    }, 2000)
  }
  const disarmExit = () => {
    if (!exitArmed) return
    exitArmed = false
    if (exitTimer) { clearTimeout(exitTimer); exitTimer = null }
  }
  rl.on('SIGINT', () => {
    const rlInternal = rl as unknown as { line: string; cursor: number; _refreshLine?: () => void }
    // Si hay turno en curso, Ctrl+C aborta el turno en vez de salir.
    if (isProcessing) {
      agent.abortCurrent()
      return
    }
    // Si hay texto escrito, limpia la línea (no sale).
    if (rlInternal.line && rlInternal.line.length > 0) {
      rlInternal.line = ''
      rlInternal.cursor = 0
      if (typeof rlInternal._refreshLine === 'function') rlInternal._refreshLine()
      disarmExit()
      return
    }
    // Input vacío — flujo de doble Ctrl+C.
    if (exitArmed) {
      rl.close()
      return
    }
    armExit()
    process.stdout.write(`\n  \x1b[2m(pulsa Ctrl+C otra vez en 2s para salir)\x1b[0m\n`)
    rl.prompt()
  })
  // Cualquier otro keypress desarma (si el user decide seguir tras un Ctrl+C).
  process.stdin.on('keypress', (_s, key) => {
    if (!key || (key.ctrl && key.name === 'c')) return
    disarmExit()
  })

  rl.on('close', () => {
    mcp.stopAll()
    killAllBackground()
    setSubAgentRunner(null)
    setUserQuestioner(null)
    setPlanApprover(null)
    setCronFireHandler(null)
    stopCronTicker()
    setWorktreeCwdChanger(null)
    clearInterval(refreshInterval)
    scrollCleanup()
    cleanupScreen()
    agent.shutdown()
    process.exit(0)
  })

  // También limpia scroll region en SIGINT/SIGTERM/exit
  const onExit = () => { try { cleanupScreen() } catch { /* ignore */ } }
  process.on('exit', onExit)
  process.on('SIGINT', onExit)
  process.on('SIGTERM', onExit)
}

/**
 * Ejecuta una sub-tarea en un SqAgent aislado. Devuelve el texto final.
 *
 * Sin subagentType: usa el modelo/config del agente principal (clone genérico).
 * Con subagentType: busca `~/.squeezr-code/agents/<name>.md` y aplica:
 *   - `model` (si está en frontmatter) como override
 *   - `tools` (lista) restringiendo qué tools puede usar
 *   - `body` del .md como system prompt append (se suma al system prompt normal)
 */
async function runSubAgent(
  auth: AuthManager,
  config: SqConfig,
  cwd: string,
  description: string,
  prompt: string,
  subagentType?: string,
  explicitModel?: string,
): Promise<string> {
  const { SqAgent } = await import('../agent/agent.js')
  const { findAgent } = await import('../agent/agents-store.js')
  const { resolveModelAlias } = await import('./model-picker.js')

  let modelOverride: string | undefined
  let appendSystem: string | undefined
  let toolsRestrict: string[] | undefined

  if (explicitModel) modelOverride = resolveModelAlias(explicitModel)

  if (subagentType) {
    const spec = findAgent(subagentType)
    if (!spec) {
      return `Error: subagent_type "${subagentType}" does not exist. Create ~/.squeezr-code/agents/${subagentType}.md`
    }
    if (!modelOverride && spec.model) modelOverride = resolveModelAlias(spec.model)
    appendSystem = spec.systemPrompt
    toolsRestrict = spec.tools
  }

  const subAgent = new SqAgent(auth, {
    defaultModel: modelOverride || config.agent.default,
    permissions: 'yolo',  // sub-agente no pregunta al user
    rules: config.permissions,
    sandbox: config.sandbox,
    appendSystemPrompt: appendSystem,
    toolsAllowed: toolsRestrict,
    transplant: {
      warnThreshold: config.transplant.warn_threshold,
      autoThreshold: config.transplant.auto_threshold,
    },
  })
  void description  // solo se usa como label en logs

  let out = ''
  try {
    for await (const ev of subAgent.send(prompt, { cwd })) {
      if (ev.type === 'text' && ev.text) out += ev.text
      if (ev.type === 'error' && ev.error) out += `\n[sub-agent error] ${ev.error}`
    }
  } finally {
    subAgent.shutdown()
  }
  return out || '(sub-agent returned no text)'
}
