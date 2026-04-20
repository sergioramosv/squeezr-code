import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { AuthManager } from '../auth/manager.js'
import type { AuthStatus } from '../auth/manager.js'

/**
 * Catálogo dinámico de modelos.
 *
 * Resuelve la lista real disponible contra `/v1/models` de cada provider
 * autenticado, con caché en `~/.squeezr-code/models-cache.json` (TTL 1h)
 * para no pagar 200-500ms en cada arranque.
 */

export interface ModelInfo {
  id: string
  alias: string
  label: string
  provider: 'anthropic' | 'openai' | 'google'
  implemented: boolean
}

const CACHE_PATH = path.join(os.homedir(), '.squeezr-code', 'models-cache.json')
const CACHE_TTL_MS = 60 * 60 * 1000

interface CacheFile {
  anthropic?: { fetchedAt: number; models: ModelInfo[] }
  openai?:    { fetchedAt: number; models: ModelInfo[] }
  google?:    { fetchedAt: number; models: ModelInfo[] }
}

function loadCache(): CacheFile {
  try {
    if (!fs.existsSync(CACHE_PATH)) return {}
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))
  } catch { return {} }
}

function saveCache(cache: CacheFile): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true })
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2))
  } catch { /* best-effort */ }
}

// ─── Derivación de alias legibles ───────────────────────────────────
// claude-opus-4-7              → opus-4.7
// claude-sonnet-4-6            → sonnet-4.6
// claude-haiku-4-5-20251001    → haiku-4.5
// claude-opus-4-5-20251101     → opus-4.5
// claude-3-haiku-20240307      → haiku-3
function aliasForAnthropic(id: string): string {
  const family = /(opus|sonnet|haiku)/.exec(id)?.[1] || 'claude'
  // Todos los "segmentos de versión" del id: números cortos (1-2 dígitos).
  // Así filtramos sin problema las fechas YYYYMMDD del sufijo.
  //   claude-opus-4-7            → ['4','7']    → opus-4.7
  //   claude-haiku-4-5-20251001  → ['4','5']    → haiku-4.5
  //   claude-3-haiku-20240307    → ['3']        → haiku-3
  const versions = id.split('-').filter(p => /^\d{1,2}$/.test(p))
  if (versions.length >= 2) return `${family}-${versions[0]}.${versions[1]}`
  if (versions.length === 1) return `${family}-${versions[0]}`
  return family
}

// ─── Fetch por provider ─────────────────────────────────────────────

// Umbral mínimo de versión Anthropic: 4.5 (corta Haiku 3, Sonnet 4, Opus 4, Opus 4.1).
const MIN_ANTHROPIC_MAJOR = 4
const MIN_ANTHROPIC_MINOR = 5

function anthropicVersion(id: string): [number, number] {
  const parts = id.split('-').filter(p => /^\d{1,2}$/.test(p))
  return [parseInt(parts[0] || '0', 10), parseInt(parts[1] || '0', 10)]
}

async function fetchAnthropic(auth: AuthManager): Promise<ModelInfo[]> {
  const headers = await auth.headersFor('anthropic')
  const res = await fetch('https://api.anthropic.com/v1/models?limit=50', { headers })
  if (!res.ok) throw new Error(`/v1/models ${res.status}`)
  const data = await res.json() as { data?: Array<{ id: string; display_name?: string }> }
  const list = data.data || []
  const out: ModelInfo[] = []
  for (const m of list) {
    const [maj, min] = anthropicVersion(m.id)
    if (maj < MIN_ANTHROPIC_MAJOR) continue
    if (maj === MIN_ANTHROPIC_MAJOR && min < MIN_ANTHROPIC_MINOR) continue
    out.push({
      id: m.id,
      alias: aliasForAnthropic(m.id),
      label: m.display_name || m.id,
      provider: 'anthropic',
      implemented: true,
    })
  }
  return out
}

/**
 * Lee los modelos que ChatGPT/Codex expone a esta suscripción.
 *
 * chatgpt.com no tiene un endpoint público /v1/models para el adapter WS,
 * pero Codex CLI cachea la lista en `~/.codex/models_cache.json` tras el
 * primer login. La usamos como fuente.
 */
