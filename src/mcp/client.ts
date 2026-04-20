import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ToolDef } from '../api/types.js'

/**
 * Cliente MCP stdio minimalista. Habla JSON-RPC 2.0 con un servidor MCP
 * spawneado como subproceso. Implementa solo lo necesario para exponer tools:
 *
 *   - initialize               → handshake
 *   - notifications/initialized → confirma handshake
 *   - tools/list               → recupera tools exportadas
 *   - tools/call               → ejecuta tool remota
 *
 * No soporta resources, prompts, sampling ni logging.
 */

export interface McpServerConfig {
  /** Nombre lógico del server (prefijo para las tools). */
  name: string
  /** Comando a spawnear. */
  command: string
  /** Argumentos del comando. */
  args?: string[]
  /** Variables de entorno adicionales. */
  env?: Record<string, string>
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number | string, {
    resolve: (value: unknown) => void
    reject: (err: Error) => void
  }>()
  private tools: McpTool[] = []

  constructor(public readonly config: McpServerConfig) {}

  async start(): Promise<void> {
    this.proc = spawn(this.config.command, this.config.args || [], {
      env: { ...process.env, ...(this.config.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout.setEncoding('utf-8')
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.proc.stderr.on('data', (_chunk: Buffer) => {
      // Servidores MCP suelen loguear a stderr — lo silenciamos para no
      // ensuciar el REPL. Si necesitas debug: redirige el env DEBUG_MCP=1.
      if (process.env.DEBUG_MCP) process.stderr.write(`[mcp:${this.config.name}] ${_chunk}`)
    })
    this.proc.on('error', (err) => {
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })

    // Handshake — timeout corto (8s) para que servers colgados no bloqueen.
    // Un MCP sano responde a `initialize` en < 500ms.
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'squeezr-code', version: '0.10.0' },
    }, 8_000)
    this.notify('notifications/initialized', {})

    // Lista de tools disponibles
    const listRes = await this.request('tools/list', {}, 8_000) as { tools?: McpTool[] }
    this.tools = listRes.tools || []

    void init  // consumido arriba por side effect — suppress unused
  }

  /**
   * Tools expuestas por este server, con el prefijo `<name>__` aplicado.
   * Usamos `__` en lugar de `:` porque Anthropic rechaza nombres con `:`
   * (su regex acepta solo `^[a-zA-Z0-9_-]{1,128}$`). OpenAI y Google no son
   * estrictos pero unificamos por simplicidad. El nombre también se sanea:
   * cualquier char no válido se reemplaza por `_` para sobrevivir a servers
   * que exponen tools con caracteres raros.
   */
  getTools(): ToolDef[] {
    const prefix = sanitizeName(this.config.name)
    return this.tools.map(t => ({
      name: `${prefix}__${sanitizeName(t.name)}`,
      description: t.description || `Tool expuesta por MCP server ${this.config.name}`,
      parameters: normalizeSchema(t.inputSchema || { type: 'object', properties: {} }),
    }))
  }

  /**
   * Devuelve el nombre ORIGINAL (antes de sanear) de una tool dado su nombre
   * "exportado" (con `<server>__<sanitized>`). Necesario para invocar la tool
   * en el server con el nombre real que el server conoce.
   */
  findOriginalToolName(exportedName: string): string | null {
    const prefix = sanitizeName(this.config.name) + '__'
    if (!exportedName.startsWith(prefix)) return null
    const sanitizedLocal = exportedName.slice(prefix.length)
    const match = this.tools.find(t => sanitizeName(t.name) === sanitizedLocal)
    return match?.name || null
  }

  /** Llama una tool remota (se le pasa el nombre sin el prefijo). */
  async callTool(localName: string, input: Record<string, unknown>): Promise<string> {
    const res = await this.request('tools/call', {
      name: localName,
      arguments: input,
    }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean }

    if (!res.content) return '(tool devolvió sin content)'
    const text = res.content
      .filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join('\n')
    return text || '(tool devolvió content vacío)'
  }

  stop(): void {
    if (this.proc) {
      try { this.proc.kill() } catch { /* ignore */ }
      this.proc = null
    }
    for (const p of this.pending.values()) p.reject(new Error('MCP client stopped'))
    this.pending.clear()
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error('MCP client not started'))
    const id = this.nextId++
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send(msg)
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP request timeout (${timeoutMs}ms): ${method}`))
        }
      }, timeoutMs)
    })
  }

  private notify(method: string, params: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.send(msg)
  }

  private send(msg: unknown): void {
    if (!this.proc) return
    const line = JSON.stringify(msg) + '\n'
    this.proc.stdin.write(line)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let msg: JsonRpcResponse | JsonRpcNotification
      try {
        msg = JSON.parse(trimmed)
      } catch {
        continue
      }
      if ('id' in msg && msg.id !== undefined) {
        const pending = this.pending.get(msg.id)
        if (!pending) continue
        this.pending.delete(msg.id)
        const r = msg as JsonRpcResponse
        if (r.error) {
          pending.reject(new Error(`${r.error.code}: ${r.error.message}`))
        } else {
          pending.resolve(r.result)
        }
      }
      // Ignoramos notifications del servidor (logs, progress, etc.)
    }
  }
}

/**
 * Reemplaza cualquier char que no case `[a-zA-Z0-9_-]` por `_`. Necesario
 * para que Anthropic acepte los nombres de tools. El mapping no es reversible
 * pero la colisión es improbable en la práctica.
 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * Convierte el JSON Schema estándar que devuelve MCP (`{properties, required: []}`)
 * al formato plano que usan las definiciones de tools de sq (un map donde cada
 * property puede tener `required: true` en línea). Los adapters de sq (anthropic,
 * openai, google) vuelven a convertirlo al shape estándar al enviar al LLM.
 */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties as Record<string, Record<string, unknown>>) || {}
  const requiredArr = (schema.required as string[]) || []
  const required = new Set(requiredArr)
  const out: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(properties)) {
    out[name] = required.has(name) ? { ...def, required: true } : { ...def }
  }
  return out
}
