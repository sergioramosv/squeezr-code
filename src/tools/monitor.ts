import { spawn } from 'node:child_process'

/**
 * Monitor tool: ejecuta un comando shell, captura stdout filtrado por un regex,
 * y devuelve las líneas capturadas cuando el proceso termina o expira el
 * timeout. Más simple que el Monitor persistente de Claude Code — nuestro
 * agente usa tool-call model (sin streaming desde tools), así que devolvemos
 * resultados en bloque.
 *
 * Para builds/tests/logs. Ejemplo:
 *   Monitor({ command: "npm run build", timeout_ms: 120000, filter: "error|FAIL" })
 */

export interface MonitorInput {
  command: string
  description?: string
  timeout_ms?: number
  filter?: string
}

export async function runMonitor(input: MonitorInput, cwd: string): Promise<string> {
  const command = input.command
  if (!command) return 'Error: `command` is required'
  const timeoutMs = Math.min(Math.max(input.timeout_ms || 60_000, 1_000), 600_000)
  const filterRe = input.filter ? new RegExp(input.filter) : null
  const description = input.description || command.slice(0, 40)

  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const proc = spawn(
      isWin ? 'cmd.exe' : '/bin/bash',
      isWin ? ['/c', command] : ['-c', command],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    )

    const matched: string[] = []
    let totalLines = 0
    let stdoutBuffer = ''
    let stderrBuffer = ''
    let resolved = false

    const processLine = (line: string) => {
      totalLines++
      if (!filterRe || filterRe.test(line)) matched.push(line)
    }

    const drainBuffer = (source: 'stdout' | 'stderr', chunk: string) => {
      if (source === 'stdout') stdoutBuffer += chunk
      else stderrBuffer += chunk
      const buf = source === 'stdout' ? stdoutBuffer : stderrBuffer
      const nl = buf.lastIndexOf('\n')
      if (nl < 0) return
      const complete = buf.slice(0, nl)
      const remainder = buf.slice(nl + 1)
      if (source === 'stdout') stdoutBuffer = remainder
      else stderrBuffer = remainder
      for (const line of complete.split('\n')) {
        processLine(line)
      }
    }

    proc.stdout!.on('data', c => drainBuffer('stdout', c.toString('utf-8')))
    proc.stderr!.on('data', c => drainBuffer('stderr', c.toString('utf-8')))

    const finish = (reason: 'exit' | 'timeout', exitCode: number | null) => {
      if (resolved) return
      resolved = true
      // Flush buffers pendientes.
      if (stdoutBuffer.trim()) processLine(stdoutBuffer.trim())
      if (stderrBuffer.trim()) processLine(stderrBuffer.trim())
      const filterTag = filterRe ? ` · filter: ${input.filter}` : ''
      const header = `Monitor "${description}" — ${reason === 'exit' ? `exit ${exitCode}` : `timeout ${timeoutMs}ms`} · ${matched.length}/${totalLines} lines${filterTag}`
      const body = matched.length > 0 ? matched.join('\n') : '(no matching lines)'
      resolve(`${header}\n\n${body}`)
    }

    proc.on('exit', code => finish('exit', code))
    proc.on('error', err => finish('exit', err instanceof Error ? -1 : -1))

    setTimeout(() => {
      if (!resolved) {
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
        finish('timeout', null)
      }
    }, timeoutMs)
  })
}