async function fetchOpenAI(): Promise<ModelInfo[]> {
  try {
    const cachePath = path.join(os.homedir(), '.codex', 'models_cache.json')
    if (!fs.existsSync(cachePath)) return []
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as {
      // El shape real de Codex usa `slug`. Mantenemos tolerancia a variantes.
      models?: Array<string | { slug?: string; id?: string; name?: string; display_name?: string }>
    }
    const items = raw.models || []
    const out: ModelInfo[] = []
    for (const m of items) {
      const id = typeof m === 'string' ? m : (m.slug || m.id || m.name || '')
      const label = typeof m === 'string' ? m : (m.display_name || m.slug || m.id || m.name || '')
      if (!id) continue
      const [maj, min] = openaiVersion(id)
      if (maj < MIN_OPENAI_MAJOR) continue
      if (maj === MIN_OPENAI_MAJOR && min < MIN_OPENAI_MINOR) continue
      out.push({
        id,
        alias: aliasForOpenAI(id),
        label,
        provider: 'openai',
        implemented: true,
      })
    }
    return out
  } catch {
    return []
  }
}

// gpt-5.4           → 5.4
// gpt-5.4-mini      → 5.4-mini
// gpt-5-codex       → 5-codex
// gpt-5.1-codex-max → 5.1-codex-max
function aliasForOpenAI(id: string): string {
  return id.replace(/^gpt-/, '').toLowerCase()
}

// Umbral mínimo OpenAI: 5.3 (corta 5, 5-codex, 5.1, 5.2 y variantes).
const MIN_OPENAI_MAJOR = 5
const MIN_OPENAI_MINOR = 3

function openaiVersion(id: string): [number, number] {
  const m = id.match(/gpt-(\d+)(?:\.(\d+))?/)
  if (!m) return [0, 0]
  return [parseInt(m[1], 10), parseInt(m[2] || '0', 10)]
}

/**
 * Lee los modelos que Gemini expone a esta suscripción.
 *
 * Code Assist no expone `/v1internal/models` (devuelve 404), así que vamos
 * directos al fallback hardcoded con los modelos reales que el endpoint acepta.
 *
 * IMPORTANTE: Code Assist exige sufijo de "thinking tier" (`-low` / `-high`)
 * para los Gemini 3 Pro. `gemini-3.1-pro` pelado da 404 "Requested entity not
 * found"; debe ser `gemini-3.1-pro-high` o `gemini-3.1-pro-low`.
 *
 * Lista actualizada para Abril 2026.
 */
