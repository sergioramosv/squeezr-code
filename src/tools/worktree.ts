import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

/**
 * Git worktree helpers. Crean un worktree bajo `.sq-worktrees/<name>/` en la
 * raíz del repo actual, con una nueva rama basada en HEAD (o entran en uno
 * existente via path). Al salir (ExitWorktree), opcionalmente borran el
 * worktree + branch si no tiene commits sin mergear ni ficheros sin commit.
 *
 * NOTA: cambiar el cwd del REPL es agresivo (afecta a todos los tools
 * subsecuentes hasta que salgas). Por eso el user debe invocar ExitWorktree
 * antes de cerrar sq.
 */

export interface WorktreeState {
  path: string
  branch: string
  repoRoot: string
  tmuxSession?: string
}

let active: WorktreeState | null = null
// Callback que el REPL registra para cambiar su propio cwd.
let cwdChanger: ((cwd: string) => void) | null = null

export function setWorktreeCwdChanger(fn: ((cwd: string) => void) | null): void {
  cwdChanger = fn
}

export function getActiveWorktree(): WorktreeState | null {
  return active
}

function findRepoRoot(cwd: string): string | null {
  try {
    const out = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out || null
  } catch { return null }
}

function sanitizeName(n: string): string | null {
  if (!n) return null
  // letras, digits, dots, underscores, dashes, slashes.
  if (!/^[\w./-]{1,64}$/.test(n)) return null
  return n
}

export function enterWorktree(input: { name?: string; path?: string; cwd: string }): string {
  if (active) return `Already inside a worktree (${active.path}). Call ExitWorktree first.`
  if (input.name && input.path) return 'Pass `name` or `path`, not both.'

  const repoRoot = findRepoRoot(input.cwd)
  if (!repoRoot) return 'Error: no git repo detected in the current cwd.'

  // Path a worktree existente → solo enter.
  if (input.path) {
    const target = path.resolve(input.path)
    // Verifica que sea un worktree registrado de este repo.
    let registered = false
    try {
      const list = execSync('git worktree list --porcelain', { cwd: repoRoot, encoding: 'utf-8' })
      registered = list.split('\n').some(l => l.startsWith('worktree ') && path.resolve(l.slice(9).trim()) === target)
    } catch { /* fall through */ }
    if (!registered) return `Error: ${target} is not a registered worktree of this repo.`
    active = { path: target, branch: '(existing)', repoRoot }
    if (cwdChanger) cwdChanger(target)
    return `Entered worktree ${target}. Use ExitWorktree with action=keep to return without deleting it.`
  }

  // Crea nuevo worktree + branch.
  const rawName = input.name || `wt-${Date.now().toString(36)}`
  const name = sanitizeName(rawName)
  if (!name) return `Error: invalid name: ${rawName}. Only letters, digits, ., _, -, /, max 64 chars.`

  const worktreesDir = path.join(repoRoot, '.claude', 'worktrees')
  fs.mkdirSync(worktreesDir, { recursive: true })
  const worktreePath = path.join(worktreesDir, name)
  if (fs.existsSync(worktreePath)) return `Error: ${worktreePath} already exists.`

  const branch = `sq/${name}`
  try {
    execSync(`git worktree add -b "${branch}" "${worktreePath}" HEAD`, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    return `Error creating worktree: ${err instanceof Error ? err.message : String(err)}`
  }

  active = { path: worktreePath, branch, repoRoot }
  if (cwdChanger) cwdChanger(worktreePath)
  return `Worktree created and activated:\n  path:   ${worktreePath}\n  branch: ${branch}\n  base:   HEAD\n\nAll tools now work from here. Call ExitWorktree when you're done.`
}

export function exitWorktree(input: { action: 'keep' | 'remove'; discard_changes?: boolean }): string {
  if (!active) return 'No active worktree — ExitWorktree has nothing to do.'
  const w = active
  const action = input.action

  // Restaura cwd antes de borrar el path.
  const originalRoot = w.repoRoot
  if (cwdChanger) cwdChanger(originalRoot)

  if (action === 'keep') {
    active = null
    return `Exited worktree ${w.path}. Still on disk (branch ${w.branch}). Return with EnterWorktree path=${w.path}.`
  }

  // action === 'remove'
  // Chequea cambios sin commit.
  let dirty = ''
  try {
    dirty = execSync('git status --porcelain', { cwd: w.path, encoding: 'utf-8' }).trim()
  } catch { /* ignore */ }
  if (dirty && !input.discard_changes) {
    // Restaura el active para no dejar inconsistente (el cwd ya cambió).
    active = w
    if (cwdChanger) cwdChanger(w.path)
    return `Error: uncommitted changes in ${w.path}:\n${dirty}\n\nCommit/stash first, or call with discard_changes=true to delete anyway.`
  }

  try {
    execSync(`git worktree remove "${w.path}" --force`, { cwd: originalRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    execSync(`git branch -D "${w.branch}"`, { cwd: originalRoot, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (err) {
    return `Warning: could not fully clean up: ${err instanceof Error ? err.message : String(err)}. Check git worktree list and git branch -l.`
  }

  active = null
  return `Worktree ${w.path} and branch ${w.branch} deleted.`
}
