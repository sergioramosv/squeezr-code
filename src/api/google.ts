import crypto from 'node:crypto'
import { APIError } from '../errors.js'
import type { APIAdapter, NormalizedRequest, NormalizedStreamChunk } from './types.js'

/**
 * Adapter para Gemini via Code Assist API (cloudcode-pa.googleapis.com/v1internal).
 *
 * Mismo canal privado que usa `gemini-cli` cuando haces login con Google: consume
 * de la suscripción Google AI Pro/Ultra igual que Codex consume de ChatGPT Plus
 * y Claude Code consume de Claude Pro.
 *
 * Es REST + SSE (no WebSocket): el endpoint `:streamGenerateContent?alt=sse`
 * devuelve un stream Server-Sent Events con los `candidates[]` parciales.
 *
 * Bootstrap por sesión:
 *   1. POST :loadCodeAssist  → resuelve tier + cloudaicompanionProject
 *   2. POST :onboardUser     → vincula projectId si no había tier asignado
 *   3. Cachea projectId en memoria del adapter (solo cuesta ~200ms en cold start)
 */

const CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com/v1internal'

interface GeminiPart {
  text?: string
  /** True cuando `text` es el razonamiento interno, no output de usuario. */
  thought?: boolean
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
  }>
}

interface ToolCallTracker {
  /** name → id generado, para emparejar el siguiente functionResponse. */
  byName: Map<string, string>
}

export class GoogleAdapter implements APIAdapter {
  private getHeaders: () => Promise<Record<string, string>>
  private currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private abortController: AbortController | null = null
  /** projectId resuelto en bootstrap, cacheado por sesión. */
  private projectId: string | null = null
  /** Para resolver el call_id del `tool_result` posterior, ya que Gemini no emite id. */
  private toolCallTracker: ToolCallTracker = { byName: new Map() }

  constructor(getHeaders: () => Promise<Record<string, string>>) {
    this.getHeaders = getHeaders
  }

  async sendRequest(req: NormalizedRequest): Promise<void> {
    // Asegura projectId resuelto antes del primer request.
    if (!this.projectId) {
      await this.bootstrap()
    }

    // Schema sane de tools idéntico al de Anthropic/OpenAI: required fuera, no
    // dentro de cada property.
    const functionDeclarations = req.tools.map(t => {
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [paramName, paramDef] of Object.entries(t.parameters)) {
        const def = paramDef as Record<string, unknown>
        const { required: isRequired, ...clean } = def
        properties[paramName] = clean
        if (isRequired) required.push(paramName)
      }
      return {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      }
    })

    const tools: GeminiTool[] = functionDeclarations.length > 0
      ? [{ functionDeclarations }]
      : []

    const contents = this.toGeminiContents(req.messages)

    const headers = await this.getHeaders()
    this.abortController = new AbortController()

    const body = {
      model: req.model,
      project: this.projectId,
      request: {
        systemInstruction: req.system
          ? { parts: [{ text: req.system }] }
          : undefined,
        contents,
        ...(tools.length > 0 ? { tools } : {}),
      },
    }

