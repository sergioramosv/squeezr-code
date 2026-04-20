/**
 * Tracker de performance por tool. Se incrementa en cada executeInner call.
 * In-memory, se resetea al reiniciar sq.
 */

interface ToolStat {
  name: string
  calls: number
  totalMs: number
  maxMs: number
  errors: number
}

const stats = new Map<string, ToolStat>()

export function trackToolCall(name: string, durationMs: number, isError: boolean): void {
  let s = stats.get(name)
  if (!s) {
    s = { name, calls: 0, totalMs: 0, maxMs: 0, errors: 0 }
    stats.set(name, s)
  }
  s.calls++
  s.totalMs += durationMs
  if (durationMs > s.maxMs) s.maxMs = durationMs
  if (isError) s.errors++
}

export function getToolStats(): ToolStat[] {
  return [...stats.values()].sort((a, b) => b.totalMs - a.totalMs)
}

export function resetToolStats(): void {
  stats.clear()
}
