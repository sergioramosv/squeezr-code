import fs from 'node:fs'

/**
 * Stack de snapshots pre-Edit/Write para `/undo`.
 *
 * Antes de modificar un fichero, push del estado anterior. /undo hace pop
 * y restaura. Best-effort: si el fichero no existía antes (Write nuevo),
 * guardamos un marcador "delete on undo". Máximo 50 niveles para no crecer
 * sin límite.
 */

interface Snapshot {
  file: string
  previous: string | null  // null = el fichero no existía antes
}

const MAX_STACK = 50
const stack: Snapshot[] = []

/** Guarda snapshot del estado actual del fichero antes de modificarlo. */
export function snapshotBeforeWrite(file: string): void {
  let previous: string | null = null
  try {
    if (fs.existsSync(file)) {
      previous = fs.readFileSync(file, 'utf-8')
    }
  } catch { /* si no podemos leer, snapshot es null (equiv. a "no existía") */ }
  stack.push({ file, previous })
  if (stack.length > MAX_STACK) stack.shift()
}

/**
 * Pop + restaura. Devuelve el path restaurado o null si el stack está vacío.
 * Si el snapshot era `null` (fichero nuevo creado por Write), borra el fichero.
 */
export function popAndRestore(): string | null {
  const snap = stack.pop()
  if (!snap) return null
  try {
    if (snap.previous === null) {
      if (fs.existsSync(snap.file)) fs.unlinkSync(snap.file)
    } else {
      fs.writeFileSync(snap.file, snap.previous)
    }
    return snap.file
  } catch {
    return null
  }
}

export function undoStackSize(): number {
  return stack.length
}
