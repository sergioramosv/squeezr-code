import { execSync } from 'node:child_process'

/**
 * Statusline custom commands: el usuario configura comandos shell que se
 * ejecutan periódicamente y su output aparece en el status bar.
 *
 * sq.toml:
 *   [statusline]
 *   commands = [
 *     "git rev-parse --short HEAD",
 *     "node -v"
 *   ]
 *   refresh_seconds = 30
 *
 * Cada output se trunca a 30 chars, sin newlines. Si el comando falla,
 * se omite silenciosamente.
 */

interface CacheEntry { value: string; ts: number }
const cache = new Map<string, CacheEntry>()

export function evaluateStatusline(commands: string[], cacheSeconds: number = 30): string[] {
  const now = Date.now()
  const ttlMs = cacheSeconds * 1000
  const out: string[] = []
  for (const cmd of commands) {
    const cached = cache.get(cmd)
    if (cached && (now - cached.ts) < ttlMs) {
      if (cached.value) out.push(cached.value)
      continue
    }
    try {
      const result = execSync(cmd, {
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      }).toString().trim().split('\n')[0].slice(0, 30)
      cache.set(cmd, { value: result, ts: now })
      if (result) out.push(result)
    } catch {
      cache.set(cmd, { value: '', ts: now })
    }
  }
  return out
}