async function fetchGoogle(_auth: AuthManager): Promise<ModelInfo[]> {
  const fallback: Array<{ id: string; label: string }> = [
    // Gemini 3.1 Pro (lo más nuevo, exige tier suffix)
    { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (high thinking)' },
    { id: 'gemini-3.1-pro-low',  label: 'Gemini 3.1 Pro (low thinking)'  },
    // Gemini 3 Pro (también exige tier suffix)
    { id: 'gemini-3-pro-high',   label: 'Gemini 3 Pro (high thinking)'   },
    { id: 'gemini-3-pro-low',    label: 'Gemini 3 Pro (low thinking)'    },
    // Gemini 3 Flash (sin tier — más rápido)
    { id: 'gemini-3-flash',      label: 'Gemini 3 Flash'                 },
    // Backup 2.5 por si el tier no tiene acceso a los 3.x
    { id: 'gemini-2.5-pro',      label: 'Gemini 2.5 Pro'                 },
    { id: 'gemini-2.5-flash',    label: 'Gemini 2.5 Flash'               },
  ]

  const out: ModelInfo[] = []
  for (const m of fallback) {
    const [maj, min] = googleVersion(m.id)
    if (maj < MIN_GOOGLE_MAJOR) continue
    if (maj === MIN_GOOGLE_MAJOR && min < MIN_GOOGLE_MINOR) continue
    out.push({
      id: m.id,
      alias: aliasForGoogle(m.id),
      label: m.label,
      provider: 'google',
      implemented: true,
    })
  }
  return out
}

// gemini-3.1-pro-high → pro-3.1-high
// gemini-3.1-pro-low  → pro-3.1-low
// gemini-3-pro-high   → pro-3-high
// gemini-3-flash      → flash-3
// gemini-2.5-pro      → pro-2.5
function aliasForGoogle(id: string): string {
  const family = /(pro|flash|ultra|nano)/.exec(id)?.[1] || 'gemini'
  const m = id.match(/gemini-(\d+(?:\.\d+)?)/)
  const ver = m?.[1] || ''
  const tier = /-(high|low)$/i.exec(id)?.[1]?.toLowerCase()
  const base = ver ? `${family}-${ver}` : family
  return tier ? `${base}-${tier}` : base
}

// Umbral mínimo Google: 2.5 (corta gemini-1.5 y anteriores). Cuando Google
// retire 2.5 del catálogo, subir a 3.0.
const MIN_GOOGLE_MAJOR = 2
const MIN_GOOGLE_MINOR = 5

function googleVersion(id: string): [number, number] {
  const m = id.match(/gemini-(\d+)(?:\.(\d+))?/)
  if (!m) return [0, 0]
  return [parseInt(m[1], 10), parseInt(m[2] || '0', 10)]
}

// ─── API pública ────────────────────────────────────────────────────

let cachedRegistry: ModelInfo[] | null = null
let refreshPromise: Promise<ModelInfo[]> | null = null

/**
 * Carga los modelos (desde caché si válida, fetch si expirada).
 * Idempotente: llamadas concurrentes comparten la misma Promise.
 */
export function loadModels(auth: AuthManager, status: AuthStatus): Promise<ModelInfo[]> {
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    const cache = loadCache()
    const now = Date.now()
    const merged: ModelInfo[] = []

    // Anthropic
    if (status.anthropic) {
      const fresh = cache.anthropic && (now - cache.anthropic.fetchedAt) < CACHE_TTL_MS
      if (fresh && cache.anthropic) {
        merged.push(...cache.anthropic.models)
      } else {
        try {
          const models = await fetchAnthropic(auth)
          cache.anthropic = { fetchedAt: now, models }
          merged.push(...models)
        } catch {
          // fallback a caché expirada si la hay
          if (cache.anthropic) merged.push(...cache.anthropic.models)
        }
      }
    }

    // OpenAI / Codex (WebSocket)
    if (status.openai) {
      const fresh = cache.openai && (now - cache.openai.fetchedAt) < CACHE_TTL_MS
      if (fresh && cache.openai) {
        merged.push(...cache.openai.models)
      } else {
        try {
          const models = await fetchOpenAI()
          if (models.length > 0) {
            cache.openai = { fetchedAt: now, models }
            merged.push(...models)
          } else if (cache.openai) {
            merged.push(...cache.openai.models)
          }
        } catch {
          if (cache.openai) merged.push(...cache.openai.models)
        }
      }
    }

    // Google / Gemini (Code Assist API)
    if (status.google) {
      const fresh = cache.google && (now - cache.google.fetchedAt) < CACHE_TTL_MS
      if (fresh && cache.google) {
        merged.push(...cache.google.models)
      } else {
        try {
          const models = await fetchGoogle(auth)
          if (models.length > 0) {
            cache.google = { fetchedAt: now, models }
            merged.push(...models)
          } else if (cache.google) {
            merged.push(...cache.google.models)
          }
        } catch {
          if (cache.google) merged.push(...cache.google.models)
        }
      }
    }

    saveCache(cache)
    cachedRegistry = merged
    return merged
  })()

  return refreshPromise
}

/** Devuelve los modelos cargados (o [] si aún no se ha llamado a loadModels). */
export function getLoadedModels(): ModelInfo[] {
  return cachedRegistry || []
}

/**
 * Alias reservados:
 *   opus / sonnet / haiku → último de cada familia Anthropic
 *   pro / flash           → último de cada familia Google
 */
export function resolveFamilyShortcut(input: string, models: ModelInfo[]): string | null {
  const family = input.toLowerCase()
  const ANTHROPIC_FAMILIES = ['opus', 'sonnet', 'haiku']
  const GOOGLE_FAMILIES = ['pro', 'flash', 'ultra', 'nano']

  const provider = ANTHROPIC_FAMILIES.includes(family)
    ? 'anthropic'
    : GOOGLE_FAMILIES.includes(family)
      ? 'google'
      : null

  if (!provider) return null

  const candidates = models
    .filter(m => m.provider === provider && m.alias.startsWith(family + '-'))
    .sort((a, b) => compareVersion(b.alias, a.alias))
  return candidates[0]?.id || null
}

function compareVersion(a: string, b: string): number {
  const va = (a.split('-')[1] || '0').split('.').map(Number)
  const vb = (b.split('-')[1] || '0').split('.').map(Number)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const x = va[i] || 0, y = vb[i] || 0
    if (x !== y) return x - y
  }
  return 0
}
