import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { ToolError } from '../errors.js'
import { evaluateRules } from './rules.js'
import { spawnBackground, readBackground, killBackground } from './background.js'
import { webFetch, webSearch } from './web.js'
import { taskCreate, taskList, taskGet, taskUpdate } from './tasks.js'
import { notebookEdit } from './notebook.js'
import { snapshotBeforeWrite } from './undo.js'
import { logToolEvent } from '../state/audit.js'
import { trackToolCall } from './perf.js'
import { redactSecrets } from '../state/redact.js'

// Flag runtime para scan de tool outputs (controlado por REPL vía config).
let scanToolOutputs = true
export function setScanToolOutputs(on: boolean): void { scanToolOutputs = on }
import { runMonitor } from './monitor.js'
import { cronCreate, cronDelete, cronList } from './cron.js'
import { enterWorktree, exitWorktree } from './worktree.js'
import type { PermissionRules } from '../config.js'

/**
 * Hook que el REPL inyecta para que el tool `Task` (sub-agente) use el mismo
 * SqAgent / auth / config sin tener que pasar el mundo entero al executor.
 * Si no está, `Task` devuelve un error.
 */
export type SubAgentRunner = (description: string, prompt: string, subagentType?: string, model?: string) => Promise<string>
let subAgentRunner: SubAgentRunner | null = null
export function setSubAgentRunner(fn: SubAgentRunner | null): void { subAgentRunner = fn }

/**
 * Hook que el REPL inyecta para que `AskUserQuestion` pregunte interactivo.
 */
export type UserQuestioner = (question: string, options: Array<{ label: string; description?: string }>, multiSelect: boolean) => Promise<string>
let userQuestioner: UserQuestioner | null = null
export function setUserQuestioner(fn: UserQuestioner | null): void { userQuestioner = fn }

/**
 * Hook para `ExitPlanMode`. El REPL pinta el plan, pregunta y/n al usuario, y
 * si acepta cambia el modo a `accept-edits`. Devuelve true/false.
 */
export type PlanApprover = (plan: string) => Promise<boolean>
let planApprover: PlanApprover | null = null
export function setPlanApprover(fn: PlanApprover | null): void { planApprover = fn }

const execAsync = promisify(exec)

const DANGEROUS_TOOLS = ['Bash', 'Write', 'Edit']

export type PermissionMode = 'default' | 'accept-edits' | 'plan' | 'bypass' | 'auto' | 'yolo'

export interface ToolExecOpts {
  cwd: string
  /**
   * Modo de operación del agente:
   *   - default: pregunta antes de Bash/Write/Edit/NotebookEdit
   *   - accept-edits: auto-aprueba Write/Edit/NotebookEdit, pregunta Bash
   *   - plan: solo-lectura (bloquea Write/Edit/Bash/NotebookEdit)
   *   - bypass (alias yolo/auto): aprueba todo sin preguntar
   */
  permissions: PermissionMode
  /** Reglas granulares (allow/deny) del sq.toml o runtime. */
  rules?: PermissionRules
  /** Sandbox Docker para Bash. Si está, los comandos corren dentro del container. */
  sandbox?: { enabled: boolean; image: string }
  askPermission?: (toolName: string, input: Record<string, unknown>) => Promise<{ approved: boolean; explanation?: string }>
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])
const MODIFYING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Bash'])
// Tools cuyo output leen contenido externo (file / shell / web) y pueden
// contener secrets. Las excluimos de acción-pura como Write/Edit.
const SCAN_TOOLS = new Set(['Read', 'Bash', 'BashOutput', 'WebFetch', 'WebSearch', 'Grep', 'Monitor'])

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  opts: ToolExecOpts,
): Promise<string> {

  // 1. Reglas granulares primero. Deny corta siempre, allow salta la pregunta.
  if (opts.rules) {
    const decision = evaluateRules(name, input, opts.rules)
    if (decision === 'deny') {
      return `Tool denied by permission rule: ${name}`
    }
    if (decision === 'allow') {
      // Salta askPermission aunque sea tool "peligroso".
      return executeInner(name, input, opts)
    }
  }

  // 2. Plan mode: bloquea tools modificadoras. ExitPlanMode SÍ se permite
  //    (es el escape hatch para que el agente presente plan + pida aprobación).
  //    Si aprueba, el REPL cambia el mode a accept-edits via planApprover.
  if (opts.permissions === 'plan' && MODIFYING_TOOLS.has(name) && name !== 'ExitPlanMode') {
    return `Tool ${name} blocked by plan mode. Call ExitPlanMode with your complete plan in markdown to request user approval, or keep investigating with Read/Grep/Glob before proposing.`
  }

  // 3. Bypass / yolo / auto: aprueba todo sin preguntar.
  if (opts.permissions === 'bypass' || opts.permissions === 'yolo' || opts.permissions === 'auto') {
    return executeInner(name, input, opts)
  }

  // 4. Accept-edits: auto-aprueba Write/Edit/NotebookEdit, pregunta Bash.
  if (opts.permissions === 'accept-edits') {
    if (EDIT_TOOLS.has(name)) return executeInner(name, input, opts)
    if (name === 'Bash' && opts.askPermission) {
      const res = await opts.askPermission(name, input)
      if (!res.approved) {
        return res.explanation ? `Tool denied by user: ${res.explanation}` : 'Tool execution denied by user'
      }
    }
    return executeInner(name, input, opts)
  }

  // 5. Default: pregunta antes de tools peligrosas.
  if (opts.permissions === 'default' && DANGEROUS_TOOLS.includes(name)) {
    if (opts.askPermission) {
      const res = await opts.askPermission(name, input)
      if (!res.approved) {
        return res.explanation ? `Tool denied by user: ${res.explanation}` : 'Tool execution denied by user'
      }
    }
  }

  return executeInner(name, input, opts)
}

