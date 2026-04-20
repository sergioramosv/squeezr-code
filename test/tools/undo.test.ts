import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { snapshotBeforeWrite, popAndRestore, undoStackSize } from '../../src/tools/undo.js'

describe('undo stack', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-undo-'))
    // drain stack
    while (popAndRestore() !== null) { /* drain */ }
  })

  afterEach(() => {
    while (popAndRestore() !== null) { /* drain */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('pop returns null when stack is empty', () => {
    expect(popAndRestore()).toBeNull()
  })

  it('snapshots existing file content and restores it', () => {
    const f = path.join(tmp, 'a.txt')
    fs.writeFileSync(f, 'original')
    snapshotBeforeWrite(f)
    fs.writeFileSync(f, 'modified')
    expect(fs.readFileSync(f, 'utf-8')).toBe('modified')
    const restored = popAndRestore()
    expect(restored).toBe(f)
    expect(fs.readFileSync(f, 'utf-8')).toBe('original')
  })

  it('snapshot of non-existent file → undo deletes it', () => {
    const f = path.join(tmp, 'new.txt')
    snapshotBeforeWrite(f)  // file does not exist yet
    fs.writeFileSync(f, 'created by Write')
    expect(fs.existsSync(f)).toBe(true)
    popAndRestore()
    expect(fs.existsSync(f)).toBe(false)
  })

  it('undo non-existent snapshot of non-existent file is safe (no-op)', () => {
    const f = path.join(tmp, 'never.txt')
    snapshotBeforeWrite(f)
    // file never created
    expect(popAndRestore()).toBe(f)
    expect(fs.existsSync(f)).toBe(false)
  })

  it('undoStackSize tracks pushes and pops', () => {
    const f1 = path.join(tmp, 'a')
    const f2 = path.join(tmp, 'b')
    snapshotBeforeWrite(f1)
    snapshotBeforeWrite(f2)
    expect(undoStackSize()).toBe(2)
    popAndRestore()
    expect(undoStackSize()).toBe(1)
    popAndRestore()
    expect(undoStackSize()).toBe(0)
  })

  it('caps stack at MAX_STACK = 50 (oldest dropped)', () => {
    for (let i = 0; i < 60; i++) {
      snapshotBeforeWrite(path.join(tmp, `f${i}.txt`))
    }
    expect(undoStackSize()).toBe(50)
  })

  it('snapshots+pops in LIFO order', () => {
    const f1 = path.join(tmp, '1.txt'); fs.writeFileSync(f1, 'one')
    const f2 = path.join(tmp, '2.txt'); fs.writeFileSync(f2, 'two')
    snapshotBeforeWrite(f1); snapshotBeforeWrite(f2)
    fs.writeFileSync(f1, 'one-mod'); fs.writeFileSync(f2, 'two-mod')
    expect(popAndRestore()).toBe(f2)
    expect(fs.readFileSync(f2, 'utf-8')).toBe('two')
    expect(popAndRestore()).toBe(f1)
    expect(fs.readFileSync(f1, 'utf-8')).toBe('one')
  })
})
