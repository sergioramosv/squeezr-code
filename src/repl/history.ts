import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Historial de prompts persistente entre sesiones.
 *
 * Guardado en `~/.squeezr-code/history`, una entrada por línea, LRU con cap.
 * Best-effort: si falla la E/S (permisos, disco lleno, etc.) simplemente no persiste.
 */

const HISTORY_PATH = path.join(os.homedir(), '.squeezr-code', 'history')
const MAX_ENTRIES = 500

/** Lee el fichero de historial. Devuelve [] si no existe. */
export function loadHistory(): string[] {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return []
    const raw = fs.readFileSync(HISTORY_PATH, 'utf-8')
    return raw.split('\n').filter(Boolean).slice(-MAX_ENTRIES)
  } catch {
    return []
  }
}

/** Añade una entrada al historial (dedupe de la última para evitar repeticiones). */
export function appendHistory(entry: string): void {
  const trimmed = entry.trim()
  if (!trimmed) return
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true })
    const existing = loadHistory()
    if (existing.length > 0 && existing[existing.length - 1] === trimmed) return
    const next = [...existing, trimmed].slice(-MAX_ENTRIES)
    fs.writeFileSync(HISTORY_PATH, next.join('\n') + '\n')
  } catch {
    // historial best-effort
  }
}
