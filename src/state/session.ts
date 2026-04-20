import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type { NormalizedMessage } from '../api/types.js'

/**
 * Persistencia de sesión: cada sesión es un fichero JSON en
 * ~/.squeezr-code/sessions/<id>.json con el historial de mensajes,
 * el modelo activo y metadatos. Se actualiza tras cada turno.
 *
 * `sq resume` carga la más reciente para que continúes la conversación
 * con el contexto intacto.
 */

const SESSIONS_DIR = path.join(os.homedir(), '.squeezr-code', 'sessions')

export interface SessionData {
  id: string
  /** ms unix de creación. */
  createdAt: number
  /** ms unix del último turno escrito. */
  updatedAt: number
  /** cwd cuando se creó la sesión. */
  cwd: string
  model: string
  messages: NormalizedMessage[]
}

export class Session {
  private constructor(private data: SessionData) {}

  static create(opts: { cwd: string; model: string }): Session {
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    return new Session({
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cwd: opts.cwd,
      model: opts.model,
      messages: [],
    })
  }

  static load(id: string): Session | null {
    const file = path.join(SESSIONS_DIR, `${id}.json`)
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
      return new Session(raw)
    } catch {
      return null
    }
  }

  /** Devuelve la sesión más reciente (por updatedAt), o null si no hay ninguna. */
  static loadLatest(): Session | null {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) return null
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
      if (files.length === 0) return null
      let best: { name: string; ts: number } | null = null
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(SESSIONS_DIR, f))
          const ts = stat.mtimeMs
          if (!best || ts > best.ts) best = { name: f, ts }
        } catch { /* skip */ }
      }
      if (!best) return null
      return Session.load(best.name.replace(/\.json$/, ''))
    } catch {
      return null
    }
  }

  /** Lista todas las sesiones ordenadas por updatedAt desc. */
  static list(): Array<{ id: string; updatedAt: number; cwd: string; model: string; turnCount: number }> {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) return []
      const out: Array<{ id: string; updatedAt: number; cwd: string; model: string; turnCount: number }> = []
      for (const f of fs.readdirSync(SESSIONS_DIR)) {
        if (!f.endsWith('.json')) continue
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8')) as SessionData
          out.push({
            id: data.id,
            updatedAt: data.updatedAt,
            cwd: data.cwd,
            model: data.model,
            turnCount: data.messages.filter(m => m.role === 'user').length,
          })
        } catch { /* skip */ }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  getId(): string { return this.data.id }
  getMessages(): NormalizedMessage[] { return this.data.messages }
  getModel(): string { return this.data.model }
  getCwd(): string { return this.data.cwd }

  updateMessages(messages: NormalizedMessage[]): void {
    this.data.messages = messages
    this.data.updatedAt = Date.now()
    this.persist()
  }

  updateModel(model: string): void {
    this.data.model = model
    this.data.updatedAt = Date.now()
    this.persist()
  }

  private persist(): void {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true })
      const file = path.join(SESSIONS_DIR, `${this.data.id}.json`)
      fs.writeFileSync(file, JSON.stringify(this.data, null, 2))
    } catch {
      // best-effort: si no podemos escribir, seguimos funcionando
    }
  }
}

/**
 * Auto-prune de sesiones: se llama al arrancar sq. Elimina:
 *   - Stubs: sesiones sin ningún mensaje de user (abriste sq y saliste).
 *   - Muy viejas: updatedAt < now - maxAgeDays.
 *   - Excedente: si tras lo anterior siguen sobrando más de maxKeep, borra
 *     las más antiguas por updatedAt hasta dejar maxKeep.
 *
 * Devuelve cuántas se borraron. Best-effort: ignora errores de fs.
 */
export function pruneSessions(opts: { maxKeep?: number; maxAgeDays?: number } = {}): number {
  const maxKeep = opts.maxKeep ?? 100
  const maxAgeDays = opts.maxAgeDays ?? 90
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  let deleted = 0
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return 0
    type Entry = { file: string; data: SessionData | null; mtime: number }
    const entries: Entry[] = []
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json')) continue
      const filePath = path.join(SESSIONS_DIR, f)
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionData
        const mtime = fs.statSync(filePath).mtimeMs
        entries.push({ file: filePath, data, mtime })
      } catch {
        // JSON corrupto — lo tratamos como candidato a borrar
        entries.push({ file: filePath, data: null, mtime: 0 })
      }
    }

    for (const e of entries.slice()) {
      const userMsgs = e.data?.messages.filter(m => m.role === 'user').length ?? 0
      const isStub = !e.data || userMsgs === 0
      const isOld = (e.data?.updatedAt ?? e.mtime) < cutoff
      if (isStub || isOld) {
        try { fs.unlinkSync(e.file); deleted++ } catch { /* ignore */ }
        entries.splice(entries.indexOf(e), 1)
      }
    }

    // Si aún sobran, borra los más antiguos.
    if (entries.length > maxKeep) {
      entries.sort((a, b) => (b.data?.updatedAt ?? 0) - (a.data?.updatedAt ?? 0))
      for (const e of entries.slice(maxKeep)) {
        try { fs.unlinkSync(e.file); deleted++ } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
  return deleted
}
