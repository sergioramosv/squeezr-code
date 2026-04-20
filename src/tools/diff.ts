import fs from 'node:fs'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const BG_GREEN = '\x1b[48;5;22m'
const BG_RED = '\x1b[48;5;52m'

/**
 * Diff visual simple basado en LCS (longest common subsequence) a nivel de línea.
 * No genera parches aplicables — solo enseña al usuario qué va a cambiar para
 * que apruebe con conocimiento antes de que la tool escriba.
 *
 * Para tool `Write`:  diff entre fichero actual (o "<nuevo>") y el content propuesto.
 * Para tool `Edit`:   diff solo del rango afectado + unas líneas de contexto.
 */

export function diffForWrite(filePath: string, newContent: string): string {
  const oldContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
  const exists = fs.existsSync(filePath)
  const header = exists
    ? `${CYAN}modificando${RESET} ${DIM}${filePath}${RESET}`
    : `${CYAN}creando${RESET} ${DIM}${filePath}${RESET}`
  if (!exists) {
    // Fichero nuevo: enseñamos las primeras 40 líneas como `+` sin comparar.
    const lines = newContent.split('\n').slice(0, 40)
    const body = lines.map(l => `  ${GREEN}+ ${l}${RESET}`).join('\n')
    const extra = newContent.split('\n').length > 40 ? `\n  ${DIM}… (+${newContent.split('\n').length - 40} líneas)${RESET}` : ''
    return `${header}\n${body}${extra}`
  }
  return `${header}\n${renderUnifiedDiff(oldContent, newContent, 3)}`
}

export function diffForEdit(filePath: string, oldStr: string, newStr: string): string {
  const header = `${CYAN}editando${RESET} ${DIM}${filePath}${RESET}`
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')

  // Hunk: solo el old_string → new_string con algo de contexto (3 líneas alrededor).
  if (!fs.existsSync(filePath)) return header
  const fullContent = fs.readFileSync(filePath, 'utf-8')
  const idx = fullContent.indexOf(oldStr)
  if (idx < 0) return `${header}\n  ${RED}(old_string no encontrado)${RESET}`

  const before = fullContent.slice(0, idx).split('\n')
  const lineNum = before.length
  const contextBefore = before.slice(Math.max(0, before.length - 4)).slice(0, -1).slice(-3)
  const afterFull = fullContent.slice(idx + oldStr.length).split('\n')
  const contextAfter = afterFull.slice(0, 3)

  const lines: string[] = []
  lines.push(`  ${DIM}@@ línea ${lineNum} @@${RESET}`)
  for (const l of contextBefore) lines.push(`  ${DIM}  ${l}${RESET}`)
  for (const l of oldLines) lines.push(`  ${RED}- ${l}${RESET}`)
  for (const l of newLines) lines.push(`  ${GREEN}+ ${l}${RESET}`)
  for (const l of contextAfter) lines.push(`  ${DIM}  ${l}${RESET}`)
  return `${header}\n${lines.join('\n')}`
}

/**
 * Diff línea a línea con LCS. Para ficheros pequeños está bien, O(n*m) en memoria
 * pero con truncado a 500 líneas por lado para no explotar.
 */
function renderUnifiedDiff(oldText: string, newText: string, context: number): string {
  const MAX = 500
  const oldLines = oldText.split('\n').slice(0, MAX)
  const newLines = newText.split('\n').slice(0, MAX)
  const hunks = computeHunks(oldLines, newLines, context)
  if (hunks.length === 0) {
    return `  ${DIM}(sin cambios)${RESET}`
  }
  const out: string[] = []
  for (const h of hunks) {
    out.push(`  ${DIM}@@ -${h.oldStart + 1},${h.oldCount} +${h.newStart + 1},${h.newCount} @@${RESET}`)
    for (const op of h.ops) {
      if (op.kind === 'keep') out.push(`  ${DIM}  ${op.line}${RESET}`)
      else if (op.kind === 'del') out.push(`  ${RED}- ${op.line}${RESET}`)
      else out.push(`  ${GREEN}+ ${op.line}${RESET}`)
    }
  }
  if (oldText.split('\n').length > MAX || newText.split('\n').length > MAX) {
    out.push(`  ${DIM}… (diff truncado a ${MAX} líneas)${RESET}`)
  }
  return out.join('\n')
}

interface DiffOp { kind: 'keep' | 'del' | 'add'; line: string }
interface Hunk { oldStart: number; newStart: number; oldCount: number; newCount: number; ops: DiffOp[] }

function computeHunks(a: string[], b: string[], context: number): Hunk[] {
  // LCS dp table — quickly infeasible for big files pero para < 500 líneas es < 1MB.
  const n = a.length, m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  // Recorrido del LCS para generar ops inline.
  const ops: DiffOp[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: 'keep', line: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ kind: 'del', line: a[i] }); i++ }
    else { ops.push({ kind: 'add', line: b[j] }); j++ }
  }
  while (i < n) { ops.push({ kind: 'del', line: a[i++] }) }
  while (j < m) { ops.push({ kind: 'add', line: b[j++] }) }

  // Agrupa en hunks (runs de cambios + `context` líneas de 'keep' alrededor).
  const hunks: Hunk[] = []
  let cur: Hunk | null = null
  let oldIdx = 0, newIdx = 0
  let bufferedKeeps: DiffOp[] = []

  for (const op of ops) {
    if (op.kind === 'keep') {
      bufferedKeeps.push(op)
      oldIdx++; newIdx++
      if (cur && bufferedKeeps.length > context * 2) {
        // Cierra hunk, las primeras `context` keeps son el tail del hunk actual.
        cur.ops.push(...bufferedKeeps.slice(0, context))
        recountHunk(cur)
        hunks.push(cur)
        cur = null
        bufferedKeeps = []
      }
      continue
    }
    // Cambio (del/add)
    if (!cur) {
      // Abrir nuevo hunk con hasta `context` keeps como prefix.
      const prefix = bufferedKeeps.slice(-context)
      cur = {
        oldStart: oldIdx - prefix.length,
        newStart: newIdx - prefix.length,
        oldCount: 0,
        newCount: 0,
        ops: [...prefix],
      }
    } else if (bufferedKeeps.length > 0) {
      // Hay keeps entre cambios — inclúyelas en el hunk.
      cur.ops.push(...bufferedKeeps)
    }
    bufferedKeeps = []
    cur.ops.push(op)
    if (op.kind === 'del') oldIdx++
    else newIdx++
  }
  if (cur) {
    cur.ops.push(...bufferedKeeps.slice(0, context))
    recountHunk(cur)
    hunks.push(cur)
  }
  return hunks
}

function recountHunk(h: Hunk): void {
  h.oldCount = h.ops.filter(o => o.kind !== 'add').length
  h.newCount = h.ops.filter(o => o.kind !== 'del').length
}
