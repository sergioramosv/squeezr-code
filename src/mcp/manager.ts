import { McpClient, type McpServerConfig } from './client.js'
import type { ToolDef } from '../api/types.js'

export type McpStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

interface ServerEntry {
  spec: McpServerConfig
  client: McpClient | null
  status: McpStatus
  /** Mensaje del último error (si status = 'error'). */
  lastError?: string
  /** Tools cacheadas la última vez que estuvo connected. */
  toolCount: number
}

/**
 * Inicia/para servidores MCP declarados en sq.toml, recoge sus tools y las
 * expone al resto de sq. Se encarga de enrutar las tool_call al server
 * correcto usando el prefijo `<serverName>:<toolName>`.
 *
 * Mantiene el `spec` original de cada server para poder reconectar después
 * de desconectar (necesario para el picker `/mcp`).
 */
export class McpManager {
  private servers = new Map<string, ServerEntry>()

  /**
   * Arranca todos los servers de la config. NO bloquea — registra los servers
   * como `connecting` y lanza los `connect()` en background. El REPL aparece
   * inmediatamente y los servers se van conectando a medida que responden
   * (o fallan con timeout). Si el usuario abre `/mcp` antes de que terminen,
   * ve el status en tiempo real.
   */
  start(specs: McpServerConfig[]): void {
    for (const spec of specs) {
      this.servers.set(spec.name, { spec, client: null, status: 'connecting', toolCount: 0 })
    }
    // Fire-and-forget — cada connect() actualiza el status del entry al terminar.
    for (const s of specs) {
      void this.connect(s.name)
    }
  }

  /** Conecta un server por nombre. Devuelve true si quedó connected. */
  async connect(name: string): Promise<boolean> {
    const entry = this.servers.get(name)
    if (!entry) return false
    if (entry.status === 'connected' && entry.client) return true

    entry.status = 'connecting'
    entry.lastError = undefined
    const client = new McpClient(entry.spec)
    try {
      await client.start()
      entry.client = client
      entry.status = 'connected'
      entry.toolCount = client.getTools().length
      return true
    } catch (err) {
      try { client.stop() } catch { /* ignore */ }
      entry.client = null
      entry.status = 'error'
      entry.lastError = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  /** Desconecta un server por nombre. Idempotente. */
  disconnect(name: string): void {
    const entry = this.servers.get(name)
    if (!entry) return
    if (entry.client) {
      try { entry.client.stop() } catch { /* ignore */ }
    }
    entry.client = null
    entry.status = 'disconnected'
    entry.lastError = undefined
  }

  /** Stop + connect (para reintentar tras fallo o relanzar el subproceso). */
  async restart(name: string): Promise<boolean> {
    this.disconnect(name)
    return this.connect(name)
  }

  /** Lista todas las tools expuestas por los servers connected. */
  getAllTools(): ToolDef[] {
    const out: ToolDef[] = []
    for (const entry of this.servers.values()) {
      if (entry.status === 'connected' && entry.client) {
        out.push(...entry.client.getTools())
      }
    }
    return out
  }

  /**
   * Parsea el nombre compuesto `<serverSanitized>__<toolSanitized>` y localiza
   * el entry cuyo nombre saneado empareja. Necesario porque el nombre puede
   * contener caracteres que tuvimos que reemplazar por `_` al enviarlo al LLM.
   */
  private findServer(toolName: string): { name: string; localName: string } | null {
    const idx = toolName.indexOf('__')
    if (idx < 0) return null
    const prefix = toolName.slice(0, idx)
    const localName = toolName.slice(idx + 2)
    // Busca el server cuyo nombre saneado encaje con `prefix`.
    for (const [name] of this.servers) {
      if (name.replace(/[^a-zA-Z0-9_-]/g, '_') === prefix) {
        return { name, localName }
      }
    }
    return null
  }

  /** True si el nombre de la tool pertenece a algún MCP server connected. */
  isMcpTool(toolName: string): boolean {
    const parsed = this.findServer(toolName)
    if (!parsed) return false
    const entry = this.servers.get(parsed.name)
    return entry?.status === 'connected'
  }

  /** Proxy a tools/call del server correspondiente. */
  async callTool(toolName: string, input: Record<string, unknown>): Promise<string> {
    const parsed = this.findServer(toolName)
    if (!parsed) throw new Error(`Invalid MCP tool name: ${toolName}`)
    const entry = this.servers.get(parsed.name)
    if (!entry || !entry.client || entry.status !== 'connected') {
      throw new Error(`MCP server not connected: ${parsed.name}`)
    }
    // Necesitamos llamar al server con el nombre ORIGINAL de la tool, no el
    // saneado. El McpClient guarda las tools originales en this.tools.
    const original = entry.client.getTools()
      .find(t => t.name === toolName)
    if (!original) {
      // Fallback: pasa el localName saneado. Puede no encontrarla.
      return entry.client.callTool(parsed.localName, input)
    }
    // Busca el nombre original del tool (sin sanear) dentro del client.
    const rawName = entry.client.findOriginalToolName(toolName)
    return entry.client.callTool(rawName || parsed.localName, input)
  }

  stopAll(): void {
    for (const name of this.servers.keys()) {
      this.disconnect(name)
    }
  }

  /** Nombres de los servers connected (para welcome banner). */
  getActiveServers(): string[] {
    return Array.from(this.servers.entries())
      .filter(([_, e]) => e.status === 'connected')
      .map(([n]) => n)
  }

  /** Snapshot completo para el picker `/mcp`. */
  list(): Array<{
    name: string
    status: McpStatus
    command: string
    args: string[]
    toolCount: number
    lastError?: string
  }> {
    return Array.from(this.servers.entries()).map(([name, e]) => ({
      name,
      status: e.status,
      command: e.spec.command,
      args: e.spec.args || [],
      toolCount: e.toolCount,
      lastError: e.lastError,
    }))
  }
}
