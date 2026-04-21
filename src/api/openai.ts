import tls from 'node:tls'
import https from 'node:https'
import crypto from 'node:crypto'
import { APIError } from '../errors.js'
import type {
  APIAdapter,
  NormalizedRequest,
  NormalizedStreamChunk,
  SubscriptionUsage,
} from './types.js'

/**
 * Adapter para Codex / ChatGPT via OAuth (suscripción ChatGPT Plus/Pro/Business).
 *
 * Hace lo mismo que hace Codex CLI: abre un WebSocket a
 *     wss://chatgpt.com/backend-api/codex/responses
 * con el `access_token` OAuth y el `chatgpt-account-id`, y habla el protocolo
 * `response.*` (similar a la API pública `/v1/responses` de OpenAI).
 *
 * Port de la lógica de `squeezr/src/codexMitm.ts` — pero como nosotros **somos**
 * el cliente (no interceptamos uno ajeno), no hace falta MITM, CA ni certs:
 * sólo un cliente WebSocket directo.
 */

const HOST = 'chatgpt.com'
const PORT = 443
const PATH = '/backend-api/codex/responses'

// ─── WebSocket frames (RFC 6455) ─────────────────────────────────────

function xorMask(data: Buffer, key: Buffer): Buffer {
  const out = Buffer.from(data)
  for (let i = 0; i < out.length; i++) out[i] ^= key[i % 4]
  return out
}

function buildFrame(opcode: number, payload: Buffer, masked: boolean): Buffer {
  const key = masked ? crypto.randomBytes(4) : Buffer.alloc(0)
  const plen = payload.length
  let hlen = 2 + (masked ? 4 : 0)
  if (plen >= 65536) hlen += 8
  else if (plen >= 126) hlen += 2

  const frame = Buffer.alloc(hlen + plen)
  frame[0] = 0x80 | opcode  // FIN + opcode

  if (plen >= 65536) {
    frame[1] = (masked ? 0x80 : 0) | 127
    frame.writeBigUInt64BE(BigInt(plen), 2)
    if (masked) key.copy(frame, 10)
  } else if (plen >= 126) {
    frame[1] = (masked ? 0x80 : 0) | 126
    frame.writeUInt16BE(plen, 2)
    if (masked) key.copy(frame, 4)
  } else {
    frame[1] = (masked ? 0x80 : 0) | plen
    if (masked) key.copy(frame, 2)
  }

  const body = masked ? xorMask(payload, key) : payload
  body.copy(frame, hlen)
  return frame
}

interface ParsedFrame {
  opcode: number
  payload: Buffer
  total: number
}

function parseFrame(buf: Buffer): ParsedFrame | null {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0F
  const masked = !!(buf[1] & 0x80)
  let plen = buf[1] & 0x7F
  let hlen = 2

  if (plen === 126) {
    if (buf.length < 4) return null
    plen = buf.readUInt16BE(2); hlen = 4
  } else if (plen === 127) {
    if (buf.length < 10) return null
    plen = Number(buf.readBigUInt64BE(2)); hlen = 10
  }

  const mask = Buffer.alloc(4)
  if (masked) {
    if (buf.length < hlen + 4) return null
    buf.copy(mask, 0, hlen, hlen + 4); hlen += 4
  }

  if (buf.length < hlen + plen) return null
  const raw = buf.slice(hlen, hlen + plen)
  const payload = masked ? xorMask(raw, mask) : raw
  return { opcode, payload, total: hlen + plen }
}

// ─── Traducción de mensajes normalizados → input de Codex ────────────
//
// El protocolo de /v1/responses acepta varios shapes de item. Usamos:
//   User:        { role: 'user', content: '...' }
//   Assistant:   { role: 'assistant', content: [{type:'output_text', text:'...'}] }
//   Tool call:   { type: 'function_call', call_id, name, arguments }
//   Tool result: { type: 'function_call_output', call_id, output }
function toCodexInput(messages: NormalizedRequest['messages']): unknown[] {
  const input: unknown[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.toolUseId || '',
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })
      continue
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const block of m.content as unknown as Array<Record<string, unknown>>) {
        if (block.type === 'text') {
          input.push({
            role: 'assistant',
            content: [{ type: 'output_text', text: block.text }],
          })
        } else if (block.type === 'tool_use') {
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          })
        }
      }
      continue
    }
    input.push({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })
  }
  return input
}

