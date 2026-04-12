import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse as parseTOML } from 'smol-toml'

export interface SqConfig {
  agent: {
    default: string
    permissions: 'default' | 'auto' | 'yolo'
  }
  transplant: {
    mode: 'auto' | 'manual' | 'hybrid'
    warn_threshold: number
    auto_threshold: number
    strategy: 'replay' | 'summary' | 'hybrid'
    max_replay_messages: number
  }
  proxy: {
    enabled: boolean
    port: number
  }
  economist: {
    enabled: boolean
    daily_budget: number
    warn_at: number
  }
  router: {
    enabled: boolean
    rules: Record<string, string>
  }
  display: {
    show_cost: boolean
    show_context: boolean
    show_router: boolean
  }
}

const DEFAULTS: SqConfig = {
  agent: {
    default: 'claude-sonnet-4-20250514',
    permissions: 'default',
  },
  transplant: {
    mode: 'hybrid',
    warn_threshold: 80,
    auto_threshold: 95,
    strategy: 'replay',
    max_replay_messages: 30,
  },
  proxy: {
    enabled: true,
    port: 8080,
  },
  economist: {
    enabled: true,
    daily_budget: 0,
    warn_at: 0,
  },
  router: {
    enabled: false,
    rules: {},
  },
  display: {
    show_cost: true,
    show_context: true,
    show_router: true,
  },
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result = { ...base }
  for (const key of Object.keys(override)) {
    const val = override[key]
    if (val && typeof val === 'object' && !Array.isArray(val) && typeof (base as Record<string, unknown>)[key] === 'object') {
      (result as Record<string, unknown>)[key] = deepMerge(
        (base as Record<string, unknown>)[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      )
    } else {
      (result as Record<string, unknown>)[key] = val
    }
  }
  return result
}

function tryLoadTOML(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf-8')
    return parseTOML(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

export function loadConfig(cwd?: string): SqConfig {
  let config = { ...DEFAULTS } as Record<string, unknown>

  // 1. Global config: ~/.squeezr-code/config.toml
  const globalPath = path.join(os.homedir(), '.squeezr-code', 'config.toml')
  const globalConf = tryLoadTOML(globalPath)
  if (globalConf) config = deepMerge(config, globalConf)

  // 2. Local config: <project>/sq.toml
  const localPath = path.join(cwd || process.cwd(), 'sq.toml')
  const localConf = tryLoadTOML(localPath)
  if (localConf) config = deepMerge(config, localConf)

  const result = config as unknown as SqConfig

  // 3. Env overrides
  if (process.env.SQ_MODEL) result.agent.default = process.env.SQ_MODEL
  if (process.env.SQ_PROXY_PORT) result.proxy.port = parseInt(process.env.SQ_PROXY_PORT, 10)
  if (process.env.SQ_PERMISSIONS) result.agent.permissions = process.env.SQ_PERMISSIONS as SqConfig['agent']['permissions']

  return result
}