    const res = await fetch(`${CODE_ASSIST_BASE}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    })

    if (!res.ok) {
      const retryAfter = res.headers.get('retry-after')
      const retryable = res.status === 429 || res.status >= 500
      const text = await res.text().catch(() => '')
      throw new APIError(
        'google',
        res.status,
        `${res.statusText}: ${text}`,
        retryable,
        retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined,
      )
    }

    if (!res.body) throw new APIError('google', 0, 'No response body', false)

    this.currentReader = res.body.getReader()
  }

  async *receiveStream(): AsyncIterable<NormalizedStreamChunk> {
    if (!this.currentReader) return

    const decoder = new TextDecoder()
    let buffer = ''
    let lastUsage: { inputTokens: number; outputTokens: number } | null = null

    while (true) {
      const { done, value } = await this.currentReader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (!data || data === '[DONE]') continue

        let event: Record<string, unknown>
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }

        for (const chunk of this.processEvent(event)) {
          if (chunk.type === 'usage' && chunk.usage) {
            // Acumulamos el último usage (Gemini lo emite en cada candidato; el
            // valor final viene en el chunk con `candidates[0].finishReason`).
            lastUsage = chunk.usage
          }
          yield chunk
        }
      }
    }

    if (lastUsage) {
      // Re-emitimos el usage final por si el último parse tampoco se entregó arriba.
      // No-op si ya se envió: el Brain solo coge el último.
    }

    yield { type: 'done' }
  }

  async sendToolResult(_toolUseId: string, _result: string): Promise<void> {
    // En Gemini los tool_results se envían como parte del siguiente sendRequest
    // (el historial completo se reenvía), igual que en Anthropic / Codex.
  }

  close(): void {
    try {
      this.abortController?.abort()
    } catch { /* ignore */ }
    try {
      this.currentReader?.cancel()
    } catch { /* ignore */ }
    this.currentReader = null
    this.abortController = null
  }

  // ─── Bootstrap (loadCodeAssist + onboardUser) ─────────────────────────

  private async bootstrap(): Promise<void> {
    const headers = await this.getHeaders()

    // 1. loadCodeAssist
    const loadRes = await fetch(`${CODE_ASSIST_BASE}:loadCodeAssist`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        metadata: { pluginType: 'GEMINI' },
      }),
    })

    if (!loadRes.ok) {
      const text = await loadRes.text().catch(() => '')
      throw new APIError(
        'google',
        loadRes.status,
        `loadCodeAssist failed: ${loadRes.statusText} ${text}`,
        loadRes.status === 429 || loadRes.status >= 500,
      )
    }

    const loadData = await loadRes.json() as {
      currentTier?: { id?: string }
      cloudaicompanionProject?: string
      allowedTiers?: Array<{ id?: string; isDefault?: boolean }>
    }

    const projectFromLoad = loadData.cloudaicompanionProject
    const currentTier = loadData.currentTier?.id

    if (currentTier && projectFromLoad) {
      this.projectId = projectFromLoad
      return
    }

    // 2. onboardUser — long-running op, polling done:true (max 3 retries 1s)
    const tierId = loadData.allowedTiers?.find(t => t.isDefault)?.id
      || currentTier
      || 'free-tier'

    let onboardData: {
      done?: boolean
      response?: { cloudaicompanionProject?: { id?: string } }
    } = {}

    for (let attempt = 0; attempt < 3; attempt++) {
      const onboardRes = await fetch(`${CODE_ASSIST_BASE}:onboardUser`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tierId,
          cloudaicompanionProject: projectFromLoad || 'default',
          metadata: { pluginType: 'GEMINI' },
        }),
      })

      if (!onboardRes.ok) {
        const text = await onboardRes.text().catch(() => '')
        throw new APIError(
          'google',
          onboardRes.status,
          `onboardUser failed: ${onboardRes.statusText} ${text}`,
          false,
        )
      }

      onboardData = await onboardRes.json()
      if (onboardData.done) break
      await new Promise(r => setTimeout(r, 1000))
    }

    const resolvedProject = onboardData.response?.cloudaicompanionProject?.id
      || projectFromLoad

    if (!resolvedProject) {
      throw new APIError(
        'google',
        0,
        'No projectId resolved after onboardUser',
        false,
      )
    }

    this.projectId = resolvedProject
  }

  // ─── Traducciones ─────────────────────────────────────────────────────

  private toGeminiContents(messages: NormalizedRequest['messages']): GeminiContent[] {
    const out: GeminiContent[] = []
    for (const m of messages) {
      if (m.role === 'tool') {
        // Gemini empaqueta el result como objeto, no string suelto.
        // Buscamos el name del tool por el id (lo trackeamos al recibirlo).
        const name = this.findToolNameById(m.toolUseId || '') || 'unknown'
        const resultText = typeof m.content === 'string'
          ? m.content
          : JSON.stringify(m.content)
        out.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name,
              response: { content: resultText },
            },
          }],
        })
        continue
      }

      if (m.role === 'assistant' && Array.isArray(m.content)) {
        const parts: GeminiPart[] = []
        for (const block of m.content) {
          const b = block as unknown as Record<string, unknown>
          if (b.type === 'text' && b.text) {
            parts.push({ text: b.text as string })
          } else if (b.type === 'tool_use') {
            parts.push({
              functionCall: {
                name: b.name as string,
                args: (b.input as Record<string, unknown>) || {},
              },
            })
            // Trackeamos para resolver el tool_result siguiente.
            if (b.id && b.name) {
              this.toolCallTracker.byName.set(b.id as string, b.name as string)
            }
          }
        }
        if (parts.length > 0) out.push({ role: 'model', parts })
        continue
      }

      // user con string o array
      const text = typeof m.content === 'string'
        ? m.content
        : (m.content as Array<{ text?: string }>)
            .map(b => b.text || '')
            .join('')
      out.push({ role: 'user', parts: [{ text }] })
    }
    return out
  }

  private findToolNameById(id: string): string | null {
    return this.toolCallTracker.byName.get(id) || null
  }

  private processEvent(event: Record<string, unknown>): NormalizedStreamChunk[] {
    const chunks: NormalizedStreamChunk[] = []

    // Code Assist envuelve el GenerateContentResponse en `response`.
    const inner = (event.response as Record<string, unknown> | undefined) || event
    const candidates = inner.candidates as Array<Record<string, unknown>> | undefined
    const candidate = candidates?.[0]

    if (candidate) {
      const content = candidate.content as { parts?: GeminiPart[] } | undefined
      const parts = content?.parts || []
      for (const part of parts) {
        if (part.text) {
          // Gemini marca el razonamiento interno con `thought: true`.
          chunks.push({
            type: part.thought ? 'thinking' : 'text',
            text: part.text,
          })
        }
        if (part.functionCall) {
          const id = crypto.randomUUID()
          // Guardamos el id ↔ name para emparejar el functionResponse posterior.
          this.toolCallTracker.byName.set(id, part.functionCall.name)
          chunks.push({
            type: 'tool_use',
            id,
            name: part.functionCall.name,
            input: part.functionCall.args || {},
          })
        }
      }
    }

    const usage = inner.usageMetadata as Record<string, number> | undefined
    if (usage) {
      const inTok = usage.promptTokenCount || 0
      const outTok = usage.candidatesTokenCount || 0
      // Gemini 2.5+ puede servir parte del input desde context cache implícito.
      // El campo cachedContentTokenCount aparece cuando lo hace.
      const cacheRead = usage.cachedContentTokenCount || 0
      chunks.push({
        type: 'usage',
        usage: { inputTokens: inTok, outputTokens: outTok, cacheRead },
      })

      // Google no expone ratelimit headers, así que sintetizamos un snapshot
      // cliente-side: rolling window de tokens en las últimas 5h contra un
      // presupuesto plausible de Code Assist free tier (~2M tok / 5h).
      const snap = recordUsageAndSnapshot(inTok + outTok)
      if (snap) chunks.push({ type: 'subscription', subscription: snap })
    }

    return chunks
  }
}

// ─── Cliente-side 5h quota tracking para Google ──────────────────────
//
// Google no devuelve % de quota en headers. Mantenemos una ventana rolling
// de (timestamp, tokens) por provider en memoria. Cada vez que emitimos un
// usage chunk, sumamos los tokens de los últimos 5h y calculamos el %
// contra GOOGLE_5H_BUDGET. Se pierde al reiniciar sq (esperado).
const GOOGLE_5H_BUDGET = 2_000_000  // ~2M tokens / 5h — heurística para Code Assist
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const bucket: Array<{ ts: number; tokens: number }> = []

function recordUsageAndSnapshot(tokens: number): import('./types.js').SubscriptionUsage | null {
  const now = Date.now()
  bucket.push({ ts: now, tokens })
  const cutoff = now - FIVE_HOURS_MS
  while (bucket.length > 0 && bucket[0].ts < cutoff) bucket.shift()
  const sum = bucket.reduce((acc, e) => acc + e.tokens, 0)
  const pct = Math.min(1, sum / GOOGLE_5H_BUDGET)
  const resetAt = bucket.length > 0 ? bucket[0].ts + FIVE_HOURS_MS : now + FIVE_HOURS_MS
  return {
    provider: 'google',
    fiveHour: pct,
    fiveHourSonnet: 0,
    fiveHourOpus: 0,
    fiveHourHaiku: 0,
    fiveHourResetAt: resetAt,
    sevenDay: 0,
    sevenDaySonnet: 0,
    sevenDayResetAt: 0,
    status: pct >= 0.9 ? 'warning' : 'allowed',
    representative: 'fiveHour',
  }
}
