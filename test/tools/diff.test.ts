import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { diffForWrite, diffForEdit } from '../../src/tools/diff.js'

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('diffForWrite', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-diff-')) })
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('shows "creando" header for new file', () => {
    const f = path.join(tmp, 'new.txt')
    const out = stripAnsi(diffForWrite(f, 'line1\nline2'))
    expect(out).toContain('creando')
    expect(out).toContain('+ line1')
    expect(out).toContain('+ line2')
  })

  it('shows "modificando" header for existing file', () => {
    const f = path.join(tmp, 'a.txt')
    fs.writeFileSync(f, 'old content')
    const out = stripAnsi(diffForWrite(f, 'new content'))
    expect(out).toContain('modificando')
  })

  it('shows truncation suffix when new file has >40 lines', () => {
    const f = path.join(tmp, 'big.txt')  // does not exist
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const out = stripAnsi(diffForWrite(f, lines))
    expect(out).toContain('líneas')
    expect(out).toContain('+ line 0')
    expect(out).toContain('+ line 39')
  })

  it('renders no-change diff', () => {
    const f = path.join(tmp, 'same.txt')
    fs.writeFileSync(f, 'identical')
    const out = stripAnsi(diffForWrite(f, 'identical'))
    expect(out).toContain('sin cambios')
  })

  it('shows added/deleted lines', () => {
    const f = path.join(tmp, 'edit.txt')
    fs.writeFileSync(f, 'line1\nline2\nline3')
    const out = stripAnsi(diffForWrite(f, 'line1\nLINE2\nline3'))
    expect(out).toContain('- line2')
    expect(out).toContain('+ LINE2')
  })
})

describe('diffForEdit', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-diff-')) })
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('shows editando header', () => {
    const f = path.join(tmp, 'a.txt')
    fs.writeFileSync(f, 'foo bar baz')
    const out = stripAnsi(diffForEdit(f, 'bar', 'BAR'))
    expect(out).toContain('editando')
  })

  it('shows error when old_string not found', () => {
    const f = path.join(tmp, 'a.txt')
    fs.writeFileSync(f, 'hello')
    const out = stripAnsi(diffForEdit(f, 'NOT THERE', 'X'))
    expect(out).toContain('no encontrado')
  })

  it('returns just header for missing file', () => {
    const out = stripAnsi(diffForEdit(path.join(tmp, 'nope.txt'), 'a', 'b'))
    expect(out).toContain('editando')
  })

  it('shows - and + lines for the change', () => {
    const f = path.join(tmp, 'a.txt')
    fs.writeFileSync(f, 'line1\nold value\nline3')
    const out = stripAnsi(diffForEdit(f, 'old value', 'new value'))
    expect(out).toContain('- old value')
    expect(out).toContain('+ new value')
  })
})
