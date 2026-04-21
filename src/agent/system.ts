import fs from 'node:fs'
import path from 'node:path'
import type { AgentLoopOpts } from '../api/types.js'

// ── Caches de filesystem (evitan re-leer en cada turno) ──────────────────────

/** Git branch: cache con TTL de 10s para no re-caminar el árbol cada turno. */
let gitCache: { branch: string | null; cwd: string; at: number } | null = null
const GIT_TTL = 10_000

/** Project memory: cache por fichero fuente con comprobación de mtime. */
interface MemoryCache {
  content: string | null
  /** Suma de mtime de todos los ficheros leídos. Cambia si se edita alguno. */
  mtimeSum: number
  cwd: string
}
let memoryCache: MemoryCache | null = null

export function buildSystemPrompt(opts: AgentLoopOpts): string {
  const parts: string[] = []

  parts.push(`You are Squeezr, an intelligent CLI agent for software engineering tasks. You read, write, and edit files, run commands, search codebases, fetch the web, and orchestrate sub-agents.

Style rules — follow these strictly:
- Never use emojis anywhere in your responses.
- Never use decorative bullet points with icons (•, ✅, 📦, 🔧, etc.). Plain text or plain dashes only.
- Be concise and direct. No preamble, no filler phrases like "Of course!" or "Sure!".
- Don't list what you can do unprompted. Just do the task.
- Respond like a senior engineer, not a customer service chatbot.
- Use markdown only when it adds clarity (code blocks, headers for long docs). Avoid it for simple answers.

Available tools:
- Read, Write, Edit, Glob, Grep — file ops with diff preview before write/edit.
- Bash (with run_in_background + BashOutput + KillShell for long processes).
- WebFetch, WebSearch — fetch a URL or search the web (DuckDuckGo).
- TaskCreate, TaskList, TaskGet, TaskUpdate — track multi-step work as a TODO list.
- AskUserQuestion — pause and ask the user a multiple-choice question. USE THIS whenever you need to clarify intent, choose between approaches, or confirm a decision before doing something irreversible. Don't guess what the user wants — ask.
- NotebookEdit — edit cells of Jupyter .ipynb files.
- Task — spawn a focused sub-agent for parallel research, isolated long-context exploration, or specialized work.

Rules:
- Read files before modifying them.
- Use Edit for small changes (string replacement). Use Write only for new files or full rewrites.
- Prefer editing existing files over creating new ones.
- Don't add unnecessary comments or documentation unless asked.
- When running Bash commands, use absolute paths when possible.
- If a tool fails, diagnose the issue before retrying.
- For multi-step work, create tasks with TaskCreate so the user sees progress.
- When the user asks "should I use X or Y?" or there's genuine ambiguity, USE AskUserQuestion with 2-4 options instead of picking unilaterally.
- NEVER write a numbered list of questions in markdown like "**1. ¿Quién…? **2. ¿Cómo…?**". The user can't pick from text. If you have multiple decisions to ask, call AskUserQuestion ONCE PER QUESTION (the harness will show them sequentially and the user picks each with arrow keys + Enter — much better UX than a wall of markdown questions).
- NEVER tell the user to run a command themselves. Phrases like "run \`npm run dev\`", "execute \`npm test\`", "then run \`cargo build\`", "try \`yarn lint\`", "start the server with \`python manage.py runserver\`", etc. are forbidden. YOU run the command via Bash. For long-running processes (dev servers, watchers, daemons) use \`run_in_background: true\` and then call BashOutput to verify it started — the user should never have to switch windows to check. For short commands (tests, build, typecheck, lint, install) just await them and report the outcome. If it fails, fix the failure instead of handing the error back. The only time you're allowed to ask the user to run something is when it genuinely requires interactive input you cannot script (credentials, MFA codes, browser login flows).`)

  parts.push(`\nWorking directory: ${opts.cwd}`)

  const gitBranch = getGitBranch(opts.cwd)
  if (gitBranch) parts.push(`Git branch: ${gitBranch}`)

  const memoryContent = loadProjectMemory(opts.cwd)
  if (memoryContent) {
    parts.push(`\nProject memory:\n${memoryContent}`)
  }

  if (opts.appendSystemPrompt) {
    parts.push(`\n--- Transplant context ---\n${opts.appendSystemPrompt}`)
  }

  return parts.join('\n')
}

function getGitBranch(cwd: string): string | null {
  const now = Date.now()
  if (gitCache && gitCache.cwd === cwd && now - gitCache.at < GIT_TTL) {
    return gitCache.branch
  }
  let branch: string | null = null
  try {
    const headPath = findGitHead(cwd)
    if (headPath) {
      const content = fs.readFileSync(headPath, 'utf-8').trim()
      branch = content.startsWith('ref: refs/heads/')
        ? content.slice('ref: refs/heads/'.length)
        : content.slice(0, 8)
    }
  } catch { /* ignore */ }
  gitCache = { branch, cwd, at: now }
  return branch
}

