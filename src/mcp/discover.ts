import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { McpServerConfig } from './client.js'

/**
 * Auto-descubre MCP servers instalados en otras herramientas compatibles, para
 * que sq los vea sin duplicar configuración. Se fusionan con los de `sq.toml`
 * (sq.toml tiene precedencia por nombre).
 *
 * Fuentes (en orden de lectura):
 *   1. ~/.claude.json                                        (Claude Code, user-level)
 *   2. %APPDATA%/Claude/claude_desktop_config.json           (Claude Desktop)
 *        o ~/Library/Application Support/Claude/...          (mac)
 *        o ~/.config/Claude/...                              (linux)
 *   3. <cwd>/.mcp.json                                        (project-level estándar)
 *
 * El formato es siempre el mismo: `{ mcpServers: { <name>: { command, args, env } } }`.
 * Se añade `[source]:<name>` al nombre lógico si colisiona con otro del mismo
 * nombre en otra fuente.
 */

interface DiscoveredServer extends McpServerConfig {
  source: string  // "claude-code" | "claude-desktop" | "project" | "sq.toml"
}

export function discoverMcpServers(cwd: string = process.cwd()): DiscoveredServer[] {
  const out: DiscoveredServer[] = []
  const seen = new Set<string>()

  const add = (source: string, name: string, spec: { command?: string; args?: string[]; env?: Record<string, string> }) => {
    if (!spec.command) return
    // Si ya hay uno con este nombre, cambiamos a "name@source" para no colisionar.
    let finalName = name
    if (seen.has(finalName)) {
      finalName = `${name}@${source}`
      if (seen.has(finalName)) return  // duplicado exacto, saltamos
    }
    seen.add(finalName)
    out.push({
      name: finalName,
      command: spec.command,
      args: spec.args || [],
      env: spec.env,
      source,
    })
  }

  // 1. Claude Code — ~/.claude.json
  const claudeCodePath = path.join(os.homedir(), '.claude.json')
  const fromClaudeCode = tryReadMcpServers(claudeCodePath)
  for (const [name, spec] of Object.entries(fromClaudeCode)) {
    add('claude-code', name, spec)
  }

  // 2. Claude Desktop — según plataforma
  const desktopPath = claudeDesktopConfigPath()
  if (desktopPath) {
    const fromDesktop = tryReadMcpServers(desktopPath)
    for (const [name, spec] of Object.entries(fromDesktop)) {
      add('claude-desktop', name, spec)
    }
  }

  // 3. Proyecto local — <cwd>/.mcp.json
  const projectPath = path.join(cwd, '.mcp.json')
  const fromProject = tryReadMcpServers(projectPath)
  for (const [name, spec] of Object.entries(fromProject)) {
    add('project', name, spec)
  }

  return out
}

function tryReadMcpServers(filePath: string): Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> {
  try {
    if (!fs.existsSync(filePath)) return {}
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return (raw.mcpServers || {}) as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
  } catch {
    return {}
  }
}

function claudeDesktopConfigPath(): string | null {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    return path.join(appdata, 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  // linux
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json')
}