async function executeInner(
  name: string,
  input: Record<string, unknown>,
  opts: ToolExecOpts,
): Promise<string> {
  const run = async (): Promise<string> => {
    switch (name) {
      case 'Read': return await toolRead(input)
      case 'Write': return toolWrite(input)
      case 'Edit': return toolEdit(input)
      case 'Bash': return await toolBash(input, opts.cwd, opts.sandbox)
      case 'BashOutput': return readBackground((input.shell_id as string) || '')
      case 'KillShell':  return killBackground((input.shell_id as string) || '')
      case 'Glob': return await toolGlob(input, opts.cwd)
      case 'Grep': return await toolGrep(input, opts.cwd)
      case 'WebFetch': return await webFetch(input)
      case 'WebSearch': return await webSearch(input)
      case 'TaskCreate': return taskCreate(input)
      case 'TaskList': return taskList()
      case 'TaskGet': return taskGet(input)
      case 'TaskUpdate': return taskUpdate(input)
      case 'NotebookEdit': return notebookEdit(input)
      case 'AskUserQuestion': return await runAskUser(input)
      case 'Task': return await runSubAgent(input)
      case 'ExitPlanMode': return await runExitPlanMode(input)
      case 'Monitor': return await runMonitor(input as unknown as import('./monitor.js').MonitorInput, opts.cwd)
      case 'CronCreate': {
        const result = cronCreate({
          cron: input.cron as string,
          prompt: input.prompt as string,
          recurring: input.recurring !== false,
          durable: input.durable === true,
        })
        const next = new Date(result.nextFireAt)
        return `Cron created: id=${result.id}, next fire: ${next.toLocaleString()}`
      }
      case 'CronList': {
        const list = cronList()
        if (list.length === 0) return 'No active cron jobs.'
        return list.map(j => {
          const next = new Date(j.nextFireAt).toLocaleString()
          return `${j.id}  "${j.cron}"  ${j.recurring ? 'recurring' : 'one-shot'}  next: ${next}  → "${j.prompt.slice(0, 60)}${j.prompt.length > 60 ? '…' : ''}"`
        }).join('\n')
      }
      case 'CronDelete': {
        const id = input.id as string
        return cronDelete(id) ? `Cron ${id} deleted.` : `Cron ${id} not found.`
      }
      case 'EnterWorktree':
        return enterWorktree({ name: input.name as string | undefined, path: input.path as string | undefined, cwd: opts.cwd })
      case 'ExitWorktree':
        return exitWorktree({ action: (input.action as 'keep' | 'remove') || 'keep', discard_changes: input.discard_changes === true })
      default: return `Unknown tool: ${name}`
    }
  }

  const start = Date.now()
  try {
    let result = await run()
    const dur = Date.now() - start
    trackToolCall(name, dur, false)
    // Scanner de secrets: enmascara API keys/tokens que aparezcan en el output
    // ANTES de que el modelo los vea. Aplica a tools que leen contenido
    // externo (Read, Bash, BashOutput, WebFetch). Skip para tools puros de
    // acción (Write/Edit/CronCreate/...) donde el "output" es un status msg.
    if (scanToolOutputs && SCAN_TOOLS.has(name)) {
      const scanned = redactSecrets(result)
      if (scanned.count > 0) {
        result = scanned.cleaned + `\n\n[squeezr: redacted ${scanned.count} secret(s) from this output before showing to model]`
      }
    }
    logToolEvent({ tool: name, input, output: result, cwd: opts.cwd })
    return result
  } catch (err) {
    const dur = Date.now() - start
    trackToolCall(name, dur, true)
    const msg = err instanceof Error ? err.message : String(err)
    logToolEvent({ tool: name, input, output: msg, cwd: opts.cwd, isError: true })
    if (err instanceof ToolError) throw err
    throw new ToolError(name, msg)
  }
}

