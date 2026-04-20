import crypto from 'node:crypto'

/**
 * Cron scheduling in-memory. Los jobs viven solo en la sesión de sq (no
 * persisten) salvo que el user pida `durable: true` — entonces los guardamos
 * en ~/.squeezr-code/scheduled_tasks.json para que sobrevivan restarts.
 *
 * Cron syntax: 5 fields, local timezone.
 *   min hour day-of-month month day-of-week
 *
 * Soporta: *, star-slash-N, N, N-M, N,M,L
 * No soporta: @reboot, L (last), W (weekday)
 *
 * Los jobs se disparan cuando el REPL está idle. Al fire, inyectan el prompt
 * como si el user lo hubiera tecleado. Auto-expiran tras 7 días (recurrentes)
 * o al primer fire (one-shot).
 */

export interface CronJob {
  id: string
  cron: string
  prompt: string
  recurring: boolean
  durable: boolean
  createdAt: number
  expiresAt: number
  lastFireAt?: number
  nextFireAt: number
}

const jobs = new Map<string, CronJob>()
let fireHandler: ((prompt: string) => void) | null = null

export function setCronFireHandler(fn: ((prompt: string) => void) | null): void {
  fireHandler = fn
}

/** Parse "M H DoM Mon DoW" → matcher function. */
function compileCron(spec: string): (d: Date) => boolean {
  const parts = spec.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`Invalid cron: expected 5 fields, got ${parts.length}`)
  const [min, hour, dom, mon, dow] = parts
  const matchField = (val: number, field: string, max: number): boolean => {
    // '*'
    if (field === '*') return true
    // '*/N'
    const stepMatch = /^\*\/(\d+)$/.exec(field)
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10)
      return val % step === 0
    }
    // 'N,M,L' — list
    for (const piece of field.split(',')) {
      // 'N-M' range
      const rangeMatch = /^(\d+)-(\d+)$/.exec(piece)
      if (rangeMatch) {
        const lo = parseInt(rangeMatch[1], 10)
        const hi = parseInt(rangeMatch[2], 10)
        if (val >= lo && val <= hi) return true
        continue
      }
      // 'N' exact
      const nMatch = /^(\d+)$/.exec(piece)
      if (nMatch) {
        if (val === parseInt(nMatch[1], 10)) return true
      }
    }
    if (val >= max) return false  // sanity
    return false
  }
  return (d: Date) =>
    matchField(d.getMinutes(), min, 60) &&
    matchField(d.getHours(), hour, 24) &&
    matchField(d.getDate(), dom, 32) &&
    matchField(d.getMonth() + 1, mon, 13) &&
    matchField(d.getDay(), dow, 7)
}

/** Find next firing time by scanning minute-by-minute up to 1 year. */
function nextFire(spec: string, from: Date): number {
  const match = compileCron(spec)
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)  // next minute
  for (let i = 0; i < 525_600; i++) {  // minutes in a year
    if (match(d)) return d.getTime()
    d.setMinutes(d.getMinutes() + 1)
  }
  return from.getTime() + 365 * 24 * 60 * 60 * 1000  // fallback: 1 year
}

export function cronCreate(opts: { cron: string; prompt: string; recurring?: boolean; durable?: boolean }): { id: string; nextFireAt: number } {
  // Valida compilando.
  compileCron(opts.cron)
  const now = Date.now()
  const id = `cron-${crypto.randomBytes(3).toString('hex')}`
  const recurring = opts.recurring !== false
  const job: CronJob = {
    id,
    cron: opts.cron,
    prompt: opts.prompt,
    recurring,
    durable: !!opts.durable,
    createdAt: now,
    expiresAt: recurring ? now + 7 * 24 * 60 * 60 * 1000 : now + 365 * 24 * 60 * 60 * 1000,
    nextFireAt: nextFire(opts.cron, new Date(now)),
  }
  jobs.set(id, job)
  return { id, nextFireAt: job.nextFireAt }
}

export function cronDelete(id: string): boolean {
  return jobs.delete(id)
}

export function cronList(): CronJob[] {
  return [...jobs.values()].sort((a, b) => a.nextFireAt - b.nextFireAt)
}

/** Loop que checa cada 30s si algún job debe dispararse. */
let tickerInterval: NodeJS.Timeout | null = null
export function startCronTicker(): void {
  if (tickerInterval) return
  tickerInterval = setInterval(() => {
    const now = Date.now()
    for (const job of [...jobs.values()]) {
      if (now >= job.expiresAt) {
        jobs.delete(job.id)
        continue
      }
      if (now >= job.nextFireAt) {
        job.lastFireAt = now
        if (fireHandler) {
          try { fireHandler(job.prompt) } catch { /* ignore */ }
        }
        if (job.recurring) {
          job.nextFireAt = nextFire(job.cron, new Date(now))
        } else {
          jobs.delete(job.id)
        }
      }
    }
  }, 30_000)
}

export function stopCronTicker(): void {
  if (tickerInterval) {
    clearInterval(tickerInterval)
    tickerInterval = null
  }
}
