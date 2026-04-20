import fs from 'node:fs'
import crypto from 'node:crypto'

/**
 * NotebookEdit — manipula celdas en .ipynb (JSON estándar de Jupyter).
 * Soporta replace (default), insert y delete. El modelo no edita el JSON
 * directamente — pasa cell_id o cell_number y nuevo source.
 */

interface NotebookCell {
  id?: string
  cell_type: 'code' | 'markdown' | 'raw'
  source: string | string[]
  metadata?: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: number | null
}

interface Notebook {
  cells: NotebookCell[]
  metadata?: Record<string, unknown>
  nbformat?: number
  nbformat_minor?: number
}

export function notebookEdit(input: Record<string, unknown>): string {
  const filePath = input.notebook_path as string
  const newSource = (input.new_source as string) || ''
  const editMode = ((input.edit_mode as string) || 'replace') as 'replace' | 'insert' | 'delete'
  const cellType = input.cell_type as 'code' | 'markdown' | undefined
  const cellId = input.cell_id as string | undefined

  if (!filePath) return 'Error: notebook_path is required'
  if (!fs.existsSync(filePath)) return `Error: notebook not found: ${filePath}`

  let nb: Notebook
  try {
    nb = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Notebook
  } catch (err) {
    return `Error: invalid notebook JSON: ${err instanceof Error ? err.message : err}`
  }
  if (!Array.isArray(nb.cells)) return 'Error: notebook has no cells array'

  // Localiza la celda objetivo: por cell_id o por índice (cell_number — no
  // documentado pero útil como fallback).
  const cellNumber = input.cell_number as number | undefined
  let idx = -1
  if (cellId) {
    idx = nb.cells.findIndex(c => c.id === cellId)
    if (idx < 0 && editMode !== 'insert') return `Error: cell_id "${cellId}" not found`
  } else if (typeof cellNumber === 'number') {
    idx = cellNumber
  }

  if (editMode === 'delete') {
    if (idx < 0 || idx >= nb.cells.length) return 'Error: invalid cell index for delete'
    nb.cells.splice(idx, 1)
    fs.writeFileSync(filePath, JSON.stringify(nb, null, 1))
    return `Cell deleted at index ${idx}`
  }

  if (editMode === 'insert') {
    if (!cellType) return 'Error: cell_type required when edit_mode=insert'
    const newCell: NotebookCell = {
      id: crypto.randomBytes(4).toString('hex'),
      cell_type: cellType,
      source: newSource.split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l),
      metadata: {},
      ...(cellType === 'code' ? { outputs: [], execution_count: null } : {}),
    }
    const insertAt = idx >= 0 ? idx + 1 : nb.cells.length
    nb.cells.splice(insertAt, 0, newCell)
    fs.writeFileSync(filePath, JSON.stringify(nb, null, 1))
    return `Cell inserted at index ${insertAt}`
  }

  // replace (default)
  if (idx < 0) return 'Error: cell_id or cell_number required for replace'
  if (idx >= nb.cells.length) return 'Error: cell index out of range'
  const cell = nb.cells[idx]
  if (cellType) cell.cell_type = cellType
  cell.source = newSource.split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l)
  if (cell.cell_type === 'code') {
    cell.outputs = []
    cell.execution_count = null
  }
  fs.writeFileSync(filePath, JSON.stringify(nb, null, 1))
  return `Cell replaced at index ${idx}`
}
