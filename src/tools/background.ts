import { spawn, type ChildProcess } from 'node:child_process'
import { Readable } from 'node:stream'
import crypto from 'node:crypto'

/**
 * Store de procesos Bash en background. Cuando el modelo lanza Bash con
 * `run_in_background=true`, sq spawnea el proceso pero no espera al exit:
 * devuelve un `shell_id` que el modelo puede consultar después con
 * `BashOutput(shell_id)` o cerrar con `KillShell(shell_id)`.
 *
 * Útil para dev servers (`npm run dev`), watchers, builds largos, monitores.
 */

interface BgProc {
  id: string
  command: string
  proc: ChildProcess
  stdout: string
  stderr: string
  exitCode: number | null
  startedAt: number
  killed: boolean
}

const procs = new Map<string, BgProc>()

export function spawnBackground(command: string, cwd: string): string {
  const id = `bash-${crypto.randomBytes(3).toString('hex')}`
  const isWin = process.platform === 'win32'
  const proc = spawn(
    isWin ? 'cmd.exe' : '/bin/bash',
    isWin ? ['/c', command] : ['-c', command],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const entry: BgProc = {
    id,
    command,
    proc,
    stdout: '',
    stderr: '',
    exitCode: null,
    startedAt: Date.now(),
    killed: false,
  }
  ;(proc.stdout as Readable).on('data', (c: Buffer) => { entry.stdout += c.toString('utf-8') })
  ;(proc.stderr as Readable).on('data', (c: Buffer) => { entry.stderr += c.toString('utf-8') })
  proc.on('exit', (code) => { entry.exitCode = code })
  proc.on('error', (err) => { entry.stderr += `\n[spawn error] ${err.message}` })
  procs.set(id, entry)
  return id
}

export function readBackground(shellId: string, opts?: { sinceLines?: number }): string {
  const entry = procs.get(shellId)
  if (!entry) return `Error: shell_id ${shellId} not found`
  const isRunning = entry.exitCode === null && !entry.killed
  const status = entry.killed
    ? 'killed'
    : entry.exitCode === null
      ? 'running'
      : `exited (${entry.exitCode})`
  const ageS = Math.floor((Date.now() - entry.startedAt) / 1000)
  const lines: string[] = []
  lines.push(`# ${shellId}  status: ${status}  age: ${ageS}s  cmd: ${entry.command}`)
  if (entry.stdout) {
    lines.push('--- stdout ---')
    lines.push(entry.stdout.slice(-50_000))  // últimos 50KB
  }
  if (entry.stderr) {
    lines.push('--- stderr ---')
    lines.push(entry.stderr.slice(-10_000))
  }
  if (!entry.stdout && !entry.stderr) {
    lines.push(`(${isRunning ? 'still running, no output yet' : 'no output captured'})`)
  }
  return lines.join('\n')
}

export function killBackground(shellId: string): string {
  const entry = procs.get(shellId)
  if (!entry) return `Error: shell_id ${shellId} not found`
  if (entry.exitCode !== null || entry.killed) return `${shellId} already stopped`
  try {
    entry.proc.kill('SIGTERM')
    entry.killed = true
    // Si no muere en 2s, SIGKILL.
    setTimeout(() => {
      if (entry.exitCode === null) {
        try { entry.proc.kill('SIGKILL') } catch { /* ignore */ }
      }
    }, 2000)
    return `${shellId} killed`
  } catch (err) {
    return `Error killing ${shellId}: ${err instanceof Error ? err.message : String(err)}`
  }
}

export function listBackground(): string {
  if (procs.size === 0) return 'No background shells running.'
  const lines: string[] = []
  for (const [id, entry] of procs) {
    const status = entry.killed
      ? 'killed'
      : entry.exitCode === null
        ? 'running'
        : `exit ${entry.exitCode}`
    const ageS = Math.floor((Date.now() - entry.startedAt) / 1000)
    lines.push(`  ${id}  ${status.padEnd(12)} age=${ageS}s  ${entry.command.slice(0, 60)}`)
  }
  return lines.join('\n')
}

/** Mata todos los procesos en background (cleanup al salir del REPL). */
export function killAllBackground(): void {
  for (const id of procs.keys()) {
    killBackground(id)
  }
}
