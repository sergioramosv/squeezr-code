import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'
import { getVersion } from '../version.js'

/**
 * Check de versión nueva en npm. Cacheado 24h para no hacer HTTP cada arranque.
 *
 * Flow:
 *   1. Al arrancar sq, lee `~/.squeezr-code/update-check.json`.
 *   2. Si lastCheck < 24h → usa el cached latest.
 *   3. Si > 24h → GET registry.npmjs.org/squeezr-code/latest (timeout 2s).
 *   4. Compara con getVersion() → devuelve banner si hay update.
 *
 * Non-blocking: fire-and-forget desde startREPL. Si falla (offline, timeout,
 * registry caído) no molesta.
 */

const CACHE_FILE = path.join(os.homedir(), '.squeezr-code', 'update-check.json')
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const REGISTRY_URL = 'https://registry.npmjs.org/squeezr-code/latest'

interface UpdateCache {
  lastCheck: number
  latest: string
}

function readCache(): UpdateCache | null {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as UpdateCache
  } catch { return null }
}

function writeCache(cache: UpdateCache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache))
  } catch { /* best-effort */ }
}

function fetchLatest(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(REGISTRY_URL, { timeout: 2000, headers: { 'User-Agent': 'squeezr-code' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return }
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        try {
          const data = JSON.parse(body) as { version: string }
          resolve(data.version || null)
        } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

/** Compara semver "a.b.c". Devuelve -1 si a<b, 0 igual, 1 si a>b. */
function semverCompare(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10))
  const pb = b.split('.').map(n => parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * Devuelve la versión latest si es mayor que la actual, o null si estamos
 * al día / offline / cache TTL no expirado. No hace nada visible — el caller
 * decide cómo mostrarlo.
 */
export async function checkForUpdate(): Promise<string | null> {
  const current = getVersion()
  const cache = readCache()
  const now = Date.now()

  let latest: string | null = null
  if (cache && (now - cache.lastCheck) < CACHE_TTL_MS) {
    latest = cache.latest
  } else {
    latest = await fetchLatest()
    if (latest) writeCache({ lastCheck: now, latest })
  }

  if (!latest) return null
  return semverCompare(latest, current) > 0 ? latest : null
}