function toCodexTools(tools: NormalizedRequest['tools']): unknown[] {
  return tools.map(t => {
    // Mismo saneado que Anthropic: required fuera, no dentro de cada property.
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [name, def] of Object.entries(t.parameters)) {
      const d = def as Record<string, unknown>
      const { required: isRequired, ...clean } = d
      properties[name] = clean
      if (isRequired) required.push(name)
    }
    return {
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    }
  })
}

// ─── Adapter ────────────────────────────────────────────────────────

export class OpenAIAdapter implements APIAdapter {
  private socket: tls.TLSSocket | null = null
  private readBuf = Buffer.alloc(0)
  /** Cola de frames JSON ya parseados, para consumir desde receiveStream. */
  private pendingEvents: unknown[] = []
  private streamClosed = false
  private streamError: Error | null = null
  /** Notificador cuando hay algo nuevo que emitir (resolve de un waiter). */
  private notifyWaiter: (() => void) | null = null

  /** Acumulador de argumentos de tool_use por item_id (arriban como deltas). */
  private toolCalls = new Map<string, { id: string; name: string; argsJson: string }>()

  constructor(
    private getHeaders: () => Promise<Record<string, string>>,
    private getAccountId: () => string | null,
  ) {}

  async sendRequest(req: NormalizedRequest): Promise<void> {
    // Limpia estado previo
    this.close()
    this.readBuf = Buffer.alloc(0)
    this.pendingEvents = []
    this.streamClosed = false
    this.streamError = null
    this.toolCalls.clear()

    const headers = await this.getHeaders()
    const accountId = this.getAccountId() || ''
    if (!accountId) throw new APIError('openai', 0, 'Missing chatgpt-account-id (re-import Codex auth).', false)

    // Handshake HTTP/1.1 Upgrade
    const wsKey = crypto.randomBytes(16).toString('base64')
    const handshake = [
      `GET ${PATH} HTTP/1.1`,
      `Host: ${HOST}`,
      `Authorization: ${headers.Authorization}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${wsKey}`,
      'Sec-WebSocket-Version: 13',
      // Sin `Sec-WebSocket-Extensions: permessage-deflate` — así los frames llegan
      // en texto plano y no tenemos que implementar inflate por nuestra cuenta.
      'Originator: codex_cli',
      `chatgpt-account-id: ${accountId}`,
      '', '',
    ].join('\r\n')

    const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect(PORT, HOST, { servername: HOST }, () => {
        s.write(handshake)
      })
      let gotUpgrade = false
      let headerBuf = Buffer.alloc(0)

      s.on('error', (err) => reject(err))
      s.on('data', (chunk: Buffer) => {
        if (gotUpgrade) {
          this.onData(chunk)
          return
        }
        headerBuf = Buffer.concat([headerBuf, chunk])
        const str = headerBuf.toString('latin1')
        const idx = str.indexOf('\r\n\r\n')
        if (idx < 0) return
        const headLines = str.slice(0, idx).split('\r\n')
        const statusLine = headLines[0] || ''
        if (!statusLine.startsWith('HTTP/1.1 101')) {
          const body = str.slice(idx + 4).slice(0, 500)
          reject(new APIError('openai', parseInt(statusLine.split(' ')[1] || '0', 10), `Handshake failed: ${statusLine}  ${body}`, false))
          return
        }
        gotUpgrade = true
        const remainder = headerBuf.slice(idx + 4)
        if (remainder.length > 0) this.onData(remainder)
        resolve(s)
      })
      s.on('close', () => {
        if (!gotUpgrade) reject(new APIError('openai', 0, 'Connection closed during handshake', true))
        else this.markClosed()
      })
    })

    this.socket = socket

    // Envía el request como un único frame de texto
    const body = {
      type: 'response.create',
      model: req.model,
      instructions: req.system,
      input: toCodexInput(req.messages),
      tools: toCodexTools(req.tools),
      stream: true,
    }
    this.socket.write(buildFrame(0x1, Buffer.from(JSON.stringify(body), 'utf-8'), true))
  }

  async *receiveStream(): AsyncIterable<NormalizedStreamChunk> {
    while (true) {
      // Drena eventos ya parseados
      while (this.pendingEvents.length > 0) {
        const evt = this.pendingEvents.shift()!
        for (const chunk of this.translateEvent(evt as Record<string, unknown>)) {
          yield chunk
        }
      }

      if (this.streamError) throw this.streamError
      if (this.streamClosed && this.pendingEvents.length === 0) {
        yield { type: 'done' }
        return
      }

      // Espera a que llegue algo
      await new Promise<void>((res) => { this.notifyWaiter = res })
      this.notifyWaiter = null
    }
  }

  async sendToolResult(_toolUseId: string, _result: string): Promise<void> {
    // En Codex los tool_results se envían como parte del siguiente sendRequest
    // (el historial completo se reenvía), igual que en Anthropic.
  }

  close(): void {
    if (this.socket) {
      // CRÍTICO: arrancar los listeners antes de destruir.
      //
      // El handler de 'close' sigue apuntando a `this.markClosed()`. Si lo
      // dejamos vivo, cuando el socket viejo termine de cerrarse (async) nos
      // marca `streamClosed = true` — pero para entonces ya hay un socket
      // nuevo abierto para la siguiente petición, y el stream termina en seco
      // sin emitir ningún evento. Por eso "el segundo mensaje no responde".
      this.socket.removeAllListeners()
      try {
        // frame CLOSE 0x8
        this.socket.write(buildFrame(0x8, Buffer.alloc(0), true))
      } catch { /* ignore */ }
      try { this.socket.destroy() } catch { /* ignore */ }
      this.socket = null
    }
  }

  // ─── Privado ──────────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.readBuf = Buffer.concat([this.readBuf, chunk])
    while (true) {
      const f = parseFrame(this.readBuf)
      if (!f) break
      this.readBuf = this.readBuf.slice(f.total)

      if (f.opcode === 0x1 /* text */) {
        try {
          const evt = JSON.parse(f.payload.toString('utf-8'))
          this.pendingEvents.push(evt)
          this.notify()
        } catch {
          // frame malformado — ignoramos
        }
      } else if (f.opcode === 0x8 /* close */) {
        this.markClosed()
        return
      } else if (f.opcode === 0x9 /* ping */) {
        if (this.socket) this.socket.write(buildFrame(0xA, f.payload, true))
      }
    }
  }

  private markClosed(): void {
    this.streamClosed = true
    this.notify()
  }

  /**
   * Consulta el endpoint REST `/backend-api/codex/usage` que ChatGPT expone para
   * Codex, convierte la respuesta al shape `SubscriptionUsage` y la inyecta en la
   * cola de eventos antes de cerrar el stream.
   *
   * Timeout de 2s: si el endpoint tarda, no bloqueamos al usuario — cerramos sin
   * información de uso.
   */
  private async fetchSubscriptionAndClose(): Promise<void> {
    try {
      const headers = await this.getHeaders()
      const accountId = this.getAccountId() || ''
      if (!accountId) { this.markClosed(); return }

      // OJO: no usamos `fetch` aquí. `undici` (fetch de Node) añade Accept-Encoding
      // gzip/deflate/br por defecto, y Cloudflare delante de chatgpt.com devuelve
      // 403 cuando ve ese header junto a nuestro UA de Codex. Con `https.request`
      // controlamos los headers al byte.
      const data = await new Promise<Record<string, unknown> | null>((resolve) => {
        const req = https.request({
          hostname: 'chatgpt.com',
          port: 443,
          path: '/backend-api/codex/usage',
          method: 'GET',
          timeout: 2000,
          headers: {
            Host: 'chatgpt.com',
            Authorization: headers.Authorization,
            'chatgpt-account-id': accountId,
            Originator: 'codex_cli',
            'User-Agent': 'codex_cli_rs/0.1.0',
            Accept: '*/*',
          },
        }, (res) => {
          if (res.statusCode !== 200) { res.resume(); resolve(null); return }
          let buf = ''
          res.setEncoding('utf-8')
          res.on('data', (c: string) => { buf += c })
          res.on('end', () => {
            try { resolve(JSON.parse(buf) as Record<string, unknown>) }
            catch { resolve(null) }
          })
        })
        req.on('timeout', () => { req.destroy(); resolve(null) })
        req.on('error', () => resolve(null))
        req.end()
      })

      const rl = data?.rate_limit as {
        allowed?: boolean
        limit_reached?: boolean
        primary_window?:   { used_percent?: number; reset_at?: number }
        secondary_window?: { used_percent?: number; reset_at?: number }
      } | undefined

      const pri = rl?.primary_window
      const sec = rl?.secondary_window
      if (pri) {
        const sub: SubscriptionUsage = {
          provider: 'openai',
          fiveHour: (pri.used_percent || 0) / 100,
          fiveHourSonnet: 0,
          fiveHourOpus: 0,
          fiveHourHaiku: 0,
          fiveHourResetAt: (pri.reset_at || 0) * 1000,
          sevenDay: (sec?.used_percent || 0) / 100,
          sevenDaySonnet: 0,
          sevenDayResetAt: (sec?.reset_at || 0) * 1000,
          status: rl?.limit_reached ? 'limited' : (rl?.allowed ? 'allowed' : 'unknown'),
          representative: 'five_hour',
          plan: data?.plan_type as string | undefined,
        }
        this.pendingEvents.push({ type: '_sq_subscription', subscription: sub })
        this.notify()
      }
    } catch { /* best-effort */ }
    this.markClosed()
  }

  private notify(): void {
    if (this.notifyWaiter) {
      const w = this.notifyWaiter
      this.notifyWaiter = null
      w()
    }
  }

  /** Traduce un evento `response.*` a uno o varios chunks normalizados. */
  private translateEvent(evt: Record<string, unknown>): NormalizedStreamChunk[] {
    const type = evt.type as string
    const out: NormalizedStreamChunk[] = []

    // Errores
    if (type === 'response.error' || type === 'error') {
      const msg = (evt.error as Record<string, unknown>)?.message as string || 'unknown error'
      this.streamError = new APIError('openai', 0, msg, false)
      return out
    }

    // Texto streaming
    if (type === 'response.output_text.delta') {
      const delta = evt.delta as string | undefined
      if (delta) out.push({ type: 'text', text: delta })
      return out
    }

    // Razonamiento interno de o3/o4-mini/gpt-5-codex — Codex lo stremea como
    // `response.reasoning_text.delta`. Lo enseñamos en gris bajo la barrita.
    if (type === 'response.reasoning_text.delta' || type === 'response.reasoning.delta') {
      const delta = evt.delta as string | undefined
      if (delta) out.push({ type: 'thinking', text: delta })
      return out
    }

    // Tool call — empieza como output_item.added con item.type = 'function_call'
    if (type === 'response.output_item.added') {
      const item = evt.item as Record<string, unknown> | undefined
      if (item?.type === 'function_call') {
        const id = (item.call_id as string) || (item.id as string) || ''
        const name = item.name as string
        this.toolCalls.set(id, { id, name, argsJson: '' })
      }
      return out
    }

    // Args de tool (streaming JSON)
    if (type === 'response.function_call_arguments.delta') {
      const id = (evt.item_id as string) || (evt.call_id as string) || ''
      const delta = evt.delta as string | undefined
      const call = Array.from(this.toolCalls.values()).find(c => c.id === id) || this.toolCalls.get(id)
      if (call && delta) call.argsJson += delta
      return out
    }

    if (type === 'response.function_call_arguments.done') {
      const id = (evt.item_id as string) || (evt.call_id as string) || ''
      const final = evt.arguments as string | undefined
      const call = this.toolCalls.get(id) ||
                   Array.from(this.toolCalls.values()).find(c => c.id === id)
      if (call) {
        const argsStr = final || call.argsJson
        let input: Record<string, unknown> = {}
        try { input = JSON.parse(argsStr || '{}') } catch { /* leave empty */ }
        out.push({ type: 'tool_use', id: call.id, name: call.name, input })
      }
      return out
    }

    // Evento sintético: resultado del fetch de /codex/usage.
    if (type === '_sq_subscription') {
      return [{ type: 'subscription', subscription: (evt as { subscription: SubscriptionUsage }).subscription }]
    }

    // Uso / completado
    if (type === 'response.completed' || type === 'response.done') {
      const usage = (evt.response as Record<string, unknown>)?.usage as Record<string, unknown> | undefined
      if (usage) {
        // OpenAI cachea prompts > 1024 tok automáticamente. Devuelve cuántos
        // se sirvieron desde cache en input_tokens_details.cached_tokens.
        // No pagan a precio completo — se descuentan ~50% del input.
        const details = usage.input_tokens_details as Record<string, number> | undefined
        const cacheRead = details?.cached_tokens || 0
        out.push({
          type: 'usage',
          usage: {
            inputTokens: (usage.input_tokens as number) || 0,
            outputTokens: (usage.output_tokens as number) || 0,
            cacheRead,
          },
        })
      }
      // No cerramos aún: disparamos fetch al /backend-api/codex/usage y será
      // éste el que, cuando responda (o time-out), push el subscription sintético
      // y después marque el stream como cerrado.
      void this.fetchSubscriptionAndClose()
      return out
    }

    // Cualquier otro evento (response.created, content_part.added, output_text.done, etc.)
    // lo ignoramos. Sólo nos importan los deltas y los terminales.
    return out
  }
}
