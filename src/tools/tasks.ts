import crypto from 'node:crypto'

/**
 * Lista de tasks/TODOs en memoria por sesión. El modelo la usa para trackear
 * trabajo multi-step. No persiste a disco — al cerrar sq se pierde (en el
 * futuro la guardamos en `~/.squeezr-code/sessions/<id>.tasks.json`).
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface TaskItem {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  blockedBy?: string[]
  blocks?: string[]
}

const tasks = new Map<string, TaskItem>()
let nextId = 1

export function taskCreate(input: Record<string, unknown>): string {
  const subject = input.subject as string
  if (!subject) return 'Error: subject is required'
  const id = String(nextId++)
  const item: TaskItem = {
    id,
    subject,
    description: (input.description as string) || '',
    activeForm: (input.activeForm as string) || undefined,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  tasks.set(id, item)
  return `Task #${id} created: ${subject}`
}

export function taskList(): string {
  if (tasks.size === 0) return 'No tasks yet.'
  const lines: string[] = []
  for (const t of tasks.values()) {
    const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '⋯' : '○'
    const blocked = t.blockedBy && t.blockedBy.length > 0 ? ` [blocked by: ${t.blockedBy.join(',')}]` : ''
    lines.push(`  ${icon} #${t.id}  ${t.subject}${blocked}`)
  }
  return lines.join('\n')
}

export function taskGet(input: Record<string, unknown>): string {
  const id = String(input.taskId || '')
  const t = tasks.get(id)
  if (!t) return `Error: task #${id} not found`
  return JSON.stringify({
    id: t.id,
    subject: t.subject,
    description: t.description,
    status: t.status,
    blockedBy: t.blockedBy || [],
    blocks: t.blocks || [],
  }, null, 2)
}

export function taskUpdate(input: Record<string, unknown>): string {
  const id = String(input.taskId || '')
  const t = tasks.get(id)
  if (!t) return `Error: task #${id} not found`
  if (input.status === 'deleted') {
    tasks.delete(id)
    return `Task #${id} deleted`
  }
  if (input.status) t.status = input.status as TaskStatus
  if (input.subject) t.subject = input.subject as string
  if (input.description !== undefined) t.description = input.description as string
  if (input.activeForm !== undefined) t.activeForm = input.activeForm as string
  if (Array.isArray(input.addBlockedBy)) {
    t.blockedBy = [...new Set([...(t.blockedBy || []), ...(input.addBlockedBy as string[])])]
  }
  if (Array.isArray(input.addBlocks)) {
    t.blocks = [...new Set([...(t.blocks || []), ...(input.addBlocks as string[])])]
  }
  t.updatedAt = Date.now()
  return `Task #${id} updated → status=${t.status}, subject="${t.subject}"`
}

/** Snapshot en JSON para que el REPL/sesión lo pueda persistir si quiere. */
export function taskSnapshot(): TaskItem[] {
  return Array.from(tasks.values())
}

/** Borra TODAS las tasks — usado por /tasklist clean. */
export function clearAllTasks(): void {
  tasks.clear()
}

/** Cargar tasks (al hacer sq resume). */
export function taskRehydrate(items: TaskItem[]): void {
  tasks.clear()
  let maxId = 0
  for (const t of items) {
    tasks.set(t.id, t)
    const n = parseInt(t.id, 10)
    if (!isNaN(n) && n > maxId) maxId = n
  }
  nextId = maxId + 1
}

/** Reset (para sesiones nuevas). */
export function taskClear(): void {
  tasks.clear()
  nextId = 1
}