async function toolRead(input: Record<string, unknown>): Promise<string> {
  const filePath = input.file_path as string
  if (!filePath) return 'Error: file_path is required'
  if (!fs.existsSync(filePath)) return `Error: file not found: ${filePath}`

  const stat = fs.statSync(filePath)
  if (stat.isDirectory()) return `Error: ${filePath} is a directory, not a file`
  if (stat.size > 10 * 1024 * 1024) return `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB)`

  // PDF: extrae texto con pdf-parse. Soporta `pages: "1-5"` o "3" para rangos.
  if (filePath.toLowerCase().endsWith('.pdf')) {
    return await readPdf(filePath, input.pages as string | undefined)
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const offset = (input.offset as number) || 0
  const limit = (input.limit as number) || 2000

  return lines
    .slice(offset, offset + limit)
    .map((line, i) => `${offset + i + 1}\t${line}`)
    .join('\n')
}

async function readPdf(filePath: string, pages?: string): Promise<string> {
  try {
    // pdf-parse v2 exporta un factory distinto; importamos dinámicamente para
    // no penalizar el cold start cuando no hay PDFs.
    const mod = await import('pdf-parse') as { default?: unknown; pdf?: unknown }
    const pdfParse = (typeof mod.default === 'function' ? mod.default : mod.pdf) as
      (buffer: Buffer, opts?: Record<string, unknown>) => Promise<{ text: string; numpages: number }>
    if (typeof pdfParse !== 'function') return 'Error: pdf-parse does not export a callable function'

    const buffer = fs.readFileSync(filePath)
    const range = parsePageRange(pages, 20)  // máx 20 páginas por petición

    // pdf-parse no tiene API de rangos nativa, así que parseamos todo y
    // cortamos. Para PDFs enormes (>10 páginas) exigimos un range explícito.
    const data = await pdfParse(buffer)
    const total = data.numpages
    if (total > 10 && !pages) {
      return `Error: PDF has ${total} pages. Specify a range with pages (e.g. "1-5", "3", "10-20"). Max 20 per request.`
    }

    // Separamos por salto de página (form-feed \f). Si pdf-parse no lo emite,
    // devolvemos el texto entero y un warning del fallback.
    const rawPages = data.text.split('\f')
    if (rawPages.length === 1 && total > 1) {
      // Fallback: el extractor no marcó páginas, devuelve todo.
      return `⚠ pdf-parse did not emit page separators for this PDF. Full text (${total} pages):\n\n${data.text.slice(0, 200_000)}`
    }

    const [start, end] = range
    const selected = rawPages.slice(Math.max(0, start - 1), Math.min(rawPages.length, end))
    return `PDF ${filePath} · pages ${start}–${Math.min(end, total)} of ${total}\n\n${selected.join('\n\n---\n\n').slice(0, 200_000)}`
  } catch (err) {
    return `Error leyendo PDF: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Parsea "1-5", "3", "10-20" o undefined → [start, end] 1-indexed inclusive. */
function parsePageRange(raw: string | undefined, defaultEnd: number): [number, number] {
  if (!raw) return [1, defaultEnd]
  const m = /^(\d+)(?:-(\d+))?$/.exec(raw.trim())
  if (!m) return [1, defaultEnd]
  const start = parseInt(m[1], 10)
  const end = m[2] ? parseInt(m[2], 10) : start
  if (end - start + 1 > 20) return [start, start + 19]  // cap 20 páginas
  return [start, end]
}

function toolWrite(input: Record<string, unknown>): string {
  const filePath = input.file_path as string
  const content = input.content as string
  if (!filePath) return 'Error: file_path is required'
  if (content === undefined) return 'Error: content is required'

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  snapshotBeforeWrite(filePath)
  fs.writeFileSync(filePath, content)
  return `File written: ${filePath}`
}

function toolEdit(input: Record<string, unknown>): string {
  const filePath = input.file_path as string
  const oldStr = input.old_string as string
  const newStr = input.new_string as string
  const replaceAll = input.replace_all === true
  if (!filePath || !oldStr || newStr === undefined) return 'Error: file_path, old_string, and new_string are required'
  if (!fs.existsSync(filePath)) return `Error: file not found: ${filePath}`

  const content = fs.readFileSync(filePath, 'utf-8')
  if (!content.includes(oldStr)) return 'Error: old_string not found in file'

  const occurrences = content.split(oldStr).length - 1
  if (!replaceAll && occurrences > 1) {
    return `Error: old_string found ${occurrences} times — must be unique, or pass replace_all=true. Provide more surrounding context to make it unique.`
  }

  const newContent = replaceAll
    ? content.split(oldStr).join(newStr)
    : content.replace(oldStr, newStr)
  snapshotBeforeWrite(filePath)
  fs.writeFileSync(filePath, newContent)
  return replaceAll
    ? `File edited: ${filePath} (${occurrences} replacements)`
    : `File edited: ${filePath}`
}

async function runAskUser(input: Record<string, unknown>): Promise<string> {
  if (!userQuestioner) {
    return 'Error: AskUserQuestion not available in this context (no TTY).'
  }
  const question = (input.question as string) || ''
  const options = (input.options as Array<{ label: string; description?: string }>) || []
  const multi = input.multiSelect === true
  if (!question || options.length < 2) return 'Error: question + at least 2 options required'
  return userQuestioner(question, options, multi)
}

async function runExitPlanMode(input: Record<string, unknown>): Promise<string> {
  const plan = (input.plan as string) || ''
  if (!plan.trim()) return 'Error: `plan` is required (markdown describing the implementation)'
  if (!planApprover) {
    // Sin TTY: el caller queda informado de que no podemos aprobar.
    return 'Plan registered but no TTY to approve. The user will need to exit plan mode manually (shift+tab).'
  }
  const approved = await planApprover(plan)
  return approved
    ? 'Plan approved by user. Mode changed to accept-edits — you can start implementing following the plan.'
    : 'Plan rejected by user. Still in plan mode — refine the plan or investigate more before proposing another.'
}

async function runSubAgent(input: Record<string, unknown>): Promise<string> {
  if (!subAgentRunner) {
    return 'Error: Task (sub-agent) not available in this context.'
  }
  const description = (input.description as string) || 'sub-task'
  const prompt = (input.prompt as string) || ''
  const subagentType = input.subagent_type as string | undefined
  const model = input.model as string | undefined
  if (!prompt) return 'Error: prompt is required'
  return subAgentRunner(description, prompt, subagentType, model)
}

async function toolBash(
  input: Record<string, unknown>,
  cwd: string,
  sandbox?: { enabled: boolean; image: string },
): Promise<string> {
  let command = input.command as string
  if (!command) return 'Error: command is required'

  // Background: spawnea, devuelve shell_id, no espera. No sandbox en BG por simplicidad.
  if (input.run_in_background === true) {
    const shellId = spawnBackground(command, cwd)
    return `Started background shell: ${shellId}\nCommand: ${command}\nUse BashOutput(shell_id="${shellId}") to read output, KillShell to stop.`
  }

  // Sandbox: envuelve el comando en `docker run --rm -v cwd:/workspace -w /workspace <image> sh -c "<cmd>"`
  // El usuario tiene que tener docker instalado. Si falla, se lo dice.
  if (sandbox?.enabled) {
    const escaped = command.replace(/"/g, '\\"').replace(/\$/g, '\\$')
    command = `docker run --rm -v "${cwd}:/workspace" -w /workspace ${sandbox.image} sh -c "${escaped}"`
  }

  const timeout = Math.min((input.timeout as number) || 120_000, 600_000)

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      windowsHide: true,
    })
    let result = stdout
    if (stderr) result += `\nSTDERR:\n${stderr}`
    if (result.length > 50_000) result = result.slice(0, 50_000) + '\n... (output truncated)'
    return result || '(no output)'
  } catch (err: unknown) {
    const e = err as { code?: number; killed?: boolean; stderr?: string; message?: string; signal?: string }
    if (e.killed || e.signal === 'SIGTERM') return `Command killed: timeout after ${timeout}ms`
    return `Command failed (exit ${e.code ?? '?'}):\n${e.stderr || e.message || 'unknown error'}`
  }
}

async function toolGlob(input: Record<string, unknown>, cwd: string): Promise<string> {
  const pattern = input.pattern as string
  if (!pattern) return 'Error: pattern is required'
  const searchPath = (input.path as string) || cwd

  // Use node:fs glob via find command as fallback
  try {
    const { stdout } = await execAsync(
      `find ${JSON.stringify(searchPath)} -type f -name ${JSON.stringify(pattern.replace(/\*\*\//g, ''))} 2>/dev/null | head -200`,
      { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 },
    )
    return stdout.trim() || 'No files matched'
  } catch {
    // Fallback for Windows
    try {
      const { stdout } = await execAsync(
        `dir /s /b ${JSON.stringify(searchPath + '\\' + pattern.replace(/\//g, '\\'))} 2>nul`,
        { cwd, timeout: 10_000, shell: 'cmd.exe', maxBuffer: 1024 * 1024 },
      )
      return stdout.trim() || 'No files matched'
    } catch {
      return 'No files matched'
    }
  }
}

async function toolGrep(input: Record<string, unknown>, cwd: string): Promise<string> {
  const pattern = input.pattern as string
  if (!pattern) return 'Error: pattern is required'
  const searchPath = (input.path as string) || cwd
  const glob = input.glob as string | undefined
  const outputMode = (input.output_mode as string) || 'files_with_matches'
  const headLimit = (input.head_limit as number) || 250
  const caseI = input['-i'] === true
  const showLineNum = input['-n'] !== false  // default true en content mode
  const after = input['-A'] as number | undefined
  const before = input['-B'] as number | undefined
  const context = input['-C'] as number | undefined
  const multiline = input.multiline === true

  // Preferimos ripgrep si está, fallback a grep.
  const tool = await whichRipgrep() ? 'rg' : 'grep'
  const args: string[] = []

  if (tool === 'rg') {
    args.push('--color=never')
    if (caseI) args.push('-i')
    if (multiline) args.push('-U', '--multiline-dotall')
    if (glob) args.push('--glob', shellQuote(glob))
    if (outputMode === 'files_with_matches') args.push('-l')
    else if (outputMode === 'count') args.push('-c')
    else {
      // content
      if (showLineNum) args.push('-n')
      if (context) args.push(`-C${context}`)
      else {
        if (after) args.push(`-A${after}`)
        if (before) args.push(`-B${before}`)
      }
    }
    args.push(shellQuote(pattern), shellQuote(searchPath))
  } else {
    // grep fallback (POSIX)
    args.push('--color=never')
    if (caseI) args.push('-i')
    if (glob) args.push(`--include=${shellQuote(glob)}`)
    if (outputMode === 'files_with_matches') args.push('-rl')
    else if (outputMode === 'count') args.push('-rc')
    else {
      args.push('-r')
      if (showLineNum) args.push('-n')
      if (context) args.push(`-C${context}`)
      else {
        if (after) args.push(`-A${after}`)
        if (before) args.push(`-B${before}`)
      }
    }
    args.push(shellQuote(pattern), shellQuote(searchPath))
  }

  try {
    const cmd = `${tool} ${args.join(' ')} 2>/dev/null | head -${headLimit}`
    const { stdout } = await execAsync(cmd, {
      cwd,
      timeout: 15_000,
      maxBuffer: 5 * 1024 * 1024,
      shell: process.platform === 'win32' ? 'bash' : '/bin/bash',
    })
    return stdout.trim() || 'No matches found'
  } catch {
    return 'No matches found'
  }
}

let ripgrepCache: boolean | null = null
async function whichRipgrep(): Promise<boolean> {
  if (ripgrepCache !== null) return ripgrepCache
  try {
    await execAsync('rg --version', { timeout: 2000 })
    ripgrepCache = true
  } catch {
    ripgrepCache = false
  }
  return ripgrepCache
}

function shellQuote(s: string): string {
  // Comillas simples seguras para bash/sh. Escapa "'" como '"'"'.
  return `'${s.replace(/'/g, `'"'"'`)}'`
}
