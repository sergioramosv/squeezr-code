import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Agentes persistentes: definiciones de sub-agentes guardadas como .md en
 * `~/.squeezr-code/agents/<name>.md`.
 *
 * Estructura del .md:
 *   ```md
 *   ---
 *   description: Code reviewer especializado en seguridad
 *   tools: Read, Grep, Glob
 *   model: opus
 *   ---
 *   You are a security-focused code reviewer.
 *   Look for: SQL injection, XSS, hardcoded secrets, ...
 *   Be terse. Output a numbered list of issues.
 *   ```
 *
 * Cuando el modelo principal usa `Task(subagent_type='X', prompt='...')`,
 * sq busca el .md de X y usa su `system prompt` + restricciones de tools/model.
 */

export interface AgentSpec {
  name: string
  description: string
  systemPrompt: string
  /** Tools que este agente puede usar (subset de los disponibles). */
  tools?: string[]
  /** Modelo override (alias o id completo). */
  model?: string
}

export function loadAgents(): AgentSpec[] {
  const dir = path.join(os.homedir(), '.squeezr-code', 'agents')
  if (!fs.existsSync(dir)) return []
  const out: AgentSpec[] = []
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const text = fs.readFileSync(path.join(dir, f), 'utf-8')
      const spec = parseAgent(f.slice(0, -3), text)
      if (spec) out.push(spec)
    }
  } catch { /* skip */ }
  return out
}

export function findAgent(name: string): AgentSpec | null {
  const all = loadAgents()
  return all.find(a => a.name === name) || null
}

function parseAgent(name: string, text: string): AgentSpec | null {
  let systemPrompt = text
  let description = ''
  let tools: string[] | undefined
  let model: string | undefined

  const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text)
  if (fmMatch) {
    systemPrompt = text.slice(fmMatch[0].length).trim()
    const fm = fmMatch[1]
    const descM = /description:\s*(.+)/.exec(fm); if (descM) description = descM[1].trim()
    const toolsM = /tools:\s*(.+)/.exec(fm); if (toolsM) tools = toolsM[1].split(',').map(s => s.trim()).filter(Boolean)
    const modelM = /model:\s*(.+)/.exec(fm); if (modelM) model = modelM[1].trim()
  }

  if (!description) {
    description = systemPrompt.split('\n')[0].slice(0, 80)
  }

  return { name, description, systemPrompt, tools, model }
}