function findGitHead(cwd: string): string | null {
  let dir = cwd
  while (true) {
    const headPath = path.join(dir, '.git', 'HEAD')
    if (fs.existsSync(headPath)) return headPath
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Carga memoria multi-nivel (estilo Claude Code):
 *   1. ~/.squeezr-code/SQUEEZR.md  o  ~/.claude/CLAUDE.md  (user-level)
 *   2. <project root>/SQUEEZR.md  o  CLAUDE.md             (project-level, walking up)
 *   3. <cwd>/SQUEEZR.md  o  CLAUDE.md  (si cwd ≠ root)     (sub-dir-level)
 *
 * Soporta `@import path` dentro de los .md para incluir otros ficheros.
 * Total truncado a 30KB.
 *
 * Cache con mtime: si ninguno de los ficheros de memoria cambia entre turnos,
 * devuelve el resultado cacheado en lugar de re-leer. Evita enviar 30KB de
 * tokens redundantes en cada turno cuando la memoria es estática.
 */
function loadProjectMemory(cwd: string): string | null {
  // Calcular suma de mtime de los candidatos existentes para detectar cambios
  const candidatePaths = getMemoryCandidates(cwd)
  let mtimeSum = 0
  for (const p of candidatePaths) {
    try { mtimeSum += fs.statSync(p).mtimeMs } catch { /* no existe */ }
  }
  if (memoryCache && memoryCache.cwd === cwd && memoryCache.mtimeSum === mtimeSum) {
    return memoryCache.content
  }
  const result = loadProjectMemoryInner(cwd)
  memoryCache = { content: result, mtimeSum, cwd }
  return result
}

function getMemoryCandidates(cwd: string): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const candidates: string[] = []
  if (home) {
    candidates.push(
      path.join(home, '.squeezr-code', 'SQUEEZR.md'),
      path.join(home, '.squeezr-code', 'CLAUDE.md'),
      path.join(home, '.claude', 'CLAUDE.md'),
    )
  }
  const names = ['SQUEEZR.md', 'CLAUDE.md', '.sq.md', '.claude.md']
  let dir = cwd
  while (true) {
    for (const n of names) candidates.push(path.join(dir, n))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return candidates
}

function loadProjectMemoryInner(cwd: string): string | null {
  const layers: Array<{ source: string; content: string }> = []
  const seen = new Set<string>()

  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (home) {
    const userCandidates = [
      path.join(home, '.squeezr-code', 'SQUEEZR.md'),
      path.join(home, '.squeezr-code', 'CLAUDE.md'),
      path.join(home, '.claude', 'CLAUDE.md'),
    ]
    for (const c of userCandidates) {
      if (fs.existsSync(c) && !seen.has(c)) {
        const content = readWithImports(c, seen)
        if (content) layers.push({ source: '~/' + path.relative(home, c).replace(/\\/g, '/'), content })
        break
      }
    }
  }

  const projectFile = findUpwards(cwd, ['SQUEEZR.md', 'CLAUDE.md', '.sq.md', '.claude.md'])
  if (projectFile && !seen.has(projectFile)) {
    const content = readWithImports(projectFile, seen)
    if (content) layers.push({ source: path.basename(projectFile) + ' (project)', content })
  }

  if (projectFile) {
    const projectDir = path.dirname(projectFile)
    if (projectDir !== cwd) {
      const cwdCandidates = ['SQUEEZR.md', 'CLAUDE.md'].map(n => path.join(cwd, n))
      for (const c of cwdCandidates) {
        if (fs.existsSync(c) && !seen.has(c)) {
          const content = readWithImports(c, seen)
          if (content) layers.push({ source: path.basename(c) + ' (cwd)', content })
          break
        }
      }
    }
  }

  if (layers.length === 0) return null

  let combined = layers
    .map(l => `=== ${l.source} ===\n${l.content}`)
    .join('\n\n')
  if (combined.length > 30_000) {
    combined = combined.slice(0, 30_000) + '\n\n... (memory truncated to 30KB)'
  }
  return combined
}

function findUpwards(start: string, fileNames: string[]): string | null {
  let dir = start
  while (true) {
    for (const n of fileNames) {
      const p = path.join(dir, n)
      if (fs.existsSync(p)) return p
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function readWithImports(filePath: string, seen: Set<string>): string | null {
  if (seen.has(filePath)) return null
  seen.add(filePath)
  try {
    let text = fs.readFileSync(filePath, 'utf-8')
    text = text.replace(/^@import\s+(\S+)\s*$/gm, (_m, importPath: string) => {
      const resolved = path.isAbsolute(importPath)
        ? importPath
        : path.join(path.dirname(filePath), importPath)
      const inner = readWithImports(resolved, seen)
      return inner
        ? `\n--- imported: ${importPath} ---\n${inner}\n--- end ${importPath} ---\n`
        : `<!-- @import not found: ${importPath} -->`
    })
    return text
  } catch {
    return null
  }
}
