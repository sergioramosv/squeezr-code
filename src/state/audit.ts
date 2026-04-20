import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

/**
 * Audit logs: JSONL append-only en ~/.squeezr-code/audit.log.
 *
 * Cada línea es un event: qué tool, qué input, qué output (hash sha256 del
 * output + primeros 500 chars como preview), cwd, sessionId, timestamp.
 *
 * Opt-in: `[audit] enabled = true` en ~/.squeezr-code/config.toml.
 * Por defecto OFF — solo users que lo necesiten (compliance, debugging, B2B)
 * lo activan.
 *
 * Formato (una línea por event):
 *   {"ts":1713355420000,"sid":"abc","cwd":"/path","tool":"Bash","input":{...},"out_sha256":"...","out_preview":"..."}
 *
 * Rotación: ningún límite por defecto. El user puede rotar manual cp audit.log audit-YYYY-MM-DD.log.
 */

const AUDIT_FILE = path.join(os.homedir(), '.squeezr-code', 'audit.log')

let enabled = false
let sessionId = ''

export function setAuditEnabled(on: boolean, sid: string): void {
  enabled = on
  sessionId = sid
}

export function logToolEvent(event: {
  tool: string
  input: Record<string, unknown>
  output: string
  cwd: string
  isError?: boolean
}): void {
  if (!enabled) return
  try {
    const outPreview = event.output.length > 500 ? event.output.slice(0, 500) + '…' : event.output
    const outSha = crypto.createHash('sha256').update(event.output).digest('hex').slice(0, 16)
    const entry = {
      ts: Date.now(),
      sid: sessionId,
      cwd: event.cwd,
      tool: event.tool,
      input: event.input,
      out_sha256: outSha,
      out_preview: outPreview,
      ...(event.isError ? { error: true } : {}),
    }
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true })
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n')
  } catch {
    // best-effort: si no podemos escribir el audit, no rompemos la ejecución
  }
}

export function getAuditPath(): string { return AUDIT_FILE }
export function isAuditEnabled(): boolean { return enabled }
