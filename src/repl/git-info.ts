import { execSync } from 'node:child_process'

export interface GitInfo {
  branch: string | null
  dirty: boolean
}

interface CacheEntry {
  result: GitInfo | null
  ts: number
}

const CACHE_TTL_MS = 5_000
const cache = new Map<string, CacheEntry>()

/**
 * Devuelve `{branch, dirty}` para `cwd`, o `null` si no es repo / git no está
 * instalado / timeout. Cacheado 5s por path: el status prompt se redibuja en
 * cada turno y no queremos un spawn de git por cada redibujo.
 */
export function getGitInfo(cwd: string): GitInfo | null {
  const now = Date.now()
  const cached = cache.get(cwd)
  if (cached && (now - cached.ts) < CACHE_TTL_MS) {
    return cached.result
  }

  let result: GitInfo | null = null
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      timeout: 100,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || null

    const status = execSync('git status --porcelain', {
      cwd,
      timeout: 100,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString()

    result = { branch, dirty: status.length > 0 }
  } catch {
    result = null
  }

  cache.set(cwd, { result, ts: now })
  return result
}
