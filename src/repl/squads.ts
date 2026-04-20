import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { SqConfig } from '../config.js'
import type { AuthManager } from '../auth/manager.js'

/**
 * Multi-agent dispatch system.
 *
 * Dos flavours:
 *   1. `/dispatch` ad-hoc: parse `@model: prompt` lines y dispara en paralelo.
 *   2. `/squad NAME [task]` cargando plantilla de ~/.squeezr-code/squads.json,
 *      con modo 'parallel' o 'sequential'.
 *
 * En paralelo: Promise.allSettled → cada agente con su modelo, errores aislados.
 * Secuencial: el result_N del agente N se inyecta como {{result_0..N-1}}
 * en el prompt del siguiente. Útil para "A implementa → B revisa la implementación de A".
 */

export interface SquadAgent {
  model: string
  role: string
  prompt: string
}

export interface Squad {
  mode: 'parallel' | 'sequential'
  agents: SquadAgent[]
}

const SQUADS_FILE = path.join(os.homedir(), '.squeezr-code', 'squads.json')

const DEFAULT_SQUADS: Record<string, Squad> = {
  'opinions': {
    mode: 'parallel',
    agents: [
      { model: 'opus', role: 'Claude', prompt: '{{task}}' },
      { model: 'gpt-5', role: 'GPT-5', prompt: '{{task}}' },
      { model: 'gemini-pro', role: 'Gemini', prompt: '{{task}}' },
    ],
  },
  'pr-review': {
    mode: 'sequential',
    agents: [
      { model: 'opus', role: 'implementer', prompt: 'Implement the following feature and write the complete code:\n\n{{task}}' },
      { model: 'gpt-5-codex', role: 'reviewer', prompt: 'Review the following implementation looking for bugs, edge cases and improvements:\n\n{{result_0}}' },
    ],
  },
  'build-and-test': {
    mode: 'sequential',
    agents: [
      { model: 'sonnet', role: 'builder', prompt: 'Implement: {{task}}' },
      { model: 'haiku', role: 'tester', prompt: 'Write unit tests for:\n\n{{result_0}}' },
    ],
  },
}

export function loadSquads(): Record<string, Squad> {
  try {
    if (!fs.existsSync(SQUADS_FILE)) return { ...DEFAULT_SQUADS }
    const raw = JSON.parse(fs.readFileSync(SQUADS_FILE, 'utf-8')) as Record<string, Squad>
    // Merge con defaults, el fichero del user gana.
    return { ...DEFAULT_SQUADS, ...raw }
  } catch {
    return { ...DEFAULT_SQUADS }
  }
}

export function saveSquads(squads: Record<string, Squad>): void {
  try {
    fs.mkdirSync(path.dirname(SQUADS_FILE), { recursive: true })
    // Solo guardamos los customs (los que NO son iguales al default).
    const custom: Record<string, Squad> = {}
    for (const [name, squad] of Object.entries(squads)) {
      if (JSON.stringify(DEFAULT_SQUADS[name]) !== JSON.stringify(squad)) {
        custom[name] = squad
      }
    }
    fs.writeFileSync(SQUADS_FILE, JSON.stringify(custom, null, 2))
  } catch { /* best-effort */ }
}

/**
 * Parsea el body de /dispatch a una lista de { model, prompt }.
 * Formato aceptado:
 *   @modelName: prompt del agente
 *   @otherModel: otro prompt
 *
 * Líneas vacías / sin @ se ignoran (pueden ser comentarios del user).
 */
export function parseDispatchBody(body: string): Array<{ model: string; prompt: string }> {
  const agents: Array<{ model: string; prompt: string }> = []
  for (const rawLine of body.split(/\n/)) {
    const line = rawLine.trim()
    if (!line || !line.startsWith('@')) continue
    const m = /^@(\S+)\s*:\s*(.+)$/.exec(line)
    if (!m) continue
    agents.push({ model: m[1], prompt: m[2].trim() })
  }
  return agents
}

/** Expande placeholders `{{task}}`, `{{result_N}}`, `{{result_last}}` en un string. */
export function applyTemplate(tpl: string, task: string, results: string[]): string {
  let out = tpl.replace(/\{\{\s*task\s*\}\}/g, task)
  out = out.replace(/\{\{\s*result_(\d+)\s*\}\}/g, (_, nStr) => {
    const n = parseInt(nStr as string, 10)
    return results[n] || ''
  })
  out = out.replace(/\{\{\s*result_last\s*\}\}/g, () => results[results.length - 1] || '')
  return out
}

/**
 * Ejecuta un squad. `runAgent` es un callback que recibe (model, prompt, role)
 * y devuelve la respuesta del sub-agente. El caller lo inyecta para no tener
 * que importar runSubAgent y meter dependencias circulares.
 */
export async function runSquad(
  squad: Squad,
  task: string,
  runAgent: (model: string, prompt: string, role: string) => Promise<string>,
): Promise<Array<{ role: string; model: string; result: string; error?: boolean; elapsedMs: number }>> {
  const results: Array<{ role: string; model: string; result: string; error?: boolean; elapsedMs: number }> = []

  if (squad.mode === 'parallel') {
    const start = Date.now()
    const settled = await Promise.allSettled(squad.agents.map(async (a) => {
      const agentStart = Date.now()
      const prompt = applyTemplate(a.prompt, task, [])
      const text = await runAgent(a.model, prompt, a.role)
      return { role: a.role, model: a.model, result: text, elapsedMs: Date.now() - agentStart }
    }))
    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(r.value)
      else results.push({ role: 'unknown', model: 'unknown', result: String(r.reason), error: true, elapsedMs: Date.now() - start })
    }
    return results
  }

  // Sequential
  const textsSoFar: string[] = []
  for (const a of squad.agents) {
    const start = Date.now()
    const prompt = applyTemplate(a.prompt, task, textsSoFar)
    try {
      const text = await runAgent(a.model, prompt, a.role)
      results.push({ role: a.role, model: a.model, result: text, elapsedMs: Date.now() - start })
      textsSoFar.push(text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ role: a.role, model: a.model, result: msg, error: true, elapsedMs: Date.now() - start })
      textsSoFar.push(msg)
    }
  }
  return results
}

// Parameters kept so the squad helper could integrate with main REPL cleanup flows.
export type SquadDispatcher = (
  cfg: SqConfig,
  auth: AuthManager,
  cwd: string,
  task: string,
  squadOrAgents: Squad | Array<{ model: string; prompt: string }>,
) => Promise<void>
